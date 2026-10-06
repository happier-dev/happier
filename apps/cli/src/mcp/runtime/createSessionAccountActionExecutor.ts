import { randomUUID } from 'node:crypto';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WaitActionInputV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';

type ActionExecutor = Readonly<{
  execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
}>;

const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
const uncertain = (): ActionExecuteResult => ({ ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });

/** Account credentials stay in the daemon; identity comes from its existing Session capability. */
export function createSessionAccountActionExecutor(params: Readonly<{
  base: ActionExecutor;
  client: HappyMcpSessionClient;
}>): ActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      // Contributed ids remain with the existing plugin catalog/execution owner.
      const builtIn = ActionIdSchema.safeParse(actionId);
      const executionPlacement = builtIn.success ? resolveActionExecutionPlacementForInput(getActionSpec(builtIn.data), input) : null;
      if (!builtIn.success || (executionPlacement !== 'account'
        && executionPlacement !== 'client'
        && !(Object.hasOwn(RoleActionInputSchemasV1, builtIn.data) && builtIn.data.startsWith('session.')))) {
        return await params.base.execute(actionId, input, context);
      }
      // This daemon Action channel returns one result, not a passive snapshot
      // feed. Never drop the sink and turn watch into a blocking condition wait.
      if (actionId === 'wait' && context?.onWaitSnapshot) {
        const request = WaitActionInputV1Schema.safeParse(input);
        if (!request.success) return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
        return { ok: true, result: { target: request.data.target, condition: request.data.condition,
          disposition: 'unsupported_condition' } };
      }
      const lifetime = params.client.getRuntimeLifetimeSignal?.();
      const signal = context?.signal && lifetime
        ? AbortSignal.any([context.signal, lifetime]) : context?.signal ?? lifetime ?? undefined;
      if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      if (!path) return unavailable();
      const hostWitness = params.client.getActiveTurnAdmissionWitness?.();
      if (!hostWitness) return unavailable();
      let witness;
      try { witness = projectAgentRuntimeDaemonServiceTurnWitnessV1(hostWitness); }
      catch { return unavailable(); }
      const authority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: params.client.sessionId,
      });
      if (!authority) return unavailable();
      const requestId = context?.actionRequestId ?? randomUUID();
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
              surface: context?.surface === 'mcp' ? 'mcp' : 'agent',
              ...(toolCallId ? { toolCallId } : {}) },
          }),
        });
        if (response.ok) return response.result.kind === 'action.execution' && response.result.requestId === requestId
          ? response.result.outcome : uncertain();
        return response.error.code === NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE ? uncertain() : unavailable();
      } catch (error) {
        if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        if (isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(error)) return uncertain();
        throw error;
      }
    },
  };
}
