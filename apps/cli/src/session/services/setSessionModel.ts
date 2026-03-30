import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';

import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionModel(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  modelId: string;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) =>
      computeNextMetadataStringOverrideV1({
        metadata,
        overrideKey: 'modelOverrideV1',
        valueKey: 'modelId',
        value: params.modelId,
        updatedAt,
      }),
  });
}
