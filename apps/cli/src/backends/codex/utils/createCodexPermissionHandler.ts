import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';

import { CodexPermissionHandler } from './permissionHandler';

export type CodexRuntimePermissionHandler = CodexPermissionHandler;

export function createCodexPermissionHandler(params: {
  session: ApiSessionClient;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
}): CodexRuntimePermissionHandler {
  return new CodexPermissionHandler(params.session, {
    onAbortRequested: params.onAbortRequested ?? null,
    toolTrace: params.toolTrace ?? null,
  });
}
