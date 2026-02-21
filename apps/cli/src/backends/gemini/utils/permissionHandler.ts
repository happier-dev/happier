/**
 * Gemini Permission Handler
 *
 * Mode-aware permission handler for Gemini-like ACP sessions.
 */

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';
import {
  CodexLikePermissionHandler,
  type PendingRequest,
  type PermissionResult,
} from '@/agent/permissions/CodexLikePermissionHandler';

export type { PermissionResult, PendingRequest };

export class GeminiPermissionHandler extends CodexLikePermissionHandler {
  private readonly alwaysAutoApproveToolNameIncludes: ReadonlyArray<string>;
  private readonly alwaysAutoApproveToolCallIdIncludes: ReadonlyArray<string>;

  constructor(session: ApiSessionClient, opts?: { onAbortRequested?: (() => void | Promise<void>) | null }) {
    super({ session, logPrefix: '[Gemini]', onAbortRequested: opts?.onAbortRequested ?? null });
    // Always-auto-approve safe internal tools that don't perform external side effects.
    this.alwaysAutoApproveToolNameIncludes = [
      ...CHANGE_TITLE_TOOL_NAME_ALIASES,
      'geminireasoning',
      'codexreasoning',
    ];
    this.alwaysAutoApproveToolCallIdIncludes = [
      // Some transports only expose the tool in the toolCallId; keep it permissive.
      ...CHANGE_TITLE_TOOL_NAME_ALIASES,
      'save_memory',
    ];
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    const lowerName = toolName.toLowerCase();
    const lowerId = toolCallId.toLowerCase();
    const isAlwaysAutoApprove =
      this.alwaysAutoApproveToolNameIncludes.some((t) => lowerName.includes(t)) ||
      this.alwaysAutoApproveToolCallIdIncludes.some((t) => lowerId.includes(t));
    if (isAlwaysAutoApprove) {
      this.recordAutoDecision(toolCallId, toolName, input, 'approved');
      return { decision: 'approved' };
    }
    return await super.handleToolCall(toolCallId, toolName, input);
  }
}
