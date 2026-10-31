export type IndexDefinition = {
  keyPath: string | string[];
  unique?: boolean;
  multiEntry?: boolean;
};

export type StoreDefinition<Value = unknown, Key extends IDBValidKey = IDBValidKey> = {
  keyType?: Key;
  value: Value;
  keyPath?: string | string[] | null;
  autoIncrement?: boolean;
  indexes?: Record<string, IndexDefinition>;
};

export type DatabaseSchema = Record<string, StoreDefinition<unknown, IDBValidKey>>;
export type StoreName<Schema extends DatabaseSchema> = Extract<keyof Schema, string>;
export type StoreValue<
  Schema extends DatabaseSchema,
  Name extends StoreName<Schema>,
> = Schema[Name]['value'];
export type StoreKey<
  Schema extends DatabaseSchema,
  Name extends StoreName<Schema>,
> = Schema[Name] extends { keyType: infer Key extends IDBValidKey }
  ? Key
  : Schema[Name] extends { keyPath: infer KeyPath }
    ? KeyPath extends keyof StoreValue<Schema, Name>
      ? Extract<StoreValue<Schema, Name>[KeyPath], IDBValidKey>
      : IDBValidKey
    : IDBValidKey;

export type MigrationContext = {
  database: IDBDatabase;
  transaction: IDBTransaction;
  oldVersion: number;
  newVersion: number | null;
};

export type StoreOptions = {
  blocked?: (currentVersion: number, requestedVersion: number) => void;
  upgrade?: (context: MigrationContext) => void;
  versionchange?: (event: IDBVersionChangeEvent) => void;
  factory?: IDBFactory;
};

export type CursorOptions = {
  range?: IDBKeyRange;
  direction?: IDBCursorDirection;
  limit?: number;
};

export class IndexedStoreError extends Error {
  override name = 'IndexedStoreError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class DatabaseBlockedError extends IndexedStoreError {
  override name = 'DatabaseBlockedError';
  readonly databaseName: string;

  constructor(databaseName: string) {
    super(`Opening database "${databaseName}" was blocked by another connection.`);
    this.databaseName = databaseName;
  }
}

export class StoreTransaction<Schema extends DatabaseSchema> {
  constructor(private readonly transaction: IDBTransaction) {}

  private objectStore<Name extends StoreName<Schema>>(name: Name): IDBObjectStore {
    return this.transaction.objectStore(name);
  }

  add<Name extends StoreName<Schema>>(
    name: Name,
    value: StoreValue<Schema, Name>,
    key?: StoreKey<Schema, Name>,
  ): Promise<IDBValidKey> {
    const store = this.objectStore(name);
    return requestResult(key === undefined ? store.add(value) : store.add(value, key));
  }

  put<Name extends StoreName<Schema>>(
    name: Name,
    value: StoreValue<Schema, Name>,
    key?: StoreKey<Schema, Name>,
  ): Promise<IDBValidKey> {
    const store = this.objectStore(name);
    return requestResult(key === undefined ? store.put(value) : store.put(value, key));
  }

  get<Name extends StoreName<Schema>>(
    name: Name,
    key: StoreKey<Schema, Name>,
  ): Promise<StoreValue<Schema, Name> | undefined> {
    return requestResult(this.objectStore(name).get(key));
  }

  getAll<Name extends StoreName<Schema>>(
    name: Name,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<StoreValue<Schema, Name>[]> {
    return requestResult(this.objectStore(name).getAll(query ?? undefined, count));
  }

  getAllByIndex<
    Name extends StoreName<Schema>,
    IndexName extends Extract<keyof NonNullable<Schema[Name]['indexes']>, string>,
  >(
    name: Name,
    indexName: IndexName,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<StoreValue<Schema, Name>[]> {
    return requestResult(
      this.objectStore(name)
        .index(indexName)
        .getAll(query ?? undefined, count),
    );
  }

  delete<Name extends StoreName<Schema>>(name: Name, key: StoreKey<Schema, Name>): Promise<void> {
    return requestResult(this.objectStore(name).delete(key));
  }

  clear<Name extends StoreName<Schema>>(name: Name): Promise<void> {
    return requestResult(this.objectStore(name).clear());
  }

  count<Name extends StoreName<Schema>>(
    name: Name,
    query?: IDBValidKey | IDBKeyRange | null,
  ): Promise<number> {
    return requestResult(this.objectStore(name).count(query ?? undefined));
  }

  countByIndex<
    Name extends StoreName<Schema>,
    IndexName extends Extract<keyof NonNullable<Schema[Name]['indexes']>, string>,
  >(name: Name, indexName: IndexName, query?: IDBValidKey | IDBKeyRange | null): Promise<number> {
    return requestResult(
      this.objectStore(name)
        .index(indexName)
        .count(query ?? undefined),
    );
  }

  cursor<Name extends StoreName<Schema>>(
    name: Name,
    options: CursorOptions = {},
  ): Promise<
    Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: StoreValue<Schema, Name> }>
  > {
    return collectCursor<StoreValue<Schema, Name>>(this.objectStore(name), options);
  }

  cursorByIndex<
    Name extends StoreName<Schema>,
    IndexName extends Extract<keyof NonNullable<Schema[Name]['indexes']>, string>,
  >(
    name: Name,
    indexName: IndexName,
    options: CursorOptions = {},
  ): Promise<
    Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: StoreValue<Schema, Name> }>
  > {
    return collectCursor<StoreValue<Schema, Name>>(
      this.objectStore(name).index(indexName),
      options,
    );
  }
}

