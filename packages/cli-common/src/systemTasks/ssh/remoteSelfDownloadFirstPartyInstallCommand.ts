import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { lookupSha256 } from '@happier-dev/release-runtime/checksums';
import { DEFAULT_MINISIGN_PUBLIC_KEY, verifyMinisign } from '@happier-dev/release-runtime/minisign';
import { fetchGitHubReleaseByTag, GitHubReleaseRateLimitError } from '@happier-dev/release-runtime/github';
import { SystemTaskExecutionError } from '../runSystemTask.js';

import {
  getFirstPartyComponentCatalogEntry,
  resolveFirstPartyComponentPublicReleaseVariant,
  type FirstPartyComponentId,
} from '../../firstPartyRuntime/componentCatalog.js';
import { quoteRemotePathWithHomeExpansion, safeBashSingleQuote } from '../../ssh/shellQuote.js';
import {
  buildRemoteFirstPartyPromotionCommand,
  normalizeRemoteFirstPartyHomeDir,
  pruneRemoteFirstPartyVersions,
  resolveRemoteFirstPartyInstallLayout,
  resolveRemoteInstalledFirstPartyBinaryPath,
  sanitizeRemoteFirstPartyPathSegment,
} from './remoteFirstPartyInstallPath.js';

type RemoteInstallAsset = Readonly<{
  name: string;
  url: string;
}>;

export type RemoteSelfDownloadFirstPartyInstallPlan = Readonly<{
  binaryPath: string;
  command: string;
  source: string;
  versionId: string;
}>;

/** Execute every self-download carrier through the same pre/post retention operation. */
export async function executeRemoteSelfDownloadFirstPartyInstallPlan(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  remoteHomeDir?: string;
  plan: RemoteSelfDownloadFirstPartyInstallPlan;
  runRemoteText: (command: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
}>): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  const layout = resolveRemoteFirstPartyInstallLayout({ ...params, versionId: params.plan.versionId });
  const prune = () => pruneRemoteFirstPartyVersions({ layout, runRemoteText: params.runRemoteText });
  await prune();
  const result = await params.runRemoteText(params.plan.command);
  if (result.status === 0) await prune();
  return result;
}

type FetchImpl = typeof fetch;
type VerifyMinisignImpl = typeof verifyMinisign;

const REMOTE_DOWNLOAD_FUNCTION = 'if command -v curl >/dev/null 2>&1; then download() { curl -fsSL "$1" -o "$2"; }; elif command -v wget >/dev/null 2>&1; then download() { wget -qO "$2" "$1"; }; else echo "missing required command: curl or wget" >&2; exit 127; fi';

function normalizeChannel(value: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(value) || 'stable';
}

function readEnv(name: string): string {
  if (typeof process === 'undefined') {
    return '';
  }
  return String(process.env?.[name] ?? '').trim();
}

async function readRemoteReleaseTextAsset(params: Readonly<{
  url: string;
  runRemoteText: (command: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
}>): Promise<string> {
  // The guest already downloads the archive. Read its signed integrity files
  // through that same transport: GitHub download redirects do not support CORS.
  const url = safeBashSingleQuote(params.url);
  const result = await params.runRemoteText(`${REMOTE_DOWNLOAD_FUNCTION}; download ${url} -`);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || '[native-ssh-bootstrap] failed to download release asset');
  }
  return result.stdout;
}

export function buildRemoteSelfDownloadFirstPartyInstallCommand(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  versionId: string;
  archive: RemoteInstallAsset;
  expectedSha256: string;
  remoteHomeDir?: string;
}>): string {
  const channel = normalizeChannel(params.channel);
  const layout = resolveRemoteFirstPartyInstallLayout({
    componentId: params.componentId,
    channel,
    versionId: params.versionId,
    remoteHomeDir: params.remoteHomeDir,
  });
  const archiveName = sanitizeRemoteFirstPartyPathSegment(params.archive.name);
  const expectedSha256 = String(params.expectedSha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new Error('[native-ssh-bootstrap] expectedSha256 must be a SHA-256 hex digest.');
  }

  return [
    'set -eu',
    'require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 127; }; }',
    'require_cmd tar',
    REMOTE_DOWNLOAD_FUNCTION,
    'if command -v sha256sum >/dev/null 2>&1; then sha256_file() { sha256sum "$1" | awk \'{print $1}\'; }; elif command -v shasum >/dev/null 2>&1; then sha256_file() { shasum -a 256 "$1" | awk \'{print $1}\'; }; else echo "missing required command: sha256sum or shasum" >&2; exit 127; fi',
    `mkdir -p ${quoteRemotePathWithHomeExpansion(layout.remoteHomeDir)}`,
    `stage="$(mktemp -d ${quoteRemotePathWithHomeExpansion(`${layout.remoteHomeDir}/bootstrap-self-download.XXXXXX`)})"`,
    'cleanup() { rm -rf "$stage"; }',
    'trap cleanup EXIT',
    'archive_path="$stage/archive"',
    `download ${safeBashSingleQuote(params.archive.url)} "$archive_path"`,
    `archive_name=${safeBashSingleQuote(archiveName)}`,
    `expected_sha=${safeBashSingleQuote(expectedSha256)}`,
    'actual_sha="$(sha256_file "$archive_path")"',
    'if [ "$expected_sha" != "$actual_sha" ]; then echo "checksum verification failed" >&2; exit 1; fi',
    'extract_root="$stage/extract"',
    'mkdir -p "$extract_root"',
    'tar -xf "$archive_path" -C "$extract_root"',
    'payload_root="$(find "$extract_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"',
    'if [ -z "$payload_root" ]; then echo "release payload root not found" >&2; exit 1; fi',
    buildRemoteFirstPartyPromotionCommand({
      layout,
      payloadRootExpression: '"$payload_root"',
    }),
  ].join('; ');
}

