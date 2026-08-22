import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { buildCliDist } from './build.mjs';

function writeBuildPackageManifest(packageRoot: string) {
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/build-fixture',
    version: '0.0.0',
    main: './dist/index.cjs',
  }), 'utf8');
}

describe('buildCliDist', () => {
  it('keeps explicit compiler emission out of the TypeScript source tree', () => {
    const packageRoot = createTempDirSync('happier-cli-compiler-output-contract-');
    try {
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const repoRoot = resolve(cliDir, '..', '..');
      const cliConfigRaw = readFileSync(join(cliDir, 'tsconfig.json'), 'utf8');
      const configuredOutDir = cliConfigRaw.match(/"outDir"\s*:\s*"([^"]+)"/)?.[1];
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          rootDir: 'src',
          outDir: configuredOutDir,
          declaration: true,
          sourceMap: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      }), 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime = "current";\n', 'utf8');

      const compilerRunner = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
      const emitted = spawnSync(
        process.execPath,
        [compilerRunner, '-p', 'tsconfig.json', '--noEmit', 'false'],
        {
          cwd: packageRoot,
          encoding: 'utf8',
        },
      );

      expect(emitted.status, emitted.stderr || emitted.stdout).toBe(0);
      expect(existsSync(join(packageRoot, 'src', 'index.js'))).toBe(false);
      expect(existsSync(join(packageRoot, 'src', 'index.d.ts'))).toBe(false);
      expect(configuredOutDir).toBe('dist/.tsc');
      expect(existsSync(join(packageRoot, 'dist', '.tsc', 'index.js'))).toBe(true);
      expect(existsSync(join(packageRoot, 'dist', '.tsc', 'index.d.ts'))).toBe(true);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('admits test-only type errors while runtime type errors still fail', () => {
    const packageRoot = createTempDirSync('happier-cli-runtime-tsconfig-contract-');
    try {
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const repoRoot = resolve(cliDir, '..', '..');
      const buildConfig = JSON.parse(readFileSync(join(cliDir, 'tsconfig.build.json'), 'utf8')) as {
        include?: string[];
        exclude?: string[];
      };
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts'],
      }), 'utf8');
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), JSON.stringify({
        extends: './tsconfig.json',
        include: buildConfig.include,
        exclude: buildConfig.exclude,
      }), 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = "valid";\n', 'utf8');
      writeFileSync(join(packageRoot, 'src', 'runtime.test.ts'), 'export const testOnly: string = 1;\n', 'utf8');

      const compilerRunner = join(repoRoot, 'scripts', 'workspaces', 'runTypeScriptCli.mjs');
      const testOnlyError = spawnSync(process.execPath, [compilerRunner, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(testOnlyError.status, testOnlyError.stderr || testOnlyError.stdout).toBe(0);

      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = 1;\n', 'utf8');
      const runtimeError = spawnSync(process.execPath, [compilerRunner, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(runtimeError.status).not.toBe(0);
      expect(`${runtimeError.stdout}\n${runtimeError.stderr}`).toContain('index.ts');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('holds the CLI dist build lock across typecheck, bundle, and finalize without publishing package dist', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-lock-section-');
    try {
      writeBuildPackageManifest(packageRoot);
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const eventsPath = join(packageRoot, 'events.txt');
      const typecheckInvocations: unknown[][] = [];
      let wrapperOutputDir = '';

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        lockPath,
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {
          writeFileSync(eventsPath, 'rm\n', { flag: 'a' });
        },
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (...args: unknown[]) => {
          typecheckInvocations.push(args);
          writeFileSync(eventsPath, 'typecheck\n', { flag: 'a' });
        },
        runPkgrollBuildImpl: ({ outputDir }: { outputDir: string }) => {
          wrapperOutputDir = outputDir;
          expect(existsSync(lockPath)).toBe(true);
          writeFileSync(eventsPath, 'bundle\n', { flag: 'a' });
        },
        finalizeDistImpl: () => {
          expect(existsSync(lockPath)).toBe(true);
          writeFileSync(eventsPath, 'finalize\n', { flag: 'a' });
        },
      });

      expect(readFileSync(eventsPath, 'utf8')).toBe('rm\ntypecheck\nbundle\nfinalize\n');
      expect(wrapperOutputDir).toBe(`dist.staging.${process.pid}`);
      expect(typecheckInvocations).toEqual([
        [
          '/canonical/runTypeScriptCli.mjs',
          ['-p', 'tsconfig.build.json', '--noEmit'],
          expect.objectContaining({ cwd: realpathSync.native(packageRoot) }),
        ],
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('finalizes the admitted immutable CLI build when live runtime inputs change during the build', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-input-currentness-');
    try {
      writeBuildPackageManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "admitted";\n', 'utf8');
      const initialFingerprint = 'a'.repeat(64);
      let finalized = false;
      let bundledSource = '';
      let typecheckCwd = '';

      let finalizedInputFingerprint: string | undefined;
      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: {
          HAPPIER_CLI_BUILD_INPUT_FINGERPRINT: initialFingerprint,
        },
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (
          _scriptPath: string,
          _args: string[],
          options: { cwd: string },
        ) => {
          typecheckCwd = options.cwd;
          writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "newer";\n', 'utf8');
        },
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          bundledSource = readFileSync(join(dirname(packageJsonPath), 'src', 'index.ts'), 'utf8');
        },
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: initialFingerprint,
          newestMtimeNs: 1n,
        }),
        finalizeDistImpl: (options: { inputFingerprint?: string }) => {
          finalized = true;
          finalizedInputFingerprint = options.inputFingerprint;
        },
      });

      expect(finalized).toBe(true);
      expect(finalizedInputFingerprint).toBe(initialFingerprint);
      expect(typecheckCwd).not.toBe(packageRoot);
      expect(dirname(typecheckCwd)).toBe(realpathSync.native(packageRoot));
      expect(bundledSource).toContain('"admitted"');
      expect(readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')).toContain('"newer"');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('publishes the post-prebuild generation that the immutable CLI source snapshot actually contains', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-prebuild-fingerprint-');
    try {
      writeBuildPackageManifest(packageRoot);
      const admittedFingerprint = 'a'.repeat(64);
      const postPrebuildFingerprint = 'b'.repeat(64);
      const workspaceRuntimeFingerprint = 'c'.repeat(64);
      const workspaceRuntimePackages = ['@happier-dev/protocol'] as const;
      let finalized = false;
      let finalizedInputFingerprint: string | undefined;
      let finalizedWorkspaceRuntimePackages: readonly string[] | undefined;

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: {
          HAPPIER_CLI_BUILD_INPUT_FINGERPRINT: admittedFingerprint,
        },
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {},
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: postPrebuildFingerprint,
          newestMtimeNs: 2n,
        }),
        readWorkspaceRuntimeIdentityImpl: () => ({
          fingerprint: workspaceRuntimeFingerprint,
          packageCount: workspaceRuntimePackages.length,
          packageNames: workspaceRuntimePackages,
        }),
        finalizeDistImpl: (options: {
          inputFingerprint?: string;
          workspaceRuntimePackages?: readonly string[];
        }) => {
          finalized = true;
          finalizedInputFingerprint = options.inputFingerprint;
          finalizedWorkspaceRuntimePackages = options.workspaceRuntimePackages;
        },
      });

      expect(finalized).toBe(true);
      expect(finalizedInputFingerprint).toBe(postPrebuildFingerprint);
      expect(finalizedWorkspaceRuntimePackages).toEqual(workspaceRuntimePackages);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('refuses to publish when the workspace runtime changes during bundling', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-workspace-runtime-race-');
    try {
      writeBuildPackageManifest(packageRoot);
      let identityReadCount = 0;
      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {},
        readRuntimeInputFreshnessImpl: async () => ({
          fingerprint: 'c'.repeat(64),
          newestMtimeNs: 1n,
        }),
        readWorkspaceRuntimeIdentityImpl: () => ({
          fingerprint: (identityReadCount++ === 0 ? 'a' : 'b').repeat(64),
          packageCount: 1,
        }),
        finalizeDistImpl: () => {
          throw new Error('mixed workspace runtime must not be finalized');
        },
      })).rejects.toThrow(/workspace runtime publication changed during the CLI build/i);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('removes its default private stage and abandoned build generations when bundling fails', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-stage-cleanup-');
    try {
      writeBuildPackageManifest(packageRoot);
      const stagingDir = join(packageRoot, `dist.staging.${process.pid}`);
      const abandonedSourceDir = join(packageRoot, '.tmp.hstack-cli-build-source.abandoned');
      const abandonedStagingDir = join(packageRoot, 'dist.staging.1001');
      mkdirSync(abandonedSourceDir, { recursive: true });
      writeFileSync(join(abandonedSourceDir, 'partial.ts'), 'abandoned\n', 'utf8');
      mkdirSync(abandonedStagingDir, { recursive: true });
      writeFileSync(join(abandonedStagingDir, 'partial.mjs'), 'abandoned\n', 'utf8');

      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: ({ outputDir }: { outputDir: string }) => {
          mkdirSync(join(packageRoot, outputDir), { recursive: true });
          writeFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('bundle failed');
        },
        finalizeDistImpl: () => {
          throw new Error('finalize must not run');
        },
      })).rejects.toThrow('bundle failed');

      expect(existsSync(stagingDir)).toBe(false);
      expect(existsSync(abandonedSourceDir)).toBe(false);
      expect(existsSync(abandonedStagingDir)).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('preserves a caller-owned explicit build output when bundling fails', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-caller-stage-');
    try {
      writeBuildPackageManifest(packageRoot);
      const outputDir = 'caller-output';
      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: { HAPPIER_CLI_BUILD_OUTPUT_DIR: outputDir },
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {
          mkdirSync(join(packageRoot, outputDir), { recursive: true });
          writeFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('bundle failed');
        },
        finalizeDistImpl: () => {},
      })).rejects.toThrow('bundle failed');

      expect(readFileSync(join(packageRoot, outputDir, 'partial.mjs'), 'utf8')).toBe('partial\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects a production typecheck terminated by a signal before bundling', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-typecheck-signal-');
    try {
      writeBuildPackageManifest(packageRoot);
      const killedCompiler = join(packageRoot, 'killed-compiler.mjs');
      writeFileSync(killedCompiler, 'process.kill(process.pid, "SIGTERM");\n', 'utf8');
      let bundleStarted = false;

      await expect(buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: [killedCompiler],
        }),
        runPkgrollBuildImpl: () => {
          bundleStarted = true;
        },
        finalizeDistImpl: () => {},
        syncPackageDistImpl: () => {},
      })).rejects.toThrow(/terminated by signal SIGTERM/);
      expect(bundleStarted).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes a directory alias before lock, cwd, and wrapper decisions', async () => {
    const fixtureRoot = createTempDirSync('happier-cli-build-physical-root-');
    const aliasRoot = createTempDirSync('happier-cli-build-alias-root-');
    const physicalPackageRoot = join(fixtureRoot, 'apps', 'cli');
    const aliasPackageRoot = join(aliasRoot, 'apps', 'cli');
    mkdirSync(join(fixtureRoot, 'apps'), { recursive: true });
    mkdirSync(join(aliasRoot, 'apps'), { recursive: true });
    mkdirSync(physicalPackageRoot, { recursive: true });
    writeBuildPackageManifest(physicalPackageRoot);
    writeFileSync(join(fixtureRoot, 'package.json'), '{"private":true}\n', 'utf8');
    writeFileSync(join(fixtureRoot, 'yarn.lock'), '# fixture\n', 'utf8');
    symlinkSync(
      physicalPackageRoot,
      aliasPackageRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const observed: {
      typecheckCwd?: string;
      packageJsonPath?: string;
      finalizeRoot?: string;
    } = {};
    try {
      await buildCliDist({
        packageRoot: aliasPackageRoot,
        rmDistImpl: async () => {},
        resolveTypeScriptCliInvocationImpl: () => ({
          argsPrefix: ['/canonical/runTypeScriptCli.mjs'],
        }),
        runTypecheckImpl: (_script: string, _args: string[], options: { cwd: string }) => {
          observed.typecheckCwd = options.cwd;
        },
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          observed.packageJsonPath = packageJsonPath;
        },
        finalizeDistImpl: ({ packageRoot }: { packageRoot: string }) => {
          observed.finalizeRoot = packageRoot;
        },
      });

      expect(observed).toEqual({
        typecheckCwd: realpathSync.native(physicalPackageRoot),
        packageJsonPath: realpathSync.native(join(physicalPackageRoot, 'package.json')),
        finalizeRoot: realpathSync.native(physicalPackageRoot),
      });
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails on a missing package manifest before waiting for the outer build lock', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-missing-manifest-');
    const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const { withWorkspaceBundleLock } = await import('../../../scripts/workspaces/workspaceBundleLock.mjs');
    try {
      await withWorkspaceBundleLock(
        async () => {
          await expect(buildCliDist({
            packageRoot,
            repoRoot: packageRoot,
            lockPath,
            lockTimeoutMs: 60,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 5_000,
          })).rejects.toThrow(/ENOENT|no such file or directory/i);
        },
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 5_000,
        },
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
