import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import type { AccountSettings } from '@happier-dev/protocol';

import { CodexPermissionHandler } from './permissionHandler';

export type CodexRuntimePermissionHandler = CodexPermissionHandler;

export function createCodexPermissionHandler(params: {
  session: ApiSessionClient;
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  triggerAbortCallbackOnAbortDecision?: boolean;
}): CodexRuntimePermissionHandler {
  return new CodexPermissionHandler(params.session, {
    pushSender: params.pushSender ?? null,
    getAccountSettings: params.getAccountSettings ?? null,
    getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
    onAbortRequested: params.onAbortRequested ?? null,
    toolTrace: params.toolTrace ?? null,
    triggerAbortCallbackOnAbortDecision: params.triggerAbortCallbackOnAbortDecision,
  });
}
