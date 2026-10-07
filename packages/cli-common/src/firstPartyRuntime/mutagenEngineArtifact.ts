import {
  createHash,
} from 'node:crypto';
import {
  createReadStream,
} from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import {
  join,
  resolve,
  win32,
} from 'node:path';

/**
 * The Mutagen engine is deliberately pinned independently from the Happier
 * release rings.  A rolling `mutagen-stable` tag is not a valid engine input:
 * manager and agent must come from one immutable fork release.
 */
export const MUTAGEN_ENGINE_FORK_REMOTE = 'https://github.com/happier-dev/mutagen.git';
export const MUTAGEN_ENGINE_FORK_BRANCH = 'happier/external-stream-v1';
/** Immutable commit on which the Happier fork implementation was based. */
export const MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT = 'f5ed5c91fa6c934f5678393c56d00362d6443a1d';
/** Exact committed fork bytes approved for the managed engine release. */
export const MUTAGEN_ENGINE_FORK_RELEASE_COMMIT = 'f02d01e88f2eeec5e4326a4739243b863f8cebbe';
export const MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT = 'cd8069cf8b945dfa0d0f47d8685322c6f1e16e44';
export const MUTAGEN_ENGINE_UPSTREAM_TAG = 'v0.18.1';
/** Immutable first-party component policy version used for acquisition. */
export const MUTAGEN_ENGINE_VERSION = '0.18.1-happier.9';
export const MUTAGEN_ENGINE_UPSTREAM_COMMIT = 'a225ae50aee3d7ebb59139203cb84e8a6a3ff4bf';
export const MUTAGEN_ENGINE_GO_VERSION = '1.22.12';
export const MUTAGEN_ENGINE_PROTOCOL_EPOCH = 'external-stream-v1';
/** Mutagen's conflict fingerprints are SHA-1; readers and delete preconditions consume this owner. */
export const MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM = 'sha1' as const;
export const MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const MUTAGEN_ENGINE_ARTIFACT_FORMAT = 'happier-mutagen-engine';
const MUTAGEN_ENGINE_SOURCE_REPOSITORY = 'https://github.com/happier-dev/mutagen';
const MUTAGEN_ENGINE_MANAGER_BUILD_TAGS = Object.freeze([
  'mutagensidecar',
  'mutagensspl',
] as const);
const MUTAGEN_ENGINE_AGENT_BUILD_TAGS = Object.freeze([
  'mutagenagent',
  'mutagensspl',
] as const);
const MUTAGEN_ENGINE_BUILD_TAGS = Object.freeze([
  'mutagensidecar',
  'mutagensspl',
  'mutagenagent',
] as const);

/** SHA-256 values published by the Go distribution index for Go 1.22.12. */
export const MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256 = Object.freeze({
  'darwin-arm64': '416c35218edb9d20990b5d8fc87be655d8b39926f15524ea35c66ee70273050d',
  'darwin-amd64': 'e7bbe07e96f0bd3df04225090fe1e7852ed33af37c43a23e16edbbb3b90a5b7c',
  'linux-amd64': '4fa4f869b0f7fc6bb1eb2660e74657fbf04cdd290b5aef905585c86051b34d43',
  'linux-arm64': 'fd017e647ec28525e86ae8203236e0653242722a7436929b1f775744e26278e7',
  'windows-amd64': '2ceda04074eac51f4b0b85a9fcca38bcd49daee24bed9ea1f29958a8e22673a6',
} as const);

export const MUTAGEN_ENGINE_SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-amd64',
  'linux-amd64',
  'linux-arm64',
  'windows-amd64',
] as const;

export type MutagenEngineArtifactTarget = (typeof MUTAGEN_ENGINE_SUPPORTED_TARGETS)[number];
export type MutagenEngineWatcher = 'fsevents' | 'native' | 'polling';
type MutagenEngineManagerRelativePath = 'bin/happier-mutagen' | 'bin/happier-mutagen.exe';
type MutagenEngineAgentRelativePath = 'bin/happier-mutagen-agent' | 'bin/happier-mutagen-agent.exe';

