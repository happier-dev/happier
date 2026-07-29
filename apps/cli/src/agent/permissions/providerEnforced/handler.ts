/**
 * ProviderEnforcedPermissionHandler
 *
 * ACP permission handler that only bridges provider permission requests to Happier UI.
 *
 * Provider-native permission policy remains authoritative for provider operations. Happier only
 * applies its own mode to host-mediated capabilities that bypass provider enforcement, such as
 * the ACP filesystem bridge.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import {
  BasePermissionHandler,
  type PermissionRequestPushSender,
  type PendingRequest,
  type PermissionResult,
} from '@/agent/permissions/BasePermissionHandler';
import type { ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import {
  resolveHappierActionForMcpToolName,
  shouldSuppressProviderPermissionForHappierApproval,
} from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import type { AccountSettings, ActionId } from '@happier-dev/protocol';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import {
  isSharedPermissionSafeToolName,
  SHARED_PROVIDER_ENFORCED_SAFE_TOOL_CALL_ID_SEGMENTS,
  SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS,
} from '../permissionTaxonomy';
import { shouldDenyAgentSessionTitleToolCall } from '../codingPromptTitlePermission';
import { normalizePermissionRequestOwner, type PermissionRequestOwner } from '../permissionRequestOwner';
import { resolveAgentRequestKind } from '../requestKind';

export type { PermissionResult, PendingRequest };

type HandlerOpts = Readonly<{
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  alwaysAutoApproveToolCallIdIncludes?: ReadonlyArray<string>;
}>;

const DEFAULT_SAFE_TOOL_NAME_SEGMENTS = SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS;

const DEFAULT_SAFE_TOOL_CALL_ID_SEGMENTS = SHARED_PROVIDER_ENFORCED_SAFE_TOOL_CALL_ID_SEGMENTS;

const ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS = new Set<ActionId>([
  'session.title.set',
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
]);

function isFullAccessPermissionMode(mode: PermissionMode): boolean {
  return mode === 'yolo' || mode === 'bypassPermissions';
}

function deniesHostMediatedFsWrites(mode: PermissionMode): boolean {
  return mode === 'read-only' || mode === 'plan';
}

export class ProviderEnforcedPermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;
  private readonly alwaysAutoApproveToolNameIncludes: ReadonlyArray<string>;
  private readonly alwaysAutoApproveToolCallIdIncludes: ReadonlyArray<string>;
  private currentPermissionMode: PermissionMode = 'default';

  constructor(
    session: ApiSessionClient,
    params: Readonly<{ logPrefix: string }> & HandlerOpts,
  ) {
    super(session, {
      pushSender: params.pushSender ?? null,
      getAccountSettings: params.getAccountSettings ?? null,
      getAccountSettingsSecretsReadKeys: params.getAccountSettingsSecretsReadKeys ?? null,
      onAbortRequested: params.onAbortRequested ?? null,
      toolTrace: params.toolTrace ?? null,
    });
    this.logPrefix = params.logPrefix;
    this.alwaysAutoApproveToolNameIncludes = [
      ...DEFAULT_SAFE_TOOL_NAME_SEGMENTS,
      ...(params.alwaysAutoApproveToolNameIncludes ?? []),
    ];
    this.alwaysAutoApproveToolCallIdIncludes = [
      ...DEFAULT_SAFE_TOOL_CALL_ID_SEGMENTS,
      ...(params.alwaysAutoApproveToolCallIdIncludes ?? []),
    ];
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  /**
   * Compatibility shim: some runtimes still call `setPermissionMode()` even when provider enforcement is enabled.
   * The mode still governs host-mediated operations that do not pass through provider policy.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode} (provider-enforced)`);
    this.resolvePendingRequestsIfNowDecidable();
  }

  private resolvePendingRequestsIfNowDecidable(): void {
    if (this.pendingRequests.size === 0) return;

    for (const [toolCallId, pending] of Array.from(this.pendingRequests.entries())) {
      const decision = this.getImmediateDecision(toolCallId, pending.toolName, pending.input);
      if (!decision) continue;
      this.resolvePendingPermissionRequest(toolCallId, decision);
    }
  }

  private splitNameTokens(value: string): string[] {
    return value
      .toLowerCase()
      .split(/__|[\\/.:\\s-]+/g)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  private matchesSafeToolSegment(value: string, candidate: string): boolean {
    const lowerValue = value.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    return lowerValue === lowerCandidate || lowerValue.endsWith(`_${lowerCandidate}`);
  }

  private isAlwaysAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
    if (isSharedPermissionSafeToolName(toolName)) return true;
    if (isSharedPermissionSafeToolName(toolCallId)) return true;
    const happierActionId = resolveHappierActionForMcpToolName({ toolName, input });
    if (happierActionId && ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS.has(happierActionId)) return true;
    const toolNameTokens = this.splitNameTokens(toolName);
    const toolCallIdTokens = this.splitNameTokens(toolCallId);
    if (this.alwaysAutoApproveToolCallIdIncludes.some((n) => toolCallId.toLowerCase().includes(n.toLowerCase()))) return true;
    if (this.alwaysAutoApproveToolNameIncludes.some((n) => toolNameTokens.includes(n.toLowerCase()))) return true;
    if (this.alwaysAutoApproveToolCallIdIncludes.some((n) => toolCallIdTokens.includes(n.toLowerCase()))) return true;
    if (this.alwaysAutoApproveToolNameIncludes.some((n) => this.matchesSafeToolSegment(toolName, n))) return true;
    if (this.alwaysAutoApproveToolCallIdIncludes.some((n) => this.matchesSafeToolSegment(toolCallId, n))) return true;
    return false;
  }

  private shouldSuppressForHappierActionApproval(toolName: string, input: unknown): boolean {
    return shouldSuppressProviderPermissionForHappierApproval({
      toolName,
      input,
      accountSettings: this.getAccountSettingsSnapshot(),
      surface: 'agent',
    }).suppress;
  }

  getImmediateDecision(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): PermissionResult | null {
    if (shouldDenyAgentSessionTitleToolCall({
      settings: this.getAccountSettingsSnapshot(),
      toolName,
      input,
    })) {
      return { decision: 'denied' };
    }
    if (
      context?.origin === 'host_acp_fs_write'
      && deniesHostMediatedFsWrites(this.currentPermissionMode)
    ) {
      return { decision: 'denied' };
    }
    if (isFullAccessPermissionMode(this.currentPermissionMode) && resolveAgentRequestKind(toolName) === 'permission') {
      return { decision: 'approved' };
    }
    if (this.isAlwaysAutoApprove(toolName, toolCallId, input)) {
      return { decision: 'approved' };
    }
    if (this.shouldSuppressForHappierActionApproval(toolName, input)) {
      return { decision: 'approved' };
    }
    return null;
  }

  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    options?: AcpPermissionCallContext & Readonly<{
      owner?: PermissionRequestOwner | null;
      source?: string | null;
      signal?: AbortSignal;
    }>,
  ): Promise<PermissionResult> {
    if (options?.signal?.aborted) {
      throw new Error('Permission request aborted');
    }
    const owner = normalizePermissionRequestOwner(options?.owner);
    const source = typeof options?.source === 'string' ? options.source.trim() : '';
    const immediateDecision = this.getImmediateDecision(toolCallId, toolName, input, options);
    if (immediateDecision) {
      this.recordAutoDecision(toolCallId, toolName, input, immediateDecision.decision, {
        ...(owner ? { owner } : {}),
        ...(source ? { source } : {}),
      });
      logger.debug(
        `${this.getLogPrefix()} Applying immediate ${immediateDecision.decision} decision for tool ${toolName} (${toolCallId})`,
      );
      return immediateDecision;
    }

    // Respect user "don't ask again for session" choices captured via our permission UI.
    if (this.isAllowedForSessionForOwner(toolName, input, owner)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session', {
        ...(owner ? { owner } : {}),
        ...(source ? { source } : {}),
      });
      return { decision: 'approved_for_session' };
    }

    const pending = this.requestPermissionDecision(toolCallId, toolName, input, options);
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
    return await pending;
  }
}
