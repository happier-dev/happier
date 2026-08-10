import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveTypeScriptCliPath } from '../../../scripts/workspaces/typescriptCommand.mjs';
import { finalizeDist, normalizeCliBuildVersion, readCliDistBuildManifestFingerprint } from './finalizeDist.mjs';
import { withOptionalCliSharedDepsBuildLock } from './optionalWorkspaceBundleLock.mjs';
import { main as rmDist } from './rmDist.mjs';
import { collectPkgrollInputPaths, runPkgrollBuild } from './runPkgrollBuild.mjs';
import { DEFAULT_CLI_NODE_HEAP_MB, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function resolveBuildOutput(env = process.env) {
  const raw = String(env?.HAPPIER_CLI_BUILD_OUTPUT_DIR ?? '').trim();
  if (raw) return { outputDir: raw, builderOwned: false };
  return { outputDir: `dist.staging.${process.pid}`, builderOwned: true };
}

function resolveCliBuildVersion(env = process.env) {
  return normalizeCliBuildVersion(env?.HAPPIER_CLI_BUILD_VERSION);
}

async function reclaimAbandonedCliBuildDirs(packageRoot, activeOutputDir) {
  const activeOutputPath = resolve(packageRoot, activeOutputDir);
  const entries = await readdir(packageRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => (
      entry.name.startsWith('dist.staging.')
      || entry.name.startsWith('.tmp.hstack-cli-build-source.')
    ) && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => resolve(packageRoot, entry.name))
    .filter((entryPath) => entryPath !== activeOutputPath)
    .map((entryPath) => rm(entryPath, { recursive: true, force: true })));
}

