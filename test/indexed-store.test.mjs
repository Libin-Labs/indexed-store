import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createIndexedStore, DatabaseBlockedError } from '../dist/esm/index.js';

const schema = {
  people: {
    value: {},
    keyPath: 'id',
    indexes: {
      byEmail: { keyPath: 'email', unique: true },
      byTeam: { keyPath: 'team' },
    },
  },
};

test('creates stores and indexes; supports CRUD, index queries, and cursors', async () => {
  const db = createIndexedStore(`people-${crypto.randomUUID()}`, 1, schema);
  await db.open();
  await db.add('people', { id: 1, email: 'a@example.com', team: 'red' });
  await db.add('people', { id: 2, email: 'b@example.com', team: 'blue' });
  await db.add('people', { id: 3, email: 'c@example.com', team: 'red' });

  assert.deepEqual(await db.get('people', 2), {
    id: 2,
    email: 'b@example.com',
    team: 'blue',
  });
  assert.equal((await db.getAllByIndex('people', 'byEmail', 'a@example.com')).length, 1);
  assert.equal(await db.count('people'), 3);
  assert.equal(await db.count('people', IDBKeyRange.bound(1, 2)), 2);

  const cursor = await db.cursorByIndex('people', 'byTeam', {
    range: IDBKeyRange.only('red'),
    direction: 'prev',
    limit: 1,
  });
  assert.equal(cursor.length, 1);
  assert.equal(cursor[0].value.team, 'red');

  await db.put('people', { id: 2, email: 'new@example.com', team: 'green' });
  await db.delete('people', 1);
  assert.equal(await db.count('people'), 2);
  await db.clear('people');
  assert.equal((await db.getAll('people')).length, 0);
  db.close();
});

test('runs explicit upgrades and closes its connection on versionchange', async () => {
  const name = `migration-${crypto.randomUUID()}`;
  const first = createIndexedStore(name, 1, {
    records: { value: {}, keyPath: 'id' },
  });
  await first.add('records', { id: 'kept', note: 'value' });
  first.close();

  let migrationRan = false;
  const second = createIndexedStore(
    name,
    2,
    {
      records: {
        value: {},
        keyPath: 'id',
        indexes: { byNote: { keyPath: 'note' } },
      },
      audit: { value: {}, keyPath: 'id' },
    },
    {
      upgrade({ oldVersion, newVersion, database, transaction }) {
        migrationRan = oldVersion === 1 && newVersion === 2;
        assert.equal(database.objectStoreNames.contains('audit'), true);
        transaction.objectStore('audit').put({ id: 1, change: 'v2' });
      },
    },
  );
  assert.deepEqual(await second.get('records', 'kept'), {
    id: 'kept',
    note: 'value',
  });
  assert.equal(migrationRan, true);
  assert.deepEqual(await second.get('audit', 1), { id: 1, change: 'v2' });
  second.close();
});

test('rejects duplicate unique-index values and invalid cursor limits', async () => {
  const db = createIndexedStore(`errors-${crypto.randomUUID()}`, 1, schema);
  await db.add('people', { id: 1, email: 'same@example.com' });
  await assert.rejects(db.add('people', { id: 2, email: 'same@example.com' }), {
    name: 'ConstraintError',
  });
  await assert.rejects(db.cursor('people', { limit: -1 }), RangeError);
  db.close();
});

test('reports a blocked open and closes a late successful connection', async () => {
  let closed = false;
  const database = {
    onversionchange: null,
    close() {
      closed = true;
    },
  };
  const request = {
    result: database,
    transaction: null,
    error: null,
    onupgradeneeded: null,
    onblocked: null,
    onerror: null,
    onsuccess: null,
  };
  const factory = {
    open() {
      queueMicrotask(() => {
        request.onblocked?.({ oldVersion: 1 });
        request.onsuccess?.();
      });
      return request;
    },
  };
  let notified = false;
  const second = createIndexedStore('blocked', 2, schema, {
    factory,
    blocked(oldVersion, requestedVersion) {
      notified = oldVersion === 1 && requestedVersion === 2;
    },
  });
  await assert.rejects(second.open(), DatabaseBlockedError);
  assert.equal(notified, true);
  assert.equal(closed, true);
});
