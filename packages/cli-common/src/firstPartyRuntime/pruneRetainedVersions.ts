import { rm } from 'node:fs/promises';

import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyVersionInstallPath } from './installLayout.js';
import { resolveRetainedVersionIds } from './retentionPolicy.js';

export interface FirstPartyPruneRetainedVersionsResult {
  keptVersionIds: string[];
  prunedVersionIds: string[];
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

  await Promise.all(
    prune.map(async (versionId) => {
      const versionPath = resolveFirstPartyVersionInstallPath({
        componentId: params.componentId,
        versionId,
        channel: params.channel,
        releaseRing: params.releaseRing,
        processEnv: params.processEnv,
      });
      await rm(versionPath, { recursive: true, force: true });
    }),
  );

  return {
    keptVersionIds: keep,
    prunedVersionIds: prune,
  };
}
