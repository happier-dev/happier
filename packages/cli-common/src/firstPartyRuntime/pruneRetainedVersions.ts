import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { resolveRetainedVersionIds } from './retentionPolicy.js';
import { FIRST_PARTY_VERSION_UNUSED_SHELL_FUNCTION } from './versionUse.js';
import { execFileWithDeadline } from '../process/execFileWithDeadline.js';

export interface FirstPartyPruneRetainedVersionsResult {
  keptVersionIds: string[];
  prunedVersionIds: string[];
  skippedVersionIds: string[];
}

const VERSION_PRUNE_MAX_ATTEMPTS = 6;
const VERSION_PRUNE_RETRY_DELAY_MS = 25;
const RETRYABLE_VERSION_PRUNE_ERROR_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

function isRetryableVersionPruneError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  return typeof code === 'string' && RETRYABLE_VERSION_PRUNE_ERROR_CODES.has(code);
}

async function pruneVersionPathBestEffort(versionPath: string): Promise<boolean> {
  // Windows retains locked payloads through the existing native removal errors below.
  // POSIX permits unlinking live executables, so obtain native file-use evidence first.
  if (process.platform !== 'win32') {
    const unused = await execFileWithDeadline('/bin/sh', [
      '-c', `${FIRST_PARTY_VERSION_UNUSED_SHELL_FUNCTION}; is_version_unused "$happier_retention_path"`,
    ], { env: { ...process.env, happier_retention_path: versionPath } }).then(() => true, () => false);
    if (!unused) return false;
  }
  for (let attemptNumber = 1; attemptNumber <= VERSION_PRUNE_MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      await rm(versionPath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!isRetryableVersionPruneError(error)) {
        throw error;
      }
      if (attemptNumber === VERSION_PRUNE_MAX_ATTEMPTS) {
        return false;
      }
      await sleep(VERSION_PRUNE_RETRY_DELAY_MS);
    }
  }

  return false;
}

export async function pruneRetainedVersions(params: Readonly<{
  componentId: FirstPartyComponentId;
  orderedVersionIdsNewestFirst: readonly string[];
  currentVersionId: string | null;
  previousVersionId?: string | null;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
  retainCount?: number;
}>): Promise<FirstPartyPruneRetainedVersionsResult> {
  const { keep, prune } = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst: params.orderedVersionIdsNewestFirst,
    currentVersionId: params.currentVersionId,
    previousVersionId: params.previousVersionId,
    retainCount: params.retainCount,
  });

  const prunedVersionIds: string[] = [];
  const skippedVersionIds: string[] = [];
  for (const versionId of prune) {
    const versionPath = resolveFirstPartyVersionInstallPath({
      componentId: params.componentId,
      versionId,
      channel: params.channel,
      releaseRing: params.releaseRing,
      processEnv: params.processEnv,
    });
    if (await pruneVersionPathBestEffort(versionPath)) {
      prunedVersionIds.push(versionId);
    } else {
      skippedVersionIds.push(versionId);
    }
  }

  return {
    keptVersionIds: keep,
    prunedVersionIds,
    skippedVersionIds,
  };
}
