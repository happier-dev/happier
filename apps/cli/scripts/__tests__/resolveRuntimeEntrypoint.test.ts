import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRuntimeEntrypoint } from '../../bin/_resolveRuntimeEntrypoint.mjs';
import { maybeRefreshLocalBundledWorkspacePackages } from '../../bin/_prepareRuntimeEntrypoint.mjs';

const syncBundledWorkspacePackagesSourcePath =
  '/Users/leeroy/Documents/Development/happier/dev/scripts/workspaces/syncBundledWorkspacePackages.mjs';

describe('resolveRuntimeEntrypoint', () => {
  it('prefers dist output over stale package-dist output in a worktree', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'happier-resolve-runtime-entrypoint-'));

    try {
      mkdirSync(join(projectRoot, 'dist', 'bin'), { recursive: true });
      mkdirSync(join(projectRoot, 'package-dist', 'bin'), { recursive: true });
      writeFileSync(join(projectRoot, 'dist', 'bin', 'entry.js'), 'dist', 'utf8');
      writeFileSync(join(projectRoot, 'package-dist', 'bin', 'entry.js'), 'package-dist', 'utf8');

      expect(resolveRuntimeEntrypoint(projectRoot, 'bin/entry.js')).toBe(join(projectRoot, 'dist', 'bin', 'entry.js'));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('refreshes local bundled workspace packages for connection-supervisor into the CLI host only', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-prepare-runtime-entrypoint-'));
    const projectRoot = join(repoRoot, 'apps', 'cli');
    const syncModulePath = join(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs');
    const connectionSupervisorDir = join(repoRoot, 'packages', 'connection-supervisor');

    try {
      mkdirSync(join(connectionSupervisorDir, 'dist'), { recursive: true });
      mkdirSync(join(syncModulePath, '..'), { recursive: true });
      mkdirSync(projectRoot, { recursive: true });

      writeFileSync(
        syncModulePath,
        readFileSync(syncBundledWorkspacePackagesSourcePath, 'utf8'),
        'utf8',
      );
      writeFileSync(
        join(connectionSupervisorDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/connection-supervisor',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          exports: { '.': { default: './dist/index.js' } },
        }),
        'utf8',
      );
      writeFileSync(join(connectionSupervisorDir, 'dist', 'index.js'), 'export const ready = true;\n', 'utf8');

      await maybeRefreshLocalBundledWorkspacePackages(projectRoot);

      expect(
        existsSync(join(projectRoot, 'node_modules', '@happier-dev', 'connection-supervisor', 'package.json')),
      ).toBe(true);
      expect(
        existsSync(join(repoRoot, 'apps', 'stack', 'node_modules', '@happier-dev', 'connection-supervisor', 'package.json')),
      ).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
