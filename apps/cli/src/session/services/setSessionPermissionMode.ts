import type { PermissionIntent } from '@happier-dev/agents';

import type { StoredCredentials } from '@/persistence';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { CallerInputConstraintsV1 } from '@happier-dev/protocol';

import { updateSessionStateFieldForTarget } from './updateSessionStateFieldForTarget';

export async function setSessionPermissionMode(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  permissionMode: PermissionIntent;
  updatedAt?: number;
  callerInputConstraints?: CallerInputConstraintsV1;
  resolveAuthorizationHeaders?: Parameters<typeof updateSessionStateFieldForTarget>[0]['resolveAuthorizationHeaders'];
}>): Promise<Awaited<ReturnType<typeof updateSessionStateFieldForTarget>> | Readonly<{ ok: false; code: 'permission_mode_not_granted' }>> {
  if (params.callerInputConstraints && !isPermissionModeGrantedV1(params.callerInputConstraints, params.permissionMode)) {
    return { ok: false, code: 'permission_mode_not_granted' };
  }
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionStateFieldForTarget({
    credentials: params.credentials,
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
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
