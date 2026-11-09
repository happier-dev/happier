import { createHappierTempDir, removeHappierTempDirAsync } from '../tempDirs/createHappierTempDir.js';
import { join } from 'node:path';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { DEFAULT_MINISIGN_PUBLIC_KEY } from '@happier-dev/release-runtime/minisign';
import { downloadVerifiedReleaseAssetBundle } from '@happier-dev/release-runtime/verifiedDownload';

import type {
  FirstPartyReleaseArtifactSource,
  PreparedFirstPartyComponentPayload,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
import { extractReleasePayloadRootFromArchive } from './extractReleasePayloadRootFromArchive.js';
import {
  assertMutagenEngineArtifactPayload,
  MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
  MutagenEngineArtifactError,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineReleaseAssetBundle,
  resolveMutagenEngineReleaseTag,
} from './mutagenEngineArtifact.js';

const DEFAULT_MUTAGEN_ENGINE_RELEASE_REPOSITORY = 'happier-dev/mutagen';

/**
 * Prepare a manager/agent payload from an immutable Mutagen fork release.
 * Unlike the generic first-party helper this function requires an explicit
 * engine version and never resolves a rolling release-ring tag.
 */
export async function prepareMutagenEnginePayloadFromGitHubRelease(params: Readonly<{
  channel: PublicReleaseRingId;
  engineVersion: string;
  os?: string;
  arch?: string;
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
  minisignPubkeyFile?: string;
}>): Promise<PreparedFirstPartyComponentPayload> {
  if (MUTAGEN_ENGINE_FORK_RELEASE_COMMIT == null) {
    throw new MutagenEngineArtifactError(
      'mutagen_engine_artifact_untrusted',
      'mutagen_fork_release_commit_required: the current fork implementation has no immutable release commit.',
    );
  }
  const engineVersion = String(params.engineVersion ?? '').trim();
  const releaseTag = resolveMutagenEngineReleaseTag(engineVersion);
  const target = resolveMutagenEngineArtifactTarget({
    platform: normalizeReleasePlatform(params.os),
    arch: params.arch,
  });
  const source = resolveReleaseSource(params);
  const scratchRoot = createHappierTempDir({ purpose: 'mutagen-engine' });

  try {
    const bundle = resolveMutagenEngineReleaseAssetBundle({
      githubRepo: source.githubRepo,
      engineVersion,
      targetTriple: target,
    });
    const downloaded = await downloadVerifiedReleaseAssetBundle({
      bundle,
      destDir: join(scratchRoot, 'download'),
      pubkeyFile: String(params.minisignPubkeyFile ?? '').trim() || DEFAULT_MINISIGN_PUBLIC_KEY,
      userAgent: source.userAgent,
    }).catch((error) => {
      throw artifactError(`failed to download verified Mutagen engine release ${releaseTag}`, error);
    });
    const payloadRoot = await extractReleasePayloadRootFromArchive({
      archivePath: downloaded.archivePath,
      archiveName: downloaded.archiveName,
      extractDir: join(scratchRoot, 'extract'),
    }).catch((error) => {
      throw artifactError(`failed to extract verified Mutagen engine release ${releaseTag}`, error);
    });
    await assertMutagenEngineArtifactPayload({
      payloadRoot,
      targetTriple: target,
      engineVersion,
    });
    return {
      componentId: 'mutagen-engine',
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
    throw error;
  }
}

function normalizeReleasePlatform(value: unknown): string {
  const normalized = String(value ?? process.platform).trim().toLowerCase();
  if (normalized === 'mac' || normalized === 'macos') return 'darwin';
  if (normalized === 'windows') return 'win32';
  return normalized;
}

function resolveReleaseSource(params: Readonly<{
  artifactSource?: FirstPartyReleaseArtifactSource;
  githubRepo?: string;
  githubToken?: string;
  userAgent?: string;
}>): Readonly<{ githubRepo: string; userAgent: string }> {
  const source = params.artifactSource?.kind === 'github-release' ? params.artifactSource : null;
  return {
    githubRepo: normalize(
      source?.githubRepo
        ?? params.githubRepo
        ?? process.env.HAPPIER_MUTAGEN_ENGINE_RELEASE_REPO
        ?? process.env.HAPPIER_FIRST_PARTY_RELEASE_REPO
        ?? DEFAULT_MUTAGEN_ENGINE_RELEASE_REPOSITORY,
      DEFAULT_MUTAGEN_ENGINE_RELEASE_REPOSITORY,
    ),
    userAgent: normalize(
      source?.userAgent
        ?? params.userAgent
        ?? process.env.HAPPIER_MUTAGEN_ENGINE_RELEASE_USER_AGENT
        ?? 'happier-mutagen-engine-runtime',
      'happier-mutagen-engine-runtime',
    ),
  };
}

function normalize(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function artifactError(context: string, error: unknown): MutagenEngineArtifactError {
  const detail = error instanceof Error ? error.message : String(error);
  return new MutagenEngineArtifactError('mutagen_engine_artifact_untrusted', `${context}: ${detail}`);
}
