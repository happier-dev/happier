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
  SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS,
} from '../permissionTaxonomy';
import { shouldDenyAgentSessionTitleToolCall } from '../codingPromptTitlePermission';
import { normalizePermissionRequestOwner, type PermissionRequestOwner } from '../permissionRequestOwner';
import { resolveAgentRequestKind } from '../requestKind';
import { resolveCausalPermissionMode } from '../causalPermissionMode';
import type { PermissionRequestCoordinatorContext } from '../permissionRequestCoordinator';

export type { PermissionResult, PendingRequest };

type HandlerOpts = Readonly<{
  pushSender?: PermissionRequestPushSender | null;
  getAccountSettings?: (() => AccountSettings | null) | null;
  getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
  onAbortRequested?: (() => void | Promise<void>) | null;
  toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
  alwaysAutoApproveToolNameIncludes?: ReadonlyArray<string>;
  isMediatorPluginCurrent?: ((pluginId: string) => boolean) | null;
  isMediatorContributionCurrent?: ((mediator: Readonly<{
    pluginId: string;
    contributionLocalId: string;
  }>) => boolean) | null;
}>;

const DEFAULT_SAFE_TOOL_NAME_SEGMENTS = SHARED_PROVIDER_ENFORCED_SAFE_TOOL_NAME_SEGMENTS;

const ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS = new Set<ActionId>([
  'session.title.set',
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
]);

// Stored in the existing opaque request `source` field only for the host ACP
// filesystem boundary, so a restarted handler can reconstruct the incumbent
// policy input without inventing a second permission owner.
const HOST_ACP_FS_WRITE_PERMISSION_SOURCE = 'happier.host_acp_fs_write.v1';

function isFullAccessPermissionMode(mode: PermissionMode): boolean {
  return mode === 'yolo' || mode === 'bypassPermissions';
}

