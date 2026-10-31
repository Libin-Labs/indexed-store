# @libinprasanth/indexed-store

Package version: `1.0.0`. License: MIT.

```sh
npm install @libinprasanth/indexed-store
```

A small, typed wrapper around browser IndexedDB. It creates declared object
stores and indexes during upgrades, provides typed CRUD and cursor helpers, and
lets migrations use the native upgrade transaction.

## Requirements

Use in a browser or another runtime that implements the IndexedDB API. Supply
an `IDBFactory` through `factory` when the global `indexedDB` is unavailable.
The package has no runtime dependencies. IndexedDB transactions are short-lived:
do not await network work or unrelated timers inside a transaction callback.

The manifest requires Node.js 20+ for Node consumers; Node alone does not supply
IndexedDB. ESM `import` and CommonJS `require` select separate declaration
entry points. TypeScript consumers need ES2022 and DOM library declarations for
the public `IDB*` types, not Node ambient types. Importing the module does not
open a database or access IndexedDB; constructing a wrapper resolves the factory.
There is no React or CSS requirement.

## Quick start

```ts
import { createIndexedStore } from "@libinprasanth/indexed-store";

type User = { id: number; email: string; displayName: string };

const users = createIndexedStore("application", 1, {
  users: {
    value: {} as User,
    keyPath: "id",
    indexes: {
      byEmail: { keyPath: "email", unique: true },
    },
  },
});

await users.open();
await users.put("users", {
  id: 1,
  email: "ada@example.com",
  displayName: "Ada",
});
const ada = await users.get("users", 1);
const emailMatches = await users.getAllByIndex(
  "users",
  "byEmail",
  "ada@example.com",
);
users.close();
```

In the schema, each store's `value` gives TypeScript its record type; it is not
stored as a default value. `keyPath` and `autoIncrement` are passed to
`IDBDatabase.createObjectStore`. Stores and indexes are created when absent,
but existing definitions are not changed or removed automatically. Increase
the database version to run schema changes. An `upgrade` callback runs in the
native versionchange transaction, after declared stores and indexes have been
created, and can move existing data or create additional structures.

## API

- `createIndexedStore(name, version, schema, options?)` creates an unopened
  database wrapper. `version` must be a positive safe integer.
- `open()` opens and returns the wrapper. `close()` is idempotent and closes
  the current connection; a closed wrapper cannot be reopened.
- `add`, `put`, `get`, `getAll`, `getAllByIndex`, `delete`, `clear`, and
  `count` are convenience methods. They each use their own transaction.
- `cursor` and `cursorByIndex` return `{ key, primaryKey, value }` rows in
  cursor order. `CursorOptions` supports `range`, `direction` (`next`,
  `nextunique`, `prev`, or `prevunique`), and a non-negative safe-integer
  `limit`.
- `transaction(storeNames, mode, callback, options?)` shares one native
  transaction across the supplied stores. The callback receives a
  `StoreTransaction` with the same CRUD, count, index, and cursor helpers.
  Return the callback result to the caller. Requests made by this wrapper are
  awaited as IndexedDB requests; arbitrary asynchronous work can let the
  browser auto-commit the transaction.

`StoreDefinition` accepts `value`, optional `keyPath`, `autoIncrement`, and
named `indexes`. An index has a `keyPath`, optional `unique`, and optional
`multiEntry`. A string `keyPath` uses the corresponding property type in
`value` as the key type. For out-of-line keys or compound key paths, optional
`keyType` is a type-only marker; it does not change the IndexedDB schema.
`StoreOptions` accepts:

- `factory`: an `IDBFactory`, useful for tests or non-window hosts.
- `blocked(currentVersion, requestedVersion)`: called when another connection
  prevents an upgrade. The open promise rejects with `DatabaseBlockedError`;
  if a connection arrives later, it is immediately closed.
- `upgrade({ database, transaction, oldVersion, newVersion })`: runs within
  `onupgradeneeded`; throwing aborts the upgrade. Keep it synchronous: returned
  promises are not awaited.
- `versionchange(event)`: notified before this wrapper closes its connection
  when another client requests a version change.

IndexedDB request, transaction, and upgrade errors reject the relevant
operation. `IndexedStoreError` is the package base error and
`DatabaseBlockedError` identifies blocked opens. Native constraint, quota, and
abort errors are preserved when supplied by the platform.

