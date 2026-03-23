import { computeNextPermissionIntentMetadata, type PermissionIntent } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';

import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';

export async function setSessionPermissionMode(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  permissionMode: PermissionIntent;
  updatedAt?: number;
}>): ReturnType<typeof updateSessionMetadataForTarget> {
  const updatedAt = params.updatedAt ?? Date.now();
  return await updateSessionMetadataForTarget({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    updater: (metadata) =>
      computeNextPermissionIntentMetadata({
        metadata,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: updatedAt,
      }),
  });
}
