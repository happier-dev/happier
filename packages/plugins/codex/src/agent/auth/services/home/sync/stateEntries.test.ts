import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveCodexSqliteStateEntryPattern,
  resolveCodexStateEntryNames,
} from './stateEntries.js';

describe('Codex connected-service home sync state entries', () => {
  it('includes Codex dynamic state entries from source and destination homes in shared mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-state-entries-'));
    try {
      const sourceSqliteHome = join(root, 'source-sqlite');
      const destinationCodexHome = join(root, 'destination-codex-home');
      await mkdir(sourceSqliteHome, { recursive: true });
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(join(sourceSqliteHome, 'state_5.sqlite'), 'state');
      await writeFile(join(sourceSqliteHome, 'logs_2.sqlite'), 'logs');
      await writeFile(join(destinationCodexHome, 'goals_1.sqlite-wal'), 'goals');
      await writeFile(join(destinationCodexHome, 'not-state.txt'), 'ignore');

      const entries = await resolveCodexStateEntryNames({
        sourceSqliteHome,
        destinationCodexHome,
        stateMode: 'shared',
      });

      expect(entries).toEqual(expect.arrayContaining([
        'sessions',
        'history.jsonl',
        'state_5.sqlite',
        'logs_2.sqlite',
        'goals_1.sqlite-wal',
      ]));
      expect(entries).not.toContain('not-state.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps source dynamic state out of isolated mode entry lists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-state-entries-isolated-'));
    try {
      const sourceSqliteHome = join(root, 'source-sqlite');
      const destinationCodexHome = join(root, 'destination-codex-home');
      await mkdir(sourceSqliteHome, { recursive: true });
      await mkdir(destinationCodexHome, { recursive: true });
      await writeFile(join(sourceSqliteHome, 'state_5.sqlite'), 'state');
      await writeFile(join(destinationCodexHome, 'goals_1.sqlite'), 'goals');

      const entries = await resolveCodexStateEntryNames({
        sourceSqliteHome,
        destinationCodexHome,
        stateMode: 'isolated',
      });

      expect(entries).toContain('goals_1.sqlite');
      expect(entries).not.toContain('state_5.sqlite');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the Codex SQLite state source-root classifier', () => {
    const pattern = resolveCodexSqliteStateEntryPattern();

    expect(pattern?.test('state_5.sqlite')).toBe(true);
    expect(pattern?.test('logs_2.sqlite')).toBe(true);
    expect(pattern?.test('notes.txt')).toBe(false);
  });
});
