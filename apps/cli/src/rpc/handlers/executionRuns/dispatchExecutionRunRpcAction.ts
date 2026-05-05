import {
  createActionExecutor,
  ExecutionRunActionRequestSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunSendRequestSchema,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';

import type { ExecutionRunHostBridgeContract } from '@/agent/runtime/bridges/executionRun/executionRunBridgeContract';
import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';
import { applyExecutionRunListRequest } from '@/session/services/applyExecutionRunListRequest';

import type { RpcActionExecutor } from '../_actionDispatchAdapter';

type ExecutionRunRpcFailure = Readonly<{ ok: false; error: string; errorCode: string }>;
type ExecutionRunStartResult =
  | Readonly<{ ok: true; runId: string; callId: string; sidechainId: string }>
  | ExecutionRunRpcFailure;

type ExecutionRunRpcActionDepsParams = Readonly<{
  manager: ExecutionRunHostBridgeContract;
  startRun: (raw: unknown) => Promise<ExecutionRunStartResult>;
  isExecutionRunsEnabled: () => boolean;
}>;

function executionRunsDisabled(): ExecutionRunRpcFailure {
  return { ok: false, error: 'Execution runs feature disabled', errorCode: 'execution_run_not_allowed' };
}

async function unsupportedActionDependency(): Promise<never> {
  throw new Error('action_not_supported_in_execution_run_rpc');
}

function createExecutionRunRpcActionDeps(params: ExecutionRunRpcActionDepsParams): ActionExecutorDeps {
  const ensureEnabled = (): ExecutionRunRpcFailure | null => params.isExecutionRunsEnabled()
    ? null
    : executionRunsDisabled();

  return {
    executionRunStart: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const started = await params.startRun(request);
      return started.ok
        ? { runId: started.runId, callId: started.callId, sidechainId: started.sidechainId }
        : started;
    },
    executionRunList: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const listRequest = ExecutionRunListRequestSchema.parse(request);
      return { runs: applyExecutionRunListRequest(params.manager.listPublic(), listRequest) };
    },
    executionRunGet: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      const run = params.manager.getPublic(parsed.runId);
      if (!run) {
        return { ok: false, error: 'Not found', errorCode: 'execution_run_not_found' };
      }
      const structuredMeta = parsed.includeStructured ? params.manager.getStructuredMeta(parsed.runId) : null;
      const latestToolResult = params.manager.getLatestToolResult(parsed.runId);
      return {
        run,
        ...(latestToolResult ? { latestToolResult } : {}),
        ...(structuredMeta ? { structuredMeta } : {}),
      };
    },
    executionRunSend: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunSendRequestSchema.parse(request);
      const sent = await params.manager.send(parsed.runId, {
        message: parsed.message,
        resume: parsed.resume,
        delivery: parsed.delivery,
      });
      if (!sent.ok) {
        return {
          ok: false,
          error: sent.error ?? 'Send failed',
          errorCode: sent.errorCode ?? 'execution_run_failed',
        };
      }
      return { ok: true };
    },
    executionRunStop: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunGetRequestSchema.parse(request);
      const stopped = await params.manager.stop(parsed.runId);
      if (!stopped.ok) {
        return {
          ok: false,
          error: stopped.error ?? 'Stop failed',
          errorCode: stopped.errorCode ?? 'execution_run_failed',
        };
      }
      return { ok: true };
    },
    executionRunAction: async (_sessionId, request) => {
      const disabled = ensureEnabled();
      if (disabled) return disabled;
      const parsed = ExecutionRunActionRequestSchema.parse(request);
      const acted = await params.manager.applyAction(parsed.runId, {
        actionId: parsed.actionId,
        input: parsed.input,
      });
      if (!acted.ok) {
        return {
          ok: false,
          error: acted.error ?? 'Unsupported',
          errorCode: acted.errorCode ?? 'execution_run_action_not_supported',
        };
      }
      return {
        ok: true,
        ...(typeof acted.updatedToolResult !== 'undefined' ? { updatedToolResult: acted.updatedToolResult } : {}),
        ...(typeof acted.result !== 'undefined' ? { result: acted.result } : {}),
      };
    },
    executionRunWait: unsupportedActionDependency,

    sessionOpen: unsupportedActionDependency,
    sessionFork: unsupportedActionDependency,
    sessionRollback: unsupportedActionDependency,
    sessionSpawnNew: unsupportedActionDependency,
    sessionSpawnPicker: unsupportedActionDependency,

    pathsListRecent: unsupportedActionDependency,
    machinesList: unsupportedActionDependency,
    serversList: unsupportedActionDependency,
    reviewEnginesList: unsupportedActionDependency,
    agentsBackendsList: unsupportedActionDependency,
    agentsModelsList: unsupportedActionDependency,

    sessionSendMessage: unsupportedActionDependency,
    sessionModeSet: unsupportedActionDependency,
    sessionModesList: unsupportedActionDependency,

    sessionTargetPrimarySet: unsupportedActionDependency,
    sessionTargetTrackedSet: unsupportedActionDependency,
    sessionList: unsupportedActionDependency,
    sessionActivityGet: unsupportedActionDependency,
    sessionRecentMessagesGet: unsupportedActionDependency,

    resetGlobalVoiceAgent: unsupportedActionDependency,

    daemonMemorySearch: unsupportedActionDependency,
    daemonMemoryGetWindow: unsupportedActionDependency,
    daemonMemoryEnsureUpToDate: unsupportedActionDependency,

    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? null,
      placement: ctx.placement ?? null,
    }),
    isActionApprovalRequired: (id, ctx) => isActionApprovalRequiredByEnv(id, {
      surface: ctx.surface ?? null,
    }),
    // Approval artifact storage belongs to A.12-approvals; until that packet wires
    // RPC approval storage, approval-required execution-run RPC actions fail closed.
  };
}

export function createExecutionRunRpcActionExecutor(
  params: ExecutionRunRpcActionDepsParams,
): RpcActionExecutor {
  return createActionExecutor(createExecutionRunRpcActionDeps(params));
}
