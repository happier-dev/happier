import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { maybeRefreshLocalBundledWorkspacePackages } from '../../bin/_prepareRuntimeEntrypoint.mjs';
import { WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, withWorkspaceBundleLock } from '../../../../scripts/workspaces/workspaceBundleLock.mjs';

const workspaceBundleLockModulePath = fileURLToPath(
  new URL('../../../../scripts/workspaces/workspaceBundleLock.mjs', import.meta.url),
);
describe('maybeRefreshLocalBundledWorkspacePackages', () => {

  it('syncs under the lock when the only snapshot has an incomplete import closure', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-torn-snapshot-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const distEntrypoint = resolve(projectRoot, 'dist', 'index.mjs');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

      mkdirSync(resolve(projectRoot, 'dist'), { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      // Dangling relative import: the closure is incomplete (torn snapshot).
      writeFileSync(distEntrypoint, "export * from './missing.mjs';\n", 'utf8');
      writeFileSync(
        resolve(syncModuleDir, 'syncBundledWorkspacePackages.mjs'),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          `const syncCalledPath = ${JSON.stringify(syncCalledPath)};`,
          'export function syncBundledWorkspacePackages() {',
          '  mkdirSync(dirname(syncCalledPath), { recursive: true });',
          "  writeFileSync(syncCalledPath, 'called', 'utf8');",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      await maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
        lockModulePath: workspaceBundleLockModulePath,
        lockPath,
        lockTimeoutMs: 50,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
      });
      expect(existsSync(syncCalledPath)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('preserves a live shared-dependency writer and refreshes after it releases the lock', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-lock-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');
      const waitingPath = resolve(repoRoot, '.project', 'tmp', 'waiting');
      const observedLockModulePath = resolve(syncModuleDir, 'observedWorkspaceBundleLock.mjs');

      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      mkdirSync(resolve(repoRoot, '.project', 'tmp'), { recursive: true });
      // Observe the real lock's admission event at a filesystem boundary.
      writeFileSync(observedLockModulePath, [
        `import { withWorkspaceBundleLock as withLock } from ${JSON.stringify(pathToFileURL(workspaceBundleLockModulePath).href)};`,
        "import { writeFileSync } from 'node:fs';",
        'export function withWorkspaceBundleLock(fn, options) {',
        `  return withLock(fn, { ...options, onWait() { writeFileSync(${JSON.stringify(waitingPath)}, 'waiting'); } });`,
        '}',
      ].join('\n'), 'utf8');
      writeFileSync(
        resolve(syncModuleDir, 'syncBundledWorkspacePackages.mjs'),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          `const syncCalledPath = ${JSON.stringify(syncCalledPath)};`,
          'export function syncBundledWorkspacePackages() {',
          '  mkdirSync(dirname(syncCalledPath), { recursive: true });',
          "  writeFileSync(syncCalledPath, 'called', 'utf8');",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      let refresh: Promise<void> | undefined;
      let waitWatcher: ReturnType<typeof watch> | undefined;
      await withWorkspaceBundleLock(
        async () => {
          if (process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0') {
            await expect(maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
              lockModulePath: observedLockModulePath, lockPath,
            })).rejects.toMatchObject({ code: WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE });
            expect(existsSync(syncCalledPath)).toBe(false);
            return;
          }
          const waiting = new Promise<void>((resolveWaiting) => {
            waitWatcher = watch(resolve(repoRoot, '.project', 'tmp'), () => {
              if (existsSync(waitingPath)) resolveWaiting();
            });
          });
          try {
            refresh = maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
              lockModulePath: observedLockModulePath,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            });
            await waiting;
            expect(existsSync(syncCalledPath)).toBe(false);
          } finally {
            waitWatcher?.close();
          }
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
      if (refresh) await refresh;
      else await maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
        lockModulePath: observedLockModulePath, lockPath,
      });
      expect(existsSync(syncCalledPath)).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
