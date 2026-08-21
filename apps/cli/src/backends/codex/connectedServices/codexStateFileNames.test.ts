import { describe, expect, it } from 'vitest';

import {
  resolveConfiguredCodexSqliteHome,
} from './codexStateFileNames';

describe('codexStateFileNames', () => {
  it('resolves CODEX_SQLITE_HOME before falling back to CODEX_HOME', () => {
    expect(resolveConfiguredCodexSqliteHome({
      CODEX_HOME: '/tmp/codex-home',
      CODEX_SQLITE_HOME: '/tmp/codex-sqlite-home',
    })).toBe('/tmp/codex-sqlite-home');
    expect(resolveConfiguredCodexSqliteHome({
      CODEX_HOME: '/tmp/codex-home',
      CODEX_SQLITE_HOME: '   ',
    })).toBe('/tmp/codex-home');
  });

  it('expands home-relative CODEX_SQLITE_HOME before resolving relative paths', () => {
    expect(resolveConfiguredCodexSqliteHome({
      HOME: '/Users/alice',
      CODEX_SQLITE_HOME: '~/.codex-state',
    }, '/work/repo')).toBe('/Users/alice/.codex-state');

    expect(resolveConfiguredCodexSqliteHome({
      HOME: '/Users/alice',
      CODEX_SQLITE_HOME: 'relative-sqlite',
    }, '/work/repo')).toBe('/work/repo/relative-sqlite');
  });
});