function deniesHostMediatedFsWrites(mode: PermissionMode): boolean {
  return mode === 'read-only' || mode === 'plan';
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
      isMediatorPluginCurrent: params.isMediatorPluginCurrent ?? null,
      isMediatorContributionCurrent: params.isMediatorContributionCurrent ?? null,
    });
    this.logPrefix = params.logPrefix;
    this.alwaysAutoApproveToolNameIncludes = [
      ...DEFAULT_SAFE_TOOL_NAME_SEGMENTS,
      ...(params.alwaysAutoApproveToolNameIncludes ?? []),
    ];
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
    // Provider policy remains authoritative, but a host-enforced current
    // denial (for example a narrowed host filesystem policy) cannot be
    // overridden by a delayed remote allow.
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
      {
        ...(context.source === HOST_ACP_FS_WRITE_PERMISSION_SOURCE
          ? { origin: 'host_acp_fs_write' as const }
          : {}),
        ...(causalPermissionContext ?? {}),
      },
    );
    return current?.decision === 'denied' || current?.decision === 'abort'
      ? current
      : { decision: 'approved' };
  }

  /**
   * Compatibility shim: some runtimes still call `setPermissionMode()` even when provider enforcement is enabled.
  * The mode still governs host-mediated operations that do not pass through provider policy.
  */
  setPermissionMode(mode: PermissionMode): void {
    if (this.currentPermissionMode !== mode) {
      this.invalidateRemoteMediationAllowCurrentness();
    }
    this.currentPermissionMode = mode;
    logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode} (provider-enforced)`);
    this.resolvePendingRequestsIfNowDecidable();
  }

  private resolvePendingRequestsIfNowDecidable(): void {
    if (this.pendingRequests.size === 0) return;

    for (const [toolCallId, pending] of Array.from(this.pendingRequests.entries())) {
      const decision = this.getImmediateDecision(
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
        () => this.getImmediateDecision(
          toolCallId,
          pending.toolName,
          pending.input,
          pending.causalPermissionContext,
        ),
      );
    }
  }

  private isAlwaysAutoApprove(toolName: string, input: unknown): boolean {
    if (isSharedPermissionSafeToolName(toolName)) return true;
    const happierActionId = resolveHappierActionForMcpToolName({ toolName, input });
    if (happierActionId && ALWAYS_AUTO_APPROVE_HAPPIER_ACTION_IDS.has(happierActionId)) return true;
    const normalized = toolName.trim().toLowerCase();
    return this.alwaysAutoApproveToolNameIncludes.some((name) => normalized === name.trim().toLowerCase());
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
    const effective = resolveCausalPermissionMode({
      currentPermissionMode: this.currentPermissionMode,
      context,
    });
    if (!effective.ok) {
      logger.debug(`${this.getLogPrefix()} Causal permission authority is invalid for ${toolName} (${toolCallId})`);
      return { decision: 'denied' };
    }
    const permissionMode = effective.effectiveMode;

    if (shouldDenyAgentSessionTitleToolCall({
      settings: this.getAccountSettingsSnapshot(),
      toolName,
      input,
    })) {
      return { decision: 'denied' };
    }
    if (
      context?.origin === 'host_acp_fs_write'
      && deniesHostMediatedFsWrites(permissionMode)
    ) {
      return { decision: 'denied' };
    }
    if (isFullAccessPermissionMode(permissionMode) && resolveAgentRequestKind(toolName) === 'permission') {
      return { decision: 'approved' };
    }
    if (this.isAlwaysAutoApprove(toolName, input)) {
      return { decision: 'approved' };
    }
    if (this.shouldSuppressForHappierActionApproval(toolName, input)) {
      return { decision: 'approved' };
    }
    return null;
  }

  private resolveAutomaticDecisionForToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    owner: PermissionRequestOwner | null,
    context?: AcpPermissionCallContext,
  ): PermissionResult | null {
    const immediate = this.getImmediateDecision(toolCallId, toolName, input, context);
    if (immediate) return immediate;

    const effective = resolveCausalPermissionMode({
      currentPermissionMode: this.currentPermissionMode,
      context,
    });
    if (!effective.ok) return null;
    if (!effective.sourceAuthority && this.isAllowedForSessionForOwner(toolName, input, owner)) {
      return { decision: 'approved_for_session' };
    }
    if (
      effective.sourceAuthority
      && this.isAllowedByRemoteMediationGrant(toolName, input, effective.sourceAuthority)
    ) {
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
    const persistedSource = source || (
      options?.origin === 'host_acp_fs_write'
        ? HOST_ACP_FS_WRITE_PERMISSION_SOURCE
        : ''
    );
    const automaticDecision = this.resolveAndRecordAutoDecision({
      toolCallId,
      toolName,
      input,
      resolve: () => this.resolveAutomaticDecisionForToolCall(toolCallId, toolName, input, owner, options),
      options: {
        ...(owner ? { owner } : {}),
        ...(persistedSource ? { source: persistedSource } : {}),
      },
    });
    if (automaticDecision) {
      const resolvedAutomaticDecision = await automaticDecision;
      if (resolvedAutomaticDecision) {
        logger.debug(
          `${this.getLogPrefix()} Applying automatic ${resolvedAutomaticDecision.decision} decision for tool ${toolName} (${toolCallId})`,
        );
        return resolvedAutomaticDecision;
      }
    }

    const resolveCurrentPermissionDecision = (): PermissionResult => {
      const current = this.getImmediateDecision(toolCallId, toolName, input, options);
      return current?.decision === 'denied' || current?.decision === 'abort'
        ? current
        : { decision: 'approved' };
    };

    // Respect user "don't ask again for session" choices captured via our permission UI.
    const effective = resolveCausalPermissionMode({
      currentPermissionMode: this.currentPermissionMode,
      context: options,
    });
    if (!effective.ok) {
      return this.requestPermissionDecision(toolCallId, toolName, input, {
        ...(owner ? { owner } : {}),
        ...(source ? { source } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options ? { causalPermissionContext: options } : {}),
        resolveCurrentPermissionDecision,
      });
    }

    const pending = this.requestPermissionDecision(toolCallId, toolName, input, {
      ...(owner ? { owner } : {}),
      ...(persistedSource ? { source: persistedSource } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options ? { causalPermissionContext: options } : {}),
      resolveCurrentPermissionDecision,
    });
    logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId})`);
    return await pending;
  }
}
