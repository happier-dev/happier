import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { SessionSpawnNewInputV2Schema, projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createProductionFreshWorkflowSessionConversation, type WorkflowSessionStartup } from './sessionStepExecutor';
import type { WorkflowActionExecutor } from './coordinator';
import { runObservedWorkflowSessionStartup } from './workflowSessionStartup';

/** Real installed Action/operation owners; callers replace only Home and Machine boundaries. */
export function createAdmittedWorkflowSessionHost(
  deps: Parameters<typeof createProductionFreshWorkflowSessionConversation>[0],
) {
  const scope = { accountId: readAccountIdFromToken(deps.credentials.token) ?? 'account-1', machineId: deps.machineId };
  const operations = createHostActionOperationRuntime({ machineId: deps.machineId,
    resolveAccountId: async () => scope.accountId });
  const { executor } = createCliActionExecutorHarness({ credentials: deps.credentials, token: deps.credentials.token,
    sessionId: deps.originSessionId ?? 'workflow-test', serverId: deps.serverId, serverIdentityId: deps.serverId,
    serverHttpBaseUrl: resolveServerHttpBaseUrl(), mode: 'plain', ctx: null });
  return {
    action: deps.action ?? { executor, buildContext: async (execution: Parameters<WorkflowActionExecutor['buildContext']>[0]) => ({ ...buildWorkflowActionContext(execution),
      approvalProfileId: execution.approvalProfileId !== undefined ? execution.approvalProfileId
        : execution.origin?.actionPolicy?.approvalProfileId !== undefined
          ? execution.origin.actionPolicy.approvalProfileId : 'builtin:full-trust',
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      agentStartContext: { caller: { kind: 'originless', runId: execution.runId, runDepth: execution.workDepth ?? deps.workDepth },
        baseline: { machineId: deps.machineId, directory: execution.workspace?.directory ?? '/' },
        roles: execution.role ? { [execution.role.roleId]: execution.role } : {}, ledSubtreeSessionIds: [],
        callerPermissionCeiling: execution.authorization.admittedPermissionCeiling,
        workDepthLimit: (execution.workDepth ?? deps.workDepth) + 1 },
    }), observeRun: async () => { throw new Error('Session birth must not start an Execution Run'); } },
    sessionStartup: deps.sessionStartup ?? ((input: Parameters<WorkflowSessionStartup>[0]) => runObservedWorkflowSessionStartup(input, {
      serverId: deps.serverId, machineId: deps.machineId, observeExecution: operations.observeExecution, rpcContext: {},
      transport: () => ({ spawn: (request, options) => callExactMachineRpc({ credentials: deps.credentials,
        machineId: deps.machineId, method: RPC_METHODS.SPAWN_HAPPY_SESSION, request, ...options }),
        resolveSpawnSessionByNonce: (spawnNonce, options) => callExactMachineRpc({ credentials: deps.credentials,
          machineId: deps.machineId, method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
          request: { spawnNonce, ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
          ...(options?.signal ? { signal: options.signal } : {}) }) }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
        ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    })),
  } satisfies Pick<Parameters<typeof createProductionFreshWorkflowSessionConversation>[0], 'action' | 'sessionStartup'>;
}

export function createAdmittedFreshWorkflowSessionConversation(
  deps: Parameters<typeof createProductionFreshWorkflowSessionConversation>[0],
): ReturnType<typeof createProductionFreshWorkflowSessionConversation> {
  const create = createProductionFreshWorkflowSessionConversation({ ...deps, ...createAdmittedWorkflowSessionHost(deps) });
  return input => create({ ...input,
    startupAuthorization: input.startupAuthorization ?? { principal: { kind: 'host' }, admittedPermissionCeiling: 'yolo' },
    origin: { kind: 'direct', ...input.origin,
      actionPolicy: input.origin?.actionPolicy ?? { surface: 'agent', authority: 'account_automation',
        approvalProfileId: 'builtin:full-trust' } },
  });
}

/** Models the private context installed by the Workflow producer for direct startup fixtures. */
export function runAdmittedObservedWorkflowSessionStartup(
  input: Parameters<typeof runObservedWorkflowSessionStartup>[0],
  host: Parameters<typeof runObservedWorkflowSessionStartup>[1],
): ReturnType<typeof runObservedWorkflowSessionStartup> {
  const agentTarget = input.request.agentTarget ?? { kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
  return runObservedWorkflowSessionStartup({ ...input,
    actionAdmission: input.actionAdmission ?? (input.retainedOperation ? undefined : {
      input: projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
        creationKey: input.creationKey, agentTarget,
        executionTarget: { serverId: host.serverId, machineId: host.machineId },
        directory: { kind: 'path', path: input.request.directory },
      })),
      context: { surface: 'agent', authority: 'account_automation', approvalProfileId: 'builtin:full-trust',
        callerPermissionMode: 'yolo',
        sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
        agentStartContext: { caller: { kind: 'originless', runId: 'workflow-test', runDepth: 0 },
          baseline: { machineId: host.machineId, directory: input.request.directory }, roles: {},
          ledSubtreeSessionIds: [], callerPermissionCeiling: 'yolo', workDepthLimit: 1 },
        actionCaller: { kind: 'workflowRun', runId: 'workflow-test', authorization: {
          principal: { kind: 'host' }, admittedPermissionCeiling: 'yolo' } },
      },
    }),
  }, host);
}
