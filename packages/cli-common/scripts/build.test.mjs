import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename as renameFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import * as buildScript from './build.mjs';
const { buildPackageDistAtomically } = buildScript;

describe('cli-common atomic build contract', () => {
  it('keeps the build script helper-only without exporting a main entrypoint', () => {
    expect(buildScript).toMatchObject({
      buildPackageDistAtomically: expect.any(Function),
      cleanPackageDistSync: expect.any(Function),
    });
    expect(buildScript).not.toHaveProperty('main');
  });

  it('resolves the build script mode from argv without coupling dispatch to the runner', () => {
    expect(buildScript.resolveBuildScriptMode(['--clean'])).toBe('clean');
    expect(buildScript.resolveBuildScriptMode(['--clean', '--verbose'])).toBe('clean');
    expect(buildScript.resolveBuildScriptMode(['--verbose'])).toBe('build');
    expect(buildScript.resolveBuildScriptMode([])).toBe('build');
  });

  it('resolves TypeScript package builds through the native CLI entrypoint instead of a shell wrapper', () => {
    expect(buildScript).toMatchObject({
      resolveTypeScriptBuildInvocation: expect.any(Function),
    });

    const invocation = buildScript.resolveTypeScriptBuildInvocation({
      repoRoot: '/repo',
      packageDir: '/repo/packages/cli-common',
      processExecPath: '/node',
      requireResolve: (request) => {
        if (request === '@typescript/native/package.json') {
          return '/repo/node_modules/@typescript/native/package.json';
        }
        throw new Error(`Unexpected request: ${request}`);
      },
      readFileSyncImpl: () => JSON.stringify({ bin: { tsc: './bin/tsc' } }),
      tsconfigPath: 'tsconfig.json',
      outDir: '/repo/packages/cli-common/.dist-stage/dist',
    });

    expect(invocation).toEqual({
      command: '/node',
      args: [
        '/repo/node_modules/@typescript/native/bin/tsc',
        '-p',
        'tsconfig.json',
        '--outDir',
        '/repo/packages/cli-common/.dist-stage/dist',
      ],
    });
  });

  it('builds an immutable atomic dist plan from the package directory', () => {
    expect(buildScript).toMatchObject({
      createPackageDistBuildPlan: expect.any(Function),
    });

    const buildPlan = buildScript.createPackageDistBuildPlan({
      packageDir: '/tmp/happier/packages/cli-common',
      packageName: '@happier-dev/cli-common',
      pid: 1234,
      now: 1700000000000,
    });

    expect(buildPlan).toEqual({
      packageDir: '/tmp/happier/packages/cli-common',
      distDir: '/tmp/happier/packages/cli-common/dist',
      backupDir: '/tmp/happier/packages/cli-common/.dist.hstack-backup.1234.1700000000000',
      lockPath: '/tmp/happier/.project/tmp/workspace-dist-builds/happier-dev-cli-common.lock',
      stageRootPrefix: '/tmp/happier/packages/cli-common/.dist.hstack-stage-',
    });
    expect(Object.isFrozen(buildPlan)).toBe(true);
  });

  it('waits for the workspace dist build lock before staging a package build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-lock-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      const lockDir = join(root, '.project', 'tmp', 'workspace-dist-builds');
      const lockPath = join(lockDir, 'happier-dev-cli-common.lock');
      const packageJson = {
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            default: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      };

      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
      writeFileSync(join(distDir, 'index.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(distDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');

      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        'utf8',
      );

      let enteredBuild = false;
      const buildPromise = buildPackageDistAtomically({
        packageDir,
        packageJson,
        env: {
          ...process.env,
          HAPPIER_PACKAGE_DIST_BUILD_LOCK_TIMEOUT_MS: '1000',
          HAPPIER_PACKAGE_DIST_BUILD_LOCK_POLL_MS: '10',
        },
        buildIntoDistDir: async ({ stagingDistDir }) => {
          enteredBuild = true;
          mkdirSync(stagingDistDir, { recursive: true });
          writeFileSync(join(stagingDistDir, 'index.js'), 'export const version = "new";\n', 'utf8');
          writeFileSync(join(stagingDistDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');
        },
      });

      await delay(30);
      expect(enteredBuild).toBe(false);

      unlinkSync(lockPath);
      await buildPromise;

      expect(enteredBuild).toBe(true);
      expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('"new"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the previous dist visible while staging a new build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      mkdirSync(join(distDir, 'relayAccess'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@happier-dev/cli-common',
          version: '0.0.0',
          type: 'module',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: {
            '.': {
              default: './dist/index.js',
              types: './dist/index.d.ts',
            },
            './relayAccess/catalog': {
              default: './dist/relayAccess/catalog.js',
              types: './dist/relayAccess/catalog.d.ts',
            },
          },
        }, null, 2),
        'utf8',
      );
      writeFileSync(join(distDir, 'index.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(distDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');
      writeFileSync(join(distDir, 'relayAccess', 'catalog.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(distDir, 'relayAccess', 'catalog.d.ts'), 'export declare const version: string;\n', 'utf8');

      let sawOldDistDuringBuild = false;
      await buildPackageDistAtomically({
        packageDir,
        buildIntoDistDir: async ({ stagingDistDir }) => {
          sawOldDistDuringBuild = existsSync(join(distDir, 'relayAccess', 'catalog.js'));
          mkdirSync(join(stagingDistDir, 'relayAccess'), { recursive: true });
          writeFileSync(join(stagingDistDir, 'index.js'), 'export const version = "new";\n', 'utf8');
          writeFileSync(join(stagingDistDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');
          writeFileSync(join(stagingDistDir, 'relayAccess', 'catalog.js'), 'export const version = "new";\n', 'utf8');
          writeFileSync(join(stagingDistDir, 'relayAccess', 'catalog.d.ts'), 'export declare const version: string;\n', 'utf8');
        },
      });

      expect(sawOldDistDuringBuild).toBe(true);
      expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('"new"');
      expect(readFileSync(join(distDir, 'relayAccess', 'catalog.js'), 'utf8')).toContain('"new"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes into the workspace staged-output directory without mutating live dist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-outer-stage-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      const outputDir = join(root, 'workspace-staged-dist');
      const packageJson = {
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            default: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
      };

      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
      writeFileSync(join(distDir, 'index.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(distDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');

      await buildPackageDistAtomically({
        packageDir,
        packageJson,
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputDir,
        },
        buildIntoDistDir: async ({ stagingDistDir }) => {
          mkdirSync(stagingDistDir, { recursive: true });
          writeFileSync(join(stagingDistDir, 'index.js'), 'export const version = "new";\n', 'utf8');
          writeFileSync(join(stagingDistDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');
        },
      });

      expect(readFileSync(join(outputDir, 'index.js'), 'utf8')).toContain('"new"');
      expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('"old"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stages package-root export assets before verifying package exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-root-export-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      const packageJson = {
        name: '@happier-dev/cli-common',
        version: '0.0.0',
        type: 'module',
        main: './dist/index.js',
        exports: {
          '.': {
            default: './dist/index.js',
          },
          './jsonOwnerBuildLockState': {
            default: './jsonOwnerBuildLockState.cjs',
          },
        },
      };
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
      writeFileSync(join(packageDir, 'jsonOwnerBuildLockState.cjs'), 'module.exports = {};\n', 'utf8');

      await buildPackageDistAtomically({
        packageDir,
        packageJson,
        buildIntoDistDir: async ({ stagingDistDir }) => {
          mkdirSync(stagingDistDir, { recursive: true });
          writeFileSync(join(stagingDistDir, 'index.js'), 'export const version = "new";\n', 'utf8');
        },
      });

      expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('"new"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits atomic build orchestration into stage, verify, swap, and rollback cleanup phases', () => {
    expect(buildScript).toMatchObject({
      stagePackageDistBuild: expect.any(Function),
      verifyStagedPackageDistExports: expect.any(Function),
      swapStagedPackageDistIntoPlace: expect.any(Function),
      restorePackageDistFromBackup: expect.any(Function),
      cleanupPackageDistBuildArtifacts: expect.any(Function),
    });
  });

  it('restores the previous dist after a swap failure and removes staging artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-build-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      const stageRoot = join(packageDir, '.dist.hstack-stage-test');
      const stageDistDir = join(stageRoot, 'dist');
      const buildPlan = buildScript.createPackageDistBuildPlan({
        packageDir,
        pid: 'test',
        now: 'test',
      });
      const backupDir = buildPlan.backupDir;

      mkdirSync(distDir, { recursive: true });
      mkdirSync(stageDistDir, { recursive: true });
      writeFileSync(join(distDir, 'index.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(stageDistDir, 'index.js'), 'export const version = "new";\n', 'utf8');

      const renameImpl = vi.fn(async (from, to) => {
        if (from === stageDistDir && to === distDir) {
          throw new Error('swap failed');
        }

        await renameFile(from, to);
      });

      await expect(
        buildScript.swapStagedPackageDistIntoPlace({
          buildPlan,
          stageDistDir,
          renameImpl,
        }),
      ).rejects.toThrow('swap failed');

      expect(existsSync(distDir)).toBe(false);
      expect(existsSync(backupDir)).toBe(true);

      await buildScript.restorePackageDistFromBackup({
        buildPlan,
        distMovedToBackup: true,
        renameImpl,
      });
      await buildScript.cleanupPackageDistBuildArtifacts({
        buildPlan,
        stageRoot,
      });

      expect(readFileSync(join(distDir, 'index.js'), 'utf8')).toContain('"old"');
      expect(existsSync(stageRoot)).toBe(false);
      expect(existsSync(backupDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