export class IndexedStore<Schema extends DatabaseSchema> {
  private connection: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase> | undefined;
  private closed = false;
  private readonly factory: IDBFactory;

  constructor(
    readonly name: string,
    readonly version: number,
    private readonly schema: Schema,
    private readonly options: StoreOptions = {},
  ) {
    if (!name.trim()) throw new TypeError('Database name must not be empty.');
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new TypeError('Database version must be a positive safe integer.');
    }
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new IndexedStoreError('IndexedDB is not available in this environment.');
    this.factory = factory;
  }

  async open(): Promise<this> {
    if (this.closed) throw new IndexedStoreError('This database wrapper has been closed.');
    if (this.connection) return this;
    if (!this.opening) this.opening = this.openDatabase();
    await this.opening;
    return this;
  }

  private openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(this.name, this.version);
      } catch (error) {
        reject(asError(error, `Could not open database "${this.name}".`));
        return;
      }

      let settled = false;
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;
        if (!transaction) {
          rejectOnce(new IndexedStoreError('Upgrade transaction was not created.'));
          return;
        }
        this.upgradeTransaction = transaction;
        try {
          this.ensureSchema(database);
          this.options.upgrade?.({
            database,
            transaction,
            oldVersion: event.oldVersion,
            newVersion: event.newVersion,
          });
        } catch (error) {
          transaction.abort();
          rejectOnce(asError(error, 'Database schema upgrade failed.'));
        } finally {
          this.upgradeTransaction = undefined;
        }
      };
      request.onblocked = (event) => {
        try {
          this.options.blocked?.(event.oldVersion, this.version);
        } catch (error) {
          rejectOnce(asError(error, 'Blocked-open callback failed.'));
          return;
        }
        rejectOnce(new DatabaseBlockedError(this.name));
      };
      request.onerror = () =>
        rejectOnce(asError(request.error, `Could not open database "${this.name}".`));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (this.closed) {
          database.close();
          rejectOnce(new IndexedStoreError('Database wrapper closed while opening.'));
          return;
        }
        database.onversionchange = (event) => {
          try {
            this.options.versionchange?.(event);
          } finally {
            this.close();
          }
        };
        this.connection = database;
        settled = true;
        resolve(database);
      };

      function rejectOnce(error: Error): void {
        if (settled) return;
        settled = true;
        reject(error);
      }
    });
  }

  private ensureSchema(database: IDBDatabase): void {
    for (const [storeName, definition] of Object.entries(this.schema)) {
      const store = database.objectStoreNames.contains(storeName)
        ? this.requireUpgradeTransaction().objectStore(storeName)
        : database.createObjectStore(storeName, {
            keyPath: definition.keyPath ?? null,
            autoIncrement: definition.autoIncrement ?? false,
          });
      for (const [indexName, indexDefinition] of Object.entries(definition.indexes ?? {})) {
        if (!store.indexNames.contains(indexName)) {
          store.createIndex(indexName, indexDefinition.keyPath, {
            unique: indexDefinition.unique ?? false,
            multiEntry: indexDefinition.multiEntry ?? false,
          });
        }
      }
    }
  }

  private upgradeTransaction: IDBTransaction | undefined;

  private requireUpgradeTransaction(): IDBTransaction {
    if (!this.upgradeTransaction) {
      throw new IndexedStoreError('Upgrade transaction is unavailable.');
    }
    return this.upgradeTransaction;
  }

  async transaction<Result>(
    storeNames: StoreName<Schema> | readonly StoreName<Schema>[],
    mode: IDBTransactionMode,
    callback: (transaction: StoreTransaction<Schema>) => Result | Promise<Result>,
    options?: IDBTransactionOptions,
  ): Promise<Result> {
    const database = await this.connectionOrOpen();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(storeNames as string | string[], mode, options);
    } catch (error) {
      throw asError(error, 'Could not create IndexedDB transaction.');
    }
    const completed = transactionDone(transaction);
    let result: Result;
    try {
      result = await callback(new StoreTransaction<Schema>(transaction));
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may have already completed.
      }
      await completed.catch(() => undefined);
      throw error;
    }
    await completed;
    return result;
  }

  add<Name extends StoreName<Schema>>(
    name: Name,
    value: StoreValue<Schema, Name>,
    key?: StoreKey<Schema, Name>,
  ): Promise<IDBValidKey> {
    return this.transaction(name, 'readwrite', (transaction) => transaction.add(name, value, key));
  }

  put<Name extends StoreName<Schema>>(
    name: Name,
    value: StoreValue<Schema, Name>,
    key?: StoreKey<Schema, Name>,
  ): Promise<IDBValidKey> {
    return this.transaction(name, 'readwrite', (transaction) => transaction.put(name, value, key));
  }

  get<Name extends StoreName<Schema>>(
    name: Name,
    key: StoreKey<Schema, Name>,
  ): Promise<StoreValue<Schema, Name> | undefined> {
    return this.transaction(name, 'readonly', (transaction) => transaction.get(name, key));
  }

  getAll<Name extends StoreName<Schema>>(
    name: Name,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<StoreValue<Schema, Name>[]> {
    return this.transaction(name, 'readonly', (transaction) =>
      transaction.getAll(name, query, count),
    );
  }

  getAllByIndex<
    Name extends StoreName<Schema>,
    IndexName extends Extract<keyof NonNullable<Schema[Name]['indexes']>, string>,
  >(
    name: Name,
    indexName: IndexName,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<StoreValue<Schema, Name>[]> {
    return this.transaction(name, 'readonly', (transaction) =>
      transaction.getAllByIndex(name, indexName, query, count),
    );
  }

  delete<Name extends StoreName<Schema>>(name: Name, key: StoreKey<Schema, Name>): Promise<void> {
    return this.transaction(name, 'readwrite', (transaction) => transaction.delete(name, key));
  }

  clear<Name extends StoreName<Schema>>(name: Name): Promise<void> {
    return this.transaction(name, 'readwrite', (transaction) => transaction.clear(name));
  }

  count<Name extends StoreName<Schema>>(
    name: Name,
    query?: IDBValidKey | IDBKeyRange | null,
  ): Promise<number> {
    return this.transaction(name, 'readonly', (transaction) => transaction.count(name, query));
  }

  cursor<Name extends StoreName<Schema>>(
    name: Name,
    options: CursorOptions = {},
  ): Promise<
    Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: StoreValue<Schema, Name> }>
  > {
    return this.transaction(name, 'readonly', (transaction) => transaction.cursor(name, options));
  }

  cursorByIndex<
    Name extends StoreName<Schema>,
    IndexName extends Extract<keyof NonNullable<Schema[Name]['indexes']>, string>,
  >(
    name: Name,
    indexName: IndexName,
    options: CursorOptions = {},
  ): Promise<
    Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: StoreValue<Schema, Name> }>
  > {
    return this.transaction(name, 'readonly', (transaction) =>
      transaction.cursorByIndex(name, indexName, options),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
  }

  private async connectionOrOpen(): Promise<IDBDatabase> {
    await this.open();
    if (!this.connection) throw new IndexedStoreError('Database connection is unavailable.');
    return this.connection;
  }
}

