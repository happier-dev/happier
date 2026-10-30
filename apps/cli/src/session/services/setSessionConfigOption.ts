import { computeNextMetadataConfigOptionOverrideV1 } from '@happier-dev/agents';
import type { Credentials } from '@/persistence';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionConfigOption(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  configId: string;
  valueId: string;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) => computeNextMetadataConfigOptionOverrideV1({
      metadata, configId: params.configId, value: params.valueId, updatedAt,
    }),
  });
}
