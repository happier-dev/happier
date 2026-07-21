import { computeNextModelOverrideMetadataV1 } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';

import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionModel(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  modelId: string;
  updatedAt?: number;
  retireModelScopedConfigOverrides: boolean;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) =>
      computeNextModelOverrideMetadataV1({
        metadata,
        modelId: params.modelId,
        updatedAt,
        retireModelScopedConfigOverrides: params.retireModelScopedConfigOverrides,
      }),
  });
}
