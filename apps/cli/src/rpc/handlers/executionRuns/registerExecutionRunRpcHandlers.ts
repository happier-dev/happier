import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type {
  ExecutionRunPublicState,
} from '@happier-dev/protocol';

import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import { buildExecutionRunProfileCatalog } from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { EXECUTION_RUN_RPC_SCOPES } from '../actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import { createExecutionRunRpcActionExecutor, type ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';

export type ExecutionRunRpcHandlerContext = Readonly<{
  sessionId: string;
  cwd: string;
  serverUrl?: string;
  parentProvider: ACPProvider;
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  streamedTranscriptSession?: Readonly<{
    sendAgentMessageEphemeral?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; createdAt: number; updatedAt: number },
    ) => void | Promise<void>;
    enqueueAgentMessageCommitted?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    sendAgentMessageCommitted: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
  }>;
  transcriptWriter?: Readonly<{
    appendUserText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendAssistantText: (text: string, meta: Record<string, unknown>) => void | Promise<void>;
    appendUserTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
    appendAssistantTextCommitted?: (text: string, meta: Record<string, unknown>) => Promise<void>;
  }>;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  policy?: Readonly<{
    maxConcurrentRuns?: number | null;
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
    maxTurns?: number | null;
    maxDepth?: number;
  }>;
  budgetRegistry?: ExecutionBudgetRegistry;
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider | null;
  parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
  onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onExecutionRunVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  actionExecutor?: RpcActionExecutor;
  actionApprovalDeps?: Partial<ExecutionRunRpcApprovalDeps>;
}>;

function invalidParams(): Readonly<{ ok: false; error: string; errorCode: string }> {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

function createExecutionRunRpcRegistrarExecutor(params: Readonly<{
  executor: RpcActionExecutor;
  defaultSessionId: string;
}>): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      const result = await params.executor.execute(actionId, input, {
        ...context,
        defaultSessionId: context?.defaultSessionId ?? params.defaultSessionId,
      });

      if (!result.ok && result.errorCode === 'invalid_parameters') {
        return { ok: true, result: invalidParams() };
      }

      return result;
    },
  };
}

export function registerExecutionRunRpcHandlers(
  rpc: RpcHandlerRegistrar,
  ctx: ExecutionRunRpcHandlerContext,
): void {
  const policy = resolveExecutionRunPolicy({
    defaults: {
      // Centralized configuration is the only source of truth for execution-run defaults.
      // Keep the fallback here wired to configuration so uncapped/no-timeout defaults cannot
      // silently drift from the policy that sessionClient passes in normal production wiring.
      maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
      boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
      reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
      maxTurns: configuration.executionRunsMaxTurns,
      maxDepth: configuration.executionRunsMaxDepth,
    },
    override: ctx.policy,
  });

  const manager = new ExecutionRunHostBridge({
    parentProvider: ctx.parentProvider,
    cwd: ctx.cwd,
    sendAcp: ctx.sendAcp,
    streamedTranscriptSession: ctx.streamedTranscriptSession,
    transcriptWriter: ctx.transcriptWriter,
    onPublicStateUpdated: ctx.onExecutionRunPublicStateUpdated,
    onVoiceAgentWelcomed: ctx.onExecutionRunVoiceAgentWelcomed,
    boundedTimeoutMs: policy.boundedTimeoutMs ?? undefined,
    maxTurns: policy.maxTurns ?? undefined,
    budgetRegistry: ctx.budgetRegistry,
    getPermissionRequestStore: ctx.getPermissionRequestStore,
    parentSessionStateTarget: ctx.parentSessionStateTarget ?? null,
    resolveAccountSettings: ctx.resolveAccountSettings,
    resolveExecutionRunProfileCatalog: async () => {
      const registry = await resolveCliEngineRegistry();
      return buildExecutionRunProfileCatalog(
        (registry.contributions.executionRunProfiles ?? []).map((profile) => profile.definition),
      );
    },
  });

  function isExecutionRunsEnabled(): boolean {
    return resolveCliFeatureDecision({ featureId: 'execution.runs', env: process.env }).state === 'enabled';
  }

  const actionExecutor = ctx.actionExecutor ?? createExecutionRunRpcActionExecutor({
    manager,
    context: ctx,
    policy,
    isExecutionRunsEnabled,
    approvalDeps: ctx.actionApprovalDeps,
  });

  registerActionSpecRpcHandlers({
    rpcHandlerManager: rpc,
    actionExecutor: createExecutionRunRpcRegistrarExecutor({
      executor: actionExecutor,
      defaultSessionId: ctx.sessionId,
    }),
    scopes: EXECUTION_RUN_RPC_SCOPES,
  });
}
