import type { ApiSessionClient } from '@/api/session/sessionClient';

import { ProviderEnforcedPermissionHandler } from './ProviderEnforcedPermissionHandler';
import type { PermissionRequestPushSender } from './BasePermissionHandler';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { AccountSettings } from '@happier-dev/protocol';

export function createProviderEnforcedPermissionHandler(params: {
  session: ApiSessionClient;
  logPrefix: string;
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  alwaysAutoApproveToolCallIdIncludes?: ReadonlyArray<string>;
}): ProviderEnforcedPermissionHandler {
  return new ProviderEnforcedPermissionHandler(params.session, {
    logPrefix: params.logPrefix,
    pushSender: params.pushSender ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
    getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
    onAbortRequested: params.onAbortRequested ?? null,
    toolTrace: params.toolTrace ?? null,
    alwaysAutoApproveToolNameIncludes: params.alwaysAutoApproveToolNameIncludes,
    alwaysAutoApproveToolCallIdIncludes: params.alwaysAutoApproveToolCallIdIncludes,
  });
}
