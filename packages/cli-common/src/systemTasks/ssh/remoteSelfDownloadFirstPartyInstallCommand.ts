import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { lookupSha256 } from '@happier-dev/release-runtime/checksums';

import {
  getFirstPartyComponentCatalogEntry,
  resolveFirstPartyComponentPublicReleaseVariant,
  type FirstPartyComponentId,
} from '../../firstPartyRuntime/componentCatalog.js';
import { safeBashSingleQuote } from '../../ssh/shellQuote.js';
import {
  buildRemoteFirstPartyPromotionCommand,
  normalizeRemoteFirstPartyHomeDir,
  resolveRemoteFirstPartyInstallLayout,
  resolveRemoteInstalledFirstPartyBinaryPath,
  sanitizeRemoteFirstPartyPathSegment,
} from './remoteFirstPartyInstallPath.js';
import { DEFAULT_MINISIGN_PUBLIC_KEY, verifyMinisign } from './minisignVerification.js';

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

type FetchImpl = typeof fetch;
type VerifyMinisignImpl = typeof verifyMinisign;

function normalizeChannel(value: unknown): PublicReleaseRingId {
  return normalizePublicReleaseRingId(value) || 'stable';
}

function readEnv(name: string): string {
  if (typeof process === 'undefined') {
    return '';
  }
  return String(process.env?.[name] ?? '').trim();
}

function buildGitHubReleaseTagUrl(githubRepo: string, tag: string): string {
  const repo = String(githubRepo ?? '').trim();
  const releaseTag = String(tag ?? '').trim();
  if (!repo) throw new Error('[native-ssh-bootstrap] githubRepo is required');
  if (!releaseTag) throw new Error('[native-ssh-bootstrap] release tag is required');
  return `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`;
}

async function fetchGitHubReleaseByTag(params: Readonly<{
  githubRepo: string;
  tag: string;
  userAgent: string;
  githubToken?: string;
  fetchImpl?: FetchImpl;
}>): Promise<unknown> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('[native-ssh-bootstrap] fetch is unavailable.');
  }
  const headers: Record<string, string> = {
    'user-agent': params.userAgent,
    accept: 'application/vnd.github+json',
  };
  const githubToken = String(params.githubToken ?? '').trim();
  if (githubToken) {
    headers.authorization = `Bearer ${githubToken}`;
  }
  const url = buildGitHubReleaseTagUrl(params.githubRepo, params.tag);
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`[native-ssh-bootstrap] failed to resolve release tag ${params.tag} (${response.status})`);
  }
  return await response.json();
}

async function fetchTextAsset(params: Readonly<{
  url: string;
  userAgent: string;
  fetchImpl?: FetchImpl;
}>): Promise<string> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('[native-ssh-bootstrap] fetch is unavailable.');
  }
  const response = await fetchImpl(params.url, {
    headers: {
      'user-agent': params.userAgent,
    },
  });
  if (!response.ok) {
    throw new Error(`[native-ssh-bootstrap] failed to download release asset (${response.status})`);
  }
  return await response.text();
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
    'if command -v curl >/dev/null 2>&1; then download() { curl -fsSL "$1" -o "$2"; }; elif command -v wget >/dev/null 2>&1; then download() { wget -qO "$2" "$1"; }; else echo "missing required command: curl or wget" >&2; exit 127; fi',
    'if command -v sha256sum >/dev/null 2>&1; then sha256_file() { sha256sum "$1" | awk \'{print $1}\'; }; elif command -v shasum >/dev/null 2>&1; then sha256_file() { shasum -a 256 "$1" | awk \'{print $1}\'; }; else echo "missing required command: sha256sum or shasum" >&2; exit 127; fi',
    `mkdir -p ${layout.remoteHomeDir}`,
    `stage="$(mktemp -d ${layout.remoteHomeDir}/bootstrap-self-download.XXXXXX)"`,
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
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  const bundle = resolveReleaseAssetBundle({
    assets: (release as { assets?: unknown }).assets,
    product: component.releaseProductName,
    os: params.os,
    arch: params.arch,
    preferZipOnWindows: false,
  });
  const checksumsText = await fetchTextAsset({
    url: bundle.checksums.url,
    userAgent,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  const checksumsSig = await fetchTextAsset({
    url: bundle.checksumsSig.url,
    userAgent,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
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