export type MutagenEngineArtifactErrorCode =
  | 'mutagen_engine_artifact_untrusted'
  | 'mutagen_engine_artifact_incomplete'
  | 'mutagen_engine_unsupported_platform'
  | 'mutagen_engine_data_dir_conflict';

export class MutagenEngineArtifactError extends Error {
  readonly code: MutagenEngineArtifactErrorCode;

  constructor(code: MutagenEngineArtifactErrorCode, message: string) {
    super(message);
    this.name = 'MutagenEngineArtifactError';
    this.code = code;
  }
}

export interface MutagenEngineArtifactManifest {
  readonly format: typeof MUTAGEN_ENGINE_ARTIFACT_FORMAT;
  readonly schemaVersion: typeof MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION;
  readonly component: 'mutagen-engine';
  readonly engineVersion: string;
  /** Exact immutable commit whose bytes produced the manager/agent pair. */
  readonly forkCommit: string;
  readonly sourceRepository: typeof MUTAGEN_ENGINE_SOURCE_REPOSITORY;
  readonly sourceTag: string;
  readonly sourceArchive: string;
  readonly forkBranch: typeof MUTAGEN_ENGINE_FORK_BRANCH;
  readonly transportSpikeCommit: typeof MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT;
  readonly upstreamTag: typeof MUTAGEN_ENGINE_UPSTREAM_TAG;
  readonly upstreamCommit: typeof MUTAGEN_ENGINE_UPSTREAM_COMMIT;
  readonly toolchain: Readonly<{
    go: typeof MUTAGEN_ENGINE_GO_VERSION;
    goChecksum: string;
    goDistributionSha256?: string;
  }>;
  readonly protocolEpoch: typeof MUTAGEN_ENGINE_PROTOCOL_EPOCH;
  readonly targetTriple: MutagenEngineArtifactTarget;
  readonly supportedTargets?: readonly MutagenEngineArtifactTarget[];
  readonly managerPath: MutagenEngineManagerRelativePath;
  readonly agentPath: MutagenEngineAgentRelativePath;
  readonly licensePolicy: 'mixed-mit-sspl';
  readonly ssplEnabled: true;
  readonly buildTags: readonly string[];
  readonly managerBuildTags: readonly string[];
  readonly agentBuildTags: readonly string[];
  readonly cgoEnabled: boolean;
  readonly watcher: MutagenEngineWatcher;
  readonly protocol?: string;
  readonly managerSha256: string;
  readonly agentSha256: string;
  readonly releaseTag: string;
}

export interface MutagenEngineArtifactPaths {
  readonly managerPath: string;
  readonly agentPath: string;
  readonly mutagenLicensePath: string;
  readonly ssplLicensePath: string;
  readonly thirdPartyNoticesPath: string;
  readonly manifestPath: string;
  readonly checksumsPath: string;
}

export interface MutagenEngineDataLayout {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly brokerDir: string;
}

export interface MutagenEngineReleaseAsset {
  readonly name: string;
  readonly url: string;
}

export interface MutagenEngineReleaseAssetBundle {
  readonly version: string;
  readonly targetTriple: MutagenEngineArtifactTarget;
  readonly archive: MutagenEngineReleaseAsset;
  readonly checksums: MutagenEngineReleaseAsset;
  readonly checksumsSig: MutagenEngineReleaseAsset;
}

const ENGINE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
/** Resolve the only release-tag shape accepted for a Mutagen engine. */
export function resolveMutagenEngineReleaseTag(engineVersion: string): string {
  const version = String(engineVersion ?? '').trim();
  if (!ENGINE_VERSION_PATTERN.test(version)) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_artifact_untrusted',
      `Mutagen engine version must be an immutable semantic version, received '${version || '<empty>'}'.`,
    );
  }
  return `mutagen-v${version}`;
}

/**
 * Resolve manager/agent archive assets from one immutable fork release.  The
 * target triple is part of the filename so an x64 host cannot accidentally
 * consume a similarly named rolling CLI archive.
 */
