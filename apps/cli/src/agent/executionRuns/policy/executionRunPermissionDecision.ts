import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type {
  AcpPermissionCallContext,
  AcpPermissionCausalAuthority,
} from '@/agent/acp/permissions/acpPermissionHandler';
import {
  isPermissionGuardToolName,
  isSharedPermissionSafeToolName,
  isSharedPermissionWriteLikeToolName,
} from '@/agent/permissions/permissionTaxonomy';
import { resolveCausalPermissionMode } from '@/agent/permissions/causalPermissionMode';
import type { PermissionMode } from '@/api/types';
import { resolveProviderPermissionForHappierAction } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { isReadOnlyWorkspaceShellCommand, isWorkspaceWriteDeniedByRole } from '@/agent/permissions/workspaceWritePolicy';
import { applyAllowedToolsToAllowlist } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import type { AgentSessionConfigurationSnapshotV1 } from '@happier-dev/protocol/runtime/agentSessionV1';

import { executionRunPermissionIntentV1 as permissionMode } from '@happier-dev/protocol/actions/executionRunActionPermissionMode';
import { prepareMcpToolCatalog, resolveMcpToolIdentity, type McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { SessionInputCausalPermissionAuthorityV1Schema, type SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ProviderEnforcedPermissionHandler, PermissionResult } from '@/agent/permissions/providerEnforced/handler';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { applyNativePermissionImmediateDecision, observedPermissionResultMatches, resolveNativePermissionChoice, resolveNativePermissionImmediateDecision } from '@/agent/permissions/nativePermissionChoice';
import { isAgentStructuredQuestionRequest, isHostOccurrenceQuestion, resolveStructuredQuestionRequestMetadata } from '@/agent/permissions/requestKind';
import { normalizePermissionRequestOwner, permissionRequestOwnersEqual } from '@/agent/permissions/permissionRequestOwner';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';

export type ExecutionRunPermissionCallContext = Parameters<ProviderEnforcedPermissionHandler['handleToolCall']>[3];
type ObservedPermissionResult = Pick<Parameters<ProviderEnforcedPermissionHandler['settleObservedDecision']>[0], 'decision' | 'answers' | 'answerDetails'>;
export type ExecutionRunPermissionResponder = (toolCallId: string, response: boolean | PermissionResult) =>
  boolean | PermissionResult | null | Promise<boolean | PermissionResult | null>;

/** Admission for a fresh Run input; an earlier turn never supplies its authority. */
export function resolveExecutionRunInputAuthority(input: Readonly<{
  permissionMode: string;
  causalPermissionAuthority?: unknown;
  effectiveCallerPermissionMode?: string;
}>): Readonly<{
  ok: true;
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
  effectiveCallerPermissionMode: PermissionMode;
}> | Readonly<{ ok: false; errorCode: 'execution_run_not_allowed'; error: string }> {
  const failure = { ok: false as const, errorCode: 'execution_run_not_allowed' as const,
    error: 'causal_permission_authority_invalid' };
  const hasAuthority = Object.hasOwn(input, 'causalPermissionAuthority');
  // A private caller mode proves that this input must carry its original witness.
  if (!hasAuthority && input.effectiveCallerPermissionMode !== undefined) return failure;
  const parsed = SessionInputCausalPermissionAuthorityV1Schema.safeParse(hasAuthority
    ? input.causalPermissionAuthority
    : { kind: 'admittedSessionInputV1', admittedPermissionCeiling: permissionMode(input.permissionMode) });
  if (!parsed.success) return failure;
  const resolved = resolveCausalPermissionMode({ currentPermissionMode: permissionMode(input.permissionMode),
    context: { causalPermissionAuthority: parsed.data,
      ...(input.effectiveCallerPermissionMode !== undefined ? { callerPermissionMode: input.effectiveCallerPermissionMode } : {}) },
  });
  return resolved.ok
    ? { ok: true, causalPermissionAuthority: parsed.data, effectiveCallerPermissionMode: resolved.effectiveMode }
    : failure;
}

export type ExecutionRunPermissionHandler = Omit<AcpPermissionHandler, 'handleToolCall'> & Readonly<{
  handleToolCall: ProviderEnforcedPermissionHandler['handleToolCall'];
  getImmediateDecision: NonNullable<AcpPermissionHandler['getImmediateDecision']>;
  respondToPermissionRequest: ExecutionRunPermissionResponder;
  settleObservedDecision: ProviderEnforcedPermissionHandler['settleObservedDecision'];
}>;

export function isExecutionRunWriteLikeToolName(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return true;
  if (isPermissionGuardToolName(lower)) return true;
  return isSharedPermissionWriteLikeToolName(lower);
}

export function shouldAlwaysApproveExecutionRunTool(toolName: string): boolean {
  return isSharedPermissionSafeToolName(toolName);
}

function resolveExecutionRunImmediateDecision(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  context?: AcpPermissionCallContext;
  getMcpToolContext?: () => McpToolPolicyContext | null;
}>): PermissionResult | null {
  const rawLower = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionMode(args.permissionMode);
  const hasContextCausalAuthority = Boolean(
    args.context
    && Object.prototype.hasOwnProperty.call(args.context, 'causalPermissionAuthority'),
  );
  const hasRunCausalAuthority = Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority');
  const effective = resolveCausalPermissionMode({
    currentPermissionMode: normalizedMode,
    context: hasContextCausalAuthority
      ? args.context
      : hasRunCausalAuthority
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : undefined,
  });

  // A supplied causal authority that cannot be proved valid is itself a typed
  // non-authorizing fact. Returning a pending prompt here would let a buffered
  // or later response bypass the malformed admitted ceiling.
  if (!effective.ok) return { decision: 'denied' };
  const effectiveMode = effective.effectiveMode;
  const mcpTool = resolveMcpToolIdentity({ toolName: args.toolName, context: args.getMcpToolContext?.(), permissionMode: parseAgentPermissionIntentV1Alias(effectiveMode) ?? 'default' });
  if (isWorkspaceWriteDeniedByRole({ workspaceWrites: args.workspaceWrites, toolName: args.toolName, toolInput: args.input, mcpEffectClass: mcpTool?.decision.effectClass })) return { decision: 'denied' };

  const allowedIdentifiers = new Set<string>();
  applyAllowedToolsToAllowlist(allowedIdentifiers, args.allowedTools);
  const listed = isToolAllowedForSession(allowedIdentifiers, args.toolName, args.input);
  if (args.unlistedTools === 'deny' && !listed) return { decision: 'denied' };

  const actionPermission = resolveProviderPermissionForHappierAction({
    toolName: args.toolName, input: args.input, permissionMode: effectiveMode,
  });
  // An admitted Action ceiling cannot be widened by a legacy tool allowlist.
  if (effective.authority === 'admittedSessionInputV1' && actionPermission.decision === 'denied') {
    return { decision: 'denied' };
  }

  // Legacy no_tools names a shared-safe tool allowlist, not the canonical
  // read-only Action ceiling. Preserve it after any admitted Action denial.
  if (rawLower === 'no_tools') {
    return { decision: shouldAlwaysApproveExecutionRunTool(args.toolName) ? 'approved' : 'denied' };
  }

  if (actionPermission.decision) return { decision: actionPermission.decision };

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return { decision: 'approved' };

  if (mcpTool) {
    return resolveNativePermissionImmediateDecision(
      mcpTool.decision.approval === 'deny' ? { decision: 'denied' }
        : mcpTool.decision.approval === 'allow' ? { decision: 'approved' }
          : listed ? { decision: 'approved_for_session' } : null,
      args.context?.nativeChoices, mcpTool);
  }

  if (effectiveMode === 'read-only' || effectiveMode === 'plan') {
    const normalizedToolName = String(args.toolName ?? '').trim().toLowerCase();
    // Explicit external MCP grants are independent of the builtin workspace
    // write ceiling. Role denial and causal admission were checked above.
    if (listed && normalizedToolName.startsWith('mcp__')) return { decision: 'approved_for_session' };
    if (
      normalizedToolName === 'bash'
      || normalizedToolName === 'shell'
      || normalizedToolName === 'execute'
    ) {
      const command = extractShellCommand(args.input);
      if (command && isReadOnlyWorkspaceShellCommand(command)) {
        return { decision: 'approved' };
      }
    }
    return isExecutionRunWriteLikeToolName(args.toolName) ? { decision: 'denied' } : { decision: 'approved' };
  }

  if (listed) return { decision: 'approved_for_session' };

  if (effectiveMode === 'yolo') {
    return { decision: 'approved_for_session' };
  }

  if (effectiveMode === 'safe-yolo') {
    return { decision: 'approved_for_session' };
  }

  // Default (and other interactive-ish modes): require an explicit response.
  return null;
}

