import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';

import { createTempDirSync } from '../../src/testkit/fs/tempDir';

function writeSnapshot(
  outputDir: string,
  source: string,
  builtAt: string,
) {
  mkdirSync(outputDir, { recursive: true });
  const entrypoint = join(outputDir, 'index.mjs');
  writeFileSync(entrypoint, source, 'utf8');
  cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, { outputDir, builtAt });
}

function writeLocalRepoFixture(repoRoot: string) {
  const projectRoot = resolve(repoRoot, 'apps', 'cli');
  mkdirSync(resolve(repoRoot, 'scripts', 'workspaces'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'scripts', 'workspaces', 'syncBundledWorkspacePackages.mjs'),
    'export function syncBundledWorkspacePackages() {}\n',
    'utf8',
  );
  return projectRoot;
}

describe('importPreparedRuntimeEntrypoint', () => {
  it('does not retry an external dependency failure while the selected snapshot is unchanged', async () => {
    const repoRoot = createTempDirSync('happier-cli-import-entrypoint-unchanged-');
    try {
      const projectRoot = writeLocalRepoFixture(repoRoot);
      writeSnapshot(
        resolve(projectRoot, 'dist'),
        'export const ready = true;\n',
        '2026-07-09T00:00:00.000Z',
      );
      const launcher = await import('../../bin/_importRuntimeEntrypoint.mjs');
      const dependencyError = Object.assign(new Error('missing external dependency'), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
      let attempts = 0;

      await expect(launcher.importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs', {
        importModule: async () => {
          attempts += 1;
          throw dependencyError;
        },
        retryDelayMs: 1,
        retryPollAttempts: 2,
      })).rejects.toBe(dependencyError);
      expect(attempts).toBe(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('re-resolves after an atomic snapshot swap, including identical-content generations', async () => {
    const repoRoot = createTempDirSync('happier-cli-import-entrypoint-swap-');
    try {
      const projectRoot = writeLocalRepoFixture(repoRoot);
      const distDir = resolve(projectRoot, 'dist');
      const stagingDir = resolve(projectRoot, 'dist.staging.writer');
      const backupDir = resolve(projectRoot, 'dist.backup.writer');
      const identicalSource = 'export const generation = "same-content";\n';
      writeSnapshot(distDir, identicalSource, '2026-07-09T00:00:00.000Z');
      writeSnapshot(stagingDir, identicalSource, '2026-07-09T00:00:01.000Z');
      const launcher = await import('../../bin/_importRuntimeEntrypoint.mjs');
      const swapError = Object.assign(new Error('entrypoint disappeared during swap'), {
        code: 'ERR_MODULE_NOT_FOUND',
        url: pathToFileURL(join(distDir, 'index.mjs')).href,
      });
      let attempts = 0;

      const runtimeModule = await launcher.importPreparedRuntimeEntrypoint(projectRoot, 'index.mjs', {
        importModule: async () => {
          attempts += 1;
          if (attempts === 1) {
            renameSync(distDir, backupDir);
            renameSync(stagingDir, distDir);
            throw swapError;
          }
          return { generation: 'new' };
        },
        retryDelayMs: 1,
        retryPollAttempts: 2,
      });

      expect(runtimeModule.generation).toBe('new');
      expect(attempts).toBe(2);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
