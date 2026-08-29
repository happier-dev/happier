import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  ExecutionRunTurnStreamStartV2RequestSchema,
  ExecutionRunUserTranscriptCommitRequestSchema,
  type ExecutionRunPublicState,
  type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import type { ExecutionRunTranscriptPublisher } from '@/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';
import {
  buildExecutionRunProfileCatalog,
  type ExecutionRunProfileContributionCatalogInput,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type {
  BrowserRecordingComposerAttachInput,
  BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import { configuration } from '@/configuration';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type { EphemeralSendResult } from '@/api/session/client/transcript/ephemeralSendOutcome';
import { EXECUTION_RUN_RPC_SCOPES } from '../actionSpecRpcRegistration';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import { createExecutionRunRpcActionExecutor, type ExecutionRunRpcApprovalDeps } from './dispatchExecutionRunRpcAction';
import {
  createReviewCommentHostActionMaterializer,
  resolveReviewCommentHostPluginAuthority,
} from '@/agent/executionRuns/profiles/review/hostActionMaterializer';
import { resolveWorkspaceRefForMachineRoot } from '@/settings/accountSettings/workspaceRefsV1';
import { checkExecutionRunConnectedServicesGenerationCurrent } from '@/daemon/controlClient';
import { resolvePluginPromptAssetBlocks } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { resolveInvocationContributionPolicyFacts } from '@/plugins/runtime/policy/evaluate';
import type { NativeAgentSessionInteractionHostBinding } from '@/agent/runtime/registry/engineRegistryTypes';

export type ExecutionRunRpcHandlerContext = Readonly<{
  /** Fixed handler scope: a concrete Session or the daemon-owned detached scope. */
  sessionId: string | null;
  cwd: string;
  machineId?: string;
  serverUrl?: string;
  parentProvider: ACPProvider;
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
  browserDiagnostics?: BrowserDiagnosticsActionRoutes | null;
  browserRecording?: BrowserRecordingRoutes | null;
  attachBrowserRecordingToComposer?: (
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>;
  localServices?: LocalServicesRuntimeActionRoutes | null;
  simulatorPreview?: SimulatorPreviewRoutes | null;
  peerMediationObservability?: DaemonPeerMediationObservabilityRuntimeActionContext | null;
  sendAcp: ExecutionRunTranscriptPublisher;
  streamedTranscriptSession?: Readonly<{
    sendAgentMessageEphemeral?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; createdAt: number; updatedAt?: number; tick?: number },
    ) => EphemeralSendResult;
    sendAgentMessageEphemeralDelta?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; tick: number; baseLength: number; meta?: Record<string, unknown>; createdAt: number; updatedAt?: number },
    ) => EphemeralSendResult;
    getEphemeralStreamConnectionEpoch?: () => number;
    enqueueAgentMessageCommitted?: (
      provider: ACPProvider,
      body: ACPMessageData,
      opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  }>;
  transcriptWriter?: Readonly<{
    appendUserTextCommitted?: (
      text: string,
      options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    appendAssistantTextCommitted?: (
      text: string,
      options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
    ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
    commitVoiceAgentTranscriptTurn: (turn: Readonly<{
      turnId: string;
      user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
      assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
    }>) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
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
  sessionInteractionHost?: NativeAgentSessionInteractionHostBinding;
  onExecutionRunPublicStateUpdated?: (run: ExecutionRunPublicState) => void;
  onExecutionRunVoiceAgentWelcomed?: (run: ExecutionRunPublicState, welcomedEpoch: number) => void | Promise<void>;
  resolveAccountSettings?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  executionRunProfileCatalog?: ExecutionRunProfileContributionCatalog;
  resolveExecutionRunProfileCatalog?: ConstructorParameters<typeof ExecutionRunHostBridge>[0]['resolveExecutionRunProfileCatalog'];
  actionExecutor?: RpcActionExecutor;
  actionApprovalDeps?: Partial<ExecutionRunRpcApprovalDeps>;
}>;

function invalidParams(): Readonly<{ ok: false; error: string; errorCode: string }> {
  return { ok: false, error: 'Invalid params', errorCode: 'execution_run_invalid_action_input' };
}

function createExecutionRunRpcRegistrarExecutor(params: Readonly<{
  executor: RpcActionExecutor;
  defaultSessionId: string | null;
}>): RpcActionExecutor {
  return {
    execute: async (actionId, input, context) => {
      const defaultSessionId = context?.defaultSessionId ?? params.defaultSessionId;
      const result = await params.executor.execute(actionId, input, {
        ...context,
        ...(defaultSessionId ? { defaultSessionId } : {}),
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

  const profileCatalogOptions: Pick<
    ConstructorParameters<typeof ExecutionRunHostBridge>[0],
    'executionRunProfileCatalog' | 'resolveExecutionRunProfileCatalog'
  > = ctx.resolveExecutionRunProfileCatalog
    ? { resolveExecutionRunProfileCatalog: ctx.resolveExecutionRunProfileCatalog }
    : ctx.executionRunProfileCatalog
      ? { executionRunProfileCatalog: ctx.executionRunProfileCatalog }
      : {
          resolveExecutionRunProfileCatalog: async () => {
            const runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
            try {
              const engineRegistry = await resolveCliEngineRegistry({
                runtimeRegistry: runtimeRegistryLease.registry,
              });
              const profileCatalog = buildExecutionRunProfileCatalog(
                (engineRegistry.contributions.executionRunProfiles ?? []).flatMap<ExecutionRunProfileContributionCatalogInput>((profile) => {
                  if (!profile.pluginId) return [profile.definition];
                  const current = runtimeRegistryLease.registry
                    .pluginFinalPolicyCurrentGenerationsById
                    ?.get(profile.pluginId) ?? null;
                  return current?.applied === true
                    ? [{
                      pluginId: profile.pluginId,
                      immutableGenerationId: current.immutableGenerationId,
                      definition: profile.definition,
                    }]
                    : [];
                }),
                {
                  resolveAgentIdentity: (agentId) => {
                    const agent = engineRegistry.contributions.agents.find((candidate) => (
                      candidate.id === agentId && candidate.pluginId
                    ));
                    // The durable identity is the Agent's own `identity`; the
                    // routing id is qualified for installed Agents and must not
                    // be re-read as a local id.
                    return agent?.pluginId
                      ? {
                        pluginId: agent.identity?.pluginId ?? agent.pluginId,
                        localId: agent.identity?.localId ?? agent.definition.id,
                      }
                      : null;
                  },
                  resolvePolicyFacts: ({ agentId }) => resolveInvocationContributionPolicyFacts({
                    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
                    facts: {
                      'session.agentId': agentId,
                      ...(ctx.machineId ? { 'machine.id': ctx.machineId } : {}),
                    },
                  }),
                  resolvePromptAssetBlocks: async ({ promptAsset, agentId }) => {
                    return await resolvePluginPromptAssetBlocks({
                      agentId,
                      selectedAsset: promptAsset,
                      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
                      ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
                    });
                  },
                },
              );
              return {
                profileCatalog,
                engineRegistry,
                release: runtimeRegistryLease.release,
              };
            } catch (error) {
              await runtimeRegistryLease.release();
              throw error;
            }
          },
        };

  let canonicalActionExecutor: RpcActionExecutor | null = null;
  const requestCurrentIntent = ctx.actionApprovalDeps?.executionRunHostActionCurrentIntent;
  const materializeReviewHostAction = requestCurrentIntent
    ? async (readCurrentCandidate: Parameters<typeof createReviewCommentHostActionMaterializer>[0]['readCurrentCandidate']) => {
      const materialize = createReviewCommentHostActionMaterializer({
        cwd: ctx.cwd,
        readCurrentCandidate,
        readCurrentPluginAuthority: async (pluginId) => {
          let runtimeRegistryLease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
          try {
            runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease();
            return resolveReviewCommentHostPluginAuthority({
              pluginId,
              current: runtimeRegistryLease.registry
                .pluginFinalPolicyCurrentGenerationsById
                ?.get(pluginId) ?? null,
            });
          } catch {
            return null;
          } finally {
            await runtimeRegistryLease?.release();
          }
        },
        resolveWorkspace: async () => {
          const machineId = typeof ctx.machineId === 'string' ? ctx.machineId.trim() : '';
          if (!machineId || !ctx.resolveAccountSettings) return null;
          const settings = accountSettingsParse(await ctx.resolveAccountSettings() ?? {});
          const workspace = resolveWorkspaceRefForMachineRoot(settings.workspaceRefsV1, {
            machineId,
            rootPath: ctx.cwd,
          });
          return workspace
            ? { projectId: workspace.id, workspaceId: workspace.id, serverId: workspace.serverId }
            : null;
        },
        requestCurrentIntent,
        ...(ctx.actionApprovalDeps?.pluginPermissionGrantRequest
          ? { requestDirectWriteGrant: ctx.actionApprovalDeps.pluginPermissionGrantRequest }
          : {}),
        executeHostAction: async (actionId, input, context) => {
          if (!canonicalActionExecutor) {
            return { ok: false, errorCode: 'execution_run_host_action_unavailable', error: 'Canonical action executor is unavailable' };
          }
          return await canonicalActionExecutor.execute(actionId, input, context);
        },
      });
      return await materialize();
    }
    : undefined;

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
    ...(ctx.sessionInteractionHost
      ? { sessionInteractionHost: ctx.sessionInteractionHost }
      : {}),
    resolveAccountSettings: ctx.resolveAccountSettings,
    ...(ctx.machineId ? { machineId: ctx.machineId } : {}),
    resolveProvidersFeatureEnabled: () => {
      const serverSnapshot = ctx.getServerFeaturesSnapshot?.();
      return resolveCliFeatureDecision({
        featureId: 'providers',
        env: process.env,
        ...(serverSnapshot ? { serverSnapshot } : {}),
      }).state === 'enabled';
    },
    ...(materializeReviewHostAction ? { materializeReviewHostAction } : {}),
    checkConnectedServicesGenerationCurrent: async ({ runId, registration }) => {
      const result = await checkExecutionRunConnectedServicesGenerationCurrent({
        runId,
        runnerPid: process.pid,
        registration,
      });
      return { current: result.ok === true && result.current === true };
    },
    ...profileCatalogOptions,
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
  canonicalActionExecutor = actionExecutor;

  registerActionSpecRpcHandlers({
    rpcHandlerManager: rpc,
    actionExecutor: createExecutionRunRpcRegistrarExecutor({
      executor: actionExecutor,
      defaultSessionId: ctx.sessionId,
    }),
    scopes: EXECUTION_RUN_RPC_SCOPES,
  });

  rpc.registerHandler(
    SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
    async (request: unknown) => {
      if (!isExecutionRunsEnabled()) {
        return { ok: false, error: 'Execution runs disabled', errorCode: 'execution_run_not_allowed' };
      }
      const parsed = ExecutionRunTurnStreamStartV2RequestSchema.safeParse(request);
      if (!parsed.success) return invalidParams();
      const started = await manager.startTurnStream(parsed.data.runId, {
        message: parsed.data.message,
        ...(parsed.data.displayMessage ? { displayMessage: parsed.data.displayMessage } : {}),
        ...(parsed.data.resume === true ? { resume: true } : {}),
        userTranscript: parsed.data.userTranscript,
      });
      return started.ok
        ? { streamId: started.streamId }
        : { ok: false, error: started.error, errorCode: started.errorCode };
    },
  );

  rpc.registerHandler(
    SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
    async (request: unknown) => {
      if (!isExecutionRunsEnabled()) {
        return { ok: false, error: 'Execution runs disabled', errorCode: 'execution_run_not_allowed' };
      }
      const parsed = ExecutionRunUserTranscriptCommitRequestSchema.safeParse(request);
      if (!parsed.success) return invalidParams();
      if (!manager.commitUserTranscript) {
        return { ok: false, error: 'Transcript commit unavailable', errorCode: 'execution_run_not_allowed' };
      }
      return await manager.commitUserTranscript(parsed.data.runId, {
        text: parsed.data.message,
        ...(typeof parsed.data.displayMessage === 'string'
          ? { displayText: parsed.data.displayMessage }
          : {}),
        localId: parsed.data.localId,
      });
    },
  );
}
