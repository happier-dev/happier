import type { CliActionDepsParams } from './types';
import type { readCurrentRunnerAgentStartPolicyV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { actionStartTargetUnavailableV1, measureActionStartPhaseV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { resolveCliAgentStartContextV1 } from '../resolveCliAgentStartContextV1';
import { resolveCliActionCallerSession } from '../resolveCliActionCallerSession';
import type { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readPreparedAccountRoleOverrides } from '@/session/roles/sessionRoleContext';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

export function createCliAgentStartContext(
  params: Pick<CliActionDepsParams, 'actionsSettingsProvider' | 'credentials' | 'getAgentStartRunCaller' | 'getCurrentAppliedChildSelection' | 'getCurrentTurnWorkDepth' | 'getSessionRoleContext' | 'readAgentStartPolicy' | 'resolveServerFeaturesSnapshot' | 'savedSecretOperationContext' | 'sessionId' | 'token' | 'workflowStepRoleDefaultEngine'>,
  { prepareAccountRoleOverrides, readReadyAccountRoleOverrides, readRoleSources, resolveActionCallerSession, readWorkflowActionStartContext }: Readonly<{
    prepareAccountRoleOverrides: (signal?: AbortSignal) => Promise<void>;
    readReadyAccountRoleOverrides: (signal?: AbortSignal) => ReturnType<typeof readPreparedAccountRoleOverrides>;
    readRoleSources: RoleSourceReader;
    resolveActionCallerSession: (context: ActionExecutorContext, readPause?: boolean) => ReturnType<typeof resolveCliActionCallerSession>;
    readWorkflowActionStartContext?: (context: ActionExecutorContext) => Promise<ActionExecutorContext['agentStartContext'] | null>;
  }>,
  readEffectiveDeps: () => ActionExecutorDeps,
): NonNullable<ActionExecutorDeps['resolveAgentStartContext']> {
  const environment = sessionProcessEnvironment();
  const resolveAgentStartContext: NonNullable<ActionExecutorDeps['resolveAgentStartContext']> = async (context, options) => {
    const binding = context.externalActionExecutionAuthorization?.binding;
    const workflowOrigin = binding?.workflowActionOrigin;
    const witness = workflowOrigin?.sessionAuthority;
    // Originless approval replay restores the accepted invocation through the
    // Workflow context owner; it has no Session authority witness to consume.
    if (context.actionCaller?.kind === 'workflowRun' && !witness) {
      return await readWorkflowActionStartContext?.(context) ?? null;
    }
    if (workflowOrigin || context.actionCaller?.kind === 'workflowRun') {
      if (!binding || !workflowOrigin || !witness || context.actionCaller?.kind !== 'workflowRun'
        || context.actionCaller.runId !== workflowOrigin.runId || context.actionRequestId !== binding?.requestId
        || binding.accountId !== readAccountIdFromToken(params.token)
        || binding.target.kind !== 'session' || binding.target.sessionId !== params.sessionId) return null;
      const settings = params.actionsSettingsProvider?.getAccountSettings?.();
      if (!settings) return null;
      return { caller: { kind: 'originless', runId: workflowOrigin.runId, runDepth: witness.runDepth,
          ...(witness.runOriginSessionId ? { runOriginSessionId: witness.runOriginSessionId } : {}) },
        baseline: { machineId: binding.machineId, directory: witness.directory },
        ledSubtreeSessionIds: [], roles: {}, callerPermissionCeiling: witness.authorization.admittedPermissionCeiling,
        workDepthLimit: settings.workDepthLimit, allowLists: settings.sessionAgentStartAllowListsV1 };
    }
    const scopeOnly = options?.purpose === 'session_scope' || options?.purpose === 'workflow_scope';
    const session = await measureActionStartPhaseV1(context, 'caller_session', () => resolveActionCallerSession(context, options?.readBotPause));
    const refuse = (reason: import('@happier-dev/protocol/workflows/workflowProgressV1').WorkflowTargetUnavailableReasonV1) =>
      actionStartTargetUnavailableV1(context, 'agent_start_context', reason);
    if (!session) return refuse('caller_session_unavailable');
    const runCaller = params.getAgentStartRunCaller?.();
    if (params.getAgentStartRunCaller && !runCaller) return refuse('caller_run_unavailable');
    const caller = context.actionCaller;
    const admittedCaller = caller?.kind === 'session'
      ? AgentStartSessionCallerV1Schema.safeParse(caller)
      : null;
    if (admittedCaller && !admittedCaller.success) return refuse('caller_witness_invalid');
    let starterDepth: unknown = admittedCaller?.success ? admittedCaller.data.starterDepth : session.workDepth;
    if (starterDepth === undefined && !runCaller) {
      try {
        const { fetchSessionById } = await import("@/session/transport/http/sessionsHttp");
        const persisted = await fetchSessionById({ reason: 'session-action', token: params.token, sessionId: session.sessionId,
          serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.() });
        if (persisted && 'workDepth' in persisted) starterDepth = persisted.workDepth;
      } catch { return refuse('caller_depth_unavailable'); }
    }
    const turnId = context.sessionInputSource && typeof context.sessionInputSource === 'object'
      && 'sourceTurnId' in context.sessionInputSource && typeof context.sessionInputSource.sourceTurnId === 'string'
      ? context.sessionInputSource.sourceTurnId : undefined;
    const turnDepth = (admittedCaller?.success ? admittedCaller.data.turnDepth : params.getCurrentTurnWorkDepth?.(turnId))
      ?? (context.actionCaller?.kind !== 'session' && session.sessionId === params.sessionId
        && !params.getCurrentTurnWorkDepth ? 0 : undefined);
    if (turnDepth === undefined) return refuse('caller_depth_unavailable');
    // Scope admission consumes the same validated caller, not Agent launch
    // selections. Catalog hydration repeats requester authority round trips
    // without contributing any fact to the fresh Home subtree decision.
    const readsWorkPolicy = options?.purpose !== 'session_scope';
    const requiresBoundStartPolicy = readsWorkPolicy && (Boolean(params.readAgentStartPolicy)
      || (params.actionsSettingsProvider ? !params.actionsSettingsProvider.getAccountSettings : !params.credentials));
    const sessionRoleContext = !scopeOnly ? params.getSessionRoleContext?.() : undefined;
    const workflowStepRoleDefaultEngine = !scopeOnly && session.sessionId === params.sessionId
      && !params.getCurrentAppliedChildSelection && !sessionRoleContext ? params.workflowStepRoleDefaultEngine : undefined;
    const { executionRunChildSelectionNeedsAppliedParent } = await import('@/agent/runtime/bridges/executionRun/runtime/openInputs');
    const needsAppliedParent = executionRunChildSelectionNeedsAppliedParent({
      lifecycle: 'attached', childSelection: options?.executionRunChildSelection,
    });
    const prepareStartReads = async () => {
      const { readCliSessionEngineBaselineV1 } = await import('../resolveCliAgentStartContextV1');
      let appliedChildSelection: import('@/agent/runtime/bridges/executionRun/runtime/openInputs').ExecutionRunAppliedParentSelection | undefined;
      const readAppliedSelection = session.sessionId === params.sessionId
        ? params.getCurrentAppliedChildSelection ?? sessionRoleContext?.readAppliedChildSelection : session.readAppliedChildSelection;
      if (!scopeOnly && needsAppliedParent && readAppliedSelection) {
        try { appliedChildSelection = await readAppliedSelection(); }
        catch { appliedChildSelection = { status: 'unavailable' }; }
      }
      // A Role snapshot consumes applied launch facts or the existing explicit
      // Workflow child engine. A role-free Run can proceed with caller facts
      // and no launch configuration when the native selector allows it.
      const hasLaunchBaseline = !scopeOnly && (appliedChildSelection?.status === 'applied' || Boolean(workflowStepRoleDefaultEngine));
      const directParentCustody = options?.purpose === 'attached_execution_run'
        && appliedChildSelection?.status === 'unavailable' && appliedChildSelection.reason === 'direct_custody';
      if (!scopeOnly && (!session.backendTarget || (!hasLaunchBaseline && !directParentCustody && needsAppliedParent))) {
        return { effectiveSnapshotUnavailable: true } as const;
      }
      if (hasLaunchBaseline) await measureActionStartPhaseV1(context, 'role_overrides', () => prepareAccountRoleOverrides(context.signal));
      // The live Session owns fresh Role resolution, including its installed
      // Agent sources. A runner's cold built-in inventory cannot re-admit it.
      const roleSources = !hasLaunchBaseline || sessionRoleContext ? undefined
        : await measureActionStartPhaseV1(context, 'role_sources', () => readRoleSources(context.signal));
      const settings = !readsWorkPolicy ? null : await measureActionStartPhaseV1(context, 'account_settings', async () =>
        {
        const [{ readCurrentRunnerAgentStartPolicyV1 }, { bootstrapAccountSettingsContext }] = await Promise.all([import("@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient"), import("@/settings/accountSettings/bootstrapAccountSettingsContext")]);
        return requiresBoundStartPolicy ? await (params.readAgentStartPolicy
          ? params.readAgentStartPolicy(context.signal) : readCurrentRunnerAgentStartPolicyV1(session.sessionId, context.signal, environment))
        : params.actionsSettingsProvider?.getAccountSettings?.()
        ?? (params.credentials ? (await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' })).settings : null);
      });
      const availableAgents = hasLaunchBaseline ? await measureActionStartPhaseV1(context, 'agent_inventory',
        async () => readEffectiveDeps().agentsBackendsList?.({ includeDisabled: false })) : undefined;
      if (hasLaunchBaseline && !availableAgents) return { effectiveSnapshotUnavailable: true } as const;
      // Only a complete child snapshot updates the live Role owner's resolution.
      const roles = sessionRoleContext && session.backendTarget && availableAgents ? await measureActionStartPhaseV1(context, 'role_sources', () =>
        sessionRoleContext.resolveRoles({
          defaultEngine: readCliSessionEngineBaselineV1({ backendTarget: session.backendTarget!, appliedChildSelection }).defaultEngine,
          availableAgentTargetKeys: availableAgents.items.filter(item => item.enabled).map(item => item.targetKey),
        }, context.signal)) : undefined;
      return { roles, roleSources, settings, appliedChildSelection, availableAgents, hasLaunchBaseline, directParentCustody };
    };
    const { resolveCliAgentStartContextV1 } = await import("../resolveCliAgentStartContextV1");
    let prepared: Awaited<ReturnType<typeof prepareStartReads>>;
    try { prepared = await prepareStartReads(); }
    catch (error) {
      if (readActionErrorCodeV1(error) === 'role_source_incomplete') return refuse('role_source_incomplete');
      throw error;
    }
    context.signal?.throwIfAborted();
    if (prepared.effectiveSnapshotUnavailable) return refuse('caller_agent_unavailable');
    const { roles, roleSources, settings, appliedChildSelection, availableAgents, hasLaunchBaseline, directParentCustody } = prepared;
    if (!scopeOnly && params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
      return refuse('caller_session_unavailable');
    }
    context.signal?.throwIfAborted();
    if (requiresBoundStartPolicy && !settings) return refuse('requester_projection_unavailable');
    const resolved = resolveCliAgentStartContextV1({
      recordActionStartDiagnostic: context.recordActionStartDiagnostic,
      sessionId: session.sessionId,
      machineId: session.machineId, directory: session.directory,
      backendTarget: session.backendTarget ?? null,
      metadata: session.metadata, starterDepth: typeof starterDepth === 'number' ? starterDepth : undefined, runCaller,
      appliedChildSelection,
      ...(directParentCustody ? { directParentCustody: true } : {}),
      workflowStepRoleDefaultEngine,
      turnDepth,
      callerPermissionMode: context.callerPermissionMode ?? null, settings,
      accountRoleOverrides: hasLaunchBaseline ? await readReadyAccountRoleOverrides(context.signal) : undefined,
      roles: hasLaunchBaseline ? roles : {},
      availableAgentTargetKeys: availableAgents?.items
        .filter((item) => item.enabled).map((item) => item.targetKey),
      roleSourceInventory: roleSources,
    });
    // A scope witness proves identity/depth/reachability, not native execution
    // configuration. Never let its metadata-only observation stand in for an
    // admitted effective baseline in a later Role copy.
    if (!resolved || 'ok' in resolved) return resolved;
    return { ...resolved, botPausedAt: session.botPausedAt, ...(scopeOnly ? { baseline: {
      machineId: resolved.baseline.machineId, directory: resolved.baseline.directory,
    } } : {}) };
  };
  return resolveAgentStartContext;
}
