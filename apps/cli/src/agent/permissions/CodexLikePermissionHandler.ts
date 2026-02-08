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
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionResult,
  type PendingRequest,
} from '@/agent/permissions/BasePermissionHandler';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissionModeFromMetadata';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';

export type { PermissionResult, PendingRequest };

const ALWAYS_AUTO_APPROVE_TOKENS = ['change_title', 'save_memory', 'think'] as const;

export function isDefaultWriteLikeToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  // Safety: when a provider reports an unknown tool name, treat it as write-like.
  if (lower === 'other' || lower === 'unknown tool' || lower === 'unknown') return true;

  const writeish = [
    'edit',
    'write',
    'patch',
    'delete',
    'remove',
    'create',
    'mkdir',
    'rename',
    'move',
    'copy',
    'exec',
    'bash',
    'shell',
    'run',
    'terminal',
  ];
  return writeish.some((k) => lower === k || lower.includes(k));
}

export class CodexLikePermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;
  private readonly isWriteLikeToolName: (toolName: string) => boolean;
  private currentPermissionMode: PermissionMode = 'default';
  private currentPermissionModeUpdatedAt = 0;

  constructor(params: {
    session: ApiSessionClient;
    logPrefix: string;
    isWriteLikeToolName?: (toolName: string) => boolean;
    onAbortRequested?: (() => void | Promise<void>) | null;
    toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  }) {
    super(params.session, { onAbortRequested: params.onAbortRequested, toolTrace: params.toolTrace ?? null });
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
    const lowerToolName = toolName.toLowerCase();
    const lowerToolCallId = toolCallId.toLowerCase();
    return (
      ALWAYS_AUTO_APPROVE_TOKENS.some((token) => lowerToolName.includes(token)) ||
      ALWAYS_AUTO_APPROVE_TOKENS.some((token) => lowerToolCallId.includes(token))
    );
  }

  private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
    if (this.isAlwaysAutoApproveTool(toolName, toolCallId)) return true;

    switch (this.currentPermissionMode) {
      case 'yolo':
        return true;
      case 'safe-yolo':
        return !this.isWriteLikeToolName(toolName);
      case 'read-only':
        return !this.isWriteLikeToolName(toolName);
      case 'plan':
        return !this.isWriteLikeToolName(toolName);
      case 'default':
      case 'acceptEdits':
      case 'bypassPermissions':
      default:
        return false;
    }
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    // Metadata updates can arrive mid-turn (e.g. UI toggles "read-only" while a tool request is in flight).
    // Sync on each tool call so the decision reflects the latest persisted intent without requiring a user message.
    this.syncPermissionModeFromMetadataSnapshotIfNewer();

    const isAlwaysAutoApprove = this.isAlwaysAutoApproveTool(toolName, toolCallId);

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

    if (this.shouldAutoApprove(toolName, toolCallId)) {
      const decision: PermissionResult['decision'] =
        this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved';
      logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
      this.recordAutoDecision(toolCallId, toolName, input, decision);
      return { decision };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
    });
  }
}
