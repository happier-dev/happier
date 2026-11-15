import { createHappierTempDir, removeHappierTempDirAsync } from '../tempDirs/createHappierTempDir.js';
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
import { FirstPartyAcquisitionError, readAcquisitionFailureCause, type FirstPartyAcquisitionOptions } from './acquisitionProgress.js';
import type { CliAcquisitionProgress } from '@happier-dev/protocol';
import { prepareMutagenEnginePayloadFromGitHubRelease } from './prepareMutagenEnginePayloadFromGitHubRelease.js';
import { MutagenEngineArtifactError } from './mutagenEngineArtifact.js';
import { resolveFirstPartyReleaseArtifactSource, type FirstPartyReleaseArtifactSource } from './releaseArtifactSource.js';

export interface PreparedFirstPartyComponentPayload {
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  versionId: string;
  payloadRoot: string;
  source: string | null;
  cleanup: () => Promise<void>;
}

export type { FirstPartyReleaseArtifactSource } from './releaseArtifactSource.js';

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

export type ResolvedFirstPartyComponentRelease = Readonly<{
  versionId: string;
  bundle: Awaited<ReturnType<typeof resolveReleaseAssetBundle>>;
  source: Readonly<{ githubRepo: string; githubToken: string; userAgent: string; releaseTag: string }>;
}>;

/**
 * The channel's (or an exact version's) release and this platform's asset bundle, without
 * downloading it. The one latest-version lookup for binary installs — `happier self check` and the
 * acquisition below both use it, on every OS the release publishes (Windows included, plan R13 S-5).
 */
export async function resolveFirstPartyComponentRelease(params: Readonly<{
  componentId: Exclude<FirstPartyComponentId, 'mutagen-engine'>;
  channel: PublicReleaseRingId;
  versionId?: string;
  os?: string;
  arch?: string;
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  signal?: AbortSignal;
}>): Promise<ResolvedFirstPartyComponentRelease> {
  const component = getFirstPartyComponentCatalogEntry(params.componentId);
  const variant = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: params.componentId,
    channel: params.channel,
  });
  const versionId = params.versionId?.trim();
  if (params.versionId !== undefined && (!versionId || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionId))) {
    throw new Error('[first-party-release] versionId must be an exact release version');
  }
  const releaseTag = versionId ? `${component.rollingReleasePrefix}-v${versionId}` : variant.releaseTag;
  const os = normalizeReleaseAssetOs(params.os);
  const arch = normalizeReleaseAssetArch(params.arch);
  const source = resolveFirstPartyReleaseArtifactSource(params);
  const githubRepo = source.githubRepo;
  const githubToken = source.githubToken;
  const userAgent = source.userAgent;
  params.signal?.throwIfAborted();
  const release = await fetchGitHubReleaseByTag({
    githubRepo,
    apiBaseUrl: source.apiBaseUrl,
    tag: releaseTag,
    // Public release asset pages carry the names and SHA-256 digests this
    // asset-only consumer needs, without spending GitHub's shared-IP REST
    // quota. Authenticated and development-mirror sources keep the API path.
    assetsOnly: !githubToken && source.apiBaseUrl === undefined,
    githubToken,
    userAgent,
    signal: params.signal,
  }).catch((error) => {
    throw wrapFirstPartyReleaseSourceError({
      componentId: params.componentId,
      channel: params.channel,
      stage: 'resolve release tag',
      githubRepo,
      releaseTag,
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
      releaseTag,
      githubToken,
      error,
    });
  });
  if (versionId && bundle.version !== versionId) {
    throw new Error(`[first-party-release] Expected version ${versionId} for ${params.componentId}, received ${bundle.version}`);
  }
  return { versionId: bundle.version, bundle, source: { githubRepo, githubToken, userAgent, releaseTag } };
}

export async function prepareFirstPartyComponentPayloadFromGitHubRelease(params: FirstPartyAcquisitionOptions & Readonly<{
  componentId: FirstPartyComponentId;
  channel: PublicReleaseRingId;
  versionId?: string;
  os?: string;
  arch?: string;
  engineVersion?: string;
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  minisignPubkeyFile?: string;
}>): Promise<PreparedFirstPartyComponentPayload> {
  if (params.componentId === 'mutagen-engine') {
    const engineVersion = String(params.engineVersion ?? process.env.HAPPIER_MUTAGEN_ENGINE_VERSION ?? '').trim();
    if (!engineVersion) {
      throw new MutagenEngineArtifactError(
        'mutagen_engine_artifact_untrusted',
        '[first-party-release] mutagen-engine requires an explicit HAPPIER_MUTAGEN_ENGINE_VERSION or engineVersion; rolling release tags are not supported.',
      );
    }
    return await prepareMutagenEnginePayloadFromGitHubRelease({
      ...params,
      engineVersion,
    });
  }
  params.signal?.throwIfAborted();
  let phase: CliAcquisitionProgress['phase'] = 'resolvingRelease';
  const report = (progress: CliAcquisitionProgress) => {
    phase = progress.phase;
    params.onProgress?.(progress);
  };
  report({ phase });
  const scratchRoot = createHappierTempDir({ purpose: `first-party-${params.componentId}` });

  try {
    const { bundle, source: { githubRepo, githubToken, userAgent, releaseTag } } = await resolveFirstPartyComponentRelease({ ...params, componentId: params.componentId });
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: join(scratchRoot, 'download'),
      pubkeyFile: String(params.minisignPubkeyFile ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY,
      userAgent,
      signal: params.signal,
      onProgress: report,
    }).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'download release assets',
        githubRepo,
        releaseTag,
        githubToken,
        error,
      });
    });
    report({ phase: 'unpacking' });
    const payloadRoot = await extractReleasePayloadRootFromArchive({
      archivePath: downloaded.archivePath,
      archiveName: downloaded.archiveName,
      extractDir: join(scratchRoot, 'extract'),
      signal: params.signal,
    }).catch((error) => {
      throw wrapFirstPartyReleaseSourceError({
        componentId: params.componentId,
        channel: params.channel,
        stage: 'extract release payload',
        githubRepo,
        releaseTag,
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
        await removeHappierTempDirAsync(scratchRoot);
      },
    };
  } catch (error) {
    await removeHappierTempDirAsync(scratchRoot);
    params.signal?.throwIfAborted();
    throw new FirstPartyAcquisitionError(phase, readAcquisitionFailureCause(error), error);
  }
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
  const shouldSuggestToken = !params.githubToken && (
    status === 401
    || status === 403
    || (status === 404 && params.stage === 'resolve release tag')
  );
  const tokenHint = shouldSuggestToken
    ? 'No GitHub token was configured; if the release repository is private, set HAPPIER_FIRST_PARTY_RELEASE_TOKEN, HAPPIER_GITHUB_TOKEN, or GH_TOKEN.'
    : 'Verify the repository, release tag, and release assets.';
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
  return createStatusAwareError(message, status, params.error);
}

function createStatusAwareError(message: string, status: number | null, cause: unknown): Error {
  const error = new Error(message, { cause });
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
