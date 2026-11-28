import { actionTargetUnavailable as sessionActionTargetUnavailable } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createHash, randomUUID } from 'node:crypto';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { ACTION_ID_FAMILIES_V1, ActionIdSchema, isPluginDevLoopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { isSessionActionRpcMethodV1 } from '@happier-dev/protocol/socketRpc';
import { WaitActionInputV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { WorkflowProjectTargetV1Schema } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { requiresExplicitScmMachineTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { readContributedActionExecutionPlacement } from '@/session/actions/readContributedActionExecutionPlacement';
import { readActionSessionTargetField } from '@happier-dev/protocol/actions/executor/sessionTargets';
import { normalizeSessionTargetV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { CurrentProcessPluginActionExecutionAttempt, OccurrenceBoundActionExecutorContext } from '@/session/actions/createDaemonPluginActionExecutor';
import { isSessionToolsBootstrapAction } from '@/agent/tools/happierTools/actionToolCatalog';

type ActionExecutor = Readonly<{
  execute(actionId: ActionId, input: unknown, context?: OccurrenceBoundActionExecutorContext): Promise<ActionExecuteResult>;
}>;

export { sessionActionTargetUnavailable };

const uncertain = (): ActionExecuteResult => ({ ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });

// These readers use the bound host's live Session RPC/catalog, including in a
// daemonless host. Reading another Session still needs credentialed transport.
const BOUND_SESSION_RPC_READS: ReadonlySet<ActionId> = new Set([
  'session.work_state.get', 'session.goal.get',
  'session.vendor_plugin_catalog.list', 'session.skill_catalog.list',
]);

// The Session MCP composition supplies these ports from its bound runtime.
// Memory retains the Session corpus, Runs retain the live host, and contributed
// Actions without a daemon-bound placement retain their local catalog owner.
const BOUND_HOST_MACHINE_ACTIONS: ReadonlySet<ActionId> = new Set([
  ...ACTION_ID_FAMILIES_V1.memory,
  ...ACTION_ID_FAMILIES_V1.execution_run_control,
  'action.invoke',
]);

/** Account credentials stay in the daemon; identity comes from its existing Session capability. */
export function createSessionAccountActionExecutor(params: Readonly<{
  base: ActionExecutor;
  client: HappyMcpSessionClient;
  /** Local Account ports do not replace the Session's daemon admission. */
  hasAccountAuthority?: boolean;
  executeInCurrentProcess?(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<CurrentProcessPluginActionExecutionAttempt>;
}>): ActionExecutor {
  const execute = async (actionId: ActionId, input: unknown, context?: OccurrenceBoundActionExecutorContext,
    routingDescriptorRead = false): Promise<ActionExecuteResult> => {
      const voiceRun = params.client.getRunActionInvocation?.()?.surface === 'voice';
      const local = voiceRun ? undefined : await params.executeInCurrentProcess?.(actionId, input, context);
      if (local?.matched) return local.result;
      const path = sessionProcessEnvironment()[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      const useDaemonDescriptor = Boolean(path && (actionId === 'action.spec.search'
        || actionId === 'action.spec.get' && input
          && typeof input === 'object' && 'id' in input && parseQualifiedPluginActionId(input.id)));
      // Search and qualified descriptors share the daemon's requester Account
      // catalog. Daemonless hosts retain their own catalog; Voice uses its App route.
      if (!voiceRun && !routingDescriptorRead && !useDaemonDescriptor
        && (actionId === 'action.spec.search' || actionId === 'action.spec.get')) {
        return await params.base.execute(actionId, input, context);
      }
      // Restricted child reads use the bound Session's admitted corpus reader.
      // Account forwarding would replace that authority with the daemon's scope.
      if (!voiceRun && (actionId === 'session.list' || actionId === 'session.targets.resolve') && context?.sessionListAccess === 'current_session') {
        return await params.base.execute(actionId, input, context);
      }
      // Contributed ids remain with the existing plugin catalog/execution owner.
      const builtIn = ActionIdSchema.safeParse(actionId);
      const spec = builtIn.success ? getActionSpec(builtIn.data) : null;
      if (!voiceRun && requiresExplicitScmMachineTarget(actionId)) return await params.base.execute(actionId, input, context);
      const executionPlacement = spec ? resolveActionExecutionPlacementForInput(spec, input, context?.actionCaller, context?.surface ?? 'agent') : null;
      let daemonContributedAction = false;
      const qualifiedAction = path && !builtIn.success ? parseQualifiedPluginActionId(actionId) : null;
      const needsContributedPlacement = actionId === 'action.invoke'
        ? !params.hasAccountAuthority || Boolean(path) : qualifiedAction !== null;
      if (!voiceRun && needsContributedPlacement) {
        const invocation = qualifiedAction ? { action: qualifiedAction, input,
          ...(context?.expectedContributorOccurrenceId
            ? { expectedContributorOccurrenceId: context.expectedContributorOccurrenceId } : {}),
        } : input;
        // The existing Session capability exposes the daemon's exact descriptor.
        // The receiving Action owner applies Home admission when executing it.
        const actual = await readContributedActionExecutionPlacement(invocation,
          request => execute('action.spec.get', request, context, true));
        if (!actual) return await params.base.execute(actionId, input, context);
        if (!actual.ok) return actual.failure;
        // Client handlers continue through their bound UI delivery path.
        daemonContributedAction = actual.placement === 'account' || actual.placement === 'machine';
        if (daemonContributedAction) {
          actionId = 'action.invoke';
          input = invocation;
        }
      }
      const requestedSessionId = input && typeof input === 'object' && 'sessionId' in input
        && typeof input.sessionId === 'string' ? input.sessionId.trim() : params.client.sessionId;
      let needsSessionTargetTransport = false;
      if ((!params.hasAccountAuthority || path) && spec?.sessionTarget && input && typeof input === 'object' && !Array.isArray(input)) {
        const operand = readActionSessionTargetField(input as Readonly<Record<string, unknown>>, spec.sessionTarget.field);
        if (operand !== undefined) {
          try {
            // A daemon-bound runner's input bridge is scoped to its own Session,
            // even when that runner also holds Account credentials.
            // Selector expansion and other Sessions retain credentialed admission.
            needsSessionTargetTransport = normalizeSessionTargetV1(operand) !== params.client.sessionId;
          } catch { /* The canonical Action validator reports malformed operands. */ }
        }
      }
      // The bound host holds its own Board stored-content key. Other
      // Session readers use the credentialed owner, including reads of children.
      // Tool discovery and dispatch use this host's admitted MCP profile.
      const boundRead = requestedSessionId === params.client.sessionId
        && (BOUND_SESSION_RPC_READS.has(actionId)
          || ACTION_ID_FAMILIES_V1.session_board.some(id => id === actionId)
          || ACTION_ID_FAMILIES_V1.subagent_registry.some(id => id === actionId)
          || ACTION_ID_FAMILIES_V1.session_permissions.some(id => id === actionId)
          || isSessionToolsBootstrapAction(actionId));
      const sessionRead = executionPlacement === 'session' && !boundRead && spec?.sideEffectClass === 'read';
      // These lifecycle owners resolve credentialed Session/Machine transport.
      // Forward through the same capability channel as reads; the credentialed
      // executor still owns current-Session scope and approval policy. Explicit
      // headless resume is Session-placed; navigation keeps client placement.
      const sessionLifecycle = executionPlacement === 'session'
        && (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive'
          || actionId === 'session.fork' || actionId === 'session.open');
      // Persisted readers are Machine-placed so an offline Session does not need
      // its original runner. Keep their established credentialed implementation.
      const persistedRead = executionPlacement === 'machine'
        && (ACTION_ID_FAMILIES_V1.session_transcripts.some(id => id === actionId)
          || actionId === 'session.history.get' || actionId === 'session.messages.recent.get');
      // Direct and dependent native inventories need the daemon's Machine
      // transport and launch environment, not the restricted runner's process.
      const nativeInventoryRead = !params.hasAccountAuthority
        && (actionId === 'action.options.resolve' || actionId === 'agents.backends.list'
          || actionId === 'agents.models.list' || actionId === 'agents.config_options.list'
          || actionId === 'agents.session_modes.list');
      // Machine placement requires the daemon's credentialed exact-target owner.
      // Account credentials in the Session host do not supply an admitted
      // Machine role. Use its existing daemon issuer for canonical placement.
      const machineAction = executionPlacement === 'machine'
        && !BOUND_HOST_MACHINE_ACTIONS.has(actionId);
      // Origin-required RPCs use the existing source-daemon custody channel,
      // including cross-Session question answers. Own questions stay with the
      // bound request store and its same canonical host-witness origin.
      const sessionOriginRpc = spec && isSessionActionRpcMethodV1(spec.bindings?.rpcMethod ?? actionId)
        && !(actionId === 'session.needs_you.raise' && requestedSessionId === params.client.sessionId);
      if (!voiceRun && !daemonContributedAction && !useDaemonDescriptor && (!builtIn.success || (executionPlacement !== 'account'
        && executionPlacement !== 'client'
        && !sessionRead && !persistedRead && !sessionLifecycle && !nativeInventoryRead && !machineAction && !sessionOriginRpc && !needsSessionTargetTransport
        && builtIn.data !== 'session.spawn_new'
        // Admission inspects the executing Machine's workspace and plugin
        // runtime before sealing Account storage; a Session runner has neither.
        && builtIn.data !== 'workflow.run.start'
        // SCM uses the target daemon's admitted backends. Restricted runners
        // reach the credentialed shared adapter through this existing capability.
        && !(builtIn.data.startsWith('scm.') && !params.hasAccountAuthority)
        // Machine plugin policy and lifecycle belong to the daemon's canonical
        // plugin-change owner, never to the restricted Session runner.
        && !(isPluginDevLoopActionIdV1(builtIn.data) && executionPlacement === 'machine')))) {
        return await params.base.execute(actionId, input, context);
      }
      // This daemon Action channel returns one result, not a passive snapshot
      // feed. Never drop the sink and turn watch into a blocking condition wait.
      if (!voiceRun && actionId === 'wait' && context?.onWaitSnapshot) {
        const request = WaitActionInputV1Schema.safeParse(input);
        if (!request.success) return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
        const target = request.data.target;
        // The live host already owns its Session/Run observation transport.
        // Keep that passive sink in-process; the one-result daemon Action
        // channel cannot carry it. Other targets retain their refusal below.
        if ((target.kind === 'session' || target.kind === 'execution_run')
          && target.sessionId === params.client.sessionId
          && await isServerProfileHomeIdentity(params.client.getServerBinding().serverId, target.serverId)) {
          return await params.base.execute(actionId, input, context);
        }
        return { ok: true, result: { target: request.data.target, condition: request.data.condition,
          disposition: 'unsupported_condition' } };
      }
      const hostWitness = params.client.getActiveTurnAdmissionWitness?.();
      const signals = [context?.signal, params.client.getRuntimeLifetimeSignal?.(), hostWitness?.signal]
        .filter((signal): signal is AbortSignal => signal != null);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      if (!path) return sessionActionTargetUnavailable('authority_path_absent');
      if (!hostWitness) return sessionActionTargetUnavailable('turn_witness_absent');
      const binding = params.client.getSessionActionConfirmationBinding?.();
      const executionRun = binding?.run;
      if (binding && executionRun) {
        if (binding.turnId !== hostWitness.turnId) return sessionActionTargetUnavailable('execution_run_turn_mismatch');
        if (!binding.isCurrent()) return sessionActionTargetUnavailable('execution_run_not_current');
      }
      const location = actionId.startsWith('scm.') ? params.client.getCurrentSessionLocation?.() : null;
      const scmWorkspace = actionId.startsWith('scm.')
        ? WorkflowProjectTargetV1Schema.safeParse({ machineId: location?.machineId, directory: location?.path }) : null;
      if (scmWorkspace && !scmWorkspace.success) return sessionActionTargetUnavailable('scm_workspace_invalid');
      let witness;
      try { witness = projectAgentRuntimeDaemonServiceTurnWitnessV1(hostWitness); }
      catch { return sessionActionTargetUnavailable('turn_witness_projection_invalid'); }
      const authority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: params.client.sessionId,
      });
      if (!authority) return sessionActionTargetUnavailable('runner_authority_refused');
      // A spawn retry belongs to the admitted parent and public creation key,
      // independently of the MCP connection, tool call, turn or runner lifetime.
      // Hash the tuple because creation keys have no private-envelope id bound.
      const creationKey = actionId === 'session.spawn_new'
        ? SessionCreationKeyV1Schema.safeParse(input && typeof input === 'object' && 'creationKey' in input
          ? input.creationKey : undefined)
        : null;
      const requestId = creationKey?.success
        ? createHash('sha256').update(JSON.stringify(['session.spawn_new', params.client.sessionId, creationKey.data])).digest('hex')
        : context?.actionRequestId ?? randomUUID();
      const toolCallId = context?.approvalOrigin?.kind === 'transcript_tool_call'
        ? context.approvalOrigin.toolCallId : undefined;
      try {
        const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({
          authority: { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
            path, sessionId: params.client.sessionId, runner: authority.runner, retainedAgent: authority.retainedAgent },
          // The Action owns its lifetime; waiting for its user approval has no subordinate deadline.
          timeoutMs: null,
          ...(signal ? { signal } : {}),
          createRequest: (capability) => ({ v: 1,
            context: { token: capability, sessionId: params.client.sessionId },
            operation: { kind: 'action.execute', requestId, actionId, input, witness,
              ...(scmWorkspace?.success ? { scmWorkspace: scmWorkspace.data } : {}),
              ...(context?.reviewCommentPrincipal ? { reviewCommentPrincipal: context.reviewCommentPrincipal } : {}),
              ...(executionRun ? { executionRun: { runId: executionRun.runId, occurrenceId: executionRun.occurrenceId } } : {}),
              surface: context?.surface === 'mcp' ? 'mcp' : 'agent',
              ...(toolCallId ? { toolCallId } : {}) },
          }),
        });
        if (response.ok) return response.result.kind === 'action.execution' && response.result.requestId === requestId
          ? response.result.outcome : uncertain();
        return response.error.code === NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE ? uncertain() : {
          ok: false, errorCode: response.error.code, error: response.error.message,
          ...(response.error.cause ? { details: response.error.cause } : {}),
        };
      } catch (error) {
        if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        if (isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(error)) return uncertain();
        throw error;
      }
    };
  return { execute: (actionId, input, context) => execute(actionId, input, context) };
}
