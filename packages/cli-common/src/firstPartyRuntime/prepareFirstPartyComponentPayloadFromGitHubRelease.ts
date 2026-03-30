import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { resolveReleaseAssetBundle } from '@happier-dev/release-runtime/assets';
import { fetchGitHubReleaseByTag } from '@happier-dev/release-runtime/github';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';

import type { FirstPartyComponentId } from './componentCatalog.js';
import {
  getFirstPartyComponentCatalogEntry,
  resolveFirstPartyComponentPublicReleaseVariant,
} from './componentCatalog.js';
import { extractReleasePayloadRootFromArchive } from './extractReleasePayloadRootFromArchive.js';

export interface PreparedFirstPartyComponentPayload {
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  versionId: string;
  payloadRoot: string;
  source: string | null;
  cleanup: () => Promise<void>;
}

export type FirstPartyReleaseArtifactSource = Readonly<{
  kind: 'github-release';
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
}>;

function normalizeReleaseAssetOs(value: unknown): 'linux' | 'darwin' | 'windows' {
  const normalized = String(value ?? process.platform).trim().toLowerCase();
  if (normalized === 'linux') return 'linux';
  if (normalized === 'darwin' || normalized === 'macos' || normalized === 'mac') return 'darwin';
  if (normalized === 'windows' || normalized === 'win32') return 'windows';
  throw new Error(`Unsupported first-party release OS: ${normalized}`);
}

function normalizeReleaseAssetArch(value: unknown): 'x64' | 'arm64' {
  const normalized = String(value ?? process.arch).trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64' || normalized === 'x86_64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  throw new Error(`Unsupported first-party release architecture: ${normalized}`);
}

export async function prepareFirstPartyComponentPayloadFromGitHubRelease(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  os?: string;
  arch?: string;
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  minisignPubkeyFile?: string;
}>): Promise<PreparedFirstPartyComponentPayload> {
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel: params.channel,
  });
  const os = normalizeReleaseAssetOs(params.os);
  const arch = normalizeReleaseAssetArch(params.arch);
  const source = resolveFirstPartyReleaseArtifactSource(params);
  const githubRepo = source.githubRepo;
  const githubToken = source.githubToken;
  const userAgent = source.userAgent;
  const scratchRoot = await mkdtemp(join(tmpdir(), `happier-first-party-${params.componentId}-`));

  try {
    const release = await fetchGitHubReleaseByTag({
      githubRepo,
      tag: variant.releaseTag,
      githubToken,
      userAgent,
    }).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'resolve release tag',
        githubRepo,
        releaseTag: variant.releaseTag,
        githubToken,
        error,
      });
    });
    const bundle = await Promise.resolve().then(() => resolveReleaseAssetBundle({
      assets: (release as { assets?: unknown }).assets,
      product: component.releaseProductName,
      os,
      arch,
      preferZipOnWindows: true,
    })).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'resolve release assets',
        githubRepo,
        releaseTag: variant.releaseTag,
        githubToken,
        error,
      });
    });
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: join(scratchRoot, 'download'),
      pubkeyFile: String(params.minisignPubkeyFile ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY,
      userAgent,
    }).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'download release assets',
        githubRepo,
        releaseTag: variant.releaseTag,
        githubToken,
        error,
      });
    });
    const payloadRoot = await extractReleasePayloadRootFromArchive({
      archivePath: downloaded.archivePath,
      archiveName: downloaded.archiveName,
      extractDir: join(scratchRoot, 'extract'),
    }).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'extract release payload',
        githubRepo,
        releaseTag: variant.releaseTag,
        githubToken,
        error,
      });
    });

    return {
      componentId: params.componentId,
      channel: params.channel,
      versionId: bundle.version,
      payloadRoot,
      source: bundle.archive.url,
      cleanup: async () => {
        await rm(scratchRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(scratchRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveFirstPartyReleaseArtifactSource(params: Readonly<{
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
}>): Readonly<{
  githubRepo: string;
  githubToken: string;
  userAgent: string;
}> {
  const source = params.artifactSource?.kind === 'github-release' ? params.artifactSource : null;
  return {
    githubRepo: normalizeFirstPartyReleaseValue(
      source?.githubRepo
        ?? params.githubRepo
        ?? process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO
        ?? process.env.HAPPIER_GITHUB_REPO
        ?? 'happier-dev/happier',
      'happier-dev/happier',
    ),
    githubToken: normalizeFirstPartyReleaseValue(
      source?.githubToken
        ?? params.githubToken
        ?? process.env.HAPPIER_FIRST_PARTY_RELEASE_TOKEN
        ?? process.env.HAPPIER_GITHUB_TOKEN
        ?? process.env.GITHUB_TOKEN
        ?? process.env.GH_TOKEN
        ?? '',
      '',
    ),
    userAgent: normalizeFirstPartyReleaseValue(
      source?.userAgent
        ?? params.userAgent
        ?? process.env.HAPPIER_FIRST_PARTY_RELEASE_USER_AGENT
        ?? 'happier-first-party-runtime',
      'happier-first-party-runtime',
    ),
  };
}

function normalizeFirstPartyReleaseValue(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function wrapFirstPartyReleaseSourceError(params: Readonly<{
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  stage: 'resolve release tag' | 'resolve release assets' | 'download release assets' | 'extract release payload';
  githubRepo: string;
  releaseTag: string;
  githubToken: string;
  error: unknown;
}>): Error {
  const status = readHttpStatus(params.error);
  const rawMessage = params.error instanceof Error && params.error.message.trim()
    ? params.error.message.trim()
    : String(params.error ?? '').trim();
  const tokenHint = params.githubToken
    ? 'Verify the repository, release tag, and release assets.'
    : 'No GitHub token was configured; if the release repository is private, set HAPPIER_FIRST_PARTY_RELEASE_TOKEN, HAPPIER_GITHUB_TOKEN, or GH_TOKEN.';
  const statusHint =
    status === 404
      ? 'GitHub returned 404, which usually means the repository is private, the tag is missing, or the token does not have release access.'
      : status === 401 || status === 403
        ? 'GitHub rejected the request, which usually means the token is missing or does not have release access.'
        : '';
  const message = [
    `[first-party-release] Failed to ${params.stage} for ${params.componentId} (${params.channel}) from ${params.githubRepo}@${params.releaseTag}.`,
    statusHint,
    tokenHint,
    rawMessage ? `Details: ${rawMessage}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return createStatusAwareError(message, status);
}

function createStatusAwareError(message: string, status: number | null): Error {
  const error = new Error(message);
  if (status != null) {
    Reflect.set(error, 'status', status);
  }
  return error;
}

function readHttpStatus(error: unknown): number | null {
  const statusValue = typeof error === 'object' && error != null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : NaN;
  if (Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599) {
    return statusValue;
  }
  return null;
}
