import { createIndexedStore } from '@libinprasanth/indexed-store';

type User = { id: number; name: string };
const database = createIndexedStore('types', 1, {
  users: { value: {} as User, keyPath: 'id' },
});
const userResult: Promise<User | undefined> = database.get('users', 1);
void userResult;
// @ts-expect-error The users store uses a numeric key.
database.get('users', 'wrong');
