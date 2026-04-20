import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename as renameFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('resolves TypeScript package builds through the JavaScript CLI entrypoint instead of a shell wrapper', () => {
    expect(buildScript).toMatchObject({
      resolveTypeScriptBuildInvocation: expect.any(Function),
    });

    const invocation = buildScript.resolveTypeScriptBuildInvocation({
      repoRoot: '/repo',
      packageDir: '/repo/packages/cli-common',
      processExecPath: '/node',
      requireResolve: (request) => {
        if (request === 'typescript/lib/tsc.js') {
          return '/repo/node_modules/typescript/lib/tsc.js';
        }
        throw new Error(`Unexpected request: ${request}`);
      },
      existsSync: () => false,
      platform: 'linux',
      tsconfigPath: 'tsconfig.json',
      outDir: '/repo/packages/cli-common/.dist-stage/dist',
    });

    expect(invocation).toEqual({
      command: '/node',
      args: [
        '/repo/node_modules/typescript/lib/tsc.js',
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
      pid: 1234,
      now: 1700000000000,
    });

    expect(buildPlan).toEqual({
      packageDir: '/tmp/happier/packages/cli-common',
      distDir: '/tmp/happier/packages/cli-common/dist',
      backupDir: '/tmp/happier/packages/cli-common/.dist.hstack-backup.1234.1700000000000',
      stageRootPrefix: '/tmp/happier/packages/cli-common/.dist.hstack-stage-',
    });
    expect(Object.isFrozen(buildPlan)).toBe(true);
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