async function createImmutableBuildSource({ packageRoot, buildVersion = '' }) {
  if (!existsSync(join(packageRoot, 'src'))) {
    return {
      packageRoot,
      packageJsonPath: join(packageRoot, 'package.json'),
      async cleanup() {},
    };
  }

  // Keep the immutable generation under the physical package root so Node and
  // TypeScript retain the package-local node_modules resolution ancestry.
  const snapshotRoot = await mkdtemp(join(packageRoot, '.tmp.hstack-cli-build-source.'));
  try {
    for (const relativePath of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src']) {
      const sourcePath = join(packageRoot, relativePath);
      if (!existsSync(sourcePath)) continue;
      await cp(sourcePath, join(snapshotRoot, relativePath), { recursive: true });
    }
    if (buildVersion) {
      const packageJsonPath = join(snapshotRoot, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      await writeFile(packageJsonPath, `${JSON.stringify({ ...packageJson, version: buildVersion }, null, 2)}\n`, 'utf8');
    }
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    packageRoot: snapshotRoot,
    packageJsonPath: join(snapshotRoot, 'package.json'),
    async cleanup() {
      await rm(snapshotRoot, { recursive: true, force: true });
    },
  };
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  });
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${scriptPath} exited with status ${result.status}`);
  }
  if (result.error) {
    throw result.error;
  }
}

function probeDistRuntimeImport(entrypoint, options = {}) {
  const timeoutMs = 30_000;
  const source = `await import(${JSON.stringify(pathToFileURL(resolve(entrypoint)).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      HAPPIER_CLI_DIST_INTEGRITY_PROBE: '1',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: timeoutMs,
  });
  if (result.error) {
    const suffix = result.error?.code === 'ETIMEDOUT' ? ` after ${timeoutMs}ms` : '';
    throw new Error(`CLI staged runtime import probe failed${suffix}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(
      `CLI staged runtime import probe failed (code=${result.status}, signal=${result.signal ?? 'none'}).`
      + (stderr ? `\n${stderr.split('\n').slice(-8).join('\n')}` : ''),
    );
  }
}

function resolveDistRuntimeEntrypoints(packageRoot, outputDir) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  return collectPkgrollInputPaths(manifest, { outputDir })
    .filter((entrypoint) => entrypoint.endsWith('.mjs'))
    .map((entrypoint) => join(packageRoot, entrypoint));
}

export async function buildCliDist(options = {}) {
  const packageRoot = realpathSync.native(resolve(String(options.packageRoot ?? process.cwd())));
  return await withOptionalCliSharedDepsBuildLock(
    () => buildCliDistUnlocked({
      ...options,
      packageRoot,
    }),
    {
      startDir: packageRoot,
      repoRoot: options.repoRoot,
      lockPath: options.lockPath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      skipLock: options.skipLock,
      heldLockValue: options.heldLockValue,
      env: options.env,
    },
  );
}

async function buildCliDistUnlocked(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? process.cwd()));
  const inheritedEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const env = {
    ...inheritedEnv,
    NODE_OPTIONS: upsertMaxOldSpaceSize(
      inheritedEnv.NODE_OPTIONS,
      DEFAULT_CLI_NODE_HEAP_MB,
    ),
  };
  const { outputDir, builderOwned: builderOwnsOutput } = resolveBuildOutput(env);
  const buildVersion = resolveCliBuildVersion(env);
  if (buildVersion && !builderOwnsOutput) {
    throw new Error('[cli-build] HAPPIER_CLI_BUILD_VERSION requires the builder-owned immutable source generation');
  }
  env.HAPPIER_CLI_BUILD_OUTPUT_DIR = outputDir;
  const expectedCurrentFingerprint = readCliDistBuildManifestFingerprint(join(packageRoot, 'dist'));
  const rmDistImpl = options.rmDistImpl ?? rmDist;
  const resolveTypeScriptCliPathImpl = options.resolveTypeScriptCliPathImpl ?? resolveTypeScriptCliPath;
  const runTypecheckImpl = options.runTypecheckImpl ?? runNodeScript;
  const runPkgrollBuildImpl = options.runPkgrollBuildImpl ?? runPkgrollBuild;
  const probeDistRuntimeImportImpl = options.probeDistRuntimeImportImpl ?? probeDistRuntimeImport;
  const resolveDistRuntimeEntrypointsImpl = options.resolveDistRuntimeEntrypointsImpl ?? resolveDistRuntimeEntrypoints;
  const finalizeDistImpl = options.finalizeDistImpl ?? finalizeDist;
  await reclaimAbandonedCliBuildDirs(packageRoot, outputDir);
  const immutableSource = builderOwnsOutput
    ? await (options.createImmutableBuildSourceImpl ?? createImmutableBuildSource)({
        packageRoot,
        buildVersion,
      })
    : {
        packageRoot,
        packageJsonPath: join(packageRoot, 'package.json'),
        async cleanup() {},
      };
  const resolvedOutputDir = resolve(immutableSource.packageRoot, outputDir);
  try {
    await rmDistImpl(['node', 'rmDist.mjs', outputDir], {
      env,
      repoRoot: options.repoRoot,
      lockPath: options.lockPath,
      lockModulePath: options.lockModulePath,
      lockTimeoutMs: options.lockTimeoutMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      lockStaleAfterMs: options.lockStaleAfterMs,
      skipLock: true,
    });

    runTypecheckImpl(resolveTypeScriptCliPathImpl({ cwd: immutableSource.packageRoot }), ['-p', 'tsconfig.build.json', '--noEmit'], {
      cwd: immutableSource.packageRoot,
      env,
    });
    runPkgrollBuildImpl({
      packageJsonPath: immutableSource.packageJsonPath,
      outputDir,
      env,
    });
    for (const entrypoint of resolveDistRuntimeEntrypointsImpl(immutableSource.packageRoot, outputDir)) {
      probeDistRuntimeImportImpl(entrypoint, {
        cwd: immutableSource.packageRoot,
        env,
      });
    }
    finalizeDistImpl({
      packageRoot,
      stagingDir: resolvedOutputDir,
      expectedCurrentFingerprint,
      ...(buildVersion ? { buildVersion } : {}),
    });
    return {
      outputDir: resolve(packageRoot, 'dist'),
      promoted: true,
    };
  } finally {
    await immutableSource.cleanup().catch(() => {});
    if (builderOwnsOutput) {
      await rm(resolvedOutputDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    await buildCliDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
