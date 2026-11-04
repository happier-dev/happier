import { readRecord } from '../../../inputs/inputRecords.js';
import { resolveSessionIdFromInput, resolveServerIdForExecutionRunScope } from '../sessionScope.js';
import { resolveExecutionRunLaunchOrigin, buildExecutionRunCallOptions, checkDetachedExecutionRunProtocolV2, normalizeExecutionBackendTargetValue, resolveFanoutTeamCredentialModel, resolveFanoutConnectedServicesSelections, fanoutStarts, classifyExecutionRunStartFailure } from '../executionRuns.js';
import { createPermissionPolicyResult, resolveAgentExecutionRunPermission } from '../callerContext.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../../executionRunActionPermissionMode.js';
import { resolveRunStartModelAndConfig } from '../agentStartAdmission.js';
import { normalizeId } from '../inputReading.js';
import { completeActionResult } from '../resultProjection.js';
import type { SubagentRefInputV1, SubagentStatusV1, SubagentLifecycleDetailV1 } from '../../../sessions/subagents/subagentRefV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult } from '../types.js';



export async function dispatchAgentsSubagents1(inv: Pick<CoreInvocation, 'actionId' | 'data' | 'parsed' | 'ctx' | 'deps'> & Readonly<{
  startExecutionRunWithSelection: (sessionId: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[0], input: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[1], opts: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2], context: ActionExecutorContext) => ReturnType<NonNullable<ActionExecutorDeps['executionRunStart']>>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, data, parsed, ctx, deps, startExecutionRunWithSelection } = inv;

      if (actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start' || actionId === 'voice_agent.start') {
        const detached = actionId === 'subagents.plan.start' && readRecord(data.target).kind === 'detached';
        const sessionId = detached ? null : resolveSessionIdFromInput(parsed.data, ctx);
        if (!detached && !sessionId) return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
        const machineTarget = detached && ctx.externalActionTarget?.kind === 'machine'
          ? ctx.externalActionTarget : undefined;
        const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
        const opts = buildExecutionRunCallOptions(
          ctx.authority,
          serverId, ctx.signal,
          detached ? ctx.defaultSessionId : undefined,
          detached ? machineTarget?.machineId ?? ctx.executionRunTargetMachineId : undefined,
          detached ? ctx.executionRunPermissionRequestStore : undefined,
          detached ? ctx.executionRunWorkflowObservationSink : undefined,
          ctx,
        );

        const backendTargetKeys: readonly string[] = Array.isArray(data.backendTargetKeys)
          ? data.backendTargetKeys
          : [];
        const teamCredentialModel = resolveFanoutTeamCredentialModel(data, backendTargetKeys);
        if (!teamCredentialModel.ok) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (
          data.teamCredentialSessionBindingConsent
          && (data.teamCredentialSessionBindingConsent as Readonly<{ sessionId: string }>).sessionId !== sessionId
        ) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        if (data.profileId && backendTargetKeys.length !== 1) {
          return {
            ok: false,
            errorCode: 'execution_run_profile_requires_single_engine',
            error: 'execution_run_profile_requires_single_engine',
          };
        }
        const instructions = String(data.instructions ?? '').trim();
        const intent: 'plan' | 'delegate' | 'voice_agent' =
          actionId === 'subagents.plan.start' ? 'plan' : actionId === 'subagents.delegate.start' ? 'delegate' : 'voice_agent';
        if (intent === 'voice_agent' && teamCredentialModel.selection) {
          return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
        }
        const permissionModeDefault = intent === 'delegate' ? 'workspace_write' : 'read_only';
        const requestedPermissionMode = data.permissionMode;
        const executionRunPermission = resolveAgentExecutionRunPermission(
          ctx,
          requestedPermissionMode,
          EXECUTION_RUN_ACTION_PERMISSION_MODES,
        );
        if (!executionRunPermission.ok) {
          return executionRunPermission.error;
        }
        const permissionDecision = executionRunPermission.permissionDecision;
        if (permissionDecision?.ok === false) {
          return createPermissionPolicyResult(ctx, permissionDecision);
        }
        const permissionMode = permissionDecision?.ok === true
          ? permissionDecision.requestedMode
          : requestedPermissionMode ?? permissionModeDefault;
        const executionRunOpts = executionRunPermission.causalPermissionAuthority
          ? {
              ...(opts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            }
          : opts;

          let executionRunDispatchOpts = executionRunOpts;
          const connectedSelections = resolveFanoutConnectedServicesSelections(data, backendTargetKeys);
          if (!connectedSelections.ok) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          const runScopedAgentBindings = data.roleId !== undefined || data.launchProfileId !== undefined
            || teamCredentialModel.selection !== null;
          if (detached || data.secretReferenceOverlay || runScopedAgentBindings) {
            const capability = await checkDetachedExecutionRunProtocolV2(
              deps,
              sessionId,
              executionRunOpts,
              {
                startAndWait: false,
                runScopedAgentBindings,
                secretReferenceOverlay: data.secretReferenceOverlay !== undefined,
              },
            );
            if (!capability.ok) return classifyExecutionRunStartFailure(capability, 'noRunCreated');
            executionRunDispatchOpts = capability.opts;
          }
          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return runOptions.error;
          }
          const {
            teamCredentialSessionBindingConsent: _teamCredentialSessionBindingConsent,
            secretReferenceOverlay: _secretReferenceOverlay,
            ...runIntentInput
          } = data;
          const results = await fanoutStarts({
            keys: backendTargetKeys,
            startOne: async (backendTargetKey) => {
              const targetSelection = connectedSelections.selections.get(backendTargetKey)!;
              const connectedServices = targetSelection.bindings;
              const connectedServicesDefaultServiceIds = targetSelection.defaultServiceIds;
              return startExecutionRunWithSelection(
                sessionId,
                {
                  intent: data.intent ?? intent,
                  ...(typeof data.roleId === 'string' ? { roleId: data.roleId } : {}),
                  ...(typeof data.launchProfileId === 'string' ? { launchProfileId: data.launchProfileId } : {}),
                  ...(machineTarget?.project ? { cwd: machineTarget.project.directory } : {}),
                  backendTarget: data.roleId && data.backendTarget ? data.backendTarget : normalizeExecutionBackendTargetValue(backendTargetKey),
                  instructions,
                  ...(data.childSelection !== undefined ? { childSelection: data.childSelection } : {}),
                  ...(data.modelSelection !== undefined ? { modelSelection: data.modelSelection } : {}),
                  ...(intent === 'voice_agent' && typeof data.chatModelId === 'string' ? { chatModelId: data.chatModelId } : {}),
                  ...(intent === 'voice_agent' && typeof data.commitModelId === 'string' ? { commitModelId: data.commitModelId } : {}),
                  permissionMode,
                  retentionPolicy: data.retentionPolicy ?? 'ephemeral',
                  runClass: data.runClass ?? 'bounded',
                  ioMode: data.ioMode ?? 'request_response',
                  ...(data.notifyParentOnCompletion !== undefined
                    ? { notifyParentOnCompletion: data.notifyParentOnCompletion }
                    : {}),
                  launchOrigin: resolveExecutionRunLaunchOrigin(ctx),
                  ...(typeof data.profileId === 'string' && data.profileSourceCustody
                    ? {
                        profileId: data.profileId,
                        profileSourceCustody: data.profileSourceCustody,
                      }
                    : {}),
                  ...(teamCredentialModel.selection
                    ? {
                        modelId: teamCredentialModel.selection.modelId,
                        teamCredentialModel: teamCredentialModel.selection,
                        ...(data.teamCredentialSessionBindingConsent
                          ? { teamCredentialSessionBindingConsent: data.teamCredentialSessionBindingConsent }
                          : {}),
                      }
                    : runOptions.options.modelId
                      ? { modelId: runOptions.options.modelId }
                      : {}),
                  ...(runOptions.options.sessionConfigOptionOverrides
                    ? { sessionConfigOptionOverrides: runOptions.options.sessionConfigOptionOverrides }
                    : {}),
                  ...(connectedServices !== undefined ? { connectedServices } : {}),
                  ...(connectedServicesDefaultServiceIds.length > 0
                    ? { connectedServicesDefaultServiceIds }
                    : {}),
                  ...(data.secretReferenceOverlay
                    ? { secretReferenceOverlay: data.secretReferenceOverlay }
                    : {}),
                  ...(!data.intent || data.intent === intent
                    ? intent === 'voice_agent'
                      // Voice owns a closed two-role input; generic launch fields are not its intent data.
                      ? (data.intentInput !== undefined ? { intentInput: data.intentInput } : {})
                      : { intentInput: { ...runIntentInput, backendTargetKey } }
                    : {}),
                },
                { ...executionRunDispatchOpts, ...(ctx.agentStartWorkDepth !== undefined ? { workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 } : {}) }, ctx,
              );
            },
          });

          return { ok: true, result: { intent, sessionId, results } };
        }
  return null;
}

