/**
 * CodexLikePermissionHandler
 *
 * Shared permission handler for ACP agents that use the "Codex decision" style:
 * - "yolo": auto-approve everything
 * - "safe-yolo" / "read-only": auto-approve read-only operations, prompt for write-like operations
 *
 * Providers can wrap this class to customize the log prefix and (optionally) the write-like heuristic.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionRequestPushSender,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/BasePermissionHandler';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permission/permissionModeFromMetadata';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { AccountSettings } from '@happier-dev/protocol';
import { parseHappierToolsShellBridgeCommand } from '@happier-dev/protocol';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';
import { isDefaultWriteLikeToolName } from './writeLikeToolNameHeuristics';
import { extractShellCommand } from './permissionToolIdentifier';
import { resolveAgentRequestKind } from './requestKind';

export type { PermissionResult, PendingRequest };

const ALWAYS_AUTO_APPROVE_TOKENS = ['change_title', 'session_title_set', 'save_memory', 'think'] as const;
const AUTO_APPROVE_HAPPIER_SHELL_BRIDGE_TOOLS = new Set<string>(ALWAYS_AUTO_APPROVE_TOKENS);
export { isDefaultWriteLikeToolName };

export class CodexLikePermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;
  private readonly isWriteLikeToolName: (toolName: string) => boolean;
  private currentPermissionMode: PermissionMode = 'default';
  private currentPermissionModeUpdatedAt = 0;

  constructor(params: {
    session: ApiSessionClient;
    logPrefix: string;
    isWriteLikeToolName?: (toolName: string) => boolean;
    pushSender?: PermissionRequestPushSender | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
    getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
    onAbortRequested?: (() => void | Promise<void>) | null;
    toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
    triggerAbortCallbackOnAbortDecision?: boolean;
  }) {
    super(params.session, {
      pushSender: params.pushSender ?? null,
      getAccountSettings: params.getAccountSettings ?? null,
      getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
      onAbortRequested: params.onAbortRequested,
      toolTrace: params.toolTrace ?? null,
      triggerAbortCallbackOnAbortDecision: params.triggerAbortCallbackOnAbortDecision,
    });
    this.logPrefix = params.logPrefix;
    this.isWriteLikeToolName = params.isWriteLikeToolName ?? isDefaultWriteLikeToolName;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  updateSession(newSession: ApiSessionClient): void {
    super.updateSession(newSession);
  }

  setPermissionMode(mode: PermissionMode, updatedAt?: number): void {
    this.currentPermissionMode = mode;
    if (typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > this.currentPermissionModeUpdatedAt) {
      this.currentPermissionModeUpdatedAt = updatedAt;
    }
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
    this.resolvePendingRequestsIfNowDecidable();
  }

  private resolvePendingRequestsIfNowDecidable(): void {
    if (this.pendingRequests.size === 0) return;

    // Snapshot to avoid Map mutation while iterating.
    const entries = Array.from(this.pendingRequests.entries());
    for (const [toolCallId, pending] of entries) {
      const decision = this.resolveDecisionForToolCall(toolCallId, pending.toolName, pending.input);
      if (!decision) continue;

      this.resolvePendingPermissionRequest(toolCallId, decision);
    }
  }

  private resolveDecisionForToolCall(toolCallId: string, toolName: string, input: unknown): PermissionResult | null {
    if (resolveAgentRequestKind(toolName) === 'user_action') {
      return null;
    }

    const isAlwaysAutoApprove =
      this.isAlwaysAutoApproveTool(toolName, toolCallId) || this.isHappierToolsShellBridgeToolCall(toolName, input);

    if ((this.currentPermissionMode === 'read-only' || this.currentPermissionMode === 'plan') && !isAlwaysAutoApprove && this.isWriteLikeToolName(toolName)) {
      logger.debug(`${this.getLogPrefix()} Denying tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      return { decision: 'denied' };
    }

    if (this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      return { decision: 'approved_for_session' };
    }

    if (this.shouldAutoApprove(toolName, toolCallId, input)) {
      const decision: PermissionResult['decision'] =
        this.isFullAutoApproveMode() ? 'approved_for_session' : 'approved';
      logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      return { decision };
    }

    return null;
  }

  private syncPermissionModeFromMetadataSnapshotIfNewer(): void {
    const resolved = resolvePermissionIntentFromMetadataSnapshot({
      metadata: this.session.getMetadataSnapshot?.() ?? null,
    });
    if (!resolved) return;
    if (resolved.updatedAt <= this.currentPermissionModeUpdatedAt) return;
    this.setPermissionMode(resolved.intent, resolved.updatedAt);
  }

  private isAlwaysAutoApproveTool(toolName: string, toolCallId: string): boolean {
    if (isChangeTitleToolLikeName(toolName)) return true;
    const lowerToolName = toolName.toLowerCase();
    const lowerToolCallId = toolCallId.toLowerCase();
    return (
      ALWAYS_AUTO_APPROVE_TOKENS.some((token) => lowerToolName.includes(token)) ||
      ALWAYS_AUTO_APPROVE_TOKENS.some((token) => lowerToolCallId.includes(token))
    );
  }

  private isHappierToolsShellBridgeToolCall(toolName: string, input: unknown): boolean {
    const lowerToolName = toolName.toLowerCase();
    if (lowerToolName !== 'bash' && lowerToolName !== 'execute' && lowerToolName !== 'shell') {
      return false;
    }

    const command = extractShellCommand(input);
    if (!command) return false;

    const parsed = parseHappierToolsShellBridgeCommand(command);
    if (!parsed) return false;
    if (parsed.kind === 'list') return true;
    return parsed.source === 'happier' && AUTO_APPROVE_HAPPIER_SHELL_BRIDGE_TOOLS.has(parsed.tool);
  }

  private isFullAutoApproveMode(): boolean {
    return this.currentPermissionMode === 'yolo' || this.currentPermissionMode === 'bypassPermissions';
  }

  private shouldAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
    if (this.isAlwaysAutoApproveTool(toolName, toolCallId)) return true;
    if (this.isHappierToolsShellBridgeToolCall(toolName, input)) return true;

    switch (this.currentPermissionMode) {
      case 'yolo':
      case 'bypassPermissions':
        return true;
      case 'safe-yolo':
        return !this.isWriteLikeToolName(toolName);
      case 'read-only':
        return !this.isWriteLikeToolName(toolName);
      case 'plan':
        return !this.isWriteLikeToolName(toolName);
      case 'default':
      case 'acceptEdits':
      default:
        return false;
    }
  }

  getImmediateDecision(toolCallId: string, toolName: string, input: unknown): PermissionResult | null {
    this.syncPermissionModeFromMetadataSnapshotIfNewer();
    return this.resolveDecisionForToolCall(toolCallId, toolName, input);
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    // Metadata updates can arrive mid-turn (e.g. UI toggles "read-only" while a tool request is in flight).
    // Sync on each tool call so the decision reflects the latest persisted intent without requiring a user message.
    this.syncPermissionModeFromMetadataSnapshotIfNewer();
    logger.debug(`${this.getLogPrefix()} handleToolCall`, {
      toolCallId,
      toolName,
      requestKind: resolveAgentRequestKind(toolName),
      permissionMode: this.currentPermissionMode,
    });

    if (resolveAgentRequestKind(toolName) === 'user_action') {
      const pending = this.requestPermissionDecision(toolCallId, toolName, input);
      logger.debug(`${this.getLogPrefix()} User action request sent for tool: ${toolName} (${toolCallId})`);
      return pending;
    }

    const isAlwaysAutoApprove =
      this.isAlwaysAutoApproveTool(toolName, toolCallId) || this.isHappierToolsShellBridgeToolCall(toolName, input);

    if ((this.currentPermissionMode === 'read-only' || this.currentPermissionMode === 'plan') && !isAlwaysAutoApprove && this.isWriteLikeToolName(toolName)) {
      logger.debug(`${this.getLogPrefix()} Denying tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      this.recordAutoDecision(toolCallId, toolName, input, 'denied');
      return { decision: 'denied' };
    }

    // Respect user "don't ask again for session" choices captured via our permission UI.
    if (this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session');
      return { decision: 'approved_for_session' };
    }

    if (this.shouldAutoApprove(toolName, toolCallId, input)) {
      const decision: PermissionResult['decision'] =
        this.isFullAutoApproveMode() ? 'approved_for_session' : 'approved';
      logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      this.recordAutoDecision(toolCallId, toolName, input, decision);
      return { decision };
    }

    const pending = this.requestPermissionDecision(toolCallId, toolName, input);
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
    return pending;
  }
}
