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
import { shouldSuppressProviderPermissionForHappierApproval } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { AccountSettings } from '@happier-dev/protocol';
import { isDefaultWriteLikeToolName } from './writeLikeToolNameHeuristics';
import { isTrustedAlwaysAutoApproveToolName } from './alwaysAutoApproveToolName';
import { extractShellCommand } from './permissionToolIdentifier';
import { resolveAgentRequestKind } from './requestKind';
import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';
import { resolveSessionCodingPromptSettingsFromSession } from '../prompting/coding/resolveSessionCodingPromptSettings';
import { parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';

export type { PermissionResult, PendingRequest };

const AUTO_APPROVE_HAPPIER_SHELL_BRIDGE_TOOLS = new Set(['change_title', 'session_title_set', 'save_memory', 'think']);
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

  /**
   * Title-tool denial evaluated on the same merged settings the prompt and tools bridge
   * consume: a profile override disabling sessionTitleUpdates must deny here too.
   */
  private shouldDenySessionTitleToolCall(toolName: string, input: unknown): boolean {
    return shouldDenyAgentSessionTitleToolCall({
      settings: resolveSessionCodingPromptSettings({
        settings: this.getAccountSettingsSnapshot() ?? {},
        profileId: this.session.getMetadataSnapshot()?.profileId ?? null,
      }),
      toolName,
      input,
    });
  }

  private resolveDecisionForToolCall(toolCallId: string, toolName: string, input: unknown): PermissionResult | null {
    if (this.isPermissionRequestClaimed(toolCallId)) {
      return null;
    }
    if (resolveAgentRequestKind(toolName) === 'user_action') {
      return null;
    }

    if (shouldDenyAgentSessionTitleToolCall({
      // Same merged decision the prompt and tools bridge consume: a profile override
      // that disables title updates must also disable it at this deny layer.
      settings: resolveSessionCodingPromptSettingsFromSession({
        settings: this.getAccountSettingsSnapshot() ?? {},
        session: this.session,
      }),
      toolName,
      input,
    })) {
      return { decision: 'denied' };
    }

    const isAlwaysAutoApprove =
      this.isAlwaysAutoApproveTool(toolName) || this.isHappierToolsShellBridgeToolCall(toolName, input);

    if ((this.currentPermissionMode === 'read-only' || this.currentPermissionMode === 'plan') && !isAlwaysAutoApprove && this.isWriteLikeToolName(toolName)) {
      logger.debug(`${this.getLogPrefix()} Denying tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      return { decision: 'denied' };
    }

    if (this.shouldSuppressForHappierActionApproval(toolName, input)) {
      return { decision: 'approved' };
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

  private isAlwaysAutoApproveTool(toolName: string): boolean {
    return isTrustedAlwaysAutoApproveToolName(toolName);
  }

  private isHappierToolsShellBridgeToolCall(toolName: string, input: unknown): boolean {
    const lowerToolName = toolName.toLowerCase();
    if (lowerToolName !== 'bash' && lowerToolName !== 'execute' && lowerToolName !== 'shell') {
      return false;
    }

    const command = extractShellCommand(input);
    if (!command) return false;

    const parsed = parseTrustedHappierToolsShellBridgeCommand(command);
    if (!parsed) return false;
    if (parsed.kind === 'list') return true;
    return parsed.source === 'happier' && AUTO_APPROVE_HAPPIER_SHELL_BRIDGE_TOOLS.has(parsed.tool);
  }

  private isFullAutoApproveMode(): boolean {
    return this.currentPermissionMode === 'yolo' || this.currentPermissionMode === 'bypassPermissions';
  }

  private shouldSuppressForHappierActionApproval(toolName: string, input: unknown): boolean {
    return shouldSuppressProviderPermissionForHappierApproval({
      toolName,
      input,
      accountSettings: this.getAccountSettingsSnapshot(),
      surface: 'session_agent',
    }).suppress;
  }

  private shouldAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
    if (this.isAlwaysAutoApproveTool(toolName)) return true;
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
    if (this.isPermissionRequestClaimed(toolCallId)) {
      return await this.requestPermissionDecision(toolCallId, toolName, input);
    }
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

    if (this.shouldDenySessionTitleToolCall(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Denying session title tool ${toolName} (${toolCallId}) because title updates are disabled`);
      this.recordAutoDecision(toolCallId, toolName, input, 'denied');
      return { decision: 'denied' };
    }

    const isAlwaysAutoApprove =
      this.isAlwaysAutoApproveTool(toolName) || this.isHappierToolsShellBridgeToolCall(toolName, input);

    if ((this.currentPermissionMode === 'read-only' || this.currentPermissionMode === 'plan') && !isAlwaysAutoApprove && this.isWriteLikeToolName(toolName)) {
      logger.debug(`${this.getLogPrefix()} Denying tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      this.recordAutoDecision(toolCallId, toolName, input, 'denied');
      return { decision: 'denied' };
    }

    if (this.shouldSuppressForHappierActionApproval(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving Happier MCP tool ${toolName} (${toolCallId}) because Happier action approval is required`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved');
      return { decision: 'approved' };
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