export async function dispatchAgentsSubagents2(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'ctx' | 'parsed'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, ctx, parsed } = inv;

        if (actionId === 'sessions.subagents.list') {
          if (!deps.subagentsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.list' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsList({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, 'groupId')
              ? { groupId: normalizeId(data.groupId) || null }
              : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.get') {
          if (!deps.subagentsGet) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.get' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsGet({
            id: String(data.id),
            ...(parentSessionId ? { parentSessionId } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.watch') {
          if (!deps.subagentsWatch) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.watch' };
          }
          const parentSessionId = normalizeId(data.parentSessionId) || normalizeId(ctx.defaultSessionId);
          const res = await deps.subagentsWatch({
            ...(parentSessionId ? { parentSessionId } : {}),
            ...(normalizeId(data.id) ? { id: normalizeId(data.id) } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.upsert') {
          if (!deps.subagentsUpsert) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.upsert' };
          }
          const res = await deps.subagentsUpsert({
            input: parsed.data as SubagentRefInputV1,
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.updateStatus') {
          if (!deps.subagentsUpdateStatus) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.updateStatus' };
          }
          const res = await deps.subagentsUpdateStatus({
            input: parsed.data as {
              id: string;
              parentSessionId: string;
              status: SubagentStatusV1;
              lifecycleDetail?: SubagentLifecycleDetailV1;
              completedAt?: number;
            },
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }

        if (actionId === 'sessions.subagents.complete') {
          if (!deps.subagentsComplete) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:sessions.subagents.complete' };
          }
          const res = await deps.subagentsComplete({
            input: parsed.data as {
              id: string;
              parentSessionId: string;
              status?: Extract<SubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
              lifecycleDetail?: SubagentLifecycleDetailV1;
              completedAt?: number;
            },
            caller: ctx.actionCaller ?? { kind: 'host' as const },
          });
          return completeActionResult(res);
        }
  return null;
}
