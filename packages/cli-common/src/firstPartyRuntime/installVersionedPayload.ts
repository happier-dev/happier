import type { FirstPartyComponentId } from './componentCatalog.js';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { listInstalledVersionIdsNewestFirst } from './listInstalledVersionIdsNewestFirst.js';
import { promoteVersionedPayload, type FirstPartyPayloadPromotionResult } from './promoteVersionedPayload.js';
import { pruneRetainedVersions } from './pruneRetainedVersions.js';
import { shouldPersistDefaultManagedReleaseChannel, writeDefaultManagedReleaseChannel } from './defaultReleaseChannelState.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';

export async function installVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  channel?: PublicReleaseRingId;
  releaseRing?: PublicReleaseRingId;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const promotion = await promoteVersionedPayload({
    componentId: params.componentId,
    versionId: params.versionId,
    stagedPayloadPath: params.payloadRoot,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  const releaseChannel = params.channel ?? params.releaseRing ?? 'stable';

  await syncInstalledFirstPartyShims({
    componentId: params.componentId,
    channel: params.channel,
    defaultReleaseChannelOverride: releaseChannel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  if (shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
    await writeDefaultManagedReleaseChannel({
      releaseChannel,
      processEnv: params.processEnv,
    });
  }

  const orderedVersionIdsNewestFirst = await listInstalledVersionIdsNewestFirst({
    componentId: params.componentId,
    channel: params.channel,
    releaseRing: params.releaseRing,
    processEnv: params.processEnv,
  });

  await pruneRetainedVersions({
    componentId: params.componentId,
    processEnv: params.processEnv,
    channel: params.channel,
    releaseRing: params.releaseRing,
    orderedVersionIdsNewestFirst,
    currentVersionId: promotion.currentVersionId,
    previousVersionId: promotion.previousVersionId,
  });

  return promotion;
}
