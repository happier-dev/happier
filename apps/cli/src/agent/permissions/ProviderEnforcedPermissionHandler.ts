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
import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';
import { resolveSessionCodingPromptSettings } from '../prompting/coding/resolveSessionCodingPromptSettings';
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

const ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS = new Set<ActionId>([
  'session.title.set',
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
]);

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
      const decision = this.getImmediateDecision(toolCallId, pending.toolName, pending.input);
      if (!decision) continue;
      this.resolvePendingPermissionRequest(toolCallId, decision);
    }
  }

  private isAlwaysAutoApprove(toolName: string, input: unknown): boolean {
    const happierActionId = resolveHappierActionForMcpToolName({ toolName, input });
    if (happierActionId && ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS.has(happierActionId)) return true;
    return isTrustedAlwaysAutoApproveToolName(toolName, this.alwaysAutoApproveToolNameIncludes);
  }

  getImmediateDecision(toolCallId: string, toolName: string, input: unknown): PermissionResult | null {
    if (this.isPermissionRequestClaimed(toolCallId)) {
      return null;
    }
    if (shouldDenyAgentSessionTitleToolCall({
      // Same merged decision the prompt and tools bridge consume: a profile override
      // that disables title updates must also disable it at this deny layer.
      settings: resolveSessionCodingPromptSettings({
        settings: this.getAccountSettingsSnapshot() ?? {},
        profileId: this.session.getMetadataSnapshot()?.profileId ?? null,
      }),
      toolName,
      input,
    })) {
      return { decision: 'denied' };
    }
    if (isFullAccessPermissionMode(this.currentPermissionMode) && resolveAgentRequestKind(toolName) === 'permission') {
      return { decision: 'approved' };
    }
    if (this.isAlwaysAutoApprove(toolName, input)) {
      return { decision: 'approved' };
    }
    const approvalSuppression = shouldSuppressProviderPermissionForHappierApproval({
      toolName,
      input,
      accountSettings: this.getAccountSettingsSnapshot(),
      surface: 'session_agent',
    });
    return approvalSuppression.suppress ? { decision: 'approved' } : null;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    if (this.isPermissionRequestClaimed(toolCallId)) {
      return await this.requestPermissionDecision(toolCallId, toolName, input);
    }
    const immediateDecision = this.getImmediateDecision(toolCallId, toolName, input);
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

    const pending = this.requestPermissionDecision(toolCallId, toolName, input);
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
    return await pending;
  }
}
