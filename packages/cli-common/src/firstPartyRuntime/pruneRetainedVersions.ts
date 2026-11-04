import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallLayout, resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { resolveRetainedVersionIds } from './retentionPolicy.js';
import { FIRST_PARTY_VERSION_USE_SHELL_FUNCTIONS } from './versionUse.js';
import { execFileWithDeadline } from '../process/execFileWithDeadline.js';

export interface FirstPartyPruneRetainedVersionsResult {
  keptVersionIds: string[];
  prunedVersionIds: string[];
  skippedVersionIds: string[];
}

const VERSION_PRUNE_MAX_ATTEMPTS = 6;
const VERSION_PRUNE_RETRY_DELAY_MS = 25;
const RETRYABLE_VERSION_PRUNE_ERROR_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

export function warnFirstPartyRetentionObservationUnavailable(onWarning?: (message: string) => void): void {
  const message = 'Skipped older payload cleanup because ps/lsof could not establish whether versions are in use; older versions were retained.';
  if (onWarning) onWarning(message);
  else process.stderr.write(`[happier] ${message}\n`);
}

function isRetryableVersionPruneError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  return typeof code === 'string' && RETRYABLE_VERSION_PRUNE_ERROR_CODES.has(code);
}

async function pruneVersionPathBestEffort(versionPath: string): Promise<boolean> {
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
  onWarning?: (message: string) => void;
}>): Promise<FirstPartyPruneRetainedVersionsResult> {
  const { keep, prune } = resolveRetainedVersionIds({
    orderedVersionIdsNewestFirst: params.orderedVersionIdsNewestFirst,
    currentVersionId: params.currentVersionId,
    previousVersionId: params.previousVersionId,
    retainCount: params.retainCount,
  });

  const prunedVersionIds: string[] = [];
  const skippedVersionIds: string[] = [];
  // Windows retains locked payloads through native removal errors. POSIX permits
  // unlinking live executables, so observe all candidates once before removal.
  let unusedVersionIds: Set<string> | null = new Set(prune);
  if (process.platform !== 'win32' && prune.length > 0) {
    const { versionsDir } = resolveFirstPartyInstallLayout(params);
    unusedVersionIds = await execFileWithDeadline('/bin/sh', [
      '-c', `${FIRST_PARTY_VERSION_USE_SHELL_FUNCTIONS}
if ! observe_version_use "$happier_retention_root"; then exit 1; fi
for version_id do
  if is_version_unused "$happier_retention_root/$version_id"; then printf '%s\\n' "$version_id"; fi
done`,
      'happier-version-retention', ...prune,
    ], { env: { ...process.env, happier_retention_root: versionsDir } })
      .then(({ stdout }) => new Set(String(stdout).split('\n').filter(Boolean)), () => null);
  }
  for (const versionId of prune) {
    const versionPath = resolveFirstPartyVersionInstallPath({
      componentId: params.componentId,
      versionId,
      channel: params.channel,
      releaseRing: params.releaseRing,
      processEnv: params.processEnv,
    });
    if (unusedVersionIds?.has(versionId) && await pruneVersionPathBestEffort(versionPath)) {
      prunedVersionIds.push(versionId);
    } else {
      skippedVersionIds.push(versionId);
    }
  }
  if (unusedVersionIds === null) warnFirstPartyRetentionObservationUnavailable(params.onWarning);

  return {
    keptVersionIds: keep,
    prunedVersionIds,
    skippedVersionIds,
  };
}
