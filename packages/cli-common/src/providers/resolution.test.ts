import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBackendCliSourcePreference, resolveProviderCliManagedCommandPath } from './resolution';

describe('readBackendCliSourcePreference', () => {
  it('prefers target-keyed preferences from the env map', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        'agent:codex': 'managed-first',
        codex: 'system-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });

  it('falls back to legacy id-keyed preferences when target-keyed entries are absent', () => {
    expect(readBackendCliSourcePreference('codex', {
      HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON: JSON.stringify({
        codex: 'managed-first',
      }),
    } as NodeJS.ProcessEnv)).toBe('managed-first');
  });
});

describe('resolveProviderCliManagedCommandPath', () => {
  it('prefers a complete active managed release over the retained legacy current install on POSIX', () => {
    if (process.platform === 'win32') return;

    const root = mkdtempSync(join(tmpdir(), 'happier-provider-active-release-'));
    const happyHomeDir = join(root, 'home');
    const installRoot = join(happyHomeDir, 'tools', 'providers', 'codex');
    const activeReleaseDir = join(installRoot, '.releases', 'release-one');
    const activeCommandPath = join(activeReleaseDir, 'bin', 'codex');
    const legacyCommandPath = join(installRoot, 'current', 'bin', 'codex');
    try {
      mkdirSync(join(activeReleaseDir, 'bin'), { recursive: true });
      writeFileSync(activeCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(activeCommandPath, 0o755);
      mkdirSync(join(installRoot, 'current', 'bin'), { recursive: true });
      writeFileSync(legacyCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(legacyCommandPath, 0o755);
      symlinkSync(join('.releases', 'release-one'), join(installRoot, 'active'));

      expect(resolveProviderCliManagedCommandPath('codex', { happyHomeDir })).toBe(
        join(installRoot, 'active', 'bin', 'codex'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