export function resolveMutagenEngineReleaseAssetBundle(params: Readonly<{
  assets: unknown;
  engineVersion: string;
  targetTriple: MutagenEngineArtifactTarget;
  preferZipOnWindows?: boolean;
}>): MutagenEngineReleaseAssetBundle {
  const version = String(params.engineVersion ?? '').trim();
  const targetTriple = params.targetTriple;
  resolveMutagenEngineReleaseTag(version);
  if (!MUTAGEN_ENGINE_SUPPORTED_TARGETS.includes(targetTriple)) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_unsupported_platform',
      `Unsupported Mutagen engine target triple: ${String(targetTriple)}`,
    );
  }
  const assets = Array.isArray(params.assets) ? params.assets : [];
  const byName = new Map<string, MutagenEngineReleaseAsset>();
  for (const value of assets) {
    if (value == null || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const url = typeof record.browser_download_url === 'string'
      ? record.browser_download_url.trim()
      : typeof record.url === 'string' ? record.url.trim() : '';
    if (name && url) byName.set(name, { name, url });
  }
  const base = `happier-mutagen-v${version}-${targetTriple}`;
  const archiveNames = targetTriple.startsWith('windows-') && params.preferZipOnWindows !== false
    ? [`${base}.zip`, `${base}.tar.gz`]
    : [`${base}.tar.gz`, `${base}.zip`];
  const archive = archiveNames.map((name) => byName.get(name)).find((entry): entry is MutagenEngineReleaseAsset => entry != null);
  const checksumsName = `checksums-happier-mutagen-v${version}.txt`;
  const checksums = byName.get(checksumsName);
  const checksumsSig = byName.get(`${checksumsName}.minisig`);
  if (!archive || !checksums || !checksumsSig) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_artifact_untrusted',
      `Mutagen engine release ${resolveMutagenEngineReleaseTag(version)} is missing the exact ${targetTriple} archive, checksums, or signature.`,
    );
  }
  return { version, targetTriple, archive, checksums, checksumsSig };
}

/** Map Node host values to the fixed manager/agent release matrix. */
export function resolveMutagenEngineArtifactTarget(params: Readonly<{
  platform?: string;
  arch?: string;
}> = {}): MutagenEngineArtifactTarget {
  const platform = String(params.platform ?? process.platform).trim().toLowerCase();
  const arch = String(params.arch ?? process.arch).trim().toLowerCase();
  const normalizedPlatform = platform === 'mac' || platform === 'macos'
    ? 'darwin'
    : platform === 'windows'
      ? 'win32'
      : platform;
  const normalizedArch = arch === 'amd64' || arch === 'x86_64'
    ? 'x64'
    : arch === 'aarch64'
      ? 'arm64'
      : arch;
  const target = normalizedPlatform === 'win32'
    ? normalizedArch === 'x64' ? 'windows-amd64' : null
    : normalizedPlatform === 'darwin' || normalizedPlatform === 'linux'
      ? normalizedArch === 'x64'
        ? `${normalizedPlatform}-amd64`
        : normalizedArch === 'arm64'
          ? `${normalizedPlatform}-arm64`
          : null
      : null;
  if (!target || !MUTAGEN_ENGINE_SUPPORTED_TARGETS.includes(target as MutagenEngineArtifactTarget)) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_unsupported_platform',
      `Unsupported platform for Mutagen engine target: ${platform || '<empty>'}/${arch || '<empty>'}.`,
    );
  }
  return target as MutagenEngineArtifactTarget;
}

export function resolveMutagenEngineArtifactPaths(
  payloadRoot: string,
  targetTriple: MutagenEngineArtifactTarget,
): MutagenEngineArtifactPaths {
  const root = String(payloadRoot ?? '').trim();
  if (!root) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_artifact_incomplete',
      'Mutagen engine payload root is required.',
    );
  }
  const executablePaths = resolveMutagenEngineExecutableRelativePaths(targetTriple);
  return {
    managerPath: join(root, executablePaths.managerPath),
    agentPath: join(root, executablePaths.agentPath),
    mutagenLicensePath: join(root, 'licenses', 'MUTAGEN-LICENSE'),
    ssplLicensePath: join(root, 'licenses', 'SSPL-LICENSE'),
    thirdPartyNoticesPath: join(root, 'licenses', 'THIRD-PARTY-NOTICES'),
    manifestPath: join(root, '.happier-mutagen-engine.json'),
    checksumsPath: join(root, 'checksums.txt'),
  };
}

