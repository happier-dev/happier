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

export type { PermissionResult, PendingRequest };

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

  constructor(params: {
    session: ApiSessionClient;
    logPrefix: string;
    isWriteLikeToolName?: (toolName: string) => boolean;
    onAbortRequested?: (() => void | Promise<void>) | null;
  }) {
    super(params.session, { onAbortRequested: params.onAbortRequested });
    this.logPrefix = params.logPrefix;
    this.isWriteLikeToolName = params.isWriteLikeToolName ?? isDefaultWriteLikeToolName;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  updateSession(newSession: ApiSessionClient): void {
    super.updateSession(newSession);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
  }

  private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
    // Conservative always-auto-approve list.
    const alwaysAutoApproveNames = ['change_title', 'save_memory', 'think'];
    if (alwaysAutoApproveNames.some((n) => toolName.toLowerCase().includes(n))) return true;
    if (alwaysAutoApproveNames.some((n) => toolCallId.toLowerCase().includes(n))) return true;

    switch (this.currentPermissionMode) {
      case 'yolo':
        return true;
      case 'safe-yolo':
        return !this.isWriteLikeToolName(toolName);
      case 'read-only':
        return !this.isWriteLikeToolName(toolName);
      case 'default':
      case 'acceptEdits':
      case 'bypassPermissions':
      case 'plan':
      default:
        return false;
    }
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
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