export function createIndexedStore<const Schema extends DatabaseSchema>(
  name: string,
  version: number,
  schema: Schema,
  options?: StoreOptions,
): IndexedStore<Schema> {
  return new IndexedStore(name, version, schema, options);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(asError(request.error, 'IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(asError(transaction.error, 'IndexedDB transaction was aborted.'));
    transaction.onerror = () => reject(asError(transaction.error, 'IndexedDB transaction failed.'));
  });
}

function collectCursor<Value>(
  source: IDBObjectStore | IDBIndex,
  options: CursorOptions,
): Promise<Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: Value }>> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    return Promise.reject(new RangeError('Cursor limit must be a non-negative safe integer.'));
  }
  if (options.limit === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const values: Array<{ key: IDBValidKey; primaryKey: IDBValidKey; value: Value }> = [];
    let request: IDBRequest<IDBCursorWithValue | null>;
    try {
      request = source.openCursor(options.range ?? null, options.direction ?? 'next');
    } catch (error) {
      reject(asError(error, 'Could not open IndexedDB cursor.'));
      return;
    }
    request.onerror = () => reject(asError(request.error, 'IndexedDB cursor failed.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (options.limit !== undefined && values.length >= options.limit)) {
        resolve(values);
        return;
      }
      values.push({
        key: cursor.key,
        primaryKey: cursor.primaryKey,
        value: cursor.value as Value,
      });
      cursor.continue();
    };
  });
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new IndexedStoreError(fallback, { cause: error });
}
