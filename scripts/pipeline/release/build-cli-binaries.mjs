#!/usr/bin/env node

// @ts-check

import { join, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/release-script-arguments.mjs';
import { resolveCliProxyApiPrebuiltExecutablePath } from './lib/cliproxyapi-managed-runtime-input.mjs';

export { resolveCliProxyApiPrebuiltExecutablePath } from './lib/cliproxyapi-managed-runtime-input.mjs';

async function loadCliBinaryReleaseOwners() {
  const [binaryRelease, notarization] = await Promise.all([
    import('./lib/binary-release.mjs'),
    import('./notarize-standalone-binary.mjs'),
  ]);
  return {
    ...binaryRelease,
    finalizeMacOSPayloadForArchive: notarization.finalizeMacOSPayloadForArchive,
  };
}

function resolveBuildCliBinariesRepoRoot() {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

export function resolveReleaseTempCleanupTimeoutMs(env = process.env) {
  const raw = String(env.HAPPIER_RELEASE_TEMP_CLEANUP_TIMEOUT_MS ?? '').trim();
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(300_000, Math.max(1_000, parsed));
}

export async function cleanupTempDirBestEffort({
  tempDir,
  timeoutMs = resolveReleaseTempCleanupTimeoutMs(process.env),
  rmImpl = rm,
  logger = console,
}) {
  let cleanupCompleted = false;
  await Promise.race([
    rmImpl(tempDir, { recursive: true, force: true }).then(() => {
      cleanupCompleted = true;
    }),
    delay(timeoutMs),
  ]);

  if (!cleanupCompleted) {
    logger.warn(`[release] temp cleanup timed out after ${timeoutMs}ms: ${tempDir}`);
    return { timedOut: true };
  }

  return { timedOut: false };
}

function resolveManagedRuntimeExecutablePath({
  cliProxyApiManagedRuntime,
  targets,
  repoRoot,
}) {
  if (!cliProxyApiManagedRuntime || typeof cliProxyApiManagedRuntime !== 'object') {
    throw new Error('[release] CLIProxyAPI managed runtime input is required');
  }
  if (cliProxyApiManagedRuntime.kind === 'build-from-workspace-source') {
    return undefined;
  }
  if (cliProxyApiManagedRuntime.kind !== 'prebuilt-executable') {
    throw new Error(
      `[release] unsupported CLIProxyAPI managed runtime input: ${
        String(cliProxyApiManagedRuntime.kind ?? '').trim() || '<missing>'
      }`,
    );
  }
  return resolveCliProxyApiPrebuiltExecutablePath({
    rawPath: cliProxyApiManagedRuntime.executablePath,
    targets,
    repoRoot,
  });
}

async function withInheritedBuildEnvironment(env, fn) {
  if (env === process.env) {
    return await fn();
  }
  if (!env || typeof env !== 'object') {
    throw new Error('[release] CLI binary build env is required');
  }

  // The canonical CLI payload/workspace owners currently read process.env internally for their
  // authenticated lease and child-tool environments. Scope the caller's inherited environment
  // around both lazy owner evaluation and execution, then restore every overlaid value in finally.
  const previousValues = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    previousValues.set(
      name,
      Object.prototype.hasOwnProperty.call(process.env, name)
        ? process.env[name]
        : undefined,
    );
    process.env[name] = String(value);
  }

  try {
    return await fn();
  } finally {
    for (const [name, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousValue;
      }
    }
  }
}

async function patchCliPackageVersion(repoRoot, nextVersion) {
  const packageJsonPath = join(repoRoot, 'apps', 'cli', 'package.json');
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const previousVersion = String(parsed.version ?? '').trim();
  if (!previousVersion) {
    throw new Error(`[release] CLI package.json missing version: ${packageJsonPath}`);
  }
  if (previousVersion === nextVersion) {
    return async () => {};
  }
  parsed.version = nextVersion;
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return async () => {
    await writeFile(packageJsonPath, raw, 'utf8');
  };
}

/**
 * Builds standalone CLI archives through the canonical payload and archive owners.
 *
 * The caller owns `outDir` and may pass an authenticated inherited CLI-dist lease in `env`.
 * Same-basis candidate builders should use `build-from-workspace-source` while their outer lease
 * and source-fingerprint window are held. `prebuilt-executable` remains explicit for release jobs
 * that produced the exact target wrapper inside their own current provenance window.
 */
export async function buildCliBinaryArtifacts(
  {
    repoRoot,
    outDir,
    tempBaseDir,
    channel,
    version,
    targets,
    externals = [],
    cliProxyApiManagedRuntime,
    requiredCliDistInputFingerprint,
    macOSSigningIdentity = '',
    macOSNotarizationOutputPath = '',
    env = process.env,
  },
  {
    loadCliBinaryReleaseOwnersImpl = loadCliBinaryReleaseOwners,
    buildCliBinaryArtifactPayloadImpl,
    finalizeMacOSPayloadForArchiveImpl,
    refreshCliBinaryArtifactRuntimeAssetBuildManifestImpl,
    packagePreparedTargetBinaryImpl,
    writeChecksumsFileImpl,
    maybeSignFileImpl,
    cleanupTempDirBestEffortImpl = cleanupTempDirBestEffort,
    mkdirImpl = mkdir,
    rmImpl = rm,
    randomUUIDImpl = randomUUID,
    warnImpl = (message) => console.warn(message),
  } = {},
) {
  const normalizedRepoRoot = resolve(String(repoRoot ?? '').trim());
  const rawOutDir = String(outDir ?? '').trim();
  if (!rawOutDir) {
    throw new Error('[release] CLI binary output directory is required');
  }
  const normalizedOutDir = resolve(normalizedRepoRoot, rawOutDir);
  const normalizedVersion = String(version ?? '').trim();
  if (!normalizedVersion) {
    throw new Error('[release] CLI binary version is required');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('[release] at least one CLI binary target is required');
  }
  const normalizedTargetKeys = targets.map((target) => String(target ?? '').trim());
  if (normalizedTargetKeys.some((target) => !target)) {
    throw new Error('[release] CLI binary targets must be non-empty target keys');
  }
  const normalizedTempBaseDir = resolve(
    normalizedRepoRoot,
    String(tempBaseDir ?? join(normalizedOutDir, '.tmp-cli-binaries')).trim(),
  );
  const tempDir = join(
    normalizedTempBaseDir,
    `build-${process.pid}-${randomUUIDImpl()}`,
  );

  return await withInheritedBuildEnvironment(env, async () => {
    // binary-release loads the mutable CLI-common dist owner. Keep that evaluation inside the
    // caller's authenticated workspace lease/source-basis window.
    const releaseOwners = await loadCliBinaryReleaseOwnersImpl();
    const resolvedTargets = releaseOwners.resolveTargets({
      availableTargets: releaseOwners.CLI_STACK_TARGETS,
      requested: normalizedTargetKeys.join(','),
    });
    const normalizedChannel = releaseOwners.normalizeChannel(channel);
    const cliProxyApiManagedRuntimeExecutablePath = resolveManagedRuntimeExecutablePath({
      cliProxyApiManagedRuntime,
      targets: resolvedTargets,
      repoRoot: normalizedRepoRoot,
    });
    const normalizedMacOSSigningIdentity = String(macOSSigningIdentity ?? '').trim();
    const normalizedMacOSNotarizationOutputPath = String(
      macOSNotarizationOutputPath ?? '',
    ).trim();
    if (
      (normalizedMacOSSigningIdentity || normalizedMacOSNotarizationOutputPath)
      && (resolvedTargets.length !== 1 || resolvedTargets[0]?.os !== 'darwin')
    ) {
      throw new Error('[release] macOS signing options require exactly one Darwin target');
    }
    const buildPayload = buildCliBinaryArtifactPayloadImpl
      ?? releaseOwners.buildCliBinaryArtifactPayload;
    const finalizeMacOSPayload = finalizeMacOSPayloadForArchiveImpl
      ?? releaseOwners.finalizeMacOSPayloadForArchive;
    const refreshRuntimeAssetManifest = (
      refreshCliBinaryArtifactRuntimeAssetBuildManifestImpl
      ?? releaseOwners.refreshCliBinaryArtifactRuntimeAssetBuildManifest
    );
    if (typeof refreshRuntimeAssetManifest !== 'function') {
      throw new Error('[release] CLI runtime asset manifest refresh owner is unavailable');
    }
    const packagePreparedTarget = packagePreparedTargetBinaryImpl
      ?? releaseOwners.packagePreparedTargetBinary;
    const writeChecksums = writeChecksumsFileImpl
      ?? releaseOwners.writeChecksumsFile;
    const maybeSign = maybeSignFileImpl
      ?? releaseOwners.maybeSignFile;

    const restorePackageVersion = await patchCliPackageVersion(
      normalizedRepoRoot,
      normalizedVersion,
    );
    let tempDirCreated = false;
    let primaryFailure = null;
    try {
      await mkdirImpl(normalizedTempBaseDir, { recursive: true });
      await rmImpl(tempDir, { recursive: true, force: true });
      await mkdirImpl(tempDir, { recursive: true });
      tempDirCreated = true;
      await mkdirImpl(normalizedOutDir, { recursive: true });

      const artifacts = [];
      for (const target of resolvedTargets) {
        const stageDir = join(
          tempDir,
          `happier-v${normalizedVersion}-${target.os}-${target.arch}`,
        );
        await buildPayload({
          repoRoot: normalizedRepoRoot,
          payloadDir: stageDir,
          target,
          externals,
          cliProxyApiManagedRuntimeExecutablePath,
          requiredCliDistInputFingerprint,
        });
        finalizeMacOSPayload({
          target,
          stageDir,
          signingIdentity: normalizedMacOSSigningIdentity,
          notarizationOutputPath: normalizedMacOSNotarizationOutputPath,
          refreshRuntimeAssetManifest: () => {
            refreshRuntimeAssetManifest({ payloadDir: stageDir });
          },
        });
        if (target.os !== 'darwin') {
          refreshRuntimeAssetManifest({ payloadDir: stageDir });
        }
        artifacts.push(await packagePreparedTarget({
          product: 'happier',
          version: normalizedVersion,
          target,
          stageDir,
          outDir: normalizedOutDir,
        }));
      }

      const checksumsPath = await writeChecksums({
        product: 'happier',
        version: normalizedVersion,
        artifacts,
        outDir: normalizedOutDir,
      });
      const signaturePath = await maybeSign({
        path: checksumsPath,
        trustedComment: `happier ${normalizedVersion} ${normalizedChannel}`,
      });

      return {
        product: 'happier',
        channel: normalizedChannel,
        version: normalizedVersion,
        outDir: normalizedOutDir,
        artifacts: artifacts.map((artifact) => ({
          name: artifact.name,
          path: artifact.path,
          os: artifact.os,
          arch: artifact.arch,
        })),
        checksumsPath,
        signaturePath,
      };
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      try {
        if (tempDirCreated) {
          // Best-effort cleanup applies to both success and every intermediate failure.
          await cleanupTempDirBestEffortImpl({ tempDir });
        }
      } catch (cleanupError) {
        if (primaryFailure === null) {
          throw cleanupError;
        }
        warnImpl(
          `[release] temp cleanup failed after CLI binary build failure: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      } finally {
        await restorePackageVersion();
      }
    }
  });
}

export async function main(
  argv = process.argv.slice(2),
  {
    repoRoot = resolveBuildCliBinariesRepoRoot(),
    env = process.env,
    loadCliBinaryReleaseOwnersImpl = loadCliBinaryReleaseOwners,
    buildCliBinaryArtifactsImpl = buildCliBinaryArtifacts,
    logImpl = (line) => console.log(line),
  } = {},
) {
  const { kv } = parseArgs(argv);
  const releaseOwners = await loadCliBinaryReleaseOwnersImpl();

  const channel = releaseOwners.normalizeChannel(kv.get('--channel'));
  const version = String(kv.get('--version') ?? '').trim()
    || releaseOwners.readVersionFromPackageJson(join(repoRoot, 'apps', 'cli', 'package.json'));
  const outDir = join(repoRoot, 'dist', 'release-assets', 'cli');
  // IMPORTANT: build scripts are invoked by multiple integration tests in parallel.
  // Never share a single temp directory across invocations, or concurrent builds will race on rm/mkdir.
  const tempBaseDir = join(repoRoot, 'dist', 'release-assets', '.tmp-cli-binaries');
  const externals = releaseOwners.parseCsv(
    kv.get('--externals') ?? env.HAPPIER_CLI_BUN_EXTERNALS ?? '',
  );
  const targets = releaseOwners.resolveTargets({
    availableTargets: releaseOwners.CLI_STACK_TARGETS,
    requested: kv.get('--targets'),
  });
  const cliProxyApiManagedRuntimeExecutablePath = resolveCliProxyApiPrebuiltExecutablePath({
    rawPath: kv.get('--cliproxyapi-managed-runtime-executable'),
    targets,
    repoRoot,
  });
  const macOSSigningIdentity = String(kv.get('--macos-signing-identity') ?? '').trim();
  const macOSNotarizationOutputPath = String(kv.get('--macos-notarization-output') ?? '').trim();
  const result = await buildCliBinaryArtifactsImpl({
    repoRoot,
    outDir,
    tempBaseDir,
    channel,
    version,
    targets: targets.map((target) => `${target.os}-${target.arch}`),
    externals,
    cliProxyApiManagedRuntime: cliProxyApiManagedRuntimeExecutablePath
      ? {
        kind: 'prebuilt-executable',
        executablePath: cliProxyApiManagedRuntimeExecutablePath,
      }
      : { kind: 'build-from-workspace-source' },
    macOSSigningIdentity,
    macOSNotarizationOutputPath,
    env,
  });

  const output = {
    product: result.product,
    channel: result.channel,
    version: result.version,
    outDir: result.outDir,
    artifacts: result.artifacts.map((artifact) => artifact.name),
    checksums: result.checksumsPath,
    signature: result.signaturePath,
  };
  logImpl(JSON.stringify(output, null, 2));
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/pipeline/release/build-cli-binaries.mjs')
    || arg.endsWith('\\scripts\\pipeline\\release\\build-cli-binaries.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
