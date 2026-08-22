import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from './sqliteSync';

describe('sqliteSync', () => {
  it('opens a daemon-owned SQLite database through the neutral persistence owner', () => {
    const db = openSqliteDatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE records (value TEXT NOT NULL)');
      db.prepare('INSERT INTO records (value) VALUES (?)').run('persisted');

      expect(db.prepare('SELECT value FROM records').get()).toEqual({ value: 'persisted' });
    } finally {
      db.close();
    }
  });
});
