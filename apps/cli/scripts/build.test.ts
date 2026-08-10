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
import { withWorkspaceBundleLock, withWorkspaceBundleLockSync } from './optionalWorkspaceBundleLock.mjs';
import { resolveTypeScriptCliPath } from '../../../scripts/workspaces/typescriptCommand.mjs';

function writeRuntimeManifest(packageRoot: string): void {
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    type: 'module',
    module: './dist/index.mjs',
  }), 'utf8');
}

describe('buildCliDist', () => {
  it('provides the CLI build heap budget to every generation subprocess', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-heap-budget-');
    try {
      writeRuntimeManifest(packageRoot);
      const subprocessNodeOptions: string[] = [];
      await buildCliDist({
        packageRoot,
        skipLock: true,
        env: {
          ...process.env,
          NODE_OPTIONS: '--trace-warnings',
        },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: (_scriptPath: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
          subprocessNodeOptions.push(options.env.NODE_OPTIONS ?? '');
        },
        runPkgrollBuildImpl: (options: { env: NodeJS.ProcessEnv }) => {
          subprocessNodeOptions.push(options.env.NODE_OPTIONS ?? '');
        },
        resolveDistRuntimeEntrypointsImpl: () => ['/tmp/entrypoint.mjs'],
        probeDistRuntimeImportImpl: (_entrypoint: string, options: { env: NodeJS.ProcessEnv }) => {
          subprocessNodeOptions.push(options.env.NODE_OPTIONS ?? '');
        },
        finalizeDistImpl: () => {},
      });

      expect(subprocessNodeOptions).toEqual([
        '--trace-warnings --max-old-space-size=8192',
        '--trace-warnings --max-old-space-size=8192',
        '--trace-warnings --max-old-space-size=8192',
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('admits test-only type errors while full typecheck rejects them and runtime errors still fail', () => {
    const packageRoot = createTempDirSync('happier-cli-runtime-tsconfig-contract-');
    try {
      const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const buildConfig = JSON.parse(readFileSync(join(cliDir, 'tsconfig.build.json'), 'utf8')) as {
        include?: string[];
        exclude?: string[];
      };
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: buildConfig.include,
        exclude: buildConfig.exclude,
      }), 'utf8');
      writeFileSync(join(packageRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['node_modules'],
      }), 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = "valid";\n', 'utf8');
      writeFileSync(join(packageRoot, 'src', 'vitestSetup.ts'), 'export const testOnly: string = 1;\n', 'utf8');

      const compiler = resolveTypeScriptCliPath({ cwd: cliDir });
      const testOnlyError = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(testOnlyError.status, testOnlyError.stderr || testOnlyError.stdout).toBe(0);

      const fullTypecheck = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(fullTypecheck.status).not.toBe(0);
      expect(`${fullTypecheck.stdout}\n${fullTypecheck.stderr}`).toContain('vitestSetup.ts');

      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime: string = 1;\n', 'utf8');
      const runtimeError = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], {
        cwd: packageRoot,
        encoding: 'utf8',
      });
      expect(runtimeError.status).not.toBe(0);
      expect(`${runtimeError.stdout}\n${runtimeError.stderr}`).toContain('index.ts');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('typechecks only runtime inputs before building the dist generation', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-runtime-tsconfig-');
    try {
      writeRuntimeManifest(packageRoot);
      const invocations: string[][] = [];
      await buildCliDist({
        packageRoot,
        skipLock: true,
        env: { ...process.env },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: (_scriptPath: string, args: string[]) => { invocations.push(args); },
        runPkgrollBuildImpl: () => {},
        probeDistRuntimeImportImpl: () => {},
        finalizeDistImpl: () => {},
        syncPackageDistImpl: () => {},
      });

      expect(invocations).toEqual([['-p', 'tsconfig.build.json', '--noEmit']]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('finalizes an immutable admitted source generation when live CLI source changes during the build', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-immutable-source-');
    try {
      writeRuntimeManifest(packageRoot);
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), '{}\n', 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "admitted";\n', 'utf8');
      let typecheckRoot = '';
      let bundledSource = '';
      let finalizedStagingDir = '';

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: { ...process.env },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: (_scriptPath: string, _args: string[], options: { cwd: string }) => {
          typecheckRoot = options.cwd;
          writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const generation = "newer";\n', 'utf8');
        },
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          bundledSource = readFileSync(join(dirname(packageJsonPath), 'src', 'index.ts'), 'utf8');
        },
        resolveDistRuntimeEntrypointsImpl: () => [],
        finalizeDistImpl: ({ stagingDir }: { stagingDir: string }) => {
          finalizedStagingDir = stagingDir;
        },
      });

      expect(typecheckRoot).not.toBe(realpathSync.native(packageRoot));
      expect(dirname(typecheckRoot)).toBe(realpathSync.native(packageRoot));
      expect(bundledSource).toContain('"admitted"');
      expect(finalizedStagingDir).not.toBe(join(realpathSync.native(packageRoot), `dist.staging.${process.pid}`));
      expect(readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')).toContain('"newer"');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('embeds an explicit release version only in the immutable build generation', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-release-version-');
    try {
      writeRuntimeManifest(packageRoot);
      const sourceManifestPath = join(packageRoot, 'package.json');
      const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(sourceManifestPath, JSON.stringify({ ...sourceManifest, version: '0.2.10' }), 'utf8');
      mkdirSync(join(packageRoot, 'src'), { recursive: true });
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}\n', 'utf8');
      writeFileSync(join(packageRoot, 'tsconfig.build.json'), '{}\n', 'utf8');
      writeFileSync(join(packageRoot, 'src', 'index.ts'), 'export const runtime = true;\n', 'utf8');

      let bundledVersion = '';
      let finalizedBuildVersion = '';
      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        skipLock: true,
        env: {
          ...process.env,
          HAPPIER_CLI_BUILD_VERSION: '0.2.10-dev.61',
        },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: ({ packageJsonPath }: { packageJsonPath: string }) => {
          bundledVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
        },
        resolveDistRuntimeEntrypointsImpl: () => [],
        finalizeDistImpl: ({ buildVersion }: { buildVersion?: string }) => {
          finalizedBuildVersion = buildVersion ?? '';
        },
      });

      expect(bundledVersion).toBe('0.2.10-dev.61');
      expect(finalizedBuildVersion).toBe('0.2.10-dev.61');
      expect(JSON.parse(readFileSync(sourceManifestPath, 'utf8')).version).toBe('0.2.10');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unimportable staged runtime before the CLI owner atomically replaces dist', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-runtime-probe-');
    try {
      writeRuntimeManifest(packageRoot);
      const distDir = join(packageRoot, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.mjs'), 'export const stable = true;\n', 'utf8');

      await expect(buildCliDist({
        packageRoot,
        skipLock: true,
        env: { ...process.env },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: ({ outputDir }: { outputDir: string }) => {
          const stagingDir = resolve(packageRoot, outputDir);
          mkdirSync(stagingDir, { recursive: true });
          writeFileSync(
            join(stagingDir, 'index.mjs'),
            "import { expected } from './chunk.mjs'; export const value = expected;\n",
            'utf8',
          );
          writeFileSync(join(stagingDir, 'chunk.mjs'), 'export const other = true;\n', 'utf8');
        },
        syncPackageDistImpl: () => {},
      })).rejects.toThrow(/does not provide an export named|runtime import probe failed|SyntaxError/);

      expect(readFileSync(join(distDir, 'index.mjs'), 'utf8')).toBe('export const stable = true;\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unimportable non-root runtime entrypoint before publishing the candidate', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-non-root-runtime-probe-');
    try {
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        type: 'module',
        module: './dist/index.mjs',
        exports: {
          '.': './dist/index.mjs',
          './bridge': './dist/bridge.mjs',
        },
      }), 'utf8');
      let didFinalize = false;

      await expect(buildCliDist({
        packageRoot,
        skipLock: true,
        env: { ...process.env },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: ({ outputDir }: { outputDir: string }) => {
          const stagingDir = resolve(packageRoot, outputDir);
          mkdirSync(stagingDir, { recursive: true });
          writeFileSync(join(stagingDir, 'index.mjs'), 'export const valid = true;\n', 'utf8');
          writeFileSync(
            join(stagingDir, 'bridge.mjs'),
            "import { expected } from './bridge-chunk.mjs'; export const value = expected;\n",
            'utf8',
          );
          writeFileSync(join(stagingDir, 'bridge-chunk.mjs'), 'export const other = true;\n', 'utf8');
        },
        finalizeDistImpl: () => { didFinalize = true; },
        syncPackageDistImpl: () => {},
      })).rejects.toThrow(/does not provide an export named|runtime import probe failed|SyntaxError/);

      expect(didFinalize).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('does not reacquire a matching build lock declared by its parent process', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-parent-lock-');
    try {
      writeRuntimeManifest(packageRoot);
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const events: string[] = [];

      await withWorkspaceBundleLock(
        async ({ heldLockValue }) => {
          await buildCliDist({
            packageRoot,
            repoRoot: packageRoot,
            lockPath,
            lockTimeoutMs: 50,
            lockPollIntervalMs: 10,
            lockStaleAfterMs: 1_000,
            env: {
              ...process.env,
              HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
            },
            rmDistImpl: async () => { events.push('rm'); },
            resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
            runTypecheckImpl: () => { events.push('typecheck'); },
            runPkgrollBuildImpl: () => { events.push('bundle'); },
            probeDistRuntimeImportImpl: () => { events.push('probe'); },
            finalizeDistImpl: () => { events.push('finalize'); },
            syncPackageDistImpl: () => { events.push('unexpected-sync'); },
          });
        },
        {
          lockPath,
          timeoutMs: 500,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      expect(events).toEqual(['rm', 'typecheck', 'bundle', 'probe', 'finalize']);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('holds the CLI dist build lock across typecheck, bundle, and finalize', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-lock-section-');
    try {
      writeRuntimeManifest(packageRoot);
      const lockPath = resolve(packageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      const eventsPath = join(packageRoot, 'events.txt');

      await buildCliDist({
        packageRoot,
        repoRoot: packageRoot,
        lockPath,
        env: {
          ...process.env,
        },
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {
          writeFileSync(eventsPath, 'rm\n', { flag: 'a' });
        },
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {
          writeFileSync(eventsPath, 'typecheck\n', { flag: 'a' });
        },
        runPkgrollBuildImpl: (input: { heldLockValue?: string }) => {
          expect(input).not.toHaveProperty('heldLockValue');
          expect(input).not.toHaveProperty('repoRoot');
          expect(input).not.toHaveProperty('lockPath');
          expect(input).not.toHaveProperty('lockModulePath');
          expect(() =>
            withWorkspaceBundleLockSync(
              () => undefined,
              {
                lockPath,
                timeoutMs: 50,
                pollIntervalMs: 10,
                staleAfterMs: 1_000,
              },
            ),
          ).toThrow(/Timed out waiting for workspace bundle lock/);
          writeFileSync(eventsPath, 'bundle\n', { flag: 'a' });
        },
        probeDistRuntimeImportImpl: () => {
          writeFileSync(eventsPath, 'probe\n', { flag: 'a' });
        },
        finalizeDistImpl: () => {
          expect(() =>
            withWorkspaceBundleLockSync(
              () => undefined,
              {
                lockPath,
                timeoutMs: 50,
                pollIntervalMs: 10,
                staleAfterMs: 1_000,
              },
            ),
          ).toThrow(/Timed out waiting for workspace bundle lock/);
          writeFileSync(eventsPath, 'finalize\n', { flag: 'a' });
        },
        syncPackageDistImpl: () => {
          writeFileSync(eventsPath, 'unexpected-sync\n', { flag: 'a' });
        },
      });

      expect(readFileSync(eventsPath, 'utf8')).toBe('rm\ntypecheck\nbundle\nprobe\nfinalize\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('uses the physical package root for the outer lock and pkgroll manifest', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-physical-root-');
    const aliasParent = createTempDirSync('happier-cli-build-root-alias-parent-');
    const aliasPackageRoot = join(aliasParent, 'cli-alias');
    try {
      writeRuntimeManifest(packageRoot);
      writeFileSync(join(packageRoot, 'yarn.lock'), '# physical build root\n', 'utf8');
      symlinkSync(
        packageRoot,
        aliasPackageRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const physicalPackageRoot = realpathSync.native(packageRoot);
      const physicalLockPath = resolve(physicalPackageRoot, '.project', 'tmp', 'cli-dist-build.lock');
      let observedPackageJsonPath = '';

      await buildCliDist({
        packageRoot: aliasPackageRoot,
        lockPath: physicalLockPath,
        env: { ...process.env },
        lockTimeoutMs: 500,
        lockPollIntervalMs: 10,
        lockStaleAfterMs: 1_000,
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: (input: { packageJsonPath: string; heldLockValue?: string }) => {
          observedPackageJsonPath = input.packageJsonPath;
          expect(input).not.toHaveProperty('heldLockValue');
          expect(() =>
            withWorkspaceBundleLockSync(
              () => undefined,
              {
                lockPath: physicalLockPath,
                timeoutMs: 50,
                pollIntervalMs: 10,
                staleAfterMs: 1_000,
              },
            ),
          ).toThrow(/Timed out waiting for workspace bundle lock/);
        },
        resolveDistRuntimeEntrypointsImpl: () => [],
        finalizeDistImpl: () => {},
      });

      expect(observedPackageJsonPath).toBe(join(physicalPackageRoot, 'package.json'));
      expect(existsSync(resolve(aliasPackageRoot, '.project', 'tmp', 'cli-dist-build.lock'))).toBe(false);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('removes builder-owned current and abandoned build generations without touching live dist', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-failed-stage-cleanup-');
    try {
      writeRuntimeManifest(packageRoot);
      const distDir = join(packageRoot, 'dist');
      const stagingDir = join(packageRoot, `dist.staging.${process.pid}`);
      const abandonedSourceDir = join(packageRoot, '.tmp.hstack-cli-build-source.abandoned');
      const abandonedStagingDirs = [
        join(packageRoot, 'dist.staging.1001'),
        join(packageRoot, 'dist.staging.1002'),
      ];
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.mjs'), 'export const stable = true;\n', 'utf8');
      mkdirSync(abandonedSourceDir, { recursive: true });
      writeFileSync(join(abandonedSourceDir, 'partial.ts'), 'abandoned\n', 'utf8');
      for (const abandonedStagingDir of abandonedStagingDirs) {
        mkdirSync(abandonedStagingDir, { recursive: true });
        writeFileSync(join(abandonedStagingDir, 'partial.mjs'), 'abandoned\n', 'utf8');
      }

      await expect(buildCliDist({
        packageRoot,
        skipLock: true,
        env: { ...process.env },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {
          mkdirSync(stagingDir, { recursive: true });
          writeFileSync(join(stagingDir, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('pkgroll failed');
        },
      })).rejects.toThrow(/pkgroll failed/);

      expect(existsSync(stagingDir)).toBe(false);
      expect(existsSync(abandonedSourceDir)).toBe(false);
      for (const abandonedStagingDir of abandonedStagingDirs) {
        expect(existsSync(abandonedStagingDir)).toBe(false);
      }
      expect(readFileSync(join(distDir, 'index.mjs'), 'utf8')).toBe('export const stable = true;\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('preserves an explicitly caller-owned failed output directory', async () => {
    const packageRoot = createTempDirSync('happier-cli-build-caller-stage-');
    try {
      writeRuntimeManifest(packageRoot);
      const callerOutput = join(packageRoot, 'dist.staging.caller-owned');

      await expect(buildCliDist({
        packageRoot,
        skipLock: true,
        env: {
          ...process.env,
          HAPPIER_CLI_BUILD_OUTPUT_DIR: callerOutput,
        },
        rmDistImpl: async () => {},
        resolveTypeScriptCliPathImpl: () => '/repo/node_modules/@typescript/native/bin/tsc',
        runTypecheckImpl: () => {},
        runPkgrollBuildImpl: () => {
          mkdirSync(callerOutput, { recursive: true });
          writeFileSync(join(callerOutput, 'partial.mjs'), 'partial\n', 'utf8');
          throw new Error('pkgroll failed');
        },
      })).rejects.toThrow(/pkgroll failed/);

      expect(readFileSync(join(callerOutput, 'partial.mjs'), 'utf8')).toBe('partial\n');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
