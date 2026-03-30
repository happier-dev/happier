import { computeNextMetadataStringOverrideV1, SESSION_MODE_OVERRIDE_KEY } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';

import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionMode(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  modeId: string;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) =>
      computeNextMetadataStringOverrideV1({
        metadata,
        overrideKey: SESSION_MODE_OVERRIDE_KEY,
        valueKey: 'modeId',
        value: params.modeId,
        updatedAt,
      }),
  });
}