export async function resolveRemoteSelfDownloadFirstPartyInstallPlan(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel?: string;
  os: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  minisignPublicKey?: string;
  remoteHomeDir?: string;
  fetchImpl?: FetchImpl;
  verifyMinisign?: VerifyMinisignImpl;
  runRemoteText: (command: string) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
}>): Promise<RemoteSelfDownloadFirstPartyInstallPlan> {
  const channel = normalizeChannel(params.channel);
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel,
  });
  const githubRepo = String(params.githubRepo ?? readEnv('HAPPIER_FIRST_PARTY_RELEASE_REPO') ?? readEnv('HAPPIER_GITHUB_REPO') ?? 'happier-dev/happier').trim() || 'happier-dev/happier';
  const githubToken = String(params.githubToken ?? readEnv('HAPPIER_FIRST_PARTY_RELEASE_TOKEN') ?? readEnv('HAPPIER_GITHUB_TOKEN') ?? readEnv('GITHUB_TOKEN') ?? readEnv('GH_TOKEN') ?? '').trim();
  const userAgent = String(params.userAgent ?? readEnv('HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT') ?? 'happier-native-ssh-bootstrap').trim() || 'happier-native-ssh-bootstrap';
  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    githubToken,
    tag: variant.releaseTag,
    userAgent,
    transientNotFoundAttempts: 1,
    fetchImpl: params.fetchImpl ?? globalThis.fetch,
  }).catch((error: unknown) => {
    // Translate the release owner's closed refusal once into the task contract,
    // which all managed/SSH hosts already preserve without exposing raw output.
    if (error instanceof GitHubReleaseRateLimitError) throw new SystemTaskExecutionError(error.code, error.message);
    throw error;
  });
  const bundle = resolveReleaseAssetBundle({
    assets: (release as { assets?: unknown }).assets,
    product: component.releaseProductName,
    os: params.os,
    arch: params.arch,
    preferZipOnWindows: false,
  });
  const checksumsText = await readRemoteReleaseTextAsset({
    url: bundle.checksums.url,
    runRemoteText: params.runRemoteText,
  });
  const checksumsSig = await readRemoteReleaseTextAsset({
    url: bundle.checksumsSig.url,
    runRemoteText: params.runRemoteText,
  });
  const verify = params.verifyMinisign ?? verifyMinisign;
  const minisignPublicKey = String(params.minisignPublicKey ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY;
  if (!verify({
    message: checksumsText,
    pubkeyFile: minisignPublicKey,
    sigFile: checksumsSig,
  })) {
    throw new Error('[native-ssh-bootstrap] release checksums signature verification failed');
  }
  const expectedSha256 = lookupSha256({
    checksumsText,
    filename: bundle.archive.name,
  });
  const command = buildRemoteSelfDownloadFirstPartyInstallCommand({
    componentId: params.componentId,
    channel,
    versionId: bundle.version,
    archive: bundle.archive,
    expectedSha256,
    ...(params.remoteHomeDir ? { remoteHomeDir: params.remoteHomeDir } : {}),
  });

  return {
    binaryPath: resolveRemoteInstalledFirstPartyBinaryPath({
      componentId: params.componentId,
      channel,
      ...(params.remoteHomeDir ? { remoteHomeDir: params.remoteHomeDir } : {}),
    }),
    command,
    source: bundle.archive.url,
    versionId: bundle.version,
  };
}
