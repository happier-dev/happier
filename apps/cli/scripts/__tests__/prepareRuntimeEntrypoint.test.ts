import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';
import { maybeRefreshLocalBundledWorkspacePackages, prepareRuntimeEntrypoint } from '../../bin/_prepareRuntimeEntrypoint.mjs';
import { withWorkspaceBundleLock } from '../../../../scripts/workspaces/workspaceBundleLock.mjs';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

const workspaceBundleLockModulePath = fileURLToPath(
  new URL('../../../../scripts/workspaces/workspaceBundleLock.mjs', import.meta.url),
);
const cliDistBuildManifestModuleUrl = pathToFileURL(fileURLToPath(
  new URL('../../../../packages/cli-common/cliDistBuildManifest.cjs', import.meta.url),
)).href;

function writeBuildManifest(outputDir: string) {
  cliDistBuildManifest.writeCliDistBuildManifest(resolve(outputDir, 'index.mjs'), {
    outputDir,
    builtAt: '2026-07-09T00:00:00.000Z',
  });
}

describe('maybeRefreshLocalBundledWorkspacePackages', () => {
  it('builds a complete local runtime snapshot under the writer lock when none is committed', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-cold-build-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const scriptsDir = resolve(projectRoot, 'scripts');
      const workspacesDir = resolve(repoRoot, 'scripts', 'workspaces');
      const eventsPath = resolve(repoRoot, '.project', 'tmp', 'build-events');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const distDir = resolve(projectRoot, 'dist');

      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(workspacesDir, { recursive: true });
      writeFileSync(resolve(repoRoot, 'package.json'), '{ "private": true }\n', 'utf8');
      writeFileSync(resolve(repoRoot, 'yarn.lock'), '# yarn\n', 'utf8');
      writeFileSync(resolve(workspacesDir, 'syncBundledWorkspacePackages.mjs'), 'export function syncBundledWorkspacePackages() {}\n', 'utf8');
      writeFileSync(
        resolve(scriptsDir, 'buildSharedDeps.mjs'),
        [
          "import { appendFileSync, existsSync, mkdirSync } from 'node:fs';",
          "import { dirname } from 'node:path';",
          `const eventsPath = ${JSON.stringify(eventsPath)};`,
          `const lockPath = ${JSON.stringify(lockPath)};`,
          'export async function main() {',
          '  mkdirSync(dirname(eventsPath), { recursive: true });',
          "  appendFileSync(eventsPath, `shared:${existsSync(lockPath)}\\n`, 'utf8');",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        resolve(scriptsDir, 'build.mjs'),
        [
          "import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
          "import { dirname, join } from 'node:path';",
          `import cliDistBuildManifest from ${JSON.stringify(cliDistBuildManifestModuleUrl)};`,
          `const eventsPath = ${JSON.stringify(eventsPath)};`,
          `const lockPath = ${JSON.stringify(lockPath)};`,
          `const distDir = ${JSON.stringify(distDir)};`,
          'export async function buildCliDist(options = {}) {',
          '  mkdirSync(dirname(eventsPath), { recursive: true });',
          "  const owner = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;",
          "  const lease = options.heldLockValue ? JSON.parse(options.heldLockValue) : null;",
          "  const exactLease = owner?.token && lease?.token === owner.token && lease?.v === 1;",
          "  appendFileSync(eventsPath, `build:${existsSync(lockPath)}:${exactLease}\\n`, 'utf8');",
          '  mkdirSync(distDir, { recursive: true });',
          "  writeFileSync(join(distDir, 'index.mjs'), 'export const ready = true;\\n', 'utf8');",
          "  cliDistBuildManifest.writeCliDistBuildManifest(join(distDir, 'index.mjs'), { outputDir: distDir, builtAt: '2026-07-09T00:00:00.000Z' });",
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      await expect(prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
        lockModulePath: workspaceBundleLockModulePath,
        lockPath,
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
      })).resolves.toBe(resolve(realpathSync.native(projectRoot), 'dist', 'index.mjs'));
      expect(readFileSync(eventsPath, 'utf8')).toBe('shared:true\nbuild:true:true\n');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses an existing packaged source snapshot instead of waiting on the shared CLI build lock', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-snapshot-lock-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const packageDistEntrypoint = resolve(projectRoot, 'package-dist', 'index.mjs');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

      mkdirSync(resolve(projectRoot, 'package-dist'), { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      writeFileSync(packageDistEntrypoint, 'export {};\n', 'utf8');
      writeBuildManifest(resolve(projectRoot, 'package-dist'));
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

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
              lockModulePath: workspaceBundleLockModulePath,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).resolves.toBe(resolve(realpathSync.native(projectRoot), 'package-dist', 'index.mjs'));
          expect(existsSync(syncCalledPath)).toBe(false);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses an existing dist snapshot instead of waiting on the shared CLI build lock', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-dist-lock-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const distEntrypoint = resolve(projectRoot, 'dist', 'index.mjs');
      const packageDistEntrypoint = resolve(projectRoot, 'package-dist', 'index.mjs');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

      mkdirSync(resolve(projectRoot, 'dist'), { recursive: true });
      mkdirSync(resolve(projectRoot, 'package-dist'), { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      writeFileSync(distEntrypoint, 'export const source = "dist";\n', 'utf8');
      writeFileSync(packageDistEntrypoint, 'export const source = "package-dist";\n', 'utf8');
      writeBuildManifest(resolve(projectRoot, 'dist'));
      writeBuildManifest(resolve(projectRoot, 'package-dist'));
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

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
              lockModulePath: workspaceBundleLockModulePath,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).resolves.toBe(resolve(realpathSync.native(projectRoot), 'dist', 'index.mjs'));
          expect(existsSync(syncCalledPath)).toBe(false);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('launches a valid compiled snapshot without syncing or touching the build lock', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-valid-snapshot-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const packageDistEntrypoint = resolve(projectRoot, 'package-dist', 'index.mjs');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

      mkdirSync(resolve(projectRoot, 'package-dist'), { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
      writeFileSync(packageDistEntrypoint, 'export {};\n', 'utf8');
      writeBuildManifest(resolve(projectRoot, 'package-dist'));
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

      // No writer lock is held. A complete snapshot must still launch lock-free,
      // without running bundled-workspace sync.
      await expect(
        prepareRuntimeEntrypoint(projectRoot, 'index.mjs', {
          lockModulePath: workspaceBundleLockModulePath,
          lockPath,
          lockTimeoutMs: 50,
          lockPollIntervalMs: 10,
          lockStaleAfterMs: 1_000,
        }),
      ).resolves.toBe(resolve(realpathSync.native(projectRoot), 'package-dist', 'index.mjs'));
      expect(existsSync(syncCalledPath)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

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

  it('waits for the shared CLI build lock before source-mode bundled workspace prep', async () => {
    const repoRoot = createTempDirSync('happier-cli-prepare-entrypoint-lock-');
    try {
      const projectRoot = resolve(repoRoot, 'apps', 'cli');
      const syncModuleDir = resolve(repoRoot, 'scripts', 'workspaces');
      const syncCalledPath = resolve(repoRoot, '.project', 'tmp', 'sync-called');
      const lockPath = resolve(repoRoot, '.project', 'tmp', 'cli-shared-deps-build.lock');

      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(syncModuleDir, { recursive: true });
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

      await withWorkspaceBundleLock(
        async () => {
          await expect(
            maybeRefreshLocalBundledWorkspacePackages(projectRoot, {
              lockModulePath: workspaceBundleLockModulePath,
              lockPath,
              lockTimeoutMs: 50,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            }),
          ).rejects.toThrow(/Timed out waiting for workspace bundle lock/);
          expect(existsSync(syncCalledPath)).toBe(false);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
