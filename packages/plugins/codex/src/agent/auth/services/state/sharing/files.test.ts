import { describe, expect, it } from 'vitest';

import {
  resolveCodexConfiguredSqliteHome,
} from './files.js';

describe('Codex state sharing files', () => {
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
