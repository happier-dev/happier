import type { FirstPartyComponentId } from './componentCatalog.js';
import { listInstalledVersionIdsNewestFirst } from './listInstalledVersionIdsNewestFirst.js';
import { promoteVersionedPayload, type FirstPartyPayloadPromotionResult } from './promoteVersionedPayload.js';
import { pruneRetainedVersions } from './pruneRetainedVersions.js';
import { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';

export async function installVersionedPayload(params: Readonly<{
  componentId: FirstPartyComponentId;
  versionId: string;
  payloadRoot: string;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<FirstPartyPayloadPromotionResult> {
  const promotion = await promoteVersionedPayload({
    componentId: params.componentId,
    versionId: params.versionId,
    stagedPayloadPath: params.payloadRoot,
    processEnv: params.processEnv,
  });

  await syncInstalledFirstPartyShims({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });

  const orderedVersionIdsNewestFirst = await listInstalledVersionIdsNewestFirst({
    componentId: params.componentId,
    processEnv: params.processEnv,
  });

  await pruneRetainedVersions({
    componentId: params.componentId,
    processEnv: params.processEnv,
    orderedVersionIdsNewestFirst,
    currentVersionId: promotion.currentVersionId,
    previousVersionId: promotion.previousVersionId,
  });

  return promotion;
}
