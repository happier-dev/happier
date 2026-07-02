import { describe, expect, it } from 'vitest';

import {
  isCodexShareableSqliteStateEntry,
  isCodexSharedStateSqliteFileName,
  resolveCodexConfiguredSqliteHome,
} from './files.js';

describe('Codex state sharing files', () => {
  it('classifies only Codex state and goals SQLite files as shareable SQLite state', () => {
    expect(isCodexShareableSqliteStateEntry('state_5.sqlite')).toBe(true);
    expect(isCodexShareableSqliteStateEntry('state_5.sqlite-wal')).toBe(true);
    expect(isCodexShareableSqliteStateEntry('state_5.sqlite-shm')).toBe(true);
    expect(isCodexShareableSqliteStateEntry('goals_1.sqlite')).toBe(true);
    expect(isCodexShareableSqliteStateEntry('goals_1.sqlite-wal')).toBe(true);
    expect(isCodexShareableSqliteStateEntry('logs_2.sqlite')).toBe(false);
    expect(isCodexSharedStateSqliteFileName('logs_2.sqlite')).toBe(false);
    expect(isCodexSharedStateSqliteFileName('state_5.sqlite-journal')).toBe(false);
  });

  it('resolves configured SQLite state homes without owning generic env expansion', () => {
    const expandHomePath = (raw: string) => raw.replace(/^~(?=\/|$)/, '/Users/alice');
    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '/tmp/codex-sqlite-home',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/tmp/codex-sqlite-home');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '   ',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/tmp/codex-home');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: '~/.codex-state',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/Users/alice/.codex-state');

    expect(resolveCodexConfiguredSqliteHome({
      codexSqliteHome: 'relative-sqlite',
      fallbackCodexHome: '/tmp/codex-home',
      cwd: '/work/repo',
      expandHomePath,
    })).toBe('/work/repo/relative-sqlite');
  });
});