/**
 * Validate the signed metadata embedded in a manager/agent payload.  This is
 * the canonical supply-chain owner used by both install and build tooling.
 */
export function assertMutagenEngineArtifactManifest(
  value: unknown,
  options: Readonly<{ trustedForkReleaseCommit?: string | null }> = {},
): MutagenEngineArtifactManifest {
  const record = asRecord(value, 'Mutagen engine manifest');
  assertOnlyKeys(record, new Set([
    'format', 'schemaVersion', 'component', 'engineVersion', 'forkCommit', 'forkBranch',
    'sourceRepository', 'sourceTag', 'sourceArchive', 'transportSpikeCommit',
    'upstreamTag', 'upstreamCommit', 'toolchain', 'protocolEpoch',
    'targetTriple', 'supportedTargets', 'managerPath', 'agentPath', 'licensePolicy',
    'ssplEnabled', 'buildTags', 'managerBuildTags', 'agentBuildTags',
    'cgoEnabled', 'watcher', 'protocol', 'managerSha256',
    'agentSha256', 'releaseTag',
  ]), 'manifest');
  const format = readOptionalString(record, 'format') ?? MUTAGEN_ENGINE_ARTIFACT_FORMAT;
  if (format !== MUTAGEN_ENGINE_ARTIFACT_FORMAT) {
    rejectManifest(`manifest format must be ${MUTAGEN_ENGINE_ARTIFACT_FORMAT}`);
  }
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION) {
    rejectManifest(`unsupported Mutagen engine manifest schema version: ${String(schemaVersion)}`);
  }
  if (record.component !== 'mutagen-engine') rejectManifest('manifest component must be mutagen-engine');

  const engineVersion = readRequiredString(record, 'engineVersion');
  if (!ENGINE_VERSION_PATTERN.test(engineVersion)) rejectManifest('manifest engineVersion is invalid');
  const forkCommit = readRequiredString(record, 'forkCommit');
  const expectedReleaseTag = resolveMutagenEngineReleaseTag(engineVersion);
  const sourceRepository = readRequiredString(record, 'sourceRepository');
  if (sourceRepository !== MUTAGEN_ENGINE_SOURCE_REPOSITORY) {
    rejectManifest(`manifest source repository must be ${MUTAGEN_ENGINE_SOURCE_REPOSITORY}`);
  }
  const sourceTag = readRequiredString(record, 'sourceTag');
  if (sourceTag !== expectedReleaseTag) rejectManifest('manifest source tag must match the immutable engine version');
  const sourceArchive = readRequiredString(record, 'sourceArchive');
  if (sourceArchive !== `happier-mutagen-source-${expectedReleaseTag}.tar.gz`) {
    rejectManifest('manifest source archive must match the immutable source tag');
  }
  const forkBranch = readOptionalString(record, 'forkBranch') ?? MUTAGEN_ENGINE_FORK_BRANCH;
  if (forkBranch !== MUTAGEN_ENGINE_FORK_BRANCH) rejectManifest('manifest fork branch is not approved');
  const transportSpikeCommit = readOptionalString(record, 'transportSpikeCommit') ?? MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT;
  if (transportSpikeCommit !== MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT) {
    rejectManifest('manifest transport spike commit is not approved');
  }
  const upstreamTag = readRequiredString(record, 'upstreamTag');
  if (upstreamTag !== MUTAGEN_ENGINE_UPSTREAM_TAG) rejectManifest('manifest upstream tag is not approved');
  const upstreamCommit = readRequiredString(record, 'upstreamCommit');
  if (upstreamCommit !== MUTAGEN_ENGINE_UPSTREAM_COMMIT) rejectManifest('manifest upstream commit is not approved');
  if (!COMMIT_PATTERN.test(forkCommit) || !COMMIT_PATTERN.test(upstreamCommit) || !COMMIT_PATTERN.test(transportSpikeCommit)) {
    rejectManifest('manifest commit values must be full 40-character SHA-1 values');
  }

  const toolchain = asRecord(record.toolchain, 'manifest toolchain');
  assertOnlyKeys(toolchain, new Set(['go', 'goChecksum', 'checksum', 'goDistributionSha256']), 'manifest toolchain');
  const go = readRequiredString(toolchain, 'go');
  if (go !== MUTAGEN_ENGINE_GO_VERSION) rejectManifest(`manifest Go toolchain must be ${MUTAGEN_ENGINE_GO_VERSION}`);
  const targetTriple = readRequiredString(record, 'targetTriple') as MutagenEngineArtifactTarget;
  if (!MUTAGEN_ENGINE_SUPPORTED_TARGETS.includes(targetTriple)) rejectManifest('manifest target triple is unsupported');
  const supportedTargetsValue = record.supportedTargets;
  const supportedTargets = supportedTargetsValue === undefined
    ? undefined
    : readStringArray(record, 'supportedTargets') as MutagenEngineArtifactTarget[];
  if (supportedTargets != null
    && (supportedTargets.length !== MUTAGEN_ENGINE_SUPPORTED_TARGETS.length
      || supportedTargets.some((target, index) => target !== MUTAGEN_ENGINE_SUPPORTED_TARGETS[index]))) {
    rejectManifest('manifest supported target matrix is not approved');
  }
  const goChecksum = readOptionalString(toolchain, 'goChecksum')
    ?? readOptionalString(toolchain, 'checksum')
    ?? readOptionalString(toolchain, 'goDistributionSha256');
  if (!goChecksum) rejectManifest('manifest Go distribution checksum is required');
  if (goChecksum != null) {
    if (!SHA256_PATTERN.test(goChecksum)) rejectManifest('manifest Go checksum must be SHA-256');
    if (goChecksum !== MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256[targetTriple]) {
      rejectManifest(`manifest Go checksum does not match Go ${MUTAGEN_ENGINE_GO_VERSION} for ${targetTriple}`);
    }
  }

  const protocolEpoch = readRequiredString(record, 'protocolEpoch');
  if (protocolEpoch !== MUTAGEN_ENGINE_PROTOCOL_EPOCH) rejectManifest('manifest protocol epoch is not approved');
  const protocol = readOptionalString(record, 'protocol');
  if (protocol != null && (!/^external:\/\/[^/?#]+$/u.test(protocol) || protocol.length > 256)) {
    rejectManifest('manifest protocol must be an opaque external:// endpoint without path, query, or fragment');
  }

  const managerPath = readRequiredString(record, 'managerPath');
  const agentPath = readRequiredString(record, 'agentPath');
  const executablePaths = resolveMutagenEngineExecutableRelativePaths(targetTriple);
  if (managerPath !== executablePaths.managerPath || agentPath !== executablePaths.agentPath) {
    rejectManifest('manifest must contain the manager and agent at the canonical bin paths');
  }

  if (record.licensePolicy !== 'mixed-mit-sspl') {
    rejectManifest('Mutagen engine license policy must be mixed-mit-sspl');
  }
  if (record.ssplEnabled !== true) rejectManifest('Mutagen engine SSPL support must be enabled');
  const buildTags = readStringArray(record, 'buildTags');
  const managerBuildTags = readStringArray(record, 'managerBuildTags');
  const agentBuildTags = readStringArray(record, 'agentBuildTags');
  assertExactBuildTags(managerBuildTags, MUTAGEN_ENGINE_MANAGER_BUILD_TAGS, 'manager');
  assertExactBuildTags(agentBuildTags, MUTAGEN_ENGINE_AGENT_BUILD_TAGS, 'agent');
  assertExactBuildTags(buildTags, MUTAGEN_ENGINE_BUILD_TAGS, 'aggregate');
  const cgoEnabled = readBoolean(record, 'cgoEnabled');
  const watcher = readRequiredString(record, 'watcher') as MutagenEngineWatcher;
  const expectedWatcher: MutagenEngineWatcher = targetTriple.startsWith('darwin-')
    ? 'fsevents'
    : targetTriple.startsWith('linux-')
      ? 'polling'
      : 'native';
  if (watcher !== expectedWatcher) {
    rejectManifest(`manifest watcher policy for ${targetTriple} must be ${expectedWatcher}`);
  }
  if (targetTriple.startsWith('darwin-') && !cgoEnabled) {
    rejectManifest('macOS Mutagen artifacts must use cgo-enabled builds');
  }
  const releaseTag = readOptionalString(record, 'releaseTag');
  if (releaseTag == null || releaseTag !== expectedReleaseTag) {
    rejectManifest('manifest release tag does not match the immutable engine version');
  }
  const managerSha256 = readRequiredString(record, 'managerSha256');
  const agentSha256 = readRequiredString(record, 'agentSha256');
  if (!SHA256_PATTERN.test(managerSha256)) rejectManifest('manifest managerSha256 must be SHA-256');
  if (!SHA256_PATTERN.test(agentSha256)) rejectManifest('manifest agentSha256 must be SHA-256');

  const trustedForkReleaseCommit = options.trustedForkReleaseCommit === undefined
    ? MUTAGEN_ENGINE_FORK_RELEASE_COMMIT
    : options.trustedForkReleaseCommit;
  if (trustedForkReleaseCommit == null) {
    rejectManifest('mutagen_fork_release_commit_required: the current fork implementation has no immutable release commit');
  }
  if (!COMMIT_PATTERN.test(trustedForkReleaseCommit)) {
    rejectManifest('trusted fork release commit must be a full 40-character SHA-1 value');
  }
  if (forkCommit !== trustedForkReleaseCommit) {
    rejectManifest(`manifest fork commit must be the exact release commit ${trustedForkReleaseCommit}`);
  }

  return Object.freeze({
    format: MUTAGEN_ENGINE_ARTIFACT_FORMAT,
    schemaVersion: MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION,
    component: 'mutagen-engine',
    engineVersion,
    forkCommit,
    sourceRepository: MUTAGEN_ENGINE_SOURCE_REPOSITORY,
    sourceTag,
    sourceArchive,
    forkBranch: MUTAGEN_ENGINE_FORK_BRANCH,
    transportSpikeCommit: MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
    upstreamTag: MUTAGEN_ENGINE_UPSTREAM_TAG,
    upstreamCommit: MUTAGEN_ENGINE_UPSTREAM_COMMIT,
    toolchain: Object.freeze({
      go: MUTAGEN_ENGINE_GO_VERSION,
      goChecksum,
    }),
    protocolEpoch: MUTAGEN_ENGINE_PROTOCOL_EPOCH,
    targetTriple,
    ...(supportedTargets ? { supportedTargets: Object.freeze([...supportedTargets]) } : {}),
    managerPath: executablePaths.managerPath,
    agentPath: executablePaths.agentPath,
    licensePolicy: 'mixed-mit-sspl',
    ssplEnabled: true,
    buildTags: Object.freeze([...buildTags]),
    managerBuildTags: Object.freeze([...managerBuildTags]),
    agentBuildTags: Object.freeze([...agentBuildTags]),
    cgoEnabled,
    watcher,
    ...(protocol ? { protocol } : {}),
    managerSha256,
    agentSha256,
    releaseTag,
  });
}

/** Validate the complete extracted payload before it enters managed install. */
export async function assertMutagenEngineArtifactPayload(params: Readonly<{
  payloadRoot: string;
  targetTriple: MutagenEngineArtifactTarget;
  engineVersion?: string;
  /** Repository build tooling may supply its already-validated release policy; runtime callers omit this. */
  trustedForkReleaseCommit?: string | null;
}>): Promise<MutagenEngineArtifactManifest> {
  const root = String(params.payloadRoot ?? '').trim();
  if (!root) rejectPayload('Mutagen engine payload root is required');
  const paths = resolveMutagenEngineArtifactPaths(root, params.targetTriple);
  for (const [label, path] of [
    ['manager binary', paths.managerPath],
    ['agent binary', paths.agentPath],
    ['Mutagen license', paths.mutagenLicensePath],
    ['SSPL license', paths.ssplLicensePath],
    ['third-party notices', paths.thirdPartyNoticesPath],
    ['checksums', paths.checksumsPath],
    ['artifact manifest', paths.manifestPath],
  ] as const) {
    await assertRegularFile(path, label);
  }
  if (params.targetTriple !== 'windows-amd64') {
    await assertExecutable(paths.managerPath, 'manager binary');
    await assertExecutable(paths.agentPath, 'agent binary');
  }
  const license = await readFile(paths.mutagenLicensePath, 'utf8');
  if (!/\bMIT License\b/iu.test(license) || !/Server Side Public License/iu.test(license)) {
    rejectPayload('Mutagen umbrella license is empty or does not describe the mixed MIT and SSPL source license boundary');
  }
  const ssplLicense = await readFile(paths.ssplLicensePath, 'utf8');
  if (!/server\s+side\s+public\s+license/iu.test(ssplLicense) || !/version\s+1\b/iu.test(ssplLicense)) {
    rejectPayload('SSPL license is empty or not recognizable as Server Side Public License Version 1');
  }
  if (!(await readFile(paths.thirdPartyNoticesPath, 'utf8')).trim()) rejectPayload('third-party notice closure is empty');
  const checksums = parseMutagenEngineChecksums(
    await readFile(paths.checksumsPath, 'utf8'),
    params.targetTriple,
  );

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as unknown;
  } catch (error) {
    rejectPayload(`artifact manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = assertMutagenEngineArtifactManifest(
    rawManifest,
    params.trustedForkReleaseCommit === undefined
      ? {}
      : { trustedForkReleaseCommit: params.trustedForkReleaseCommit },
  );
  if (manifest.targetTriple !== params.targetTriple) {
    rejectPayload(`artifact target triple ${manifest.targetTriple} does not match requested ${params.targetTriple}`);
  }
  if (params.engineVersion != null && manifest.engineVersion !== params.engineVersion) {
    rejectPayload(`artifact engine version ${manifest.engineVersion} does not match requested ${params.engineVersion}`);
  }
  if (checksums.get(manifest.managerPath) !== manifest.managerSha256
    || checksums.get(manifest.agentPath) !== manifest.agentSha256) {
    rejectPayload('checksums.txt does not match the signed artifact manifest');
  }
  if (await sha256File(paths.managerPath) !== manifest.managerSha256) {
    rejectPayload('manager binary checksum does not match the artifact manifest');
  }
  if (await sha256File(paths.agentPath) !== manifest.agentSha256) {
    rejectPayload('agent binary checksum does not match the artifact manifest');
  }
  for (const [relativePath, absolutePath] of [
    ['licenses/MUTAGEN-LICENSE', paths.mutagenLicensePath],
    ['licenses/SSPL-LICENSE', paths.ssplLicensePath],
    ['licenses/THIRD-PARTY-NOTICES', paths.thirdPartyNoticesPath],
    ['.happier-mutagen-engine.json', paths.manifestPath],
  ] as const) {
    if (await sha256File(absolutePath) !== checksums.get(relativePath)) {
      rejectPayload(`${relativePath} checksum does not match checksums.txt`);
    }
  }
  return manifest;
}

/** Resolve isolated manager state; stack dev-target data can never overlap it. */
export function resolveMutagenEngineDataLayout(params: Readonly<{
  daemonDataRoot: string;
  stackDevTargetMutagenDataDir?: string | null;
}>): MutagenEngineDataLayout {
  const daemonDataRoot = resolvePathLike(params.daemonDataRoot);
  if (!String(params.daemonDataRoot ?? '').trim()) {
    throw new MutagenEngineArtifactError('mutagen_engine_data_dir_conflict', 'daemon data root is required');
  }
  const pathModule = isWindowsPathLike(daemonDataRoot) ? win32 : null;
  const rootDir = (pathModule ?? { resolve }).resolve(daemonDataRoot, 'workspace-sync', 'mutagen');
  const dataDir = (pathModule ?? { resolve }).resolve(rootDir, 'data');
  const brokerDir = (pathModule ?? { resolve }).resolve(rootDir, 'broker');
  const stackData = String(params.stackDevTargetMutagenDataDir ?? process.env.MUTAGEN_DATA_DIRECTORY ?? '').trim();
  if (stackData) {
    const normalizedStackData = resolvePathLike(stackData);
    if ([rootDir, dataDir, brokerDir].some((candidate) => pathsOverlap(candidate, normalizedStackData))) {
      throw new MutagenEngineArtifactError(
        'mutagen_engine_data_dir_conflict',
        `Managed Mutagen data must be isolated from the stack dev-target MUTAGEN_DATA_DIRECTORY (${normalizedStackData}).`,
      );
    }
  }
  return Object.freeze({ rootDir, dataDir, brokerDir });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    rejectManifest(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) rejectManifest(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}

function parseMutagenEngineChecksums(
  value: string,
  targetTriple: MutagenEngineArtifactTarget,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const executablePaths = resolveMutagenEngineExecutableRelativePaths(targetTriple);
  const expectedPaths = new Set([
    executablePaths.managerPath,
    executablePaths.agentPath,
    'licenses/MUTAGEN-LICENSE',
    'licenses/SSPL-LICENSE',
    'licenses/THIRD-PARTY-NOTICES',
    '.happier-mutagen-engine.json',
  ]);
  const lines = value.trim().split(/\r?\n/u);
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match || !expectedPaths.has(match[2]) || result.has(match[2])) {
      rejectPayload('checksums.txt has malformed, unexpected, or duplicate entries');
    }
    result.set(match[2], match[1]);
  }
  if (result.size !== expectedPaths.size || [...expectedPaths].some((path) => !result.has(path))) {
    rejectPayload('checksums.txt must contain the exact executable, license, notice, and manifest closure');
  }
  return result;
}

function resolveMutagenEngineExecutableRelativePaths(
  targetTriple: MutagenEngineArtifactTarget,
): Readonly<{
  managerPath: MutagenEngineManagerRelativePath;
  agentPath: MutagenEngineAgentRelativePath;
}> {
  if (!MUTAGEN_ENGINE_SUPPORTED_TARGETS.includes(targetTriple)) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_unsupported_platform',
      `Unsupported Mutagen engine target triple: ${String(targetTriple)}`,
    );
  }
  return targetTriple === 'windows-amd64'
    ? { managerPath: 'bin/happier-mutagen.exe', agentPath: 'bin/happier-mutagen-agent.exe' }
    : { managerPath: 'bin/happier-mutagen', agentPath: 'bin/happier-mutagen-agent' };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);
  if (!value) rejectManifest(`manifest ${key} is required`);
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== 'boolean') rejectManifest(`manifest ${key} must be boolean`);
  return record[key] as boolean;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    rejectManifest(`manifest ${key} must be a string array`);
  }
  return (value as string[]).map((entry) => entry.trim());
}

function assertExactBuildTags(
  actual: readonly string[],
  expected: readonly string[],
  label: 'manager' | 'agent' | 'aggregate',
): void {
  if (actual.length !== expected.length || actual.some((tag, index) => tag !== expected[index])) {
    rejectManifest(`manifest ${label} build tags must be exactly ${expected.join(', ')}`);
  }
}

function rejectManifest(message: string): never {
  throw new MutagenEngineArtifactError('mutagen_engine_artifact_untrusted', message);
}

function rejectPayload(message: string): never {
  throw new MutagenEngineArtifactError('mutagen_engine_artifact_incomplete', message);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    rejectPayload(`${label} is missing: ${path}`);
  }
  if (!stats.isFile()) rejectPayload(`${label} must be a regular file: ${path}`);
}

async function assertExecutable(path: string, label: string): Promise<void> {
  let mode = 0;
  try {
    mode = (await lstat(path)).mode;
  } catch {
    rejectPayload(`${label} is missing: ${path}`);
  }
  if ((mode & 0o111) === 0) rejectPayload(`${label} is not executable: ${path}`);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function isWindowsPathLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\');
}

function resolvePathLike(value: string): string {
  const raw = String(value ?? '').trim();
  return isWindowsPathLike(raw) ? win32.resolve(raw) : resolve(raw);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftCanonical = canonicalPath(left);
  const rightCanonical = canonicalPath(right);
  return leftCanonical === rightCanonical
    || leftCanonical.startsWith(`${rightCanonical}/`)
    || rightCanonical.startsWith(`${leftCanonical}/`);
}

function canonicalPath(path: string): string {
  const resolved = resolvePathLike(path).replaceAll('\\', '/').replace(/\/+$/u, '');
  return isWindowsPathLike(resolved) ? resolved.toLowerCase() : resolved;
}
