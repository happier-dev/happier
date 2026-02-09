/**
 * ProviderEnforcedPermissionHandler
 *
 * ACP permission handler that only bridges provider permission requests to Happier UI.
 *
 * Key property: it does NOT apply local allow/deny heuristics based on Happier permission mode.
 * The provider is expected to enforce its own policies (sandbox / approval rules) and to decide
 * when to emit ACP `requestPermission` prompts.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PendingRequest,
  type PermissionResult,
} from '@/agent/permissions/BasePermissionHandler';

export type { PermissionResult, PendingRequest };

type HandlerOpts = Readonly<{
  onAbortRequested?: (() => void | Promise<void>) | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  alwaysAutoApproveToolCallIdIncludes?: ReadonlyArray<string>;
}>;

const DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_NAME_INCLUDES = [
  'change_title',
  'save_memory',
  'think',
  // ACP fs bridge operations are host-side capability calls; provider policy decides when these occur.
  // Auto-approve here to avoid duplicating provider permission policy at the host layer.
  'readtextfile',
  'writetextfile',
  'read_text_file',
  'write_text_file',
] as const;

const DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_CALL_ID_INCLUDES = [
  'change_title',
  'save_memory',
] as const;

export class ProviderEnforcedPermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;
  private readonly alwaysAutoApproveToolNameIncludes: ReadonlyArray<string>;
  private readonly alwaysAutoApproveToolCallIdIncludes: ReadonlyArray<string>;

  constructor(
    session: ApiSessionClient,
    params: Readonly<{ logPrefix: string }> & HandlerOpts,
  ) {
    super(session, { onAbortRequested: params.onAbortRequested ?? null });
    this.logPrefix = params.logPrefix;
    this.alwaysAutoApproveToolNameIncludes = [
      ...DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_NAME_INCLUDES,
      ...(params.alwaysAutoApproveToolNameIncludes ?? []),
    ];
    this.alwaysAutoApproveToolCallIdIncludes = [
      ...DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_CALL_ID_INCLUDES,
      ...(params.alwaysAutoApproveToolCallIdIncludes ?? []),
    ];
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  /**
   * Compatibility shim: some runtimes still call `setPermissionMode()` even when provider enforcement is enabled.
   * This handler intentionally ignores the mode for decision-making.
   */
  setPermissionMode(_mode: PermissionMode): void {
    logger.debug(`${this.getLogPrefix()} Permission mode ignored (provider-enforced)`);
  }

  private splitNameTokens(value: string): string[] {
    return value
      .toLowerCase()
      .split(/__|[\\/.:\\s-]+/g)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  private isAlwaysAutoApprove(toolName: string, toolCallId: string): boolean {
    const toolNameTokens = this.splitNameTokens(toolName);
    const toolCallIdTokens = this.splitNameTokens(toolCallId);
    if (this.alwaysAutoApproveToolNameIncludes.some((n) => toolNameTokens.includes(n.toLowerCase()))) return true;
    if (this.alwaysAutoApproveToolCallIdIncludes.some((n) => toolCallIdTokens.includes(n.toLowerCase()))) return true;
    return false;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    if (this.isAlwaysAutoApprove(toolName, toolCallId)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving safe tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved');
      return { decision: 'approved' };
    }

    // Respect user "don't ask again for session" choices captured via our permission UI.
    if (this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session');
      return { decision: 'approved_for_session' };
    }

    return await new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}
