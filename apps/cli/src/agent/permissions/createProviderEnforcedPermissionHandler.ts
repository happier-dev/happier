import type { ApiSessionClient } from '@/api/session/sessionClient';

import { ProviderEnforcedPermissionHandler } from './ProviderEnforcedPermissionHandler';

export function createProviderEnforcedPermissionHandler(params: {
  session: ApiSessionClient;
  logPrefix: string;
  onAbortRequested?: (() => void | Promise<void>) | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  alwaysAutoApproveToolCallIdIncludes?: ReadonlyArray<string>;
}): ProviderEnforcedPermissionHandler {
  return new ProviderEnforcedPermissionHandler(params.session, {
    logPrefix: params.logPrefix,
    onAbortRequested: params.onAbortRequested ?? null,
    alwaysAutoApproveToolNameIncludes: params.alwaysAutoApproveToolNameIncludes,
    alwaysAutoApproveToolCallIdIncludes: params.alwaysAutoApproveToolCallIdIncludes,
  });
}
