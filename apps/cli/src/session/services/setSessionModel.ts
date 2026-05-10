import type { Credentials } from '@/persistence';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

export async function setSessionModel(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  modelId: string;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionStateFieldForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    fieldId: 'intent.model',
    value: {
      v: 1,
      modelId: params.modelId || null,
      updatedAt,
    },
    metadataReason: 'cli-session-model-set',
  });
}
