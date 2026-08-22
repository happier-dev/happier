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
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import { shouldSuppressProviderPermissionForHappierApproval } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import {
  extractShellCommand,
  type AccountSettings,
} from '@happier-dev/protocol';
import { parseTrustedHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import { isDefaultWriteLikeToolName } from './writeLikeToolNameHeuristics';
import { isSharedHappierShellBridgeToolName, isSharedPermissionSafeToolName } from './permissionTaxonomy';
import { resolveAgentRequestKind } from './requestKind';
import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import { resolveCausalPermissionMode } from './causalPermissionMode';
import type { PermissionRequestCoordinatorContext } from './permissionRequestCoordinator';

export type { PermissionResult, PendingRequest };

const SAFE_HAPPIER_SHELL_BRIDGE_TOOLS = new Set<string>([
  'change_title',
  'session_title_set',
  'save_memory',
  'think',
]);
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
    isMediatorPluginCurrent?: ((pluginId: string) => boolean) | null;
    isMediatorContributionCurrent?: ((mediator: Readonly<{
      pluginId: string;
      contributionLocalId: string;
    }>) => boolean) | null;
  }) {
    super(params.session, {
      pushSender: params.pushSender ?? null,
      getAccountSettings: params.getAccountSettings ?? null,
      getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
      onAbortRequested: params.onAbortRequested,
      toolTrace: params.toolTrace ?? null,
      triggerAbortCallbackOnAbortDecision: params.triggerAbortCallbackOnAbortDecision,
      isMediatorPluginCurrent: params.isMediatorPluginCurrent ?? null,
      isMediatorContributionCurrent: params.isMediatorContributionCurrent ?? null,
    });
    this.logPrefix = params.logPrefix;
    this.isWriteLikeToolName = params.isWriteLikeToolName ?? isDefaultWriteLikeToolName;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  protected isCurrentRemoteMediationAllowEligible(params: Readonly<{
    requestId: string;
    toolName: string;
    input: unknown;
    causalPermissionContext: AcpPermissionCallContext;
  }>): boolean {
    // A remote approval can satisfy a pending request but must never bypass a
    // mode reduction that arrived after the turn was admitted.
    return this.getImmediateDecision(
      params.requestId,
      params.toolName,
      params.input,
      params.causalPermissionContext,
    )?.decision !== 'denied';
  }

  protected override resolveCurrentPermissionDecisionForOutstandingRequest(
    context: PermissionRequestCoordinatorContext,
  ): PermissionResult {
    const sourceAuthority = context.owner?.sourceAuthority;
    const causalPermissionContext = sourceAuthority
      ? {
          causalPermissionAuthority: {
            kind: 'admittedSessionInputV1' as const,
            admittedPermissionCeiling: sourceAuthority.admittedPermissionCeiling,
            sourceAuthority,
          },
        }
      : undefined;
    const current = this.getImmediateDecision(
      context.requestId,
      context.toolName,
      context.toolInput,
      causalPermissionContext,
    );
    return current?.decision === 'denied' || current?.decision === 'abort'
      ? current
      : { decision: 'approved' };
  }

  updateSession(newSession: ApiSessionClient): void {
    super.updateSession(newSession);
  }

  setPermissionMode(mode: PermissionMode, updatedAt?: number): void {
    if (this.currentPermissionMode !== mode) {
      this.invalidateRemoteMediationAllowCurrentness();
    }
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
      const decision = this.resolveDecisionForToolCall(
        toolCallId,
        pending.toolName,
        pending.input,
        pending.causalPermissionContext,
      );
      if (!decision) continue;

      this.resolvePendingPermissionRequest(
        toolCallId,
        decision,
        undefined,
        () => this.resolveDecisionForToolCall(
          toolCallId,
          pending.toolName,
          pending.input,
          pending.causalPermissionContext,
        ),
      );
    }
  }

  private resolveDecisionForToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): PermissionResult | null {
    const effective = resolveCausalPermissionMode({
      currentPermissionMode: this.currentPermissionMode,
      context,
    });
    if (!effective.ok) {
      logger.debug(`${this.getLogPrefix()} Causal permission authority is invalid for ${toolName} (${toolCallId})`);
      return { decision: 'denied' };
    }
    const permissionMode = effective.effectiveMode;

    if (resolveAgentRequestKind(toolName) === 'user_action') {
      return null;
    }

    if (shouldDenyAgentSessionTitleToolCall({
      settings: this.getAccountSettingsSnapshot(),
      toolName,
      input,
    })) {
      return { decision: 'denied' };
    }

    const isAlwaysAutoApprove =
      this.isAlwaysAutoApproveTool(toolName) || this.isHappierToolsShellBridgeToolCall(toolName, input);

    if ((permissionMode === 'read-only' || permissionMode === 'plan') && !isAlwaysAutoApprove && this.isWriteLikeToolName(toolName)) {
      logger.debug(`${this.getLogPrefix()} Denying tool ${toolName} (${toolCallId}) in ${permissionMode} mode`);
      return { decision: 'denied' };
    }

    if (this.shouldSuppressForHappierActionApproval(toolName, input)) {
      return { decision: 'approved' };
    }

    if (!effective.sourceAuthority && this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      return { decision: 'approved_for_session' };
    }

    if (
      effective.sourceAuthority
      && this.isAllowedByRemoteMediationGrant(toolName, input, effective.sourceAuthority)
    ) {
      logger.debug(`${this.getLogPrefix()} Auto-approving through exact remote mediation grant (${toolCallId})`);
      // The durable grant, not legacy allowedTools, owns future approvals.
      return { decision: 'approved' };
    }

    if (this.shouldAutoApprove(toolName, toolCallId, input, permissionMode)) {
      const decision: PermissionResult['decision'] =
        this.isFullAutoApproveMode(permissionMode) ? 'approved_for_session' : 'approved';
      logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${permissionMode} mode`);
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
    return isSharedPermissionSafeToolName(toolName);
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
    return parsed.source === 'happier' && (SAFE_HAPPIER_SHELL_BRIDGE_TOOLS.has(parsed.tool) || isSharedHappierShellBridgeToolName(parsed.tool));
  }

  private isFullAutoApproveMode(permissionMode: PermissionMode): boolean {
    return permissionMode === 'yolo' || permissionMode === 'bypassPermissions';
  }

  private shouldSuppressForHappierActionApproval(toolName: string, input: unknown): boolean {
    return shouldSuppressProviderPermissionForHappierApproval({
      toolName,
      input,
      accountSettings: this.getAccountSettingsSnapshot(),
      surface: 'agent',
    }).suppress;
  }

  private shouldAutoApprove(
    toolName: string,
    toolCallId: string,
    input: unknown,
    permissionMode: PermissionMode,
  ): boolean {
    if (this.isAlwaysAutoApproveTool(toolName)) return true;
    if (this.isHappierToolsShellBridgeToolCall(toolName, input)) return true;

    switch (permissionMode) {
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

  getImmediateDecision(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): PermissionResult | null {
    this.syncPermissionModeFromMetadataSnapshotIfNewer();
    return this.resolveDecisionForToolCall(toolCallId, toolName, input, context);
  }

  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): Promise<PermissionResult> {
    // Metadata updates can arrive mid-turn (e.g. UI toggles "read-only" while a tool request is in flight).
    // Sync on each tool call so the decision reflects the latest persisted intent without requiring a user message.
    this.syncPermissionModeFromMetadataSnapshotIfNewer();
    logger.debug(`${this.getLogPrefix()} handleToolCall`, {
      toolCallId,
      toolName,
      requestKind: resolveAgentRequestKind(toolName),
      permissionMode: this.currentPermissionMode,
    });

    const automaticDecision = this.resolveAndRecordAutoDecision({
      toolCallId,
      toolName,
      input,
      resolve: () => this.resolveDecisionForToolCall(toolCallId, toolName, input, context),
    });
    if (automaticDecision) {
      const immediate = await automaticDecision;
      if (immediate) {
        return immediate;
      }
    }

    const pending = this.requestPermissionDecision(toolCallId, toolName, input, {
      ...(context ? { causalPermissionContext: context } : {}),
      resolveCurrentPermissionDecision: () => {
        const current = this.getImmediateDecision(toolCallId, toolName, input, context);
        return current?.decision === 'denied' || current?.decision === 'abort'
          ? current
          : { decision: 'approved' };
      },
    });
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
    return pending;
  }
}
