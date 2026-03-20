/**
 * Codex Permission Handler
 *
 * Handles tool permission requests and responses for Codex sessions.
 *
 * Codex MCP approvals (exec/patch) are represented as tools:
 * - CodexBash (exec)
 * - CodexPatch (patch)
 *
 * This handler is mode-aware:
 * - "yolo": auto-approve
 * - "safe-yolo": auto-approve read-only, prompt for write-like
 * - "read-only": deny write-like
 *
 * Codex itself remains responsible for sandbox/approval policy enforcement; this class only
 * controls how Happier answers/surfaces permission prompts and host-side tool gating (e.g. ACP fs).
 */

import type { ApiSessionClient } from '@/api/session/sessionClient';
import {
  CodexLikePermissionHandler,
  type PendingRequest,
  type PermissionResult,
} from '@/agent/permissions/CodexLikePermissionHandler';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import type { AccountSettings } from '@happier-dev/protocol';

export type { PermissionResult, PendingRequest };

export class CodexPermissionHandler extends CodexLikePermissionHandler {
  constructor(
    session: ApiSessionClient,
    opts?: {
      pushSender?: PermissionRequestPushSender | null;
      getAccountSettings?: (() => AccountSettings | null) | null;
      getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
      onAbortRequested?: (() => void | Promise<void>) | null;
      toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
      triggerAbortCallbackOnAbortDecision?: boolean;
    },
  ) {
    super({
      session,
      logPrefix: '[Codex]',
      pushSender: opts?.pushSender ?? null,
      getAccountSettings: opts?.getAccountSettings ?? null,
      getAccountSettingsSecretsReadKeys: opts?.getAccountSettingsSecretsReadKeys ?? null,
      onAbortRequested: opts?.onAbortRequested ?? null,
      toolTrace: opts?.toolTrace ?? null,
      triggerAbortCallbackOnAbortDecision: opts?.triggerAbortCallbackOnAbortDecision,
    });
  }
}