### Complete exports, signatures, and defaults

Runtime named exports are `IndexedStore`, `StoreTransaction`,
`createIndexedStore`, `IndexedStoreError`, and `DatabaseBlockedError`.
`new IndexedStore<Schema>(name, version, schema, options?)` is equivalent to the
factory. `name` and `version` are readonly public properties. Empty names and
non-positive/non-safe-integer versions throw `TypeError`; a missing factory throws
`IndexedStoreError`. CRUD methods automatically open the database as needed.
After a failed open, use a fresh wrapper; the opening promise is retained.

The following methods exist on both `IndexedStore<Schema>` and
`StoreTransaction<Schema>`. `name` is a `StoreName<Schema>` and key/value types
are inferred for that store:

| Method | Result |
| --- | --- |
| `add(name, value, key?)` | `Promise<IDBValidKey>`; insert only, duplicate keys reject |
| `put(name, value, key?)` | `Promise<IDBValidKey>`; insert or replace |
| `get(name, key)` | `Promise<StoreValue<Schema, Name> \| undefined>` |
| `getAll(name, query?, count?)` | Promise of matching values |
| `getAllByIndex(name, indexName, query?, count?)` | Promise of matching index values |
| `delete(name, key)` | `Promise<void>` |
| `clear(name)` | `Promise<void>` |
| `count(name, query?)` | `Promise<number>` |
| `cursor(name, options?)` | Promise of `{ key, primaryKey, value }[]` |
| `cursorByIndex(name, indexName, options?)` | Same rows, ordered by index key |

`query` accepts `IDBValidKey | IDBKeyRange | null`; omitted/null means all.
`count` is the native optional maximum result count, not a pagination offset.
`CursorOptions` defaults to no range, `"next"` direction, and no limit; `limit: 0`
returns no rows. Cursor rows are collected into memory, not streamed.
Only `StoreTransaction` additionally exposes
`countByIndex(name, indexName, query?): Promise<number>`. To use it, call
`db.transaction("users", "readonly", tx => tx.countByIndex("users", "byEmail"))`.

`transaction(storeNames, mode, callback, options?)` accepts one store name or a
readonly array, a native `IDBTransactionMode`, and optional native
`IDBTransactionOptions` (such as durability). It resolves the callback's result
only after native transaction completion. A callback throw/rejection attempts
abort and rethrows that value. Construct `StoreTransaction` directly only when
you already own a native `IDBTransaction`; its request promises do not by
themselves guarantee that the transaction committed.

Type-only exports:

- `IndexDefinition`: required `keyPath: string | string[]`, optional
  `unique` and `multiEntry` (both default false when creating an index).
- `StoreDefinition<Value = unknown, Key extends IDBValidKey = IDBValidKey>`:
  required type marker `value`; optional `keyType`, `keyPath` (default null),
  `autoIncrement` (default false), and `indexes` (default none).
- `DatabaseSchema = Record<string, StoreDefinition<unknown, IDBValidKey>>`.
- `StoreName<Schema>` extracts string store names; `StoreValue<Schema, Name>`
  selects that store's record; `StoreKey<Schema, Name>` uses explicit `keyType`,
  then a simple key-path property type, otherwise `IDBValidKey`.
- `MigrationContext`: `database: IDBDatabase`, `transaction: IDBTransaction`,
  `oldVersion: number`, `newVersion: number | null`.
- `StoreOptions` and `CursorOptions` are the options described above; all fields
  are optional and callbacks default to absent.

`IndexedStoreError(message, options?: ErrorOptions)` extends `Error`.
`DatabaseBlockedError(databaseName)` extends it and exposes readonly
`databaseName`. Callback errors during upgrade/blocked opening reject the open
promise; `versionchange` closes in `finally` even if its callback throws.

## Limits

This package does not delete stores or indexes, reconcile changed key paths,
provide cross-tab locking, or make non-IDB asynchronous work transaction-safe.
Schema changes to existing stores need an explicit version bump and migration.
Browser security settings, quota, storage eviction, and transaction scheduling
remain implementation-specific.

There is no AbortSignal API, background compaction, encryption, or worker
dependency. `close()` closes the connection but does not roll back transactions
already submitted. Bound cursor/read sizes yourself and handle quota errors.
This is a non-visual utility with no styling or accessibility behavior.

## License

[MIT](./LICENSE).

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