/**
 * Deterministic execution-run permission decision used by non-interactive call sites that cannot
 * block on a prompt loop.
 *
 * If the permission mode would normally require an interactive response, this fails closed by
 * denying rather than auto-approving.
 */
export function resolveExecutionRunPermissionDecision(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  getMcpToolContext?: () => McpToolPolicyContext | null;
}>): 'approved_for_session' | 'denied' {
  const immediate = resolveExecutionRunImmediateDecision(args);
  if (!immediate) return 'denied';
  return immediate.decision === 'denied' ? 'denied' : 'approved_for_session';
}

export function createExecutionRunPermissionHandler(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  getMcpToolContext?: () => McpToolPolicyContext | null;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
  publishPendingRequest?: (request: Omit<Parameters<AgentStateRequestStore['publishRequest']>[0], 'createdAt'>) => Promise<void> | void;
  }>): ExecutionRunPermissionHandler {
  const pending = new Map<string, { resolve: (value: PermissionResult) => void;
    readCurrentDecision: () => ReturnType<typeof resolveExecutionRunImmediateDecision>;
    context?: ExecutionRunPermissionCallContext; toolName?: string; cleanup?: () => void; preparing?: boolean;
    application?: Promise<boolean | PermissionResult | null>;
    observed?: { result: ObservedPermissionResult; persistence?: Promise<boolean> } }>();

  type Pending = NonNullable<ReturnType<typeof pending.get>>;
  const settle = (requestId: string, request: Pending, result: PermissionResult): void => {
    if (pending.get(requestId) !== request) return;
    pending.delete(requestId);
    request.cleanup?.();
    request.resolve(result);
  };
  const persistObserved = async (requestId: string, request: Pending, result: ObservedPermissionResult): Promise<boolean> => {
    const store = args.getPermissionRequestStore?.();
    const application = store?.captureRequestApplication?.(requestId);
    if (!application || !store?.completeRequest || pending.get(requestId) !== request) return false;
    const completion = { requestId, status: result.decision === 'abort' ? 'canceled' : result.decision,
      decision: result.decision,
      ...(result.answers ? { structuredAnswersV1: result.answers } : {}),
      ...(result.answerDetails === undefined ? {} : { answerDetails: result.answerDetails }),
      extraCompletedFields: { responseTarget: undefined }, applicationAcknowledged: application };
    const persistence = Promise.resolve(store.completeRequest(completion)).then(saved => saved !== false);
    request.observed = { result, persistence };
    const retained = store.readAppliedCompletion?.(completion);
    if (retained?.matches) void retained.acknowledgement.then(saved => { if (saved) settle(requestId, request, result); });
    const saved = await persistence;
    if (saved) settle(requestId, request, result);
    return saved;
  };

  const settleObservedDecision: ProviderEnforcedPermissionHandler['settleObservedDecision'] = async observed => {
    const request = pending.get(observed.requestId);
    const context = request?.context;
    if (!request || !context || request.observed
      || (!context.nativeChoices && !isHostOccurrenceQuestion(request.toolName ?? '', context))
      || !observed.source.trim() || observed.source.trim() !== context.source?.trim()
      || !permissionRequestOwnersEqual(normalizePermissionRequestOwner(context.owner), normalizePermissionRequestOwner(observed.owner))) return false;
    const result: ObservedPermissionResult = { decision: observed.decision,
      ...(observed.answers === undefined ? {} : { answers: observed.answers }),
      ...(observed.answerDetails === undefined ? {} : { answerDetails: observed.answerDetails }) };
    if (request.application) {
      request.observed = { result };
      try { const applied = await request.application; if (applied !== false && applied !== null) return true; } catch { /* Native observation remains authoritative after refusal. */ }
      return await (request.observed.persistence ?? Promise.resolve(false));
    }
    return await persistObserved(observed.requestId, request, result);
  };

  const respondToPermissionRequest: ExecutionRunPermissionResponder = (toolCallId, response) => {
    const request = pending.get(toolCallId) ?? null;
    const legacy = typeof response === 'boolean';
    if (!request || request.preparing) return legacy ? false : null;
    let accepted: PermissionResult;
    if (request.context?.nativeChoices) {
      const native = !legacy && resolveNativePermissionChoice(request.context.nativeChoices, response.nativeChoice);
      if (!native) return legacy ? false : null;
      accepted = native.result;
      if (request.readCurrentDecision()?.decision === 'denied'
        && accepted.decision !== 'denied' && accepted.decision !== 'abort') return null;
    } else {
      accepted = legacy ? { decision: response ? 'approved' : 'denied' } : response;
      if (request.readCurrentDecision()?.decision === 'denied') accepted = { decision: 'denied' };
    }
    if (legacy && !request.context?.acknowledgeDecisionApplication) {
      pending.delete(toolCallId);
      request.cleanup?.();
      request.resolve(accepted);
      return true;
    }
    request.preparing = true;
    const application = Promise.resolve().then(async () => {
      try {
        try {
          await request.context?.acknowledgeDecisionApplication?.(accepted);
        } catch (error) {
          if (request.observed && !request.observed.persistence) await persistObserved(toolCallId, request, request.observed.result);
          throw error;
        }
        if (request.observed) {
          if (request.observed.persistence) {
            return await request.observed.persistence && observedPermissionResultMatches(accepted, request.observed.result)
              ? legacy ? true : accepted : legacy ? false : null;
          }
          if (!observedPermissionResultMatches(accepted, request.observed.result)) {
            await persistObserved(toolCallId, request, request.observed.result);
            return legacy ? false : null;
          }
        }
        if (pending.get(toolCallId) !== request) return legacy ? false : null;
        pending.delete(toolCallId);
        request.cleanup?.();
        request.resolve(accepted);
        return legacy ? true : accepted;
      } finally {
        if (pending.get(toolCallId) === request) {
          request.preparing = false;
          if (request.application === application) delete request.application;
        }
      }
    });
    request.application = application;
    return application;
  };

  function readImmediate(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: ExecutionRunPermissionCallContext,
  ) {
    if (isAgentStructuredQuestionRequest({ toolName, source: context?.source }) && !context?.nativeChoices) return null;
    const immediate = resolveExecutionRunImmediateDecision({
      permissionMode: args.permissionMode,
      allowedTools: args.allowedTools,
      unlistedTools: args.unlistedTools,
      workspaceWrites: args.workspaceWrites,
      backendId: args.backendId,
      toolName,
      input,
      getMcpToolContext: args.getMcpToolContext,
      ...(Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority')
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : {}),
      ...(context ? { context } : {}),
    });
    return resolveNativePermissionImmediateDecision(immediate, context?.nativeChoices);
  }

  return {
    respondToPermissionRequest,
    settleObservedDecision,
    getImmediateDecision(toolCallId, toolName, input, context) {
      return readImmediate(toolCallId, toolName, input, context);
    },
    async handleToolCall(toolCallId, toolName, input, context) {
      if (context?.signal?.aborted) throw new Error('Permission request aborted');
      const catalogPreparation = prepareMcpToolCatalog({ toolName, context: args.getMcpToolContext?.() });
      if (catalogPreparation) {
        let cancelled = false;
        const cancellation = new Promise<void>(resolve => {
          pending.set(toolCallId, { preparing: true, readCurrentDecision: () => null,
            resolve: () => { cancelled = true; resolve(); } });
        });
        const request = pending.get(toolCallId);
        // Cancellation owns this waiter, never the shared catalog hydration.
        await Promise.race([catalogPreparation, cancellation]);
        if (cancelled || pending.get(toolCallId) !== request) return { decision: 'denied' };
        pending.delete(toolCallId);
      }
      const immediate = readImmediate(toolCallId, toolName, input, context);
      if (immediate) return await applyNativePermissionImmediateDecision(immediate, context);

      if (!args.publishPendingRequest) {
        const error = Object.assign(
          new Error('Execution-run permission interaction target is unavailable'),
          { code: 'execution_run_interaction_unavailable' },
        );
        throw error;
      }
      const pendingDecision = new Promise<PermissionResult>((resolve) => {
        const onAbort = () => {
          const request = pending.get(toolCallId);
          if (!request) return;
          pending.delete(toolCallId);
          request.cleanup?.();
          resolve({ decision: 'denied' });
        };
        pending.set(toolCallId, { resolve, context, toolName,
          readCurrentDecision: () => readImmediate(toolCallId, toolName, input, context),
          cleanup: () => context?.signal?.removeEventListener('abort', onAbort) });
        context?.signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await args.publishPendingRequest({
          requestId: toolCallId,
          toolName,
          toolInput: input,
          ...resolveStructuredQuestionRequestMetadata({ toolName, source: context?.source,
            nativeChoices: context?.nativeChoices }),
          ...(context?.nativeChoices ? { nativeChoices: context.nativeChoices } : {}),
          ...(context?.source ? { source: context.source } : {}),
          ...(context?.owner ? { owner: context.owner } : {}),
          ...(context?.lifetime ? { lifetime: context.lifetime } : {}),
          ...(() => {
            const effective = resolveCausalPermissionMode({ currentPermissionMode: permissionMode(args.permissionMode), context: context ?? (args.causalPermissionAuthority ? { causalPermissionAuthority: args.causalPermissionAuthority } : undefined) });
            const mcpTool = effective.ok ? resolveMcpToolIdentity({ toolName, context: args.getMcpToolContext?.(), permissionMode: parseAgentPermissionIntentV1Alias(effective.effectiveMode) ?? 'default' }) : null;
            return mcpTool ? { mcpTool } : {};
          })(),
          ...(context?.turnId ? { turnId: context.turnId } : {}),
        });
      } catch (error) {
        pending.get(toolCallId)?.cleanup?.();
        pending.delete(toolCallId);
        throw error;
      }
      return await pendingDecision;
    },
    async abortPendingRequestAndFlush(toolCallId) {
      const request = pending.get(toolCallId);
      if (!request) return;
      pending.delete(toolCallId);
      request.cleanup?.();
      request.resolve({ decision: 'denied' });
    },
    async abortPendingRequestsAndFlush() {
      const requests = [...pending.values()];
      pending.clear();
      for (const request of requests) { request.cleanup?.(); request.resolve({ decision: 'denied' }); }
    },
  };
}
