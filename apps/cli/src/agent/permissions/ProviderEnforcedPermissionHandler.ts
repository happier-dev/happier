/**
 * ProviderEnforcedPermissionHandler
 *
 * ACP permission handler that only bridges provider permission requests to Happier UI.
 *
 * Key property: the provider is expected to enforce its own policies (sandbox / approval rules)
 * and to decide when to emit ACP `requestPermission` prompts. Host-created ACP extension tools
 * still flow through this handler, so full-access modes must bypass ordinary permission prompts
 * while preserving structured user-action requests.
 */

import { logger } from '@/ui/logger';
import type { AcpPermissionCallContext } from '@/agent/acp/AcpBackend';
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
  isSafeFirstPartyHappierActionToolCall,
} from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import type { AccountSettings } from '@happier-dev/protocol';
import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';
import { resolveSessionCodingPromptSettingsFromSession } from '../prompting/coding/resolveSessionCodingPromptSettings';
import { resolveAgentRequestKind } from './requestKind';
import { isTrustedAlwaysAutoApproveToolName } from './alwaysAutoApproveToolName';

export type { PermissionResult, PendingRequest };

type HandlerOpts = Readonly<{
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
}>;

const DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_NAME_INCLUDES = [
  'change_title',
  'session_title_set',
  // Action-spec discovery tools are read-only and used by several providers before invoking actions/tools.
  // Auto-approve to avoid blocking harmless capability discovery behind provider-native permission prompts.
  'action_spec_search',
  'action_spec_get',
  'action_options_resolve',
  'save_memory',
  'think',
  // ACP fs bridge operations are host-side capability calls; provider policy decides when these occur.
  // Auto-approve here to avoid duplicating provider permission policy at the host layer.
  'readtextfile',
  'writetextfile',
  'read_text_file',
  'write_text_file',
] as const;

function isFullAccessPermissionMode(mode: PermissionMode): boolean {
  return mode === 'yolo' || mode === 'bypassPermissions';
}

export class ProviderEnforcedPermissionHandler extends BasePermissionHandler {
  private readonly logPrefix: string;
  private readonly alwaysAutoApproveToolNameIncludes: ReadonlyArray<string>;
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
      ...DEFAULT_ALWAYS_AUTO_APPROVE_TOOL_NAME_INCLUDES,
      ...(params.alwaysAutoApproveToolNameIncludes ?? []),
    ];
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  /**
   * Compatibility shim: some runtimes still call `setPermissionMode()` even when provider enforcement is enabled.
   * Full-access modes still matter for host-created extension tool prompts that do not go through provider policy.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode} (provider-enforced)`);
    this.resolvePendingRequestsIfNowDecidable();
  }

  private resolvePendingRequestsIfNowDecidable(): void {
    if (this.pendingRequests.size === 0) return;

    for (const [toolCallId, pending] of Array.from(this.pendingRequests.entries())) {
      const decision = pending.resolveDecisionIfPolicyChanges
        ? pending.resolveDecisionIfPolicyChanges()
        : this.getImmediateDecision(toolCallId, pending.toolName, pending.input);
      if (!decision) continue;
      this.resolvePendingPermissionRequest(toolCallId, decision);
    }
  }

  private isAlwaysAutoApprove(toolName: string, input: unknown): boolean {
    if (isSafeFirstPartyHappierActionToolCall({ toolName, input })) return true;
    return isTrustedAlwaysAutoApproveToolName(toolName, this.alwaysAutoApproveToolNameIncludes);
  }

  getImmediateDecision(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): PermissionResult | null {
    if (this.isPermissionRequestClaimed(toolCallId)) {
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
    if (isFullAccessPermissionMode(context?.permissionMode ?? this.currentPermissionMode) && resolveAgentRequestKind(toolName) === 'permission') {
      return { decision: 'approved' };
    }
    if (this.isAlwaysAutoApprove(toolName, input)) {
      return { decision: 'approved' };
    }
    return null;
  }

  async handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): Promise<PermissionResult> {
    if (this.isPermissionRequestClaimed(toolCallId) || this.pendingRequests.has(toolCallId)) {
      return await this.requestPermissionDecision(toolCallId, toolName, input);
    }
    // Provider continuations retain the policy of their admitted input.
    const permissionMode = context?.permissionMode;
    const admittedContext = permissionMode === undefined ? undefined : Object.freeze({ permissionMode });
    const immediateDecision = this.getImmediateDecision(toolCallId, toolName, input, admittedContext);
    if (immediateDecision) {
      this.recordAutoDecision(toolCallId, toolName, input, immediateDecision.decision);
      logger.debug(`${this.getLogPrefix()} Auto-approving safe tool ${toolName} (${toolCallId})`);
      return immediateDecision;
    }

    // Respect user "don't ask again for session" choices captured via our permission UI.
    if (this.isAllowedForSession(toolName, input)) {
      logger.debug(`${this.getLogPrefix()} Auto-approving (allowed for session) tool ${toolName} (${toolCallId})`);
      this.recordAutoDecision(toolCallId, toolName, input, 'approved_for_session');
      return { decision: 'approved_for_session' };
    }

    const pending = this.requestPermissionDecision(
      toolCallId,
      toolName,
      input,
      admittedContext ? () => this.getImmediateDecision(toolCallId, toolName, input, admittedContext) : undefined,
    );
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
    return await pending;
  }
}
