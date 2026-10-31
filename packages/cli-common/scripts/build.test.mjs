import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename as renameFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import * as buildScript from './build.mjs';
import { installNativeAdmissionFixture } from '../../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { writeFakeBin } from '../../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';
import { withPatchedProcessEnv } from '../../../apps/stack/scripts/testkit/core/env_scope.mjs';
const { buildPackageDistAtomically } = buildScript;

describe('cli-common atomic build contract', () => {
  it('emits source-runtime code but checks public package publication before replacing last-green output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-runtime-mode-'));
    try {
      const repoDir = process.platform === 'linux' ? join(root, 'native-owner') : root;
      const packageDir = join(repoDir, 'packages', 'cli-common');
      const env = { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev', npm_lifecycle_event: 'build' };
      let build = buildPackageDistAtomically;
      let fixtureAwkPath;
      if (process.platform === 'linux') {
        // Isolate only host capacity/OS observation. The finite build, lock owner,
        // compiler resolver and real compiler still run their production logic.
        await installNativeAdmissionFixture({ root });
        const sourceRoot = resolve(import.meta.dirname, '../../..');
        for (const path of [
          'packages/cli-common/scripts/build.mjs',
          'packages/cli-common/scripts/packageDistBuildPlan.mjs',
          'packages/cli-common/scripts/packageDistBuildPhases.mjs',
          'packages/cli-common/scripts/verifyExports.mjs',
          'packages/cli-common/workspaceChildBuildEnv.mjs',
          'scripts/workspaces/copyDirectoryContents.mjs',
          'scripts/workspaces/resolveTypeScriptCliInvocation.mjs',
        ]) {
          mkdirSync(dirname(join(repoDir, path)), { recursive: true });
          cpSync(join(sourceRoot, path), join(repoDir, path));
        }
        for (const path of ['workspaceBundleLock.mjs', 'workspacePackageBuildLock.mjs']) {
          writeFileSync(join(repoDir, 'scripts/workspaces', path),
            `export * from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'scripts/workspaces', path)).href)};\n`);
        }
        const { binDir } = writeFakeBin({ root, name: 'awk', content: '#!/bin/sh\ncase "$*" in\n  */proc/meminfo*) printf "52428800 73400320\\n" ;;\n  *) exec /usr/bin/awk "$@" ;;\nesac\n' });
        fixtureAwkPath = join(binDir, 'awk');
        writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
        Object.assign(env, { PATH: `${binDir}:${env.PATH}`, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
          HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: '', HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES: '' });
        ({ buildPackageDistAtomically: build } = await import(pathToFileURL(join(repoDir, 'packages/cli-common/scripts/build.mjs')).href));
      }
      mkdirSync(join(packageDir, 'src'), { recursive: true });
      symlinkSync(resolve(import.meta.dirname, '../../../node_modules'), join(repoDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const packageJson = { name: '@fixture/cli-common', type: 'module', exports: { '.': './dist/index.js' } };
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson));
      writeFileSync(join(packageDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', strict: true, noEmitOnError: true },
        include: ['src/**/*.ts'],
      }));
      writeFileSync(join(packageDir, 'src/index.ts'), 'export const value: string = 42;\n');
      await build({ packageDir, packageJson, env });
      const prior = readFileSync(join(packageDir, 'dist/index.js'), 'utf8');
      expect(prior).toContain('42');
      await expect(build({ packageDir, packageJson, env: { ...env, npm_lifecycle_event: 'prepack' } }))
        .rejects.toThrow(/failed with code/);
      expect(readFileSync(join(packageDir, 'dist/index.js'), 'utf8')).toBe(prior);
      if (fixtureAwkPath) {
        // Ordinary local CI already owns capacity. Its default package command
        // must still hold the joint publication lease without joining the host queue.
        writeFileSync(fixtureAwkPath, '#!/bin/sh\ncase "$*" in\n  */proc/meminfo*) printf "1 73400320\\n" ;;\n  *) exec /usr/bin/awk "$@" ;;\nesac\n');
        await build({ packageDir, packageJson, env: {
          ...env, CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
          HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '', HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '',
          HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
        } });
        expect(readFileSync(join(packageDir, 'dist/index.js'), 'utf8')).toBe(prior);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      env: {},
      platform: 'linux',
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
      command: fileURLToPath(new URL('../../../apps/stack/bin/hstack-exec', import.meta.url)),
      args: [
        '--heavyweight-admission',
        '--class=package-dist',
        '--machine=local',
        '--exec-admitted',
        '--',
        '/node',
        '/repo/node_modules/@typescript/native/bin/tsc',
        '-p',
        'tsconfig.json',
        '--outDir',
        '/repo/packages/cli-common/.dist-stage/dist',
        '--noCheck',
        'false',
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

  it('waits for the workspace dist build lock before staging a package build', async ({ onTestFinished }) => {
    // This injected-compiler fixture owns an independent temporary lock;
    // the routed payload's restriction applies to real publication leases.
    onTestFinished(withPatchedProcessEnv(undefined, { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED: undefined }));
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

  it('does not reacquire the package lock when an outer workspace publisher supplies staged output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-outer-stage-lock-'));
    try {
      const packageDir = join(root, 'packages', 'cli-common');
      const distDir = join(packageDir, 'dist');
      const outputDir = join(root, 'workspace-staged-dist');
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
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
      writeFileSync(join(distDir, 'index.js'), 'export const version = "old";\n', 'utf8');
      writeFileSync(join(distDir, 'index.d.ts'), 'export declare const version: string;\n', 'utf8');
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
        'utf8',
      );

      await buildPackageDistAtomically({
        packageDir,
        packageJson,
        env: {
          ...process.env,
          HAPPIER_WORKSPACE_DIST_OUTPUT_DIR: outputDir,
          HAPPIER_PACKAGE_DIST_BUILD_LOCK_TIMEOUT_MS: '20',
          HAPPIER_PACKAGE_DIST_BUILD_LOCK_POLL_MS: '5',
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
          expect(dirname(dirname(stagingDistDir))).toBe(packageDir);
          expect(statSync(stagingDistDir).dev).toBe(statSync(distDir).dev);
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
