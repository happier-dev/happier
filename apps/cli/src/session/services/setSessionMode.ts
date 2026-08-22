import type { StoredCredentials } from '@/persistence';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

export async function setSessionMode(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  modeId: string;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionStateFieldForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    fieldId: 'intent.acpSessionMode',
    value: {
      v: 1,
      modeId: params.modeId || null,
      updatedAt,
    },
    metadataReason: 'cli-session-mode-set',
  });
}
