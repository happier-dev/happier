import type { PermissionIntent } from '@happier-dev/agents';

import type { StoredCredentials } from '@/persistence';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

export async function setSessionPermissionMode(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  permissionMode: PermissionIntent;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionStateFieldForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    fieldId: 'intent.permissionMode',
    value: {
      v: 1,
      permissionMode: params.permissionMode,
      updatedAt,
    },
    metadataReason: 'cli-session-permission-mode-set',
  });
}
