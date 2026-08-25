import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ensurePinnedNativeBuildInputArchive } from './nativeBuildInputArchive.mjs';
import { replaceDirectoryPreservingLastGood } from './atomicNativeBuildInputInstall.mjs';
import { validateGhosttyKitArtifact } from './probeIos.mjs';
import {
  ensureTermuxAndroidSourceFromEnvironment,
  installTermuxAndroidSource,
} from './termuxAndroidSource.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CACHE_ROOT = join(homedir(), '.cache', 'happier-terminal-native-build-inputs');

export class NativeBuildInputError extends Error {
  constructor(payload, cause) {
    super(payload?.detail ?? payload?.reason ?? 'Native build-input materialization failed.', { cause });
    this.name = 'NativeBuildInputError';
    this.payload = payload;
  }
}

export async function materializeNativeBuildInputs({
  platform,
  packageRoot: packageRootOverride = packageRoot,
  cacheRoot = process.env.HAPPIER_TERMINAL_NATIVE_BUILD_INPUT_CACHE_DIR?.trim() || DEFAULT_CACHE_ROOT,
  destinationPath,
  policy: policyOverride,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedPlatform = String(platform ?? '').trim().toLowerCase();
  if (normalizedPlatform !== 'ios' && normalizedPlatform !== 'android') {
    throw new NativeBuildInputError({
      status: 'blocked',
      reason: 'unsupported-native-build-input-platform',
      platform,
    });
  }

  const resolvedPackageRoot = resolve(packageRootOverride);
  const policy = policyOverride ?? JSON.parse(await readFile(join(resolvedPackageRoot, 'native-renderers.json'), 'utf-8'));

  if (normalizedPlatform === 'ios') {
    return materializeIosGhosttyKit({
      packageRoot: resolvedPackageRoot,
      cacheRoot,
      destinationPath,
      policy,
      fetchImpl,
    });
  }

  return materializeAndroidTermux({
    packageRoot: resolvedPackageRoot,
    cacheRoot,
    destinationPath,
    policy,
    fetchImpl,
  });
}

async function materializeIosGhosttyKit({ packageRoot: packageRootPath, cacheRoot, destinationPath, policy, fetchImpl }) {
  const artifactPolicy = policy?.iosGhostty?.artifact;
  if (!artifactPolicy) {
    throw new NativeBuildInputError({
      status: 'blocked',
      platform: 'ios',
      reason: 'missing-ios-ghosttykit-policy',
    });
  }

  const noticePath = await verifyNotice({
    packageRoot: packageRootPath,
    relativePath: 'ios/Vendor/NOTICE.md',
    requiredTokens: [
      artifactPolicy.source,
      artifactPolicy.upstreamRelease,
      artifactPolicy.upstreamZipSha256,
      policy.iosGhostty.upstream.observedCommit,
    ],
    label: 'Ghostty',
  });

  const configuredDestination = destinationPath
    ? resolve(destinationPath)
    : join(packageRootPath, artifactPolicy.path);
  const displayDestination = destinationPath
    ?? artifactPolicy.path;
  const explicitSourcePath = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_XCFRAMEWORK?.trim();
  const explicitExpectedSha256 = process.env.HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256?.trim();

  if (explicitSourcePath) {
    if (!explicitExpectedSha256) {
      throw new NativeBuildInputError(missingGhosttyChecksumPayload({
        sourceArtifactPath: explicitSourcePath,
        artifactPath: displayDestination,
      }));
    }

    const sourceArtifactPath = resolve(explicitSourcePath);
    const source = await validateGhosttyKitOrThrow({
      artifactPath: sourceArtifactPath,
      expectedSha256: explicitExpectedSha256,
      reason: 'invalid-libghostty-spm-ghosttykit-xcframework',
      sourceArtifactPath,
      reportedArtifactPath: displayDestination,
    });
    const installedExpectedSha256 = source.sourceKind === 'expanded-xcframework'
      ? explicitExpectedSha256
      : explicitExpectedSha256 === artifactPolicy.upstreamZipSha256
        ? artifactPolicy.expandedSha256
        : undefined;
    return installGhosttyKitArtifact({
      sourceArtifactPath,
      source,
      sourceLabel: source.sourceKind === 'xcframework-zip'
        ? 'explicit-local-xcframework-zip'
        : 'explicit-local-xcframework',
      installedExpectedSha256,
      destinationPath: configuredDestination,
      displayDestination,
      noticePath,
      cache: { status: 'not-used', reason: 'explicit-local-artifact' },
    });
  }

  const cache = await ensurePinnedNativeBuildInputArchive({
    sourceUrl: artifactPolicy.upstreamDownloadUrl,
    expectedSha256: artifactPolicy.upstreamZipSha256,
    cacheRoot,
    cacheKey: 'ios-ghosttykit.zip',
    fetchImpl,
  });
  const source = await validateGhosttyKitOrThrow({
    artifactPath: cache.path,
    expectedSha256: artifactPolicy.upstreamZipSha256,
    reason: 'invalid-pinned-libghostty-spm-ghosttykit-xcframework',
    sourceArtifactPath: cache.path,
    reportedArtifactPath: displayDestination,
  });

  return installGhosttyKitArtifact({
    sourceArtifactPath: cache.path,
    source,
    sourceLabel: 'pinned-libghostty-spm-release-xcframework-zip',
    installedExpectedSha256: artifactPolicy.expandedSha256,
    destinationPath: configuredDestination,
    displayDestination,
    noticePath,
    cache,
    downloadedChecksum: cache.status === 'downloaded' ? cache.checksum : undefined,
  });
}

async function installGhosttyKitArtifact({
  sourceArtifactPath,
  source,
  sourceLabel,
  installedExpectedSha256,
  destinationPath,
  displayDestination,
  noticePath,
  cache,
  downloadedChecksum,
}) {
  await mkdir(dirname(destinationPath), { recursive: true });
  const stagingRoot = await mkdtemp(join(dirname(destinationPath), `.${basename(destinationPath)}-`));
  const stagedArtifactPath = join(stagingRoot, basename(destinationPath));

  try {
    await materializeGhosttyKitArtifact(sourceArtifactPath, stagedArtifactPath);
    const staged = await validateGhosttyKitOrThrow({
      artifactPath: stagedArtifactPath,
      expectedSha256: installedExpectedSha256,
      reason: 'copied-ghosttykit-artifact-failed-verification',
      sourceArtifactPath,
      reportedArtifactPath: displayDestination,
    });
    const persisted = await replaceDirectoryPreservingLastGood({
      stagedPath: stagedArtifactPath,
      destinationPath,
      validate: () => validateGhosttyKitOrThrow({
        artifactPath: destinationPath,
        expectedSha256: installedExpectedSha256,
        reason: 'installed-ghosttykit-artifact-failed-verification',
        sourceArtifactPath,
        reportedArtifactPath: displayDestination,
      }),
    });

    return {
      status: 'ok',
      platform: 'ios',
      renderer: 'ios-ghosttykit',
      source: sourceLabel,
      sourceArtifactPath,
      artifactPath: displayDestination,
      installedArtifactPath: displayDestination,
      slices: persisted.slices,
      checksum: source.checksum,
      installedChecksum: persisted.checksum,
      noticePath,
      cache,
      ...(downloadedChecksum ? { downloadedChecksum } : {}),
      stagedChecksum: staged.checksum,
    };
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

async function materializeAndroidTermux({ packageRoot: packageRootPath, cacheRoot, destinationPath, policy, fetchImpl }) {
  const termuxPolicy = policy?.androidTermux;
  const sourceArchive = termuxPolicy?.upstream?.sourceArchive;
  if (!termuxPolicy || !sourceArchive) {
    throw new NativeBuildInputError({
      status: 'blocked',
      platform: 'android',
      reason: 'missing-android-termux-source-archive-policy',
    });
  }
  if (sourceArchive.commit !== termuxPolicy.upstream.observedCommit) {
    throw new NativeBuildInputError({
      status: 'blocked',
      platform: 'android',
      reason: 'termux-source-archive-commit-mismatch',
      expectedCommit: termuxPolicy.upstream.observedCommit,
      archiveCommit: sourceArchive.commit,
    });
  }

  const noticePath = await verifyNotice({
    packageRoot: packageRootPath,
    relativePath: 'android/termux/NOTICE.md',
    requiredTokens: [
      termuxPolicy.upstream.observedCommit,
      sourceArchive.url,
      sourceArchive.sha256,
      ...termuxPolicy.upstream.modules.flatMap((module) => [module.name, module.license]),
      termuxPolicy.license.kind,
    ],
    label: 'Termux',
  });
  const configuredDestination = destinationPath
    ? resolve(destinationPath)
    : join(packageRootPath, termuxPolicy.sourceStrategy.vendorRoot);
  const explicitSourceRoot = process.env.HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT?.trim();

  if (explicitSourceRoot) {
    const installed = await ensureTermuxAndroidSourceFromEnvironment({
      sourceRoot: explicitSourceRoot,
      vendorRoot: configuredDestination,
    });
    if (installed.status !== 'ok') {
      throw new NativeBuildInputError({
        ...installed,
        platform: 'android',
        artifactPath: configuredDestination,
      });
    }
    return {
      platform: 'android',
      source: 'explicit-local-termux-source',
      noticePath,
      cache: { status: 'not-used', reason: 'explicit-local-source-root' },
      ...installed,
    };
  }

  const cache = await ensurePinnedNativeBuildInputArchive({
    sourceUrl: sourceArchive.url,
    expectedSha256: sourceArchive.sha256,
    cacheRoot,
    cacheKey: 'android-termux-source.tar.gz',
    fetchImpl,
  });
  const extractionRoot = await mkdtemp(join(tmpdir(), 'happier-termux-source-'));
  try {
    await extractSourceArchive(cache.path, extractionRoot);
    const sourceRoot = await findTermuxSourceRoot(extractionRoot, termuxPolicy.upstream.modules);
    const installed = await installTermuxAndroidSource({
      sourceRoot,
      vendorRoot: configuredDestination,
      observedCommit: sourceArchive.commit,
      sourceArchive,
    });
    if (installed.status !== 'ok') {
      throw new NativeBuildInputError({
        ...installed,
        platform: 'android',
        artifactPath: configuredDestination,
      });
    }
    return {
      platform: 'android',
      source: 'pinned-termux-source-archive',
      noticePath,
      cache,
      ...installed,
    };
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

async function extractSourceArchive(archivePath, extractionRoot) {
  if (archivePath.toLowerCase().endsWith('.zip')) {
    await execFileAsync('unzip', ['-q', archivePath, '-d', extractionRoot], { maxBuffer: 1024 * 1024 });
    return;
  }
  await execFileAsync('tar', ['-xzf', archivePath, '-C', extractionRoot], { maxBuffer: 1024 * 1024 });
}

async function findTermuxSourceRoot(extractionRoot, modules) {
  const entries = await readdir(extractionRoot, { withFileTypes: true });
  const candidates = [extractionRoot, ...entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extractionRoot, entry.name))];
  for (const candidate of candidates) {
    if (await Promise.all(modules.map((module) => pathExists(join(candidate, module.path)))).then((values) => values.every(Boolean))) {
      return candidate;
    }
  }
  throw new NativeBuildInputError({
    status: 'blocked',
    platform: 'android',
    reason: 'termux-source-archive-missing-required-modules',
  });
}

async function validateGhosttyKitOrThrow({ artifactPath, reason, reportedArtifactPath, ...options }) {
  const result = await validateGhosttyKitArtifact({ artifactPath, ...options });
  if (result.status === 'ok') return result;
  throw new NativeBuildInputError({
    status: 'blocked',
    platform: 'ios',
    renderer: 'ios-ghosttykit',
    reason,
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: true,
    ...options,
    artifactPath: reportedArtifactPath ?? artifactPath,
    verifier: result,
  });
}

async function verifyNotice({ packageRoot: root, relativePath, requiredTokens, label }) {
  const noticePath = join(root, relativePath);
  let notice;
  try {
    notice = await readFile(noticePath, 'utf-8');
  } catch (error) {
    throw new NativeBuildInputError({
      status: 'blocked',
      reason: `${label.toLowerCase()}-notice-missing`,
      noticePath: relativePath,
      detail: `${label} build-input notice is required at ${relativePath}.`,
    }, error);
  }
  for (const token of requiredTokens) {
    if (!String(token) || !notice.includes(String(token))) {
      throw new NativeBuildInputError({
        status: 'blocked',
        reason: `${label.toLowerCase()}-notice-provenance-mismatch`,
        noticePath: relativePath,
        missingToken: token,
      });
    }
  }
  return relativePath;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function missingGhosttyChecksumPayload(fields = {}) {
  return {
    status: 'blocked',
    platform: 'ios',
    renderer: 'ios-ghosttykit',
    reason: 'missing-checksum-pinned-artifact',
    fallbackRenderer: 'xterm-webview',
    fallbackRequired: true,
    checksumEnv: 'HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256',
    requiredGates: [
      'set HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256 to the approved sha256 for the pinned GhosttyKit.xcframework',
      'verify checksum, wrapper source/patch provenance, license, size, ABI smoke, and App Store/export review before installing',
    ],
    ...fields,
  };
}

async function materializeGhosttyKitArtifact(sourcePath, destinationPath) {
  if (!sourcePath.toLowerCase().endsWith('.zip')) {
    await cp(sourcePath, destinationPath, { recursive: true });
    return;
  }

  const extractionRoot = await mkdtemp(join(tmpdir(), 'happier-ghosttykit-install-'));
  try {
    await execFileAsync('unzip', ['-q', sourcePath, '-d', extractionRoot], { maxBuffer: 1024 * 1024 });
    await cp(join(extractionRoot, 'GhosttyKit.xcframework'), destinationPath, { recursive: true });
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

async function main() {
  const platformIndex = process.argv.indexOf('--platform');
  const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : undefined;
  try {
    const result = await materializeNativeBuildInputs({ platform });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const payload = error instanceof NativeBuildInputError
      ? error.payload
      : {
        status: 'blocked',
        reason: 'native-build-input-materialization-failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
