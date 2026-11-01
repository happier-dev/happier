import type { AgentSessionRuntimeEventV1 } from '@happier-dev/protocol/runtime';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { extractAssistantTextSnapshotFromAcpMessage } from '@/api/session/turns/extractAssistantTextSnapshot';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { configuration, reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import axios from 'axios';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { UpdateSchema, UserMessageSchema } from '@/api/types';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import * as storedAuthTransport from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProductionFreshWorkflowSessionConversation, createProductionWorkflowSessionStepExecutor } from '@/daemon/workflows/sessionStepExecutor';
import { registerPrivateSpawnSessionRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import type { RpcHandler } from '@/api/rpc/types';
import type { WorkflowStepExecutor } from '@/daemon/workflows/coordinator';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { resolveExecutionRunChildSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { startExecutionRun } from '@/agent/runtime/bridges/executionRun/startExecutionRun';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { VoiceAgentManager } from '@/agent/voice/agent/VoiceAgentManager';
import type { SessionModelTransitionProviderTargetAuthorizer } from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { readLeasedAgentProviderRequirements } from '@/plugins/runtime/providerBindings/adapter';
import * as daemonControl from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { createManifestAgentCatalogEntry } from '@/plugins/projection/registry/agentCliMetadata';
import { createExternalContributionFixtures } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readSessionCapabilityApplyChange, sessionCapabilityApplyNotice } from '../../../../../../ui/sources/components/sessions/capabilities/sessionCapabilityApplyNotice';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readPendingCapabilityApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { prepareSessionRunnerRestartAdmission } from '../input/sessionProviderInputAdmissionRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { CheckpointCodeRollbackResultSchema } from '@happier-dev/protocol/sessions/control/rollback/checkpointCodeRollback';
import { buildRepositoryCheckpointRefs } from '@/scm/checkpoints';

import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  buildBackendTargetKey,
  accountSettingsParse,
  normalizeActionsSettingsV1,
  buildBackendTargetKeyV2,
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  deriveSessionFollowWakeEventLocalIdV1,
  deriveSessionCreationTagV1,
  ProviderConnectionIdSchema,
  redactBugReportSensitiveText,
  SessionCreationCorrespondenceV1Schema,
  SESSION_FOLLOW_WAKE_EVENT_MESSAGE,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  sealWorkflowFinalResultStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1,
  deriveWorkflowSessionInputLocalIdV2,
  serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowRunSummaryV1,
  type WorkflowAcceptedSnapshotV1,
  type WorkflowRunRecipientCensusResponseV1,
  type PluginContributionIdentityV1,
  type VoiceProviderContribution,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionModelMutationReversalV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { emptyMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type {
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

const { loggerDebugMock } = vi.hoisted(() => ({
  loggerDebugMock: vi.fn(),
}));

const { readAgentCatalogSnapshotOverride } = vi.hoisted(() => ({
  readAgentCatalogSnapshotOverride: vi.fn(),
}));

vi.mock('@/ui/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/logger')>();
  return {
    ...actual,
    logger: new Proxy(actual.logger, {
      get(target, property, receiver) {
        if (property === 'debug') return loggerDebugMock;
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
});

vi.mock('@/agent/catalog/snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/catalog/snapshot')>();
  return {
    ...actual,
    readAgentCatalogSnapshot: () => (
      readAgentCatalogSnapshotOverride() ?? actual.readAgentCatalogSnapshot()
    ),
  };
});

import { runHostSessionRuntime, type HostRuntimeReplacementLifecycle, type HostSessionRuntimeConfig, type HostSessionRuntimeFactoryParams, type HostSessionRuntimeRunOptions } from './runHostSessionRuntime';
import { createAdmittedFollowInputFixture, installFollowHomeReadinessBoundary } from './runHostSessionRuntime.follow.testkit';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createSessionRunnerRespawnManager } from '@/daemon/processSupervision/sessionRunnerRespawn';
import { resolveSessionRunnerFailureExitCode } from '@/cli/resolveSessionRunnerFailureExitCode';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import type { CreateSessionMetadataOptions } from '@/agent/runtime/createSessionMetadata';
import type { cleanupBackendRunResources } from '@/agent/runtime/cleanupBackendRunResources';
import type { InitializeBackendRunSessionOptions } from '@/agent/runtime/initializeBackendRunSession';
import type { Metadata } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { HostSessionTerminalRemoteModeLoop } from './terminalRemoteModeRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import {
  HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY,
  serializeProviderBindingLaunchHandoffForEnv,
} from '@/plugins/runtime/providerBindings/handoff';
import {
  HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY,
  serializePersistedTakeoverAdmissionForEnv,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD,
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { beginActivePromptLibraryCatalogRefresh, commitActiveProfileCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { PermissionMode } from '@/api/types';
import { resolveAgentSessionRealtimeVoiceAuthority } from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import {
  ApiSessionClient,
  type ApiSessionClientOptions,
} from '@/api/session/sessionClient';
import { createMutableApiSessionClientFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { applyRunnerMcpSessionContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
// The composed Follow gate below runs the real prompt loop over the real admitted
// permission-mode queue, so this is the production owner rather than a test double.
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createPermissionModeQueueState } from '@/agent/runtime/createPermissionModeQueueState';
import { AgentPermissionIntentV1Schema } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import type { HostProviderInputOutcomeEvidence } from '@/agent/runtime/session/input/providerInputOutcome';
import type { RuntimeConfigUpdateOutcomeV1, RuntimeTurnConfigUpdate } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH,
  ConnectedServiceAppliedParentSelectionRequestSchema,
} from '@/daemon/connectedServices/runs/materializeContract';

vi.mock('@/api/session/client/transport/initializeSessionClientConnection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/session/client/transport/initializeSessionClientConnection')>();
  return {
  initializeSessionClientConnection: (params: {
    transport?: Parameters<typeof actual.initializeSessionClientConnection>[0]['transport'];
    setSessionSocket(socket: unknown): void;
    onStateChange(state: {
      phase: 'online';
      reason: null;
      attempt: number;
      nextRetryAt: null;
      lastConnectedAt: number;
      lastDisconnectedAt: null;
      lastErrorMessage: null;
    }): void;
    markConnected(): Readonly<{ reason: 'connect' | 'reconnect'; epoch: number }> | 'connect' | 'reconnect';
    setSessionSyncPendingInputServerContractResult?(result: Readonly<{
      mode: 'released_server_v0_2_1';
      sessionConnectionEpoch: number;
      socket: unknown;
    }>): Promise<void> | void;
  }) => {
    // The Account invalidation composition supplies an actual socket boundary.
    // Keep its production registration and recovery owner intact; only the
    // unrelated offline host cases retain their pre-existing transport fixture.
    if (params.transport?.createAccountUpdatesSocket) return actual.initializeSessionClientConnection(
      params as unknown as Parameters<typeof actual.initializeSessionClientConnection>[0]);
    const userSocket = {
      connected: false,
      on: () => userSocket,
      off: () => userSocket,
      emit: () => undefined,
      disconnect: () => undefined,
      close: () => undefined,
      volatile: {
        emit: () => undefined,
      },
    };
    const sessionSocket = {
      connected: true,
      on: () => sessionSocket,
      off: () => sessionSocket,
      emit: () => undefined,
      timeout: () => sessionSocket,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'update-metadata') {
          const request = payload as {
            expectedVersion: number;
            metadata: string;
          };
          return {
            result: 'success',
            version: request.expectedVersion + 1,
            metadata: request.metadata,
          };
        }
        return { ok: false };
      },
    };
    params.setSessionSocket(sessionSocket);
    const state = {
      phase: 'online' as const,
      reason: null,
      attempt: 0,
      nextRetryAt: null,
      lastConnectedAt: Date.now(),
      lastDisconnectedAt: null,
      lastErrorMessage: null,
    };
    return {
      userSocket,
      sessionConnectionSupervisor: {
        start: async () => {
          params.onStateChange(state);
          const markedConnected = params.markConnected();
          await params.setSessionSyncPendingInputServerContractResult?.({
            mode: 'released_server_v0_2_1',
            sessionConnectionEpoch:
              typeof markedConnected === 'string' ? 0 : markedConnected.epoch,
            socket: sessionSocket,
          });
        },
        stop: async () => undefined,
        getState: () => state,
        captureProbeReportScope: () => null,
        reportProbeResult: () => undefined,
      },
    };
  },
  };
});

const providerModelDescriptor = Object.freeze({
  id: 'provider-model',
  name: 'Provider Model',
});

/**
 * The runtime binding basis an authorized Provider binding carries.
 *
 * `projectAgentSessionProviderBindingV1` refuses a binding without it, so every
 * launch-handoff fixture that reaches runtime creation builds its basis here
 * rather than restating the canonical shape per case.
 */
function externalProviderRuntimeBindingBasis(input: Readonly<{
  connectionId: string;
  agentTargetKey: string;
  contributionKey: string;
  adapterBindingKey: string;
  fingerprintScope: string;
}>) {
  return {
    v: 1 as const,
    deployment: { kind: 'external' as const },
    agentTargetKey: input.agentTargetKey,
    connectionId: ProviderConnectionIdSchema.parse(input.connectionId),
    contributionKey: input.contributionKey,
    endpoint: {
      endpointTemplateId: 'responses',
      normalizedUrl: 'https://provider.example/v1',
      protocol: 'openai-responses' as const,
      publicHeaders: {},
    },
    runtimeCredentialTransport: null,
    prepared: {
      v: 1 as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: input.adapterBindingKey,
    },
    adapterVersion: 1,
    credentialAuthorization: {
      connectionSecurityFingerprint: `connection-security:v1:${input.fingerprintScope}`,
      grantFingerprint: `grant:v1:${input.fingerprintScope}`,
      selectedSecretBindingId: null,
      selectedSecretRecordFingerprint: null,
    },
    agentSupport: {
      acceptsProtocols: ['openai-responses'],
      required: {},
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: [],
      },
      materialization: 'engineConfig' as const,
      applyPolicy: 'live' as const,
      supportsFreeformModelIds: true,
    },
  };
}

function lateExternalProviderBindingHandoff(input: Readonly<{
  connectionId: string;
  modelId: string;
  agentTargetKey: string;
}>) {
  const model = {
    id: input.modelId,
    name: input.modelId,
  };
  const runtimeBindingBasis = externalProviderRuntimeBindingBasis({
    connectionId: input.connectionId,
    agentTargetKey: input.agentTargetKey,
    contributionKey: 'plugin.openrouter/openrouter',
    adapterBindingKey: 'openrouter',
    fingerprintScope: 'late',
  });
  return {
    v: 1 as const,
    materialization: {
      v: 1 as const,
      kind: 'engineConfig' as const,
      engineConfig: { model_provider: { name: 'late-gateway' } },
    },
    sessionBindingMetadata: {
      v: 1 as const,
      connectionId: runtimeBindingBasis.connectionId,
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 1,
      model,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility:v1:late',
      bindingSecurityFingerprint: 'binding-security:v1:late',
      runtimeBindingBasis,
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Late',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    },
  };
}

type CreateAgentSessionRealtimeService = (input: Readonly<{
  provider: Readonly<{ pluginId: string; localId: string }>;
  conversationSessionAddress: Readonly<{ serverId: string; sessionId: string }>;
  applicationAttemptId: string;
  signal: AbortSignal;
  sessionRpc(input: Readonly<{
    sessionAddress: Readonly<{ serverId: string; sessionId: string }>;
    method: string;
    payload: unknown;
    signal: AbortSignal;
  }>): Promise<unknown>;
  onStarted(handle: AgentSessionRealtimeHandle): void;
}>) => AgentSessionRealtimeConversation;

async function loadAgentSessionRealtimeService(): Promise<CreateAgentSessionRealtimeService> {
  // This is an explicit cross-package composition seam; keep the CLI compiler
  // from adopting UI source outside its rootDir while Vitest loads the real module.
  const modulePath: string =
    '../../../../../../ui/sources/voice/runtime/agentRealtime/createAgentSessionRealtimeService';
  const loaded: unknown = await import(modulePath);
  if (
    typeof loaded !== 'object'
    || loaded === null
    || !('createAgentSessionRealtimeService' in loaded)
    || typeof loaded.createAgentSessionRealtimeService !== 'function'
  ) {
    throw new Error('expected the real UI Agent-realtime service factory');
  }
  return loaded.createAgentSessionRealtimeService as CreateAgentSessionRealtimeService;
}

async function withEmptyVoicePromptCatalogFixture(
  credentials: HostSessionRuntimeRunOptions['credentials'],
  run: () => Promise<void>,
): Promise<void> {
  // The Account transport fixture publishes real catalog authority: no authored
  // Voice instructions, rather than an unavailable Account preparation source.
  setActiveAccountSettingsSnapshot({
    source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(credentials),
    promptLibraryCatalog: {
      status: 'ready', rows: [{ revision: 1, record: {
        key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [] },
      } }], tombstones: [], diagnostics: [],
    },
  });
  try {
    await run();
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
  }
}

async function unsupportedRuntimeConfigUpdate(): Promise<RuntimeConfigUpdateOutcomeV1> {
  return { status: 'unsupported', timing: 'not_applicable', reason: 'native_agent_configuration_unsupported' };
}

type HarnessManagedMcpSelection = 'empty' | 'account-default';
const harnessHomeFeatures = Object.freeze({ status: 'ready' as const, provenance: 'authenticated' as const,
  features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_runtime_catalog_fixture' } } }) });

function createSessionFixture(sessionId: string, managedMcpSelection: HarnessManagedMcpSelection = 'empty') {
  const handlers = new Map<string, (payload?: unknown, context?: RpcHandlerContext) => unknown>();
  // The offline Session transport is substituted; mutable metadata, Agent state
  // and their event delivery remain owned by the canonical Session testkit.
  const sessionBoundary = createMutableApiSessionClientFixture({
    sessionId,
    metadata: createTestMetadata({ path: '/tmp/workspace', permissionMode: 'default',
      mcpSelectionV1: SessionMcpSelectionV1Schema.parse({ managedServersEnabled: managedMcpSelection === 'account-default' }),
    }),
    // Home's authenticated feature response is the transport boundary. The
    // canonical Session reader derives its stable Home identity from it.
    overrides: { getServerFeaturesSnapshot: () => harnessHomeFeatures },
  });
  const session: any = {
    ...sessionBoundary,
    sessionId,
    rpcHandlerManager: {
      sessionId,
      registerHandler: (name: string, handler: (payload?: unknown, context?: RpcHandlerContext) => unknown) => {
        handlers.set(name, handler);
      },
    },
    setSessionRuntimeControls: vi.fn(),
    setOwnerActivityDelivery: vi.fn(),
    sendAgentMessage: vi.fn(),
    enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
    sendSessionEvent: vi.fn(),
    // The transcript transport admits Ready into durable custody before notification.
    enqueueSessionEventCommitted: vi.fn(async (): ReturnType<ApiSessionClient['enqueueSessionEventCommitted']> => ({
      persisted: true,
      delivered: false,
    })),
    keepAlive: vi.fn(),
    // Session boundary projection: this server fixture has no reports-to link or origin.
    readRolePromptOrganization: vi.fn(async (): ReturnType<ApiSessionClient['readRolePromptOrganization']> => ({})),
    fetchLatestUserPermissionIntentFromTranscript: vi.fn(async () => null),
    waitForMetadataUpdate: vi.fn(sessionBoundary.waitForMetadataUpdate),
    hasPendingProviderInput: vi.fn(() => true),
    getPendingQueueState: () => ({
      known: true,
      pendingCount: session.hasPendingProviderInput() ? 1 : 0,
      pendingBlockedCount: 0,
      pendingVersion: 0,
    }),
    observeProviderInputSettlement: vi.fn(),
    confirmUserMessageLocallyConsumed: vi.fn(),
    updateMetadata: vi.fn(async (update: (metadata: Metadata) => Metadata) => sessionBoundary.updateMetadata(update)),
    updateMetadataAsCurrentPublisher: vi.fn(
      async (update: (metadata: Metadata) => Metadata) =>
        await session.updateMetadata(update),
    ),
    checkCurrentPublisherAuthority: vi.fn(async () => true),
    hasOwnerMetadataAuthority: vi.fn(() => true),
    on: vi.fn(sessionBoundary.on.bind(sessionBoundary)),
    off: vi.fn(sessionBoundary.off.bind(sessionBoundary)),
    onUserMessage: vi.fn(),
    refreshSessionSnapshotFromServerRequired: vi.fn(async () => undefined),
    enqueueSessionTurnMutation: vi.fn(async () => undefined),
    enqueueRegisteredSessionStateFieldMutation: vi.fn(async () => undefined),
    subscribeExecutionRunActivitySnapshots: vi.fn(() => () => undefined),
    wakePendingMaterialization: vi.fn(),
    claimCurrentSessionPublisherAuthorityForStartup: vi.fn(
      async () => ({ status: 'claimed' as const }),
    ),
    readCurrentPublisherPreconditionForStartup: vi.fn(async () => ({
      machineId: 'machine-1',
      committedFenceMs: 1,
      publisherGeneration: '1',
    })),
    activateDurableMutationDelivery: vi.fn(async () => undefined),
    deactivateDurableMutationDelivery: vi.fn(),
    stageInitialDurableMutationSnapshots: vi.fn(async () => undefined),
    flushDurableMutationDelivery: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    endSessionAndClose: vi.fn(async () => undefined),
    close: vi.fn(sessionBoundary.close),
  };

  return {
    session,
    handlers,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(sessionId = 'session-1', fixture: Readonly<{
  managedMcpSelection?: HarnessManagedMcpSelection;
  credentials?: HostSessionRuntimeRunOptions['credentials'];
  accountId?: string;
}> = {}) {
  let defaultReadyCalls = 0;
  let customReadyCalls = 0;
  let cleanupCalls = 0;
  let beforeInitializeCalls = 0;
  let onAfterStartCalls = 0;
  let onAfterResetCalls = 0;
  let permissionResetCalls = 0;
  let providerPermissionMode: PermissionMode = 'default';
  const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
    mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts },
  );
  const queueReset = vi.spyOn(queue, 'reset');
  let killHandler: (() => void | Promise<void>) | null = null;
  const killHandlersBySessionId = new Map<string, () => void | Promise<void>>();

  const createHarnessSessionFixture = (id: string) => createSessionFixture(id, fixture.managedMcpSelection ?? 'empty');
  const sessionFixture = createHarnessSessionFixture(sessionId);
  const session = sessionFixture.session;
  const handlers = sessionFixture.handlers;
  const runtimeMessageSubscribers = new Set<(message: unknown) => void>();

  const runtime: any = {
    beginTurn: vi.fn(),
    beginTurnLifecycle: vi.fn(function (this: unknown) {
      if (this !== runtime) {
        throw new Error('beginTurnLifecycle called with wrong receiver');
      }
      runtime.beginTurn();
    }),
    sendPrompt: vi.fn(async () => undefined),
    sendTurnPrompt: vi.fn(async function (this: unknown, prompt: string) {
      if (this !== runtime) {
        throw new Error('sendTurnPrompt called with wrong receiver');
      }
      await runtime.sendPrompt(prompt);
    }),
    flushTurn: vi.fn(),
    waitForTurnCompletion: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('waitForTurnCompletion called with wrong receiver');
      }
      await runtime.flushTurn();
    }),
    reset: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('resetOrDisposeRuntime called with wrong receiver');
      }
      await runtime.reset();
    }),
    getSessionId: vi.fn(() => null),
    readSessionIdentity: vi.fn(function (this: unknown) {
      if (this !== runtime) {
        throw new Error('readSessionIdentity called with wrong receiver');
      }
      return { sessionId: runtime.getSessionId() };
    }),
    cancel: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async function (this: unknown) {
      if (this !== runtime) {
        throw new Error('cancelTurn called with wrong receiver');
      }
      await runtime.cancel();
    }),
    setSessionMode: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(async () => undefined),
    setSessionModel: vi.fn(async () => undefined),
    updateSessionRuntimeConfig: vi.fn(async function (
      this: unknown,
      update: RuntimeTurnConfigUpdate,
    ): Promise<RuntimeConfigUpdateOutcomeV1 | void> {
      if (this !== runtime) {
        throw new Error('updateSessionRuntimeConfig called with wrong receiver');
      }
      if (update.workspaceWrites !== undefined) return await unsupportedRuntimeConfigUpdate();
      if (typeof update.modeId === 'string') {
        await runtime.setSessionMode(update.modeId);
      }
      if (typeof update.modelId === 'string') {
        await runtime.setSessionModel(update.modelId);
      }
      if (update.configOption) {
        await runtime.setSessionConfigOption(update.configOption.id, update.configOption.value);
      }
    }),
    subscribeRuntimeEvents: vi.fn((handler: (message: unknown) => void) => {
      runtimeMessageSubscribers.add(handler);
      return () => {
        runtimeMessageSubscribers.delete(handler);
      };
    }),
    emitRuntimeMessage: vi.fn((message: unknown) => {
      for (const subscriber of runtimeMessageSubscribers) {
        subscriber(message);
      }
    }),
    setOnPromptDeliveryOutcome: vi.fn(),
    steerInFlightTurn: vi.fn(async function (this: unknown, prompt: string) {
      if (this !== runtime) {
        throw new Error('steerInFlightTurn called with wrong receiver');
      }
      if (typeof runtime.steerPrompt !== 'function') return;
      await runtime.steerPrompt(prompt);
    }),
  };

  const opts: HostSessionRuntimeRunOptions = {
    // Authentication is an external Home boundary in this offline harness.
    // Author its Account subject; never reinterpret an opaque caller token.
    credentials: fixture.credentials ?? {
      token: `e30.${Buffer.from(JSON.stringify({ sub: fixture.accountId ?? 'runtime-catalog-account', session: 'runtime-catalog-terminal' })).toString('base64url')}.fixture`,
      encryption: null,
    },
  };
  if ((fixture.managedMcpSelection ?? 'empty') === 'empty') {
    // A real runner captures this observation before composing its runtime
    // options. Never reselect a lifetime from a later API callback or getter.
    const existing = getActiveAccountSettingsSnapshot();
    const snapshot = existing ?? {
      source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
      scopeKey: resolveAccountSettingsScopeKey(opts.credentials), settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready' as const,
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1,
          record: emptyPromptLibraryRecordV1(key) })), tombstones: [], diagnostics: [] },
    };
    opts.accountSettingsContext = { ...snapshot, whenRefreshed: null };
    if (!existing) {
      setActiveAccountSettingsSnapshot(snapshot);
      onTestFinished(() => resetActiveAccountSettingsSnapshotForTests());
      if (!fixture.credentials) onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    }
  }

  const config: HostSessionRuntimeConfig = {
    flavor: 'qwen',
    policyAgentId: 'qwen',
    backendDisplayName: 'Qwen Code',
    uiLogPrefix: '[Qwen]',
    providerName: 'Qwen Code',
    waitingForCommandLabel: 'Qwen Code',
    agentMessageType: 'qwen',
    runtimeActivityApplicability: 'not_applicable',
    machineMetadata: {
      host: 'host',
      platform: 'darwin',
      happyCliVersion: '1.0.0',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happy',
      happyLibDir: '/tmp/lib',
    },
    loadTerminalDisplay: async () => () => null,
    beforeInitializeSession: ({ metadata }: any) => {
      beforeInitializeCalls += 1;
      (metadata as any).auggieAllowIndexing = true;
    },
    createSessionRuntime: () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }),
    onAfterStart: async () => {
      onAfterStartCalls += 1;
    },
    onAfterReset: async () => {
      onAfterResetCalls += 1;
    },
    formatPromptErrorMessage: (error) => String(error),
    shouldRenderTerminalDisplay: () => false,
  };

  const deps: any = {
    readProcessIdentityByPidFn: async (pid: number) => ({
      pid,
      processStartTimeMs: 1_000,
      command: '/usr/local/bin/happier qwen',
    }),
    initializeBackendApiContextFn: async () => {
      return {
        api: {
          push: () => ({
            sendToAllDevices: () => {
              defaultReadyCalls += 1;
            },
          }),
        },
        machineId: 'machine-1',
      };
    },
    createSessionMetadataFn: () => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }),
    initializeBackendRunSessionFn: async ({ metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    },
    resolveRunnerMcpServersFn: async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: {},
    }),
    createProviderEnforcedPermissionHandlerFn: () => ({
      setPermissionMode: (mode: PermissionMode) => { providerPermissionMode = mode; },
      getPermissionMode: () => providerPermissionMode,
      reset: () => {
        permissionResetCalls += 1;
      },
      updateSession: () => undefined,
    }),
    createPermissionModeQueueStateFn: () => ({
      messageQueue: queue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    }),
    runPermissionModePromptLoopFn: async (params: any) => {
      await params.onAfterStart?.();
      await params.onAfterReset?.();
      params.sendReady();
    },
    sendReadyWithPushNotificationFn: () => {
      defaultReadyCalls += 1;
    },
    registerKillSessionHandlerFn: (manager: unknown, handler: () => void | Promise<void>) => {
      const sessionId =
        typeof (manager as { sessionId?: unknown } | null)?.sessionId === 'string'
          ? String((manager as { sessionId: string }).sessionId)
          : 'unknown';
      (manager as { registerHandler?: (method: string, handler: () => Promise<unknown>) => void } | null)?.registerHandler?.(
        RPC_METHODS.KILL_SESSION,
        async () => {
          await handler();
          return { success: true, message: 'Killing happier process' };
        },
      );
      killHandlersBySessionId.set(sessionId, handler);
      killHandler = handler;
    },
    cleanupBackendRunResourcesFn: async ({ stopKeepAlive, unmountUi }: Parameters<typeof cleanupBackendRunResources>[0]) => {
      cleanupCalls += 1;
      stopKeepAlive();
      unmountUi?.();
    },
  };

  return {
    opts,
    config,
    deps,
    session,
    runtime,
    queue,
    handlers,
    metrics: {
      get defaultReadyCalls() {
        return defaultReadyCalls;
      },
      get customReadyCalls() {
        return customReadyCalls;
      },
      bumpCustomReadyCalls() {
        customReadyCalls += 1;
      },
      get cleanupCalls() {
        return cleanupCalls;
      },
      get beforeInitializeCalls() {
        return beforeInitializeCalls;
      },
      get onAfterStartCalls() {
        return onAfterStartCalls;
      },
      get onAfterResetCalls() {
        return onAfterResetCalls;
      },
      get permissionResetCalls() {
        return permissionResetCalls;
      },
      get queueResetCalls() {
        return queueReset.mock.calls.length;
      },
      get killHandler() {
        return killHandler;
      },
      getKillHandler(sessionId: string) {
        return killHandlersBySessionId.get(sessionId) ?? null;
      },
    },
    createSessionFixture: createHarnessSessionFixture,
  };
}

function setSessionRuntimeFactory(
  config: HostSessionRuntimeConfig,
  factory: NonNullable<HostSessionRuntimeConfig['createSessionRuntime']>,
): void {
  config.createSessionRuntime = factory;
}

function setAgentSessionRealtimeVoiceAuthority(
  config: HostSessionRuntimeConfig,
  authority: NonNullable<
    HostSessionRuntimeConfig['agentSessionRealtimeVoiceAuthority']
  >,
): void {
  config.agentSessionRealtimeVoiceAuthority = authority;
}

/**
 * The bundled Voice declaration exactly as the shipped contribution registry
 * carries it, bound to one explicit current runtime generation.
 *
 * The host authority admits a Voice provider only through the declaring plugin's
 * committed installation generation, and this in-process registry lease commits
 * none, so `resolveVoiceProviderRuntimeLifecycle` fails closed for every bundled
 * contribution. The fixture supplies that single missing lifecycle carrier and
 * keeps the declaration bytes, contribution identity, and declared Agent binding
 * exactly as the bundled plugin ships them.
 */
function resolveBundledAgentSessionRealtimeVoiceAuthorityFixture(input: Readonly<{
  runtimeRegistry: PluginRuntimeRegistryLease['registry'] | null;
  provider: PluginContributionIdentityV1;
  policyAgentRef: PluginContributionIdentityV1;
  agentGeneration: string;
}>) {
  const bundled = (input.runtimeRegistry?.contributes.voiceProviders ?? []).find(
    (candidate) => candidate.identity.pluginId === input.provider.pluginId
      && candidate.identity.localId === input.provider.localId,
  );
  if (!bundled) {
    throw new Error(
      `expected the bundled Voice contribution ${input.provider.pluginId}/${input.provider.localId}`,
    );
  }
  const providerRetirement = new AbortController();
  const authority = resolveAgentSessionRealtimeVoiceAuthority({
    runtimeRegistry: {
      contributes: { voiceProviders: [bundled] },
      resolveVoiceProviderRuntimeLifecycle: (identity) => (
        identity.pluginId === input.provider.pluginId
        && identity.localId === input.provider.localId
          ? {
              occurrenceId: 'bundled-provider-occurrence',
              isCurrent: () => !providerRetirement.signal.aborted,
              retirementSignal: providerRetirement.signal,
            }
          : null
      ),
    },
    policyAgentRef: input.policyAgentRef,
    agentRuntimeIdentity: {
      pluginId: input.policyAgentRef.pluginId,
      agentId: input.policyAgentRef.localId,
      occurrenceId: input.agentGeneration,
      sourceCustody: {
        kind: 'development',
        registeredRootId: 'voice-test-root',
      },
      isCurrent: () => true,
    },
  });
  if (!authority) throw new Error('expected the bundled Voice authority');
  return authority;
}

function setTerminalRemoteModeLoop(
  config: HostSessionRuntimeConfig,
  terminalRemoteModeLoop: HostSessionTerminalRemoteModeLoop,
): void {
  const createSessionRuntime = config.createSessionRuntime;
  if (!createSessionRuntime) throw new Error('expected session runtime factory');
  config.createSessionRuntime = async (params) => ({
    ...await createSessionRuntime(params),
    terminalRemoteModeLoop,
  });
}

function createTerminalRemoteModeLoopFixture() {
  return {
    startingMode: 'remote' as const,
    remoteExitCode: 0,
    runTerminal: vi.fn(async () => ({ type: 'exit' as const, code: 0 })),
    runRemote: vi.fn(async () => 'exit' as const),
    onModeChange: vi.fn(),
  };
}

let shellBridgeRuntimeFixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | null = null;

async function useShellBridgeRuntimeFixture(config: HostSessionRuntimeConfig) {
  // Prompt planning reads the canonical active catalog. Admit the physical
  // declaration through that same controller, and retain its suite lifetime.
  shellBridgeRuntimeFixture ??= await createAuthoredAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    plugins: [{
      manifest: createPluginManifestV2Fixture({
        id: 'com.acme.review',
        contributes: { systemTools: [{ id: 'fixture-acp', title: 'Fixture ACP', executableNames: ['fixture-acp'] }], agents: [{
          id: 'review', title: 'Review', primary: 'sessions',
          runtime: { kind: 'acp', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } } },
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true }, tools: { delivery: 'shell_bridge' } },
        }] },
      }),
      files: { 'daemon.mjs': 'export function activate(api) {}' },
    }],
  });
  config.policyAgentId = 'com.acme.review/review';
  config.pluginRuntimeRegistryLease = shellBridgeRuntimeFixture.lease;
}

describe('runHostSessionRuntime', () => {
  it('binds restart admission to the receiving RPC manager rather than the lifecycle registrar', async () => {
    const harness = createHarness();
    const rpc = new RpcHandlerManager({ scopePrefix: harness.session.sessionId, encryptionMode: 'plain', logger: () => {} });
    harness.session.rpcHandlerManager = rpc;
    rpc.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async () => ({ started: true }));
    delete harness.deps.runPermissionModePromptLoopFn;
    harness.config.startRuntimeBeforeFirstPrompt = true;
    let stop: (() => Promise<void>) | undefined;
    let stopping: Promise<void> | undefined;
    let observed = false;
    // Real host termination reaches the OS; only process exit is substituted here.
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.config.onRuntimeStopReady = (requestStop: () => Promise<void>) => { stop = requestStop; };
    harness.config.onAfterStart = async () => {
      try {
        const release = await prepareSessionRunnerRestartAdmission({ expectedPid: process.pid, signal: new AbortController().signal,
          callRpc: (request, signal) => rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request, { signal }) });
        expect(release).not.toBeNull();
        await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {}))
          .resolves.toMatchObject({ errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE });
        await release?.();
        await expect(rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_START, {})).resolves.toEqual({ started: true });
        observed = true;
      } finally { stopping = stop?.(); void stopping?.catch(() => undefined); }
    };
    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await stopping;
      expect(observed).toBe(true);
    } finally { exit.mockRestore(); }
  });
  it.each([
    { name: 'legacy void', outcome: undefined, warns: false },
    { name: 'applied', outcome: { status: 'applied' as const }, warns: false },
    { name: 'deferred', outcome: { status: 'applied' as const, timing: 'next_idle' as const }, warns: true },
    { name: 'unsupported', outcome: { status: 'unsupported' as const }, warns: true },
  ])('classifies an external Agent native MCP policy update outcome: $name', async ({ outcome, warns }) => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const agentId = 'acme-native-policy';
    const fixture = createExternalContributionFixtures(agentId);
    if (!fixture.agent.richDefinition || !runtimeRegistryLease) throw new Error('Missing external Agent boundary');
    const definition = { ...fixture.agent.richDefinition.definition, capabilities: { ...fixture.agent.richDefinition.definition.capabilities,
      tools: { delivery: 'native_mcp' as const, mcpToolControl: { off: 'hidden' as const, approval: 'native' as const } } } };
    harness.config.policyAgentId = agentId;
    harness.config.pluginRuntimeRegistryLease = { ...runtimeRegistryLease, registry: { ...runtimeRegistryLease.registry,
      contributes: createResolvedContributionRegistry({ agents: [{ ...fixture.agent,
        richDefinition: { ...fixture.agent.richDefinition, definition }, catalogEntry: createManifestAgentCatalogEntry({
          agentId, pluginId: fixture.agent.pluginId, definition, cli: null, provenance: 'external' }) }] }) } };
    harness.opts.credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'policy-account' })).toString('base64url')}.signature`, encryption: null };
    const snapshot = {
      source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(harness.opts.credentials),
      mcpServerCatalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [],
        catalog: emptyMcpServerCatalogV1() },
    };
    setActiveAccountSettingsSnapshot(snapshot);
    delete harness.deps.resolveRunnerMcpServersFn;
    const updates: RuntimeTurnConfigUpdate[] = [];
    harness.runtime.updateSessionRuntimeConfig = async (update: RuntimeTurnConfigUpdate) => {
      updates.push(update);
      return update.workspaceWrites === undefined ? outcome : await unsupportedRuntimeConfigUpdate();
    };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(updates.some(update => update.mcpToolPolicy !== undefined)).toBe(true);
      expect(warn.mock.calls.some(([message]) => String(message).includes('MCP tool policy configuration update'))).toBe(warns);
    } finally {
      warn.mockRestore();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('rolls back host repository checkpoints through the registered Session Action without an Agent rollback facet', async () => {
    const harness = createHarness();
    const rpc = new RpcHandlerManager({ scopePrefix: harness.session.sessionId, encryptionMode: 'plain' });
    harness.session.rpcHandlerManager = rpc;
    const root = await mkdtemp(join(tmpdir(), 'happier-host-checkpoint-rollback-'));
    const execFile = promisify(execFileCallback);
    const git = async (...args: string[]) => (await execFile('git', args, { cwd: root })).stdout.trim();
    try {
      await git('init');
      await git('config', 'user.name', 'Happier Test');
      await git('config', 'user.email', 'test@example.com');
      await writeFile(join(root, 'tracked.txt'), 'initial\n');
      await git('add', 'tracked.txt');
      await git('commit', '-m', 'initial');
      const repoRoot = await git('rev-parse', '--show-toplevel');
      await harness.session.updateMetadata((metadata: Metadata) => ({ ...metadata, path: repoRoot }));
      harness.deps.createSessionMetadataFn = () => ({
        state: { controlledByUser: false },
        metadata: { path: repoRoot, permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      });
      harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof import('@/agent/runtime/runPermissionModePromptLoop').runPermissionModePromptLoop>[0]) => {
        await params.checkpointLifecycle?.onBeforePromptDispatch?.({ messageId: 'message-1', prompt: 'edit' });
        await params.checkpointLifecycle?.onTurnStarted?.({ messageId: 'message-1', turnId: 'turn-1' });
        await writeFile(join(root, 'tracked.txt'), 'agent change\n');
        await params.checkpointLifecycle?.onTurnFinal?.({ messageId: 'message-1', turnId: 'turn-1', status: 'completed' });
        const refs = buildRepositoryCheckpointRefs({ scopeId: `${harness.session.sessionId}:${repoRoot}`, turnId: 'turn-1' });
        const request = {
          v: 1, sessionId: harness.session.sessionId, turnId: 'turn-1', cwd: repoRoot,
          codeMode: 'code_only_without_stash', backupMode: 'happier_checkpoint_only',
          expectedStartRef: refs.turnStart?.ref, expectedFinalRef: refs.turnFinal?.ref,
          codeOnlyTranscriptDivergenceConfirmed: true,
        };
        const invoke = async (input: unknown) => await rpc.invokeLocal(SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK, input);
        const foreign = CheckpointCodeRollbackResultSchema.parse(await invoke({ ...request, sessionId: 'another-session' }));
        expect(foreign).toMatchObject({ status: 'unavailable', diagnostics: ['checkpoint_rollback_session_mismatch'] });
        const wrongDirectory = CheckpointCodeRollbackResultSchema.parse(await invoke({ ...request, cwd: tmpdir() }));
        expect(wrongDirectory).toMatchObject({ status: 'unavailable', diagnostics: ['checkpoint_rollback_worktree_mismatch'] });
        expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('agent change\n');
        const executor = createCliActionExecutor({
          token: '', sessionId: harness.session.sessionId, mode: 'plain', ctx: null,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({
            v: 1, approvalWaivedSurfaces: { 'session.checkpoint_code_rollback': ['agent'] },
          })),
          invokeBoundSessionRpc: async (method, input) => await rpc.invokeLocal(method, input),
        });
        const executed = await executor.execute('session.checkpoint_code_rollback', request, {
          surface: 'agent', authority: 'account_automation', defaultSessionId: harness.session.sessionId,
        });
        expect(executed, JSON.stringify(executed)).toMatchObject({ ok: true });
        if (!executed.ok) throw new Error('Checkpoint Action failed');
        const result = CheckpointCodeRollbackResultSchema.parse(executed.result);
        expect(result).toMatchObject({ status: 'applied', changedPaths: ['tracked.txt'], diagnostics: [] });
        expect(result.receipts).toContain('checkpoint.rollback_backup_captured');
        expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('initial\n');
        expect(await git('show', `${result.backupCheckpointRef}:tracked.txt`)).toBe('agent change');
      };
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a hookless runtime before the Session loop can dispatch provider input', async () => {
    const harness = createHarness();
    const { setOnPromptDeliveryOutcome: _omittedOutcomePort, ...hooklessRuntime } = harness.runtime;
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    setSessionRuntimeFactory(harness.config, () => ({
      operations: hooklessRuntime,
      nativeRuntime: hooklessRuntime,
    } as never));

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toThrow(/provider delivery outcome/i);
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
    expect(hooklessRuntime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(hooklessRuntime.steerInFlightTurn).not.toHaveBeenCalled();
    expect(hooklessRuntime.resetOrDisposeRuntime).toHaveBeenCalledOnce();
  });

  let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

  beforeAll(async () => {
    runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        // This harness substitutes the native Agent and activates no plugins.
        // Keep the real declarations without admitting unrelated UI artifacts.
        contributes: createResolvedContributionRegistry({ ...resolveBuiltInContributions(), activationTargets: [], pluginDeclarations: [] }),
        pluginIds: [],
      }),
    });
  });

  afterAll(async () => {
    await runtimeRegistryLease?.release();
    runtimeRegistryLease = null;
    await shellBridgeRuntimeFixture?.dispose();
    shellBridgeRuntimeFixture = null;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  it.each(['create', 'resume', 'missing-skill', 'admitted-route', 'retired-during-skills', 'parallel-capabilities', 'parallel-capabilities-retired', 'capabilities-timing', 'selected-role', 'selected-role-account-wake', 'selected-role-later-turn', 'selected-role-loading', 'selected-role-loading-unavailable', 'selected-role-settings-refresh'] as const)(
    'starts the real host runner with a skipped optional MCP server once for %s', async scenario => {
      const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
      if (!runtimeRegistryLease) throw new Error('Missing runtime fixture');
      const agentId = 'acme-optional-reader';
      const fixture = createExternalContributionFixtures(agentId);
      if (!fixture.agent.richDefinition) throw new Error('Missing Agent declaration');
      const definition = { ...fixture.agent.richDefinition.definition, capabilities: {
        ...fixture.agent.richDefinition.definition.capabilities,
        tools: { delivery: 'native_mcp' as const },
        skills: { delivery: 'session_dir' as const, nativeDisable: 'unsupported' as const, liveReload: 'unsupported' as const },
      } };
      const catalogEntry = createManifestAgentCatalogEntry({ agentId, pluginId: fixture.agent.pluginId,
        definition, cli: null, provenance: 'external' });
      harness.config.policyAgentId = agentId;
      harness.config.pluginRuntimeRegistryLease = { ...runtimeRegistryLease, registry: {
        ...runtimeRegistryLease.registry, contributes: createResolvedContributionRegistry({ agents: [{
          ...fixture.agent, richDefinition: { ...fixture.agent.richDefinition, definition }, catalogEntry,
        }] }),
      } };
      harness.opts.credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'optional-account' })).toString('base64url')}.signature`, encryption: null };
      if (scenario === 'resume') harness.opts.resume = 'vendor-optional-session';
      const selectedRole = scenario.startsWith('selected-role');
      const loadingRole = scenario.startsWith('selected-role-loading');
      const settingsRefresh = scenario === 'selected-role-settings-refresh';
      if (selectedRole) {
        const initialMetadata = harness.session.getMetadataSnapshot();
        harness.session.getMetadataSnapshot = () => ({ ...initialMetadata, work: { sessionRolesV1: {
          roleId: 'builder', overrides: loadingRole
            ? { builder: { roleId: 'builder', secondOpinion: 'encouraged' } } : {},
          sessionRoles: {}, notes: loadingRole ? 'ROLE_SESSION_CONTEXT' : '',
        } } });
      }
      const admittedRoute = 'http://127.0.0.1:59173';
      if (scenario === 'admitted-route') {
        vi.spyOn(harness.session, 'getServerBinding').mockReturnValue({
          ...harness.session.getServerBinding(), serverUrl: admittedRoute,
        });
      }
      const settings = accountSettingsParse({ mcpServersStrictMode: false });
      const scopeKey = resolveAccountSettingsScopeKey(harness.opts.credentials);
      harness.opts.accountSettingsContext = { source: 'network', settings, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null };
      const rules = scenario === 'missing-skill' ? [{ id: 'everywhere', skillId: 'missing-skill',
        target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 }] : [];
      setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        ...(selectedRole ? {} : { promptLibraryCatalog: { status: 'ready' as const, rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1,
          record: key === 'skill-rules' ? { key, value: { v: 1, rules } } : emptyPromptLibraryRecordV1(key) })),
          tombstones: [], diagnostics: [] } }),
        mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: { v: 1,
          servers: [{ id: 'optional-linear', name: 'optional-linear', transport: 'stdio', stdio: { command: 'echo', args: [] },
            env: { HAPPIER_FIX1_MISSING_KEY: { t: 'literal', v: '${HAPPIER_FIX1_MISSING_KEY}' } }, createdAt: 1, updatedAt: 1 }],
          bindings: [{ id: 'everywhere-linear', serverId: 'optional-linear', target: { t: 'allMachines' },
            enabled: true, createdAt: 1, updatedAt: 1 }] } },
      });
      vi.stubEnv('HAPPIER_FIX1_MISSING_KEY', undefined);
      vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
      const missing = { id: 'missing-skill', ownerAccountId: 'optional-account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Unavailable skill', bundleSchemaId: 'skills.skill_md_v1' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      // HTTP/daemon IPC and the native Agent are external boundaries. The real
      // runner, MCP bridge/materializer, skill resolver and prompt owner compose here.
      let inventoryReads = 0;
      const parallelCapabilities = scenario.startsWith('parallel-capabilities');
      const mcpNoticeIssued = createDeferred<void>();
      const releaseMcpNotice = createDeferred<void>();
      let skillInventoryStarted = false;
      let boundaryActive = 0;
      let boundaryPeak = 0;
      let boundaryStartedAt: number | undefined;
      let boundaryFinishedAt = 0;
      const observeCapabilityLatency = async () => {
        boundaryStartedAt ??= performance.now();
        boundaryPeak = Math.max(boundaryPeak, ++boundaryActive);
        await new Promise(resolve => setTimeout(resolve, 40));
        boundaryActive -= 1;
        boundaryFinishedAt = performance.now();
      };
      const commitSessionEvent = harness.session.enqueueSessionEventCommitted.getMockImplementation()!;
      if (parallelCapabilities || scenario === 'capabilities-timing') harness.session.enqueueSessionEventCommitted.mockImplementation(async (event: unknown) => {
        if (readSessionCapabilityNoticeV1(event)?.items.some(item => item.kind === 'mcp_server')) {
          if (scenario === 'capabilities-timing') await observeCapabilityLatency();
          else { mcpNoticeIssued.resolve(); await releaseMcpNotice.promise; }
        }
        return commitSessionEvent(event);
      });
      let invalidatedDuringRoleInventory = false;
      let roleOverrideWritten = false;
      const profiles = { status: 'ready' as const, authority: 'active' as const, source: 'destination' as const,
        records: [], diagnostics: [], referenceGuardRevision: 1, control: null, controlRevision: 'absent' as const };
      const roleRowsIssued = createDeferred<void>();
      const releaseRoleRows = createDeferred<void>();
      let settledTurns = 0;
      let recaptureAccount: HostSessionRuntimeFactoryParams['resolveAccountSettingsSnapshot'];
      let refreshedAccount: Awaited<ReturnType<NonNullable<HostSessionRuntimeFactoryParams['resolveAccountSettingsSnapshot']>>> | undefined;
      const sentPrompts: string[] = [];
      const preparationFailures: unknown[] = [];
      if (scenario === 'selected-role-later-turn') {
        // The substituted Agent accepts the real host's Role ceiling update.
        harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied', timing: 'current_window' });
        harness.runtime.sendTurnPrompt = async (prompt: string) => { sentPrompts.push(prompt); };
        harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
          params.messageQueue.push({ text: 'ROLE_FIRST_TURN', localId: null }, { permissionMode: 'default' });
          await runPermissionModePromptLoop({ ...params, shouldExit: () => settledTurns === 2,
            formatPromptErrorMessage: error => {
              preparationFailures.push(error);
              return params.formatPromptErrorMessage(error);
            },
            sendReady: () => {
              settledTurns += 1;
              params.sendReady();
              if (settledTurns === 1) {
                beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
                params.messageQueue.push({ text: 'ROLE_SECOND_TURN', localId: null }, { permissionMode: 'default' });
              }
            } });
        };
      }
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        } };
        if (path === '/v2/account/settings' && settingsRefresh) {
          return { status: 200, data: AccountSettingsV2GetResponseSchema.parse({ version: 2,
            content: { t: 'plain', v: { mcpServersStrictMode: false, preferredLanguage: 'fr' } } }) };
        }
        if (path === '/v1/account/entity-rows/prompt-library') {
          inventoryReads += 1;
          if (loadingRole && invalidatedDuringRoleInventory) {
            roleRowsIssued.resolve();
            await releaseRoleRows.promise;
            if (scenario === 'selected-role-loading-unavailable') return { status: 503, data: {} };
          }
          if (scenario === 'selected-role-account-wake' || scenario === 'selected-role-later-turn') {
            // Independent Account hydration is an external wake. The private
            // Session reader still owns its in-flight prompt/Role demand.
            commitActiveProfileCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
              catalog: { status: 'ready', authority: 'active', source: 'destination', records: [], diagnostics: [],
                referenceGuardRevision: inventoryReads, control: null, controlRevision: 'absent' } });
            if (settledTurns === 1) await recaptureAccount?.();
          }
          return { status: 200, data: { status: 'listed',
            rows: PromptLibraryCatalogKeyV1Schema.options.filter(key => !settingsRefresh || roleOverrideWritten || key !== 'role-overrides')
              .map(key => ({ key, revision: key === 'role-overrides' && settledTurns === 1 ? 2 : 1,
              content: { t: 'plain', v: key === 'role-overrides' && settledTurns === 1
                ? { key, value: { v: 1, overrides: { builder: { roleId: 'builder', instructionsOverride: 'ROLE_SECOND_CONTEXT' } } } }
                : key === 'role-overrides' && loadingRole
                  ? { key, value: { v: 1, overrides: { builder: { roleId: 'builder', instructionsOverride: 'ROLE_ACCOUNT_CONTEXT' } } } }
                : emptyPromptLibraryRecordV1(key) } })),
          } };
        }
        if (path === '/v1/artifacts') {
          skillInventoryStarted = true;
          if (scenario === 'capabilities-timing') await observeCapabilityLatency();
          // Role discovery now lists headers before opening selected bodies.
          // Withdraw the catalog at that real read boundary, even for an empty inventory.
          if (loadingRole && !invalidatedDuringRoleInventory) {
            invalidatedDuringRoleInventory = true;
            beginActivePromptLibraryCatalogRefresh({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
          }
          if (scenario === 'retired-during-skills') {
            const snapshot = getActiveAccountSettingsSnapshot();
            if (!snapshot) throw new Error('Missing captured Account');
            resetActiveAccountSettingsSnapshotForTests();
            setActiveAccountSettingsSnapshot(snapshot);
          }
          return { status: 200, data: scenario === 'missing-skill' ? [missing] : [] };
        }
        if (path === '/v1/artifacts/missing-skill') return { status: 404, data: { error: 'not_found' } };
        throw new Error(`Unexpected optional-capability HTTP path: ${path}`);
      });
      const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (new URL(String(url)).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) {
          return { status: 200, data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }) };
        }
        if (!settingsRefresh) throw new Error('Unexpected Project/Prompt write');
        expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/prompt-library/role-overrides');
        const mutation = PromptLibraryRowMutationV1Schema.parse(body);
        expect(mutation).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 2 });
        roleOverrideWritten = true;
        // The real source reader has privately accepted Settings v2. An
        // independent domain now publishes from the still-v1 ambient owner.
        expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(1);
        expect(commitActiveProfileCatalog({ scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
          catalog: profiles })).toBe(true);
        return { status: 200, data: PromptLibraryRowMutationResponseV1Schema.parse({ status: 'updated', revision: 1, cursor: 1 }) };
      });
      const catalog = vi.spyOn(daemonControl, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
      const home = await mkdtemp(join(tmpdir(), 'happier-fix1-composed-'));
      const store = createSkillStore({ happyHomeDir: home });
      const ensure = vi.spyOn(daemonControl, 'ensureSkillSessionDirHttp').mockImplementation(input => store.ensureSkillSessionDir(input));
      delete harness.deps.resolveRunnerMcpServersFn;
      delete harness.deps.cleanupBackendRunResourcesFn;
      const createRuntime = harness.config.createSessionRuntime!;
      let opened = false;
      const constructionDiagnostic = vi.spyOn(logger, 'infoFile');
      setSessionRuntimeFactory(harness.config, async params => {
        recaptureAccount = params.resolveAccountSettingsSnapshot;
        expect(params.mcpServers?.['optional-linear']).toBeUndefined();
        expect(params.mcpServers?.happier).toBeDefined();
        if (settingsRefresh) {
          refreshedAccount = await params.resolveAccountSettingsSnapshot?.();
        }
        if (!params.resolveFreshSessionSystemPrompt) throw new Error('Missing production prompt binding');
        const prompt = await params.resolveFreshSessionSystemPrompt({ baseOverride: 'Base instructions' });
        expect(prompt).toContain('Base instructions');
        if (selectedRole) expect(prompt).toContain('Builder');
        if (loadingRole) {
          expect(prompt).toContain('ROLE_ACCOUNT_CONTEXT');
          expect(prompt).toContain('ROLE_SESSION_CONTEXT');
          // The real host must publish its admitted Role holder to the Action
          // receiver, rather than leaving that receiver to construct another.
          const bound = applyRunnerMcpSessionContext(params.session, {}).getSessionRoleContext?.();
          expect(await bound?.readAccountOverrides()).toMatchObject({ status: 'ready', overrides: {
            builder: { instructionsOverride: 'ROLE_ACCOUNT_CONTEXT' },
          } });
          expect(bound?.readOperationContext?.()).toBeDefined();
        }
        opened = true;
        return createRuntime(params);
      });
      let capabilityRun: Promise<void> | undefined;
      try {
        if (scenario === 'retired-during-skills') {
          await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).resolves.toBeUndefined();
          expect(opened).toBe(false);
          expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
            action: 'fail',
            issue: expect.objectContaining({ code: 'preparation_pending', source: 'dependency_failure' }),
          }));
          const { SessionTurnMutationV1Schema } = await import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1');
          const mutationCalls: readonly (readonly unknown[])[] = harness.session.enqueueSessionTurnMutation.mock.calls;
          const mutations = mutationCalls.map(([mutation]) => SessionTurnMutationV1Schema.parse(mutation));
          expect(mutations.filter(mutation => mutation.action === 'fail')).toEqual([
            expect.objectContaining({ issue: expect.objectContaining({ code: 'preparation_pending', source: 'dependency_failure' }) }),
          ]);
          return;
        }
        const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
        capabilityRun = running;
        if (parallelCapabilities) {
          await Promise.race([mcpNoticeIssued.promise, running]);
          // Home inventory must progress while the independent MCP notice's
          // transcript commit is pending. Native open still joins both owners.
          await vi.waitFor(() => expect(skillInventoryStarted).toBe(true));
          expect(opened).toBe(false);
          if (scenario === 'parallel-capabilities-retired') {
            const snapshot = getActiveAccountSettingsSnapshot()!;
            resetActiveAccountSettingsSnapshotForTests();
            setActiveAccountSettingsSnapshot(snapshot);
          }
          releaseMcpNotice.resolve();
        }
        if (loadingRole) {
          // The real Role source read crosses a Home boundary after its initial
          // preparation. A withdrawn catalog must be demanded again before use.
          await Promise.race([roleRowsIssued.promise, running]);
          expect(opened).toBe(false);
          releaseRoleRows.resolve();
        }
        if (scenario === 'parallel-capabilities-retired') {
          await expect(running).rejects.toMatchObject({ code: 'mcp_catalog_unavailable', reason: 'scope-retired' });
          expect(opened).toBe(false);
          return;
        }
        await running;
        if (scenario === 'selected-role-loading-unavailable') {
          expect(opened).toBe(false);
          expect(constructionDiagnostic.mock.calls.filter(([message]) => message.includes('Session construction failed')))
            .toEqual([[expect.any(String), expect.objectContaining({ originalCode: 'role_overrides_unavailable', reason: 'unreachable' })]]);
          expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({ action: 'fail',
            issue: expect.objectContaining({ code: 'preparation_pending', source: 'dependency_failure' }) }));
          return;
        }
        expect(constructionDiagnostic.mock.calls.filter(([message]) => message.includes('Session construction failed'))).toEqual([]);
        expect(opened).toBe(true);
        if (scenario === 'capabilities-timing') {
          console.info('PERF4 host capability boundary measurement', { durationMs: Math.round(boundaryFinishedAt - boundaryStartedAt!), peak: boundaryPeak });
          expect(boundaryPeak).toBe(2);
        }
        if (settingsRefresh) {
          expect(roleOverrideWritten).toBe(true);
          expect(refreshedAccount).toMatchObject({ settingsVersion: 2, rawSettings: { mcpServersStrictMode: false, preferredLanguage: 'fr' },
            settings: { preferredLanguage: 'fr' }, profileCatalog: profiles });
          expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(1);
        }
        if (scenario === 'selected-role-later-turn') {
          expect(preparationFailures.map(readSessionPreparationFailureDiagnostic)).toEqual([]);
          expect(sentPrompts).toEqual([expect.stringContaining('ROLE_FIRST_TURN'), expect.stringContaining('ROLE_SECOND_TURN')]);
          expect(sentPrompts[1]).toContain('ROLE_SECOND_CONTEXT');
          expect(settledTurns).toBe(2);
        }
        if (scenario === 'admitted-route') {
          expect(get.mock.calls.length).toBeGreaterThan(0);
          expect(get.mock.calls.some(call => new URL(String(call[0])).pathname === '/v1/artifacts')).toBe(true);
          expect(get.mock.calls.map(call => String(call[0])).filter(url => new URL(url).origin !== admittedRoute)).toEqual([]);
        }
        const events: readonly unknown[] = harness.session.enqueueSessionEventCommitted.mock.calls
          .map((call: readonly unknown[]) => call[0]);
        const notices = events.map(readSessionCapabilityNoticeV1).filter(notice => notice !== null);
        expect(notices.flatMap(notice => notice?.items ?? []).filter(item => item.kind === 'mcp_server')).toEqual([
          { kind: 'mcp_server', name: 'optional-linear', itemId: 'optional-linear', code: 'missing_value_ref', detail: 'env:HAPPIER_FIX1_MISSING_KEY' },
        ]);
        const skills = notices.flatMap(notice => notice?.items ?? []).filter(item => item.kind === 'skill');
        expect(skills).toEqual(scenario === 'missing-skill' ? [expect.objectContaining({ itemId: 'missing-skill', detail: 'content_unreadable' })] : []);
      } finally {
        releaseMcpNotice.resolve();
        releaseRoleRows.resolve();
        await capabilityRun?.catch(() => undefined);
        get.mockRestore(); post?.mockRestore(); catalog.mockRestore(); ensure.mockRestore(); constructionDiagnostic.mockRestore();
        await store.releaseSkillSessionDirs('session-1'); await store.collectSkillCache({ libraryDigests: [] });
        await rm(home, { recursive: true, force: true });
        vi.unstubAllEnvs(); resetActiveAccountSettingsSnapshotForTests();
      }
    },
  );

  it.each([false, true])('prepares two daemon-spawned Bot turns through the real server beside unknown catalog keys (required context: %s)', async requiredContext => {
    const { createLightSqliteHarness } = await import('../../../../../../server/sources/testkit/lightSqliteHarness');
    const { db } = await import('../../../../../../server/sources/storage/db');
    const { createAuthenticatedTestApp } = await import('../../../../../../server/sources/app/api/testkit/sqliteFastify');
    const { registerPromptLibraryRoutes } = await import('../../../../../../server/sources/app/account/prompts/registerPromptLibraryRoutes');
    const { registerAccountEncryptionRoutes } = await import('../../../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes');
    const { buildPromptLibraryPhysicalKeyV1, PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1, PromptLibraryRecordV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-ctx-source-runner-', initEncrypt: true });
    const app = createAuthenticatedTestApp();
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'happier.agent.claude/claude';
    harness.config.agentMessageType = 'claude';
    delete harness.deps.createSessionMetadataFn;
    delete harness.deps.resolveRunnerMcpServersFn;
    delete harness.deps.createProviderEnforcedPermissionHandlerFn;
    delete harness.deps.createPermissionModeQueueStateFn;
    delete harness.deps.registerKillSessionHandlerFn;
    delete harness.deps.sendReadyWithPushNotificationFn;
    delete harness.deps.cleanupBackendRunResourcesFn;
    let settledTurns = 0;
    const sentPrompts: string[] = [];
    const preparationFailures: unknown[] = [];
    harness.runtime.sendTurnPrompt = async (prompt: string) => { sentPrompts.push(prompt); };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      params.messageQueue.push({ text: 'BOT_FIRST_TURN', localId: null }, { permissionMode: 'default' });
      await runPermissionModePromptLoop({ ...params, shouldExit: () => settledTurns === 2,
        formatPromptErrorMessage: error => {
          preparationFailures.push(error);
          return params.formatPromptErrorMessage(error);
        },
        sendReady: () => {
          settledTurns += 1;
          params.sendReady();
          if (settledTurns === 1) {
            const current = getActiveAccountSettingsSnapshot();
            if (!current?.scopeKey) throw new Error('Missing Bot Account');
            beginActivePromptLibraryCatalogRefresh({ scopeKey: current.scopeKey,
              lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
            params.messageQueue.push({ text: 'BOT_SECOND_TURN', localId: null }, { permissionMode: 'default' });
          }
        } });
    };
    let opened = false;
    try {
      const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
      const coding = PromptLibraryRecordV1Schema.parse({ key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: requiredContext ? [{
        id: 'context-source', ref: { kind: 'doc', artifactId: 'context-source' }, enabled: true, required: true, placement: 'system_append',
      }] : [] } });
      const document = { id: 'context-source', ownerAccountId: account.id, access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Context source' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'CTX_SOURCE_ACCOUNT_CONTEXT', createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      await db.userKVStore.createMany({ data: [
        ...PromptLibraryCatalogKeyV1Schema.options.map(key => ({ accountId: account.id,
          key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
          value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: key === 'coding' ? coding : emptyPromptLibraryRecordV1(key) })) })),
        { accountId: account.id, key: `${PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1}future-skill-usage`, version: 1,
          value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1('coding') })) },
      ] });
      registerPromptLibraryRoutes(app);
      registerAccountEncryptionRoutes(app);
      harness.opts.credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: account.id })).toString('base64url')}.signature`, encryption: null };
      harness.opts.startedBy = 'daemon';
      harness.opts.directory = '/tmp/managed-ctx-source';
      harness.session.getMetadataSnapshot = () => createTestMetadata({ path: harness.opts.directory,
        permissionMode: 'read-only', startedBy: 'daemon', profileId: null, bot: { kind: 'bot' }, createdAsBot: true,
        sessionDirectoryV1: { v: 1, kind: 'managed' },
        connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
          source: 'connected', selection: 'profile', profileId: 'connected-claude-profile',
        } } } });
      const settings = accountSettingsParse({});
      const scopeKey = resolveAccountSettingsScopeKey(harness.opts.credentials);
      harness.opts.accountSettingsContext = { source: 'network', settings, scopeKey, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], mcpServerCatalog: { status: 'ready', authority: 'active',
          revision: 1, diagnostics: [], catalog: emptyMcpServerCatalogV1() } });
      // HTTP and Agent execution are genuine external boundaries. Route, SQLite,
      // persisted-mode admission, credential custody and prompt preparation stay real.
      vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        const authorization = options?.headers?.Authorization;
        expect(authorization).toBe(`Bearer ${harness.opts.credentials.token}`);
        if (path === '/v1/artifacts') return { status: 200, data: [document] };
        if (path === '/v1/artifacts/context-source') return { status: 200, data: document };
        const response = await app.inject({ method: 'GET', url: path, headers: { 'x-test-user-id': account.id } });
        if (settledTurns === 1 && path === '/v1/account/entity-rows/prompt-library') {
          // An Account wake can finish unrelated Profile hydration while the
          // second coding plan reads its real rows. No coding Profile is selected.
          const current = getActiveAccountSettingsSnapshot();
          if (!current?.scopeKey) throw new Error('Missing Bot Account');
          commitActiveProfileCatalog({ scopeKey: current.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
            catalog: { status: 'ready', authority: 'active', source: 'destination', records: [], diagnostics: [],
              referenceGuardRevision: 1, control: null, controlRevision: 'absent' } });
        }
        return { status: response.statusCode, data: response.json() };
      });
      vi.spyOn(daemonControl, 'readDaemonPluginCatalog').mockResolvedValue({ kind: 'available', plugins: [], tools: [] });
      const createRuntime = harness.config.createSessionRuntime!;
      setSessionRuntimeFactory(harness.config, async params => {
        if (!params.resolveFreshSessionSystemPrompt) throw new Error('Missing production prompt binding');
        const prompt = await params.resolveFreshSessionSystemPrompt({ baseOverride: 'CTX_SOURCE_STARTUP' });
        expect(prompt).toContain('CTX_SOURCE_STARTUP');
        if (requiredContext) expect(prompt).toContain('CTX_SOURCE_ACCOUNT_CONTEXT');
        opened = true;
        return createRuntime(params);
      });
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(opened).toBe(true);
      expect(preparationFailures).toEqual([]);
      expect(sentPrompts).toEqual([expect.stringContaining('BOT_FIRST_TURN'), expect.stringContaining('BOT_SECOND_TURN')]);
      expect(settledTurns).toBe(2);
    } finally {
      vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests();
      await app.close(); await sqlite.close();
    }
  }, 180_000);

  it.each([{ overridden: false, miswired: false, duringPreparation: false }, { overridden: true, miswired: false, duringPreparation: false },
    { overridden: false, miswired: false, duringPreparation: false, operationsOnly: true },
    { overridden: false, miswired: true, duringPreparation: false }, { overridden: false, miswired: false, duringPreparation: true },
    { overridden: false, miswired: false, duringPreparation: true, startupMaintenance: true },
    { overridden: false, miswired: false, duringPreparation: false, loadingAtAdmission: true },
    { overridden: false, miswired: false, duringPreparation: false, mcpRules: true },
    { overridden: false, miswired: false, duringPreparation: false, mcpRules: true, startOff: true },
    { overridden: true, miswired: false, duringPreparation: false, mcpRules: true },
    { overridden: false, miswired: true, duringPreparation: false, mcpRules: true }])(
    'applies a recorded Account invalidation through Session-client hydration with unchanged Session selection %j', async ({ overridden, miswired, duringPreparation, startupMaintenance, loadingAtAdmission, mcpRules, startOff, operationsOnly }) => {
    const { createLightSqliteHarness } = await import('../../../../../../server/sources/testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp } = await import('../../../../../../server/sources/app/api/testkit/sqliteFastify');
    const { accountRoutes } = await import('../../../../../../server/sources/app/api/routes/account/accountRoutes');
    const { artifactsRoutes } = await import('../../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes');
    const { registerWorkflowRunStorageRoutes } = await import('../../../../../../server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes');
    const { enableOptionalStatics } = await import('../../../../../../server/sources/app/api/utils/enableOptionalStatics');
    const { auth } = await import('../../../../../../server/sources/app/auth/auth');
    const { db } = await import('../../../../../../server/sources/storage/db');
    const { eventRouter } = await import('../../../../../../server/sources/app/events/connectionEventRouter');
    const { getAccountStoredContentV3SocketRoom } = await import('../../../../../../server/sources/app/api/socketRooms');
    const { Server } = await import('socket.io');
    const { io } = await import('socket.io-client');
    const { AgentSessionStartupInstructionsV1Schema } = await import('@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1');
    const { createSessionScopedSocketConnection } = await import('@/api/session/sockets');
    const { refreshActiveMcpServerCatalog } = await import('@/settings/mcp/hydrateMcpServerCatalog');
    const { refreshActivePromptLibraryCatalog } = await import('@/settings/prompts/hydratePromptLibraryCatalog');
    const { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, sealMcpServerCatalogContentV1, openMcpServerCatalogContentV1,
      MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema, McpServerCatalogRowReadResponseV1Schema,
      McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema } = await import('@happier-dev/protocol/mcp/servers/serverRowsV1');
    const { applyMcpServerCatalogMutationV1 } = await import('@happier-dev/protocol/mcp/servers/serverCatalogV1');
    const { publishServerHttpRuntimeOrigin } = await import('@/api/client/serverHttpBaseUrl');
    const { buildPromptLibraryPhysicalKeyV1, PromptLibraryRowReadResponseV1Schema, PromptLibraryRowMutationV1Schema,
      PromptLibraryRowMutationResponseV1Schema, sealPromptLibraryContentV1, openPromptLibraryContentV1,
      PROMPT_LIBRARY_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
    const { applyReachRulesChangeV1 } = await import('@happier-dev/protocol/reach/reachRulesChangeV1');
    const { buildCurrentAccountStoredContentCompatibilityHttpHeaders } = await import('@/api/clientCompatibility/cliClientCompatibility');
    const persistence = await import('@/persistence');
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { createCliActionDeps } = await import('@/session/actions/createCliActionDeps');
    const { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } = await import('@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1');
    const { AgentSessionSkillDeliveryV1Schema } = await import('@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1');
    const { AgentSessionRuntimeEventSchema } = await import('@happier-dev/protocol/runtime/agentSessionV1');
    const { ConnectedServiceTurnLifecycleRequestBodySchema, ConnectedServiceTurnLifecycleResultSchema,
      connectedServiceTurnLifecycleContinue } = await import('@/daemon/connectedServices/connectedServiceTurnLifecycleContract');
    const { writeSessionCapabilitySelectionToMetadataV1 } = await import('@happier-dev/protocol/reach/sessionCapabilityMetadataV1');
    const { readSessionCapabilityAgentFactsV1 } = await import('@happier-dev/protocol/reach/capabilityApplyTimingV1');
    const { readFile, access } = await import('node:fs/promises');
    const sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-b1fix-b-rule-wiring-', initAuth: true, initEncrypt: true });
    // The canonical harness decorates a real Fastify instance; narrow its untyped boundary.
    const app = createAuthenticatedTestApp({ authentication: 'real' }) as import('../../../../../../server/sources/app/api/types').Fastify;
    const rootScope = createEnvKeyScope(['HAPPIER_SERVER_UI_DIR', 'HAPPIER_SERVER_UI_REQUIRED']);
    rootScope.patch({ HAPPIER_SERVER_UI_DIR: undefined, HAPPIER_SERVER_UI_REQUIRED: '0' });
    enableOptionalStatics(app);
    accountRoutes(app); artifactsRoutes(app); registerWorkflowRunStorageRoutes(app);
    const preparationRead = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    const maintenanceRead = createDeferred<void>();
    const releaseMaintenance = createDeferred<void>();
    const admissionCatalogRead = createDeferred<void>();
    const releaseAdmissionCatalog = createDeferred<void>();
    let holdAdmissionCatalog = false;
    let holdMaintenance = false;
    let preparationPath: string | null = null;
    app.addHook('onRequest', async request => {
      if (holdAdmissionCatalog && request.method === 'GET' && request.url === '/v1/account/entity-rows/prompt-library') {
        holdAdmissionCatalog = false;
        admissionCatalogRead.resolve();
        await releaseAdmissionCatalog.promise;
      }
      if (request.method === 'GET' && request.url === preparationPath) {
        preparationRead.resolve();
        await releasePreparation.promise;
      }
      if (holdMaintenance && request.method === 'GET' && request.url === '/v2/account/settings') {
        holdMaintenance = false;
        maintenanceRead.resolve();
        await releaseMaintenance.promise;
      }
    });
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1 } });
    for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
      accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 1,
      value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
    } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const sockets = new Server(app.server, { path: '/v1/updates' });
    sockets.use((socket, next) => {
      void (async () => {
        const token: unknown = socket.handshake.auth.token;
        const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
        if (!verified || verified.userId !== account.id) return next(new Error('Unauthorized'));
        await socket.join(getAccountStoredContentV3SocketRoom(verified.userId)); next();
      })().catch(next);
    });
    eventRouter.setIo(sockets);
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const observer = io(url, { path: '/v1/updates', transports: ['websocket'], auth: { token: credentials.token }, reconnection: false });
    const wakes: unknown[] = []; observer.on('update', event => wakes.push(event));
    await new Promise<void>((resolve, reject) => { observer.once('connect', resolve); observer.once('connect_error', reject); });
    const releaseHome = publishServerHttpRuntimeOrigin(url, 'https');
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    // The host's real origin-delivery read requires its Account-owned Session identity.
    await db.session.create({ data: { id: harness.session.sessionId, tag: 'rule-live-apply',
      accountId: account.id, metadata: '{}', encryptionMode: 'plain' } });
    harness.opts.credentials = credentials;
    harness.opts.startedBy = 'daemon';
    // Daemon IPC is outside this host process. Admit its exact typed marker
    // receipt, keeping the host's real lifecycle observation and drain intact.
    const notifyTurnMarker: NonNullable<import('./lifecycle').SessionLoopLifecycleDeps['notifyDaemonConnectedServiceTurnLifecycleFn']> = async body => {
      const request = ConnectedServiceTurnLifecycleRequestBodySchema.parse(body);
      return ConnectedServiceTurnLifecycleResultSchema.parse(connectedServiceTurnLifecycleContinue({
        status: 'recorded', activeTurnId: request.event === 'task_started' ? request.turnId ?? null : null,
      }));
    };
    harness.deps.sessionLoopLifecycleDeps = { ...harness.deps.sessionLoopLifecycleDeps,
      notifyDaemonConnectedServiceTurnLifecycleFn: notifyTurnMarker } satisfies import('./lifecycle').SessionLoopLifecycleDeps;
    vi.spyOn(harness.session, 'getServerBinding').mockReturnValue({ ...harness.session.getServerBinding(), serverUrl: url });
    const settings = accountSettingsParse({});
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, scopeKey,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
      serverId: configuration.activeServerId, serverIdentityId: configuration.activeServerId, serverHttpBaseUrl: url,
      sessionId: 'account-client', mode: 'plain', ctx: null }) });
    const actionContext = { surface: 'ui' as const, authority: 'present_user' as const };
    const store = createSkillStore({ happyHomeDir: join(sqlite.baseDir, 'skills-home') });
    let run: Promise<void> | null = null;
    let admissionHydration: Promise<unknown> | undefined;
    let networkClient: ApiSessionClient | null = null;
    let restoreAccountRefresh = () => {};
    const readCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    // Real Session termination reaches process exit; substitute only this OS boundary.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const settleTurn = createDeferred<void>();
    const ensure = vi.spyOn(daemonControl, 'ensureSkillSessionDirHttp').mockImplementation(input => store.ensureSkillSessionDir(input));
    const restart = vi.spyOn(daemonControl, 'requestDaemonSessionRunnerRestart').mockResolvedValue({
      ok: false, status: 'busy', sessionId: harness.session.sessionId, reasonCode: 'turn_in_progress',
    });
    try {
      const created = await executor.execute('skills.create', { name: 'rule-sample', files: [{ path: 'SKILL.md', contentKind: 'utf8',
        contentBase64: Buffer.from('---\nname: rule-sample\ndescription: Rule seam\n---\nSupporting instructions').toString('base64') }] }, actionContext);
      if (!created.ok) throw new Error(JSON.stringify(created));
      const item = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(created.result);
      if (!item.ok || item.incomplete) throw new Error('Skill creation was not fully acknowledged');
      if (mcpRules) {
        const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'rule-mcp', name: 'rule-mcp',
          transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
          bindings: [{ id: 'rule-mcp-machine', serverId: 'rule-mcp', target: { t: 'machine', machineId: 'machine-1' },
            enabled: !startOff, createdAt: 1, updatedAt: 1 }] });
        await db.userKVStore.create({ data: { accountId: account.id, key: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, version: 1,
          value: new TextEncoder().encode(JSON.stringify(sealMcpServerCatalogContentV1({ mode: 'plain', material: null, catalog }))) } });
        delete harness.deps.resolveRunnerMcpServersFn;
      }
      let startupDocumentId: string | undefined;
      if (duringPreparation) {
        const document = await executor.execute('prompt_doc.create', { title: 'Startup context', markdown: 'FIX20D_PREPARED_CONTEXT' }, {
          ...actionContext, presentUserConfirmation: { actionId: 'prompt_doc.create' },
        });
        if (!document.ok || typeof document.result !== 'object' || document.result === null
          || !('artifactId' in document.result) || typeof document.result.artifactId !== 'string') throw new Error(`Startup document creation failed: ${JSON.stringify(document)}`);
        startupDocumentId = document.result.artifactId;
        await harness.session.updateMetadata((metadata: Metadata) => ({ ...metadata, work: { ...metadata.work,
          promptStack: [{ id: 'startup-context', ref: { kind: 'doc', artifactId: startupDocumentId! }, enabled: true, placement: 'system_append' }] } }));
      }
      // A daemon-started runner hydrates its private captured operation at
      // admission. It need not have demanded the process-global catalog.
      const admitted = getActiveAccountSettingsSnapshot();
      if (!admitted) throw new Error('Missing admitted Account');
      setActiveAccountSettingsSnapshot({ ...admitted, promptLibraryCatalog: undefined });
      networkClient = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: harness.session.sessionId }), {
        metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
        transport: { serverId: configuration.activeServerId, serverUrl: url,
          createAccountUpdatesSocket: () => observer,
          createSessionSocketTransport: binding => createSessionScopedSocketConnection({ token: credentials.token, serverUrl: url, ...binding }),
        },
      });
      // Observe completion of the real socket-invoked owner, without replacing
      // its logic or issuing a test-owned catalog read that could hide mis-wiring.
      const refreshAccount = vi.spyOn(networkClient as unknown as { refreshDemandedAccountCatalogs(): Promise<void> }, 'refreshDemandedAccountCatalogs');
      restoreAccountRefresh = () => { refreshAccount.mockRestore(); };
      if (miswired) {
        // Remove only the production network ingress. The host's captured
        // Account observer and synchronizer remain bound normally.
        observer.removeAllListeners('update');
        observer.on('update', event => wakes.push(event));
      }
      // FIX20B CDP capture, runtime-trace.json: real content-free producer vector.
      const recordedAccountChange = { id: '5ZzoT0HAXoh7', seq: 1825467,
        body: { t: 'account-change' as const }, createdAt: 1791960978451 };
      const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), authorization: `Bearer ${credentials.token}` };
      const writeRuleFromOtherClient = async (state: 'on' | 'off') => {
        if (mcpRules) {
          const row = McpServerCatalogRowReadResponseV1Schema.parse((await axios.get(`${url}${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { headers })).data);
          if (row.status !== 'present') throw new Error('Missing MCP row');
          const opened = openMcpServerCatalogContentV1({ content: row.content, mode: 'plain', material: null });
          if (opened.status !== 'opened') throw new Error('Unreadable MCP row');
          const catalog = applyMcpServerCatalogMutationV1(opened.catalog, { kind: 'rules-change', serverIds: ['rule-mcp'],
            change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-1' }, state } } },
            { nowMs: Date.now(), newId: () => 'rule-mcp-machine' });
          const mutation = McpServerCatalogRowMutationV1Schema.parse({ expectedRevision: row.revision,
            content: sealMcpServerCatalogContentV1({ catalog, mode: 'plain', material: null }) });
          expect(McpServerCatalogRowMutationResponseV1Schema.parse((await axios.post(`${url}${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, mutation, { headers })).data))
            .toMatchObject({ status: 'updated' });
          sockets.to(getAccountStoredContentV3SocketRoom(account.id)).emit('update', recordedAccountChange);
          return;
        }
        const row = PromptLibraryRowReadResponseV1Schema.parse((await axios.get(`${url}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, { headers })).data);
        if (row.status !== 'present') throw new Error('Missing rules row');
        const opened = openPromptLibraryContentV1({ key: 'skill-rules', content: row.content, mode: 'plain', material: null });
        if (opened.status !== 'opened' || opened.record.key !== 'skill-rules') throw new Error('Unreadable rules row');
        const rules = [...opened.record.value.rules.filter(rule => rule.skillId !== item.skillId),
          ...applyReachRulesChangeV1(opened.record.value.rules.filter(rule => rule.skillId === item.skillId),
            { kind: 'write', write: { place: loadingAtAdmission
              ? { t: 'machine', machineId: 'machine-1' } : { t: 'allMachines' }, state } },
            { nowMs: Date.now(), newId: () => 'socket-rule' }).map(rule => ({ ...rule, skillId: item.skillId }))];
        const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: row.revision,
          content: sealPromptLibraryContentV1({ record: { ...opened.record, value: { ...opened.record.value, rules } }, mode: 'plain', material: null }) });
        expect(PromptLibraryRowMutationResponseV1Schema.parse((await axios.post(`${url}${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, mutation, { headers })).data))
          .toMatchObject({ status: 'updated' });
        // Replay the recorded vector as well as the current real producer. Their
        // duplicate wakes must join the existing in-flight catalog hydration.
        sockets.to(getAccountStoredContentV3SocketRoom(account.id)).emit('update', recordedAccountChange);
      };
      if (loadingAtAdmission) await writeRuleFromOtherClient('off');
      if (overridden) await harness.session.updateMetadata((metadata: Metadata) => writeSessionCapabilitySelectionToMetadataV1(metadata,
        mcpRules ? { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['rule-mcp'], forceExcludeServerIds: [] } }
          : { skills: { v: 1, forceIncludeSkillIds: [item.skillId], forceExcludeSkillIds: [], excludeNativeSkillNames: [] } }, { sessionActive: false }));
      const selectionKey = mcpRules ? 'mcpSelectionV1' : 'skillSelectionV1';
      const selectionBefore = harness.session.getMetadataSnapshot()?.[selectionKey];
      const agentId = 'acme-rule-reader';
      const fixture = createExternalContributionFixtures(agentId);
      if (!fixture.agent.richDefinition || !runtimeRegistryLease) throw new Error('Missing native Agent boundary');
      const definition = { ...fixture.agent.richDefinition.definition, capabilities: { ...fixture.agent.richDefinition.definition.capabilities,
        ...(mcpRules ? { tools: { delivery: 'native_mcp' as const } } : {}),
        skills: { delivery: 'session_dir' as const, nativeDisable: 'unsupported' as const, liveReload: 'supported' as const } } };
      harness.config.policyAgentId = agentId;
      harness.config.pluginRuntimeRegistryLease = { ...runtimeRegistryLease, registry: { ...runtimeRegistryLease.registry,
        contributes: createResolvedContributionRegistry({ agents: [{ ...fixture.agent,
          richDefinition: { ...fixture.agent.richDefinition, definition }, catalogEntry: createManifestAgentCatalogEntry({
            agentId, pluginId: fixture.agent.pluginId, definition, cli: null, provenance: 'external' }) }] }) } };
      harness.opts.accountSettingsContext = { source: 'network', settings, scopeKey, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null };
      harness.config.startRuntimeBeforeFirstPrompt = true;
      harness.session.hasPendingProviderInput.mockReturnValue(false);
      delete harness.deps.runPermissionModePromptLoopFn;
      const turnReady = createDeferred<void>();
      let awaitingSettlementReady = false;
      // Push/Ready delivery is a genuine outward boundary; keep the real turn settlement.
      const sendReady = harness.deps.sendReadyWithPushNotificationFn;
      harness.deps.sendReadyWithPushNotificationFn = (params: unknown) => {
        sendReady(params);
        if (awaitingSettlementReady) turnReady.resolve();
      };
      let root = '';
      const acknowledged: string[][] = [];
      const restoredAck = createDeferred<void>();
      const refresh = vi.fn(async ({ skills }: Parameters<NonNullable<import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntime['refreshSkills']>>[0]) => {
        const delivery = AgentSessionSkillDeliveryV1Schema.parse(skills);
        acknowledged.push(delivery.items.map(skill => skill.skillId));
        if (delivery.items.some(skill => skill.skillId === item.skillId)) restoredAck.resolve();
        return { kind: 'applied' as const };
      });
      const createRuntime = harness.config.createSessionRuntime!;
      harness.runtime.refreshSkills = refresh;
      if (startupMaintenance) {
        // The production MCP loader admits rows before its source/history
        // maintenance finishes. Fresh startup proceeds with that read in flight.
        await db.userKVStore.create({ data: { accountId: account.id, key: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, version: 1,
          value: new TextEncoder().encode(JSON.stringify(sealMcpServerCatalogContentV1({ mode: 'plain', material: null,
            catalog: emptyMcpServerCatalogV1() }))) } });
        holdMaintenance = true;
        await runWithServerHttpBaseUrl(url, () => refreshActiveMcpServerCatalog({ credentials }));
        await maintenanceRead.promise;
      }
      const startupPrepared = createDeferred<void>();
      setSessionRuntimeFactory(harness.config, async params => {
        root = params.skills?.skillsRoot ?? '';
        if (mcpRules) expect(Object.keys(params.mcpServers ?? {}).filter(name => name !== 'happier')).toEqual(startOff ? [] : ['rule-mcp']);
        if (duringPreparation) {
          try {
            if (!params.resolveFreshSessionSystemPrompt) throw new Error('Missing production startup prompt binding');
            preparationPath = `/v1/artifacts/${startupDocumentId}`;
            const preparation = params.resolveFreshSessionSystemPrompt({ baseOverride: 'FIX20D_STARTUP' });
            // Retain a handler immediately: RED must fail as a startup assertion,
            // not as an unhandled promise while the HTTP boundary is held.
            const prepared = preparation.then(text => ({ text }), error => ({ error }));
            await preparationRead.promise;
            const admittedAccount = getActiveAccountSettingsSnapshot();
            const admittedLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
            const before = refreshAccount.mock.calls.length;
            if (startupMaintenance) {
              const { updateSessionMetadata } = await import('../../../../../../server/sources/app/session/sessionWriteService');
              // The runner's own startup metadata writes publish AccountChange
              // wakes even when Account settings and rules have not changed.
              const written = await updateSessionMetadata({ actorUserId: account.id, sessionId: harness.session.sessionId,
                authentication: { env: process.env, authority: 'present_user', authenticationEvidence: undefined },
                expectedVersion: 0, metadataCiphertext: JSON.stringify({ startedBy: 'daemon', profileId: null }) });
              expect(written).toMatchObject({ ok: true });
              if (!written.ok) throw new Error('Startup metadata publication failed');
              const cursor = written.recipientCursors.find(recipient => recipient.accountId === account.id)?.cursor;
              // Consume the real metadata writer's socket output with the
              // exact Session-client consumer schema, before replaying FIX20C.
              await vi.waitFor(() => expect(wakes.map(wake => UpdateSchema.parse(wake)).some(wake =>
                wake.seq === cursor && wake.body.t === 'account-change')).toBe(true));
            }
            sockets.to(getAccountStoredContentV3SocketRoom(account.id)).emit('update', recordedAccountChange);
            await vi.waitFor(() => expect(refreshAccount.mock.calls.length).toBeGreaterThan(before));
            await Promise.all(refreshAccount.mock.results.slice(before).map(result => result.type === 'return' ? result.value : Promise.reject(result.value)));
            expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog?.status).toBe('ready');
            if (startupMaintenance) {
              holdMaintenance = false;
              releaseMaintenance.resolve();
              await vi.waitFor(() => expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toHaveProperty('cleanup'));
              const current = getActiveAccountSettingsSnapshot();
              expect(current?.settings).toBe(admittedAccount?.settings);
              expect(current?.settingsVersion).toBe(admittedAccount?.settingsVersion);
              expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(admittedLifetime);
              expect(harness.session.getMetadataSnapshot()?.profileId ?? null).toBeNull();
              expect(current?.mcpServerCatalog).not.toBe(admittedAccount?.mcpServerCatalog);
              expect(current).toEqual({ ...admittedAccount, promptLibraryCatalog: current?.promptLibraryCatalog,
                mcpServerCatalog: current?.mcpServerCatalog });
            }
            preparationPath = null;
            releasePreparation.resolve();
            const result = await prepared;
            if ('error' in result) throw result.error;
            expect(result.text).toContain('FIX20D_PREPARED_CONTEXT');
            params.resolveFreshSessionSystemPrompt.assertPreparedPlanCurrent?.();
            const startup = AgentSessionStartupInstructionsV1Schema.parse(params.resolveFreshSessionSystemPrompt.readStartupInstructions?.());
            expect(startup.instructions).toContain('FIX20D_PREPARED_CONTEXT');
            startupPrepared.resolve();
          } catch (error) { startupPrepared.reject(error); throw error; }
        }
        const created = await createRuntime(params);
        // The native factory publishes refreshSkills on operations and does not
        // require a separate nativeRuntime object.
        return operationsOnly ? { ...created, nativeRuntime: undefined } : created;
      });
      if (loadingAtAdmission) {
        // Live Session metadata wakes can leave real catalog hydration in flight
        // at skills admission. The old fixture supplied only an absent catalog.
        holdAdmissionCatalog = true;
        admissionHydration = runWithServerHttpBaseUrl(url, () => refreshActivePromptLibraryCatalog({ credentials }));
        await admissionCatalogRead.promise;
        expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog?.status).toBe('loading');
      }
      if (duringPreparation) harness.queue.push({ text: 'Start and become READY', localId: null }, { permissionMode: 'default' });
      run = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      if (duringPreparation) await startupPrepared.promise;
      await vi.waitFor(() => expect(harness.metrics.onAfterStartCalls).toBeGreaterThan(0));
      if (duringPreparation) await vi.waitFor(() => expect(harness.metrics.defaultReadyCalls).toBeGreaterThan(0));
      if (loadingAtAdmission) {
        releaseAdmissionCatalog.resolve();
        await admissionHydration;
      } else expect(await readFile(join(root, 'rule-sample', 'SKILL.md'), 'utf8')).toContain('Supporting instructions');
      // Native lifecycle events, not a held transport promise, establish the
      // canonical host's active-turn fact. Keep that lifecycle owner real.
      harness.runtime.flushTurn.mockImplementation(async () => {
        harness.runtime.emitRuntimeMessage(AgentSessionRuntimeEventSchema.parse({
          kind: 'turn-start', sequence: 1, sessionId: harness.session.sessionId, turnId: 'rules-turn', emittedAtMs: Date.now(), startedBy: 'host',
        }));
        await settleTurn.promise;
        harness.runtime.emitRuntimeMessage(AgentSessionRuntimeEventSchema.parse({
          kind: 'turn-complete', sequence: 2, sessionId: harness.session.sessionId, turnId: 'rules-turn', emittedAtMs: Date.now(),
        }));
      });
      harness.queue.push({ text: 'Keep this native turn open', localId: null }, { permissionMode: 'default' });
      await vi.waitFor(() => expect(harness.runtime.flushTurn).toHaveBeenCalled());
      await vi.waitFor(() => expect(harness.session.enqueueSessionTurnMutation, JSON.stringify({
        sessionId: harness.session.sessionId, beginCalls: harness.runtime.beginTurn.mock.calls.length,
        subscriptions: harness.runtime.subscribeRuntimeEvents.mock.calls.length,
        emitted: harness.runtime.emitRuntimeMessage.mock.calls.slice(-2),
      })).toHaveBeenCalledWith(expect.objectContaining({ action: 'begin', turnId: 'rules-turn' })));
      const beforeWake = wakes.length;
      await writeRuleFromOtherClient(loadingAtAdmission || startOff ? 'on' : 'off');
      await vi.waitFor(() => expect(wakes.slice(beforeWake)).toContainEqual(recordedAccountChange));
      if (!miswired) {
        await Promise.all(refreshAccount.mock.results.map(result => result.type === 'return' ? result.value : Promise.reject(result.value)));
        if (mcpRules) expect(getActiveAccountSettingsSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', catalog: {
          bindings: [expect.objectContaining({ serverId: 'rule-mcp', enabled: startOff === true })] } });
        const catalog = getActiveAccountSettingsSnapshot()?.promptLibraryCatalog;
        const read = catalog ? readPromptLibraryCatalogRecordV1({ catalog, key: 'skill-rules' }) : null;
        if (!mcpRules) expect(read).toMatchObject({ status: 'ready', record: { value: { rules: expect.arrayContaining([
          expect.objectContaining({ skillId: item.skillId, enabled: loadingAtAdmission === true }),
        ]) } } });
      }
      const row = await app.inject({ method: 'GET', url: `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, headers: { authorization: `Bearer ${credentials.token}` } });
      expect(PromptLibraryRowReadResponseV1Schema.safeParse(row.json()).success).toBe(true);
      const applyNotice = () => {
        const snapshot = harness.session.getMetadataSnapshot();
        const created = createSessionOwnerMetadataV1({ metadata: snapshot });
        if (!created.ok) throw new Error(`Owner metadata rejected: ${created.unsupportedFields.join(', ')}`);
        const metadata = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata: snapshot }),
          ownerMetadata: SessionOwnerMetadataV1Schema.parse(created.ownerMetadata) });
        return sessionCapabilityApplyNotice({ pendingApply: readPendingCapabilityApplyV1(metadata),
          applyTiming: { mcp: { t: 'next_turn' }, skills: { t: 'applied_now' } },
          change: readSessionCapabilityApplyChange(metadata, () => null), machineOnline: true, machineName: 'QA', turnSettled: false });
      };
      if (overridden) expect(applyNotice()).toBeNull();
      else {
        const requirePendingNotice = () => vi.waitFor(() => expect(applyNotice()?.key, JSON.stringify({
          catalog: getActiveAccountSettingsSnapshot()?.promptLibraryCatalog,
          status: harness.session.getMetadataSnapshot()?.capabilitySelectionApplyV1,
          errors: loggerDebugMock.mock.calls.filter(call => /catalog refresh|CapabilitySelection|Prompt library/.test(String(call[0]))).slice(-5),
        })).toBe('pendingNextTurn'));
        if (miswired) await expect(requirePendingNotice()).rejects.toThrow();
        else await requirePendingNotice();
      }
      expect(refresh).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      if (!loadingAtAdmission) expect(await readFile(join(root, 'rule-sample', 'SKILL.md'), 'utf8')).toContain('Supporting instructions');
      awaitingSettlementReady = true;
      settleTurn.resolve();
      await turnReady.promise;
      if (mcpRules) {
        if (overridden || miswired) expect(restart).not.toHaveBeenCalled();
        else {
          expect(restart).toHaveBeenCalledExactlyOnceWith({ sessionId: harness.session.sessionId,
            mode: 'force_current_cli', reason: 'capability_selection_change' });
          expect(readPendingCapabilityApplyV1(harness.session.getMetadataSnapshot()).mcp).toBe(true);
          expect(applyNotice()?.text).toBe('Changes apply at the next turn');
          // Restore the actual launch set before a busy refusal gets another
          // settlement wake. An idle Account write must withdraw the notice.
        }
        await writeRuleFromOtherClient(startOff ? 'off' : 'on');
        if (!miswired) await Promise.all(refreshAccount.mock.results.map(result => result.type === 'return' ? result.value : Promise.reject(result.value)));
        await vi.waitFor(() => expect(applyNotice()).toBeNull());
        if (!overridden && !miswired) expect(restart).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
        expect(harness.session.getMetadataSnapshot()?.[selectionKey]).toEqual(selectionBefore);
        return;
      }
      if (overridden || miswired) {
        expect(refresh).not.toHaveBeenCalled();
        expect(await readFile(join(root, 'rule-sample', 'SKILL.md'), 'utf8')).toContain('Supporting instructions');
      } else {
        expect(acknowledged, JSON.stringify({ agent: readSessionCapabilityAgentFactsV1(harness.session.getMetadataSnapshot()),
          status: harness.session.getMetadataSnapshot()?.capabilitySelectionApplyV1,
          errors: loggerDebugMock.mock.calls.filter(call => String(call[0]).includes('[CapabilitySelection]')).slice(-3) })).toHaveLength(1);
        if (loadingAtAdmission) expect(acknowledged[0]).toContain(item.skillId);
        else expect(acknowledged[0]).not.toContain(item.skillId);
        expect(applyNotice()).toBeNull();
        if (loadingAtAdmission) expect(await readFile(join(root, 'rule-sample', 'SKILL.md'), 'utf8')).toContain('Supporting instructions');
        else await expect(access(join(root, 'rule-sample'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      // A second remote write while idle must wake the incumbent Account subscription;
      // no new turn or Session metadata edit may provide the wake.
      await writeRuleFromOtherClient(loadingAtAdmission ? 'off' : 'on');
      if (!overridden) {
        const requireIdleAcknowledgement = () => vi.waitFor(() => expect(acknowledged).toHaveLength(2));
        if (miswired) await expect(requireIdleAcknowledgement()).rejects.toThrow();
        else {
          if (loadingAtAdmission) await requireIdleAcknowledgement();
          else await restoredAck.promise;
          expect(acknowledged).toHaveLength(2);
          if (loadingAtAdmission) expect(acknowledged[1]).not.toContain(item.skillId);
          else expect(acknowledged[1]).toContain(item.skillId);
        }
      }
      if (!harness.metrics.killHandler) throw new Error('Missing registered Session termination boundary');
      await harness.metrics.killHandler(); await run; run = null;
      if (overridden) expect(refresh).not.toHaveBeenCalled();
      if (!loadingAtAdmission) expect(await readFile(join(root, 'rule-sample', 'SKILL.md'), 'utf8')).toContain('Supporting instructions');
      expect(harness.session.getMetadataSnapshot()?.[selectionKey]).toEqual(selectionBefore);
    } finally {
      releaseAdmissionCatalog.resolve();
      await admissionHydration;
      try {
        preparationPath = null; releasePreparation.resolve();
        holdMaintenance = false; releaseMaintenance.resolve();
        settleTurn.resolve();
        if (run) { await harness.metrics.killHandler?.(); harness.queue.close(); await run; }
      } finally {
        restoreAccountRefresh(); await networkClient?.close(); readCredentials.mockRestore();
        ensure.mockRestore(); restart.mockRestore(); observer.close(); eventRouter.clearIo(); await new Promise<void>(resolve => sockets.close(() => resolve()));
        resetActiveAccountSettingsSnapshotForTests(); releaseHome(); await app.close();
        await store.releaseSkillSessionDirs('session-1'); await store.collectSkillCache({ libraryDigests: [] }); await sqlite.close();
        exitSpy.mockRestore(); rootScope.restore();
      }
    }
  }, 180_000);

  it.each(['create', 'resume', 'daemon-unreachable', 'launch-unsupported', 'session-scoped'] as const)(
    'resolves Account skill delivery at the real host owner for %s', async scenario => {
      const harness = createHarness('session-1', { credentials: {
        token: `header.${Buffer.from(JSON.stringify({ sub: 'skills-account' })).toString('base64url')}.signature`, encryption: null,
      } });
      const agentId = 'acme-skills-reader';
      const fixture = createExternalContributionFixtures(agentId);
      if (!fixture.agent.richDefinition || !runtimeRegistryLease) throw new Error('Missing runtime fixture');
      const definition = { ...fixture.agent.richDefinition.definition, capabilities: {
        ...fixture.agent.richDefinition.definition.capabilities,
        skills: { delivery: 'session_dir' as const, nativeDisable: 'unsupported' as const, liveReload: 'unsupported' as const },
      } };
      const catalogEntry = createManifestAgentCatalogEntry({ agentId, pluginId: fixture.agent.pluginId,
        definition, cli: null, provenance: 'external' });
      harness.config.policyAgentId = agentId;
      harness.config.pluginRuntimeRegistryLease = { ...runtimeRegistryLease, registry: {
        ...runtimeRegistryLease.registry, contributes: createResolvedContributionRegistry({ agents: [{
          ...fixture.agent, richDefinition: { ...fixture.agent.richDefinition, definition }, catalogEntry,
        }] }),
      } };
      if (scenario === 'resume') harness.opts.resume = 'vendor-skills-session';
      if (scenario === 'session-scoped') harness.config.runtimeAuthority = {
        scope: 'session', sessionCredentials: harness.opts.credentials, accountCredentials: null,
      };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(harness.opts.credentials),
        promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [{
          id: 'everywhere', skillId: 'library-skills', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1,
        }] } } }], tombstones: [], diagnostics: [] },
      });
      const body = JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
        { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: host-skill\ndescription: Host fixture\n---\nPrivate skill body').toString('base64') },
        { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from('Supporting file').toString('base64') },
      ] });
      const row = { id: 'library-skills', ownerAccountId: 'skills-account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' }),
        body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      // Account/Artifact HTTP and daemon control are external boundaries; selection, scan and resolution stay real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data:
        new URL(String(url)).pathname === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 1 }
          : new URL(String(url)).pathname === '/v1/artifacts' ? [row]
          : new URL(String(url)).pathname === '/v1/artifacts/library-skills' ? row : {} }));
      const ensured: Parameters<typeof daemonControl.ensureSkillSessionDirHttp>[0][] = [];
      const ensure = vi.spyOn(daemonControl, 'ensureSkillSessionDirHttp').mockImplementation(async input => {
        ensured.push(input);
        if (scenario === 'daemon-unreachable') throw new Error('daemon_unreachable');
        return { pluginRoot: `/skills/${input.ownerKey}`, skillsRoot: `/skills/${input.ownerKey}/skills`, failed: [],
          items: input.items.map(({ skillId, name, digest, sourceFolderName }) => ({ skillId, name, digest,
            directory: `/skills/${input.ownerKey}/skills/${sourceFolderName ?? name}` })) };
      });
      let skills: unknown;
      const createRuntime = harness.config.createSessionRuntime!;
      setSessionRuntimeFactory(harness.config, async params => {
        skills = params.skills;
        return { ...await createRuntime(params), ...(scenario === 'launch-unsupported' ? { skillsDelivered: false } : {}) };
      });
      try {
        await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
        expect(harness.metrics.cleanupCalls).toBe(1);
        if (scenario === 'session-scoped') {
          expect(skills).toBeUndefined(); expect(ensured).toEqual([]); expect(get).not.toHaveBeenCalled();
        } else if (scenario === 'daemon-unreachable') {
          expect(skills).toBeUndefined();
          expect(harness.session.enqueueSessionEventCommitted).toHaveBeenCalledWith(expect.objectContaining({
            capabilityNoticeV1: { v: 1, items: expect.arrayContaining([expect.objectContaining({ kind: 'skill', code: 'skills_unavailable' })]) },
          }));
        } else {
          expect(skills).toMatchObject({ pluginRoot: '/skills/session-1', items: [{ name: 'host-skill', skillId: 'library-skills' }] });
          expect(ensured[0]?.items[0]?.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'references/note.md' })]));
          if (scenario === 'launch-unsupported') expect(harness.session.enqueueSessionEventCommitted).toHaveBeenCalledWith(expect.objectContaining({
            capabilityNoticeV1: { v: 1, items: expect.arrayContaining([expect.objectContaining({ kind: 'skill', code: 'skills_unavailable' })]) },
          }));
        }
      } finally { get.mockRestore(); ensure.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
    },
  );

  it.each(['ordinary', 'deferred', 'session-scoped'] as const)('reads manual-start tool policy only with Account authority through a %s push-only loop port', async (startup) => {
    const harness = createHarness('session-1', { credentials: {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'manual-policy-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    harness.opts.startedBy = 'terminal';
    let inheritedTimeout: string | undefined;
    const startupHookFailure = new Error('Startup contribution stopped before Agent admission');
    const stopAtStartupContribution = async () => {
      inheritedTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
      throw startupHookFailure;
    };
    if (startup === 'session-scoped') {
      harness.config.runtimeAuthority = {
        scope: 'session', sessionCredentials: { token: 'runner-session-token', encryption: null }, accountCredentials: null,
      };
    }
    if (startup === 'deferred') {
      harness.config.createSessionRuntime = async () => { await stopAtStartupContribution(); throw startupHookFailure; };
      harness.config.startupBootstrap = {
        create: async () => ({
          api: { push: () => null },
          session: harness.session,
          machineId: 'machine-1',
          metadata: createTestMetadata({ path: '/tmp/workspace' }),
          attachedToExistingSession: false,
          reconnectionHandle: null,
          // Real deferred startup attaches a Session and calls prepareSession;
          // Agent admission follows Session attachment and policy preparation.
          start: async options => { await options?.prepareSession?.(harness.session); },
        }),
      };
    }
    const scope = createEnvKeyScope(['AGENT_BROWSER_IDLE_TIMEOUT_MS', 'HAPPIER_PROCESS_OWNER']);
    scope.patch({ AGENT_BROWSER_IDLE_TIMEOUT_MS: undefined });
    const requests: string[] = [];
    const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, processes: { toolIdleCloseMs: 1250 } });
    const codec = createMachineContentCodec({ encryptionMode: 'plain' });
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption') {
        response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
      } else if (request.url === '/v1/machines/machine-1') {
        response.end(JSON.stringify({ machine: {
          id: 'machine-1', storageMode: 'plain', dataEncryptionKey: null,
          metadata: codec.encodeStored({ ...harness.config.machineMetadata, resourcesPolicyV1: policy }),
          metadataVersion: 7, daemonState: null, daemonStateVersion: 0,
        } }));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Machine fixture did not bind');
      // The Session transport captures this endpoint when constructed in production.
      vi.spyOn(harness.session, 'getServerBinding').mockReturnValue({
        ...harness.session.getServerBinding(), serverUrl: `http://127.0.0.1:${address.port}`,
      });
      harness.config.lifecycleHooks = {
        ...harness.config.lifecycleHooks,
        onSessionInitialized: stopAtStartupContribution,
      };
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () =>
        runHostSessionRuntime(harness.opts, harness.config, harness.deps))).rejects.toBe(startupHookFailure);
      expect(inheritedTimeout).toBe(startup === 'session-scoped' ? undefined : '1250');
      expect(requests).toEqual(startup === 'session-scoped' ? [] : ['/v1/account/encryption', '/v1/machines/machine-1']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      scope.restore();
    }
  });

  it('starts an Account-scoped queued prompt with the canonical Agent identity at the daemon auth boundary', async () => {
    const harness = createHarness('session-1', { credentials: {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'queued-workflow-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    // The server queue is materialized, while this exact input retains provider custody.
    harness.session.hasPendingProviderInput = vi.fn((localId?: string) => localId === 'queued-workflow-input');
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
    harness.session.enqueueSessionEventCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    harness.session.getCommittedUserMessageSeq = (localId: string) => localId === 'queued-workflow-input' ? 1 : null;
    let userMessageHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: typeof userMessageHandler) => { userMessageHandler = handler; };
    delete harness.deps.createPermissionModeQueueStateFn;
    delete harness.deps.createSessionMetadataFn;
    delete harness.deps.createProviderEnforcedPermissionHandlerFn;
    delete harness.deps.registerKillSessionHandlerFn;
    delete harness.deps.sendReadyWithPushNotificationFn;
    delete harness.deps.cleanupBackendRunResourcesFn;
    harness.runtime.openedWithoutConnectedServices = () => true;
    // The provider boundary exposes a normalized lifecycle facade, not a receiver-bound method.
    harness.runtime.resetOrDisposeRuntime = async () => { await harness.runtime.reset(); };
    harness.runtime.beginTurnLifecycle = () => { harness.runtime.beginTurn(); };
    harness.runtime.waitForTurnCompletion = async () => { await harness.runtime.flushTurn(); };
    harness.runtime.readSessionIdentity = () => ({ sessionId: null });
    harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied' });
    let providerOutcome: ((outcome: HostProviderInputOutcomeEvidence) => void) | null = null;
    harness.runtime.setOnPromptDeliveryOutcome = (handler: typeof providerOutcome) => { providerOutcome = handler; };
    const prompts: string[] = [];
    let parentRegistrationPending = false;
    let deliveredWhileParentRegistrationPending = false;
    const registrationResponse = createDeferred<void>();
    const registrationReceived = createDeferred<void>();
    const registrationClosed = createDeferred<void>();
    let registrationClosedBeforeResponse = false;
    let registrationReceivedAt = 0;
    let dispatchedAt = 0;
    harness.runtime.sendTurnPrompt = async (prompt: string, meta?: { localId?: string }) => {
      dispatchedAt = performance.now();
      deliveredWhileParentRegistrationPending = parentRegistrationPending;
      prompts.push(prompt);
      if (!meta?.localId) throw new Error('Expected the original queued input identity');
      providerOutcome?.({ type: 'input-accepted', localInputId: meta.localId, userMessageSeq: 1,
        delivery: { kind: 'newTurn', turnId: 'queued-workflow-turn' } });
    };
    let completed = false;
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      await registrationReceived.promise;
      if (!userMessageHandler) throw new Error('Expected the real Session queue callback');
      userMessageHandler({ role: 'user', content: { type: 'text', text: 'Reply exactly QA_FIN21_REPLY.' },
        localId: 'queued-workflow-input', meta: {} });
      await runPermissionModePromptLoop({ ...params, shouldExit: () => completed, sendReady: () => { params.sendReady(); completed = true; } });
    };
    const home = await mkdtemp(join(tmpdir(), 'queued-workflow-startup-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const authRequests: unknown[] = [];
    // Reuse the Session/process bootstrap boundary fixture. Account scope,
    // metadata, permissions, queue binding, input custody and prompt loop stay real.
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if (request.url === CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH) {
          const parsed: unknown = JSON.parse(body);
          authRequests.push(parsed);
          response.statusCode = ConnectedServiceAppliedParentSelectionRequestSchema.safeParse(parsed).success ? 200 : 400;
          parentRegistrationPending = true;
          registrationReceivedAt = performance.now();
          registrationReceived.resolve();
          response.on('close', () => {
            registrationClosedBeforeResponse = parentRegistrationPending;
            registrationClosed.resolve();
          });
          // Hold the HTTP response through prompt dispatch and Session close.
          // The fixture release lets the old serial path finish cleanly.
          const release = setTimeout(() => registrationResponse.resolve(), 2_000);
          void registrationResponse.promise.then(() => {
            clearTimeout(release);
            parentRegistrationPending = false;
            response.end(JSON.stringify({ status: 'unavailable' }));
          });
        } else response.end(JSON.stringify({ success: true }));
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected daemon listener');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'test-token' });
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await registrationClosed.promise;
      expect(authRequests).toEqual([expect.objectContaining({ agentId: harness.config.policyAgentId,
        sessionId: harness.session.sessionId, runnerPid: process.pid, initialEmpty: true })]);
      // The real prompt owner prepends Agent instructions; the original user input remains one intact delivery.
      expect(prompts).toEqual([expect.stringMatching(/(?:^|\n\n)Reply exactly QA_FIN21_REPLY\.$/)]);
      expect(completed).toBe(true);
      console.info('[r9-latency] parent registration → prompt dispatch', {
        durationMs: Math.round(dispatchedAt - registrationReceivedAt),
        registrationPending: deliveredWhileParentRegistrationPending,
      });
      expect(deliveredWhileParentRegistrationPending).toBe(true);
      expect(registrationClosedBeforeResponse).toBe(true);
      expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'accepted', localId: 'queued-workflow-input', userMessageSeq: 1,
        providerTurnId: 'queued-workflow-turn', providerDeliveryKind: 'newTurn',
      }));
    } finally {
      registrationResponse.resolve();
      await clearDaemonStateForTestTeardown();
      envScope.restore();
      reloadConfiguration();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    { backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, viaGateway: false },
    { backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, viaGateway: false },
    { backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, viaGateway: true },
  ] satisfies ReadonlyArray<{ backendTarget: BackendTargetRefV2Input; viaGateway: boolean }>)('inherits actual readback through the attached child factory (Gateway: $viaGateway, target: $backendTarget.kind)', async ({ backendTarget, viaGateway }) => {
    const harness = createHarness('session-1', { credentials: {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'attached-parent-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = backendTarget;
    harness.opts.modelSelection = { v: 1, updatedAt: 1, ref: {
      agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: null, modelId: 'default',
    } };
    if (viaGateway) {
      if (!runtimeRegistryLease) throw new Error('Missing runtime fixture');
      const support = readLeasedAgentProviderRequirements({ lease: runtimeRegistryLease, agentId: 'codex' });
      if (!support) throw new Error('Missing Codex Provider support');
      const initialHandoff = lateExternalProviderBindingHandoff({ connectionId: 'pc_gateway', modelId: 'parent-model',
        agentTargetKey: buildBackendTargetKeyV2(backendTarget) });
      const handoff = { ...initialHandoff, sessionBindingMetadata: { ...initialHandoff.sessionBindingMetadata,
        runtimeBindingBasis: { ...initialHandoff.sessionBindingMetadata.runtimeBindingBasis,
          agentSupport: support } } };
      harness.opts.modelSelection = { v: 1, updatedAt: 1, ref: {
        agentTargetKey: handoff.sessionBindingMetadata.runtimeBindingBasis.agentTargetKey,
        providerConnectionId: handoff.sessionBindingMetadata.connectionId, modelId: 'parent-model',
      } };
      harness.config.providerBindingAdmission = 'runtime';
      harness.config.createSessionRuntime = () => ({ operations: harness.runtime, nativeRuntime: harness.runtime,
        admittedProviderBindingHandoff: handoff });
      const authorizeProviderTarget: SessionModelTransitionProviderTargetAuthorizer = async input => ({
        selection: input.selection, policy: support.applyPolicy,
        model: { id: input.selection.modelId, name: input.selection.modelId },
        sessionBindingMetadata: { ...handoff.sessionBindingMetadata,
          model: { id: input.selection.modelId, name: input.selection.modelId } },
        runtimeBindingBasis: handoff.sessionBindingMetadata.runtimeBindingBasis,
      });
      // This is the runner → daemon authorization boundary. Runtime coordination,
      // metadata publication, installed Session controls and Run admission stay real.
      harness.deps.daemonModelTransitionAuthorizer = authorizeProviderTarget;
    }
    let modelSnapshot = { currentModelId: 'parent-model', models: [{ id: 'parent-model', name: 'Actual parent model' }] };
    const modelListeners = new Set<(snapshot: typeof modelSnapshot) => void>();
    harness.runtime.models = { read: () => modelSnapshot, subscribe: listener => {
      modelListeners.add(listener); listener(modelSnapshot); return { dispose: () => modelListeners.delete(listener) };
    } };
    // Real queue and model-transition owner; only Session/native Agent and daemon HTTP are boundaries.
    delete harness.deps.createPermissionModeQueueStateFn;
    harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied' });
    harness.runtime.resetOrDisposeRuntime = async () => { await harness.runtime.reset(); };
    harness.runtime.readSessionIdentity = () => ({ sessionId: null });
    let appliedIdentityReady = false;
    harness.runtime.readAppliedTeamCredentialModel = () => appliedIdentityReady ? null : undefined;
    harness.runtime.openedWithoutConnectedServices = () => true;
    let registrationComplete = false;
    let daemonSelectionReady = false;
    let authAppliedAfterRegistration = false;
    harness.runtime.runtimeAuth = {
      apply: async () => {
        authAppliedAfterRegistration = registrationComplete;
        return { ok: true, appliedVia: 'direct_live_hot_auth' };
      },
      readIdentity: async () => ({ ok: false, error: 'unavailable' }),
    };
    let controls: SessionRuntimeControls | null = null;
    harness.session.setSessionRuntimeControls = (next: SessionRuntimeControls | null) => { controls = next; };
    const diagnostics = vi.spyOn(logger, 'infoFile');
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(registrationComplete).toBe(false);
      if (!controls?.readAppliedChildSelection) throw new Error('Attached parent reader was not installed');
      if (!viaGateway) {
        expect(await controls.readAppliedChildSelection()).toEqual({ status: 'unavailable' });
        expect(diagnostics).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          reason: 'native_applied_selection_unavailable',
        }));
      }
      appliedIdentityReady = true;
      if (!viaGateway) {
        expect(await controls.readAppliedChildSelection()).toEqual({ status: 'unavailable' });
        expect(diagnostics).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          reason: 'connected_services_unavailable',
        }));
      }
      daemonSelectionReady = true;
      const authApply = controls.applyConnectedServiceAuthGeneration?.({
        serviceId: 'openai-codex', reason: 'manual', authGeneration: { credential: { kind: 'oauth' } },
      });
      const parent = await controls.readAppliedChildSelection();
      await authApply;
      expect(authAppliedAfterRegistration).toBe(true);
      if (!viaGateway) {
        expect(parent).toMatchObject({ status: 'applied', backendTarget, modelId: 'parent-model' });
        const child = resolveExecutionRunChildSelection({ backendTarget, lifecycle: 'attached', parent });
        expect(child).toMatchObject({ selectionSource: 'inherited', inheritedFromDifferentAgent: false,
          modelId: 'parent-model', connectedServices: { v: 2, bindingsByServiceId: {} } });
      }
      const nextSelection = { ...harness.opts.modelSelection!.ref, modelId: 'next-model' };
      harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied', timing: 'before_next_prompt' });
      await harness.handlers.get(SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION)?.({ v: 1, selection: nextSelection });
      if (!viaGateway) await vi.waitFor(async () => expect(await controls!.readAppliedChildSelection!()).toMatchObject({ status: 'applied', modelId: 'parent-model' }));
      const runs = new Map<string, ExecutionRunState>();
      const controllers = new Map<string, ExecutionRunController>();
      const createRuntime = () => createTestExecutionRunHostRuntime();
      const voiceAgentManager = new VoiceAgentManager({ createRuntime });
      const previousAccountSnapshot = getActiveAccountSettingsSnapshot();
      try {
        const accountSettings = accountSettingsParse({ ...previousAccountSnapshot?.settings, providerDefaultModelSelectionsByAgentTargetKeyV1: {
          [buildBackendTargetKeyV2(backendTarget)]: { v: 1, updatedAt: 3, ref: {
            ...harness.opts.modelSelection!.ref, providerConnectionId: null, modelId: 'account-default-z',
          } },
        } });
        setActiveAccountSettingsSnapshot({ ...previousAccountSnapshot, source: 'network', settings: accountSettings,
          rawSettings: accountSettings, settingsVersion: (previousAccountSnapshot?.settingsVersion ?? 0) + 1,
          loadedAtMs: 3, settingsSecretsReadKeys: [],
          scopeKey: previousAccountSnapshot?.scopeKey ?? resolveAccountSettingsScopeKey(harness.opts.credentials) });
        const started = await startExecutionRun({
          params: { sessionId: harness.session.sessionId, intent: 'delegate', backendTarget, accountSettings,
            permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' },
          childSelectionContext: { lifecycle: 'attached', readAppliedParentSelection: controls.readAppliedChildSelection },
          parentProvider: 'codex', sendAcp: async () => {}, streamedTranscriptSession: null,
          createRuntime, getNowMs: () => 1, budgetRegistry: null, runs, controllers,
          enqueueMarkerWrite: async () => {}, writeActivityMarker: async () => {}, finishRun: async () => {},
          executeBoundedRun: async () => {}, send: async () => ({ ok: true }), voiceAgentManager,
        });
        expect(started.resolvedSelection).toMatchObject({ source: 'inherited', modelId: 'parent-model',
          modelSelection: { ...harness.opts.modelSelection!.ref, modelId: 'parent-model' } });
        const controller = controllers.get(started.runId);
        if (controller?.kind !== 'backend') throw new Error('Child backend was not provisioned');
        await controller.provisioningPromise;
        const publications = harness.session.updateMetadataAsCurrentPublisher.mock.calls.length;
        for (let read = 0; read < 5; read++) {
          expect(await controls.readAppliedChildSelection()).toMatchObject({ status: 'applied', modelId: 'parent-model' });
        }
        expect(harness.session.updateMetadataAsCurrentPublisher.mock.calls).toHaveLength(publications);
      } finally {
        await Promise.all([...controllers.values()].flatMap(controller => controller.kind === 'backend'
          ? [controller.backend.dispose()] : []));
        await voiceAgentManager.dispose();
        if (previousAccountSnapshot) setActiveAccountSettingsSnapshot(previousAccountSnapshot);
        else resetActiveAccountSettingsSnapshotForTests();
      }
      if (viaGateway) return;
      modelSnapshot = { currentModelId: 'next-model', models: [{ id: 'next-model', name: 'Actual next model' }] };
      for (const listener of modelListeners) listener(modelSnapshot);
      await vi.waitFor(async () => expect(await controls!.readAppliedChildSelection!()).toMatchObject({ status: 'applied', modelId: 'next-model' }));
    };
    const home = await mkdtemp(join(tmpdir(), 'attached-parent-selection-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if (request.url === CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH) {
          const selection = ConnectedServiceAppliedParentSelectionRequestSchema.parse(JSON.parse(body));
          if (selection.initialEmpty) {
            setTimeout(() => {
              registrationComplete = true;
              response.end(JSON.stringify({ status: 'applied', connectedServices: { v: 2, bindingsByServiceId: {} } }));
            }, 2_000);
          } else {
            // An ordinary inheritance read before registration has no applied
            // authority, even though the parent's first prompt can proceed.
            response.end(JSON.stringify(registrationComplete && daemonSelectionReady
              ? { status: 'applied', connectedServices: { v: 2, bindingsByServiceId: {} } }
              : { status: 'unavailable' }));
          }
        } else response.end(JSON.stringify({ success: true }));
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Daemon boundary did not bind');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'test-token' });
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      diagnostics.mockRestore();
      await clearDaemonStateForTestTeardown();
      envScope.restore();
      reloadConfiguration();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it('cancels an attached parent selection read when its Session retires', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = { v: 1, updatedAt: 1, ref: {
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'qwen' }),
      providerConnectionId: null, modelId: 'parent-model',
    } };
    // Reach the pending daemon read with an actually observed parent model.
    // Startup configuration alone must not supply applied-selection proof.
    const modelSnapshot = { currentModelId: 'parent-model', models: [{ id: 'parent-model', name: 'Parent model' }] };
    harness.runtime.models = { read: () => modelSnapshot, subscribe: listener => {
      listener(modelSnapshot); return { dispose() {} };
    } };
    harness.runtime.readAppliedTeamCredentialModel = () => null;
    harness.runtime.openedWithoutConnectedServices = () => false;
    let controls: SessionRuntimeControls | null = null;
    harness.session.setSessionRuntimeControls = next => { controls = next; };
    const received = createDeferred<void>();
    const closed = createDeferred<void>();
    let parentRead: ReturnType<NonNullable<SessionRuntimeControls['readAppliedChildSelection']>> | undefined;
    let replied = false;
    let closedBeforeReply = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    harness.deps.runPermissionModePromptLoopFn = async () => {
      if (!controls?.readAppliedChildSelection) throw new Error('Attached parent reader missing');
      parentRead = controls.readAppliedChildSelection();
      // Observe later retirement rejection while retaining the original promise for the assertion.
      void parentRead.catch(() => undefined);
      await Promise.race([
        received.promise,
        parentRead.then(selection => {
          throw new Error(`Parent read settled before reaching the daemon boundary: ${JSON.stringify(selection)}`);
        }),
      ]);
    };
    const server = createServer((request, response) => {
      request.resume();
      response.setHeader('content-type', 'application/json');
      if (request.url !== CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH) {
        response.end(JSON.stringify({ success: true }));
        return;
      }
      response.on('close', () => { closedBeforeReply = !replied; closed.resolve(); });
      received.resolve();
      // Release the wrong uncancelled path so RED can finish without a leaked waiter.
      release = setTimeout(() => {
        replied = true;
        response.end(JSON.stringify({ status: 'applied', connectedServices: { v: 2, bindingsByServiceId: {} } }));
      }, 2_000);
    });
    const home = await mkdtemp(join(tmpdir(), 'attached-parent-cancellation-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Daemon boundary did not bind');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'test-token' });
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await closed.promise;
      expect(closedBeforeReply).toBe(true);
      await expect(parentRead).resolves.toEqual({ status: 'unavailable' });
    } finally {
      if (release) clearTimeout(release);
      server.closeAllConnections();
      await clearDaemonStateForTestTeardown();
      envScope.restore();
      reloadConfiguration();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it('completes a fresh Workflow Agent step through real spawn, Session runtime and exact input observation', async () => {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'composed-workflow-account' })).toString('base64url')}.signature`, encryption: null };
    const harness = createHarness('session-1', { credentials });
    harness.session.sessionId = 'workflow-composed-session';
    harness.config.policyAgentId = 'claude';
    const directory = await mkdtemp(join(tmpdir(), 'workflow-runtime-composition-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const input = createDeferred<import('@/api/types').UserMessage>();
    const loopReady = createDeferred<void>();
    let runtimeRun: Promise<void> | null = null;
    let inputLocalId: string | null = null;
    let metadata = createTestMetadata({ path: directory, machineId: 'machine-1', permissionMode: 'default', flavor: 'claude' });
    let userHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
    let completed = false;
    const prompts: string[] = [];
    const transcript: { id: string; seq: number; localId: string | null; createdAt: number; updatedAt: number; content: { t: 'plain'; v: unknown } }[] = [];
    const authRequests: unknown[] = [];
    const unexpectedRequests: string[] = [];
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.hasPendingProviderInput = (localId?: string) => localId !== undefined && localId === inputLocalId;
    harness.session.getCommittedUserMessageSeq = (localId: string) => localId === inputLocalId ? 1 : null;
    harness.session.onUserMessage = (handler: typeof userHandler) => { userHandler = handler; };
    harness.session.enqueueAgentMessageCommitted = async (_agent: unknown, body: unknown) => {
      transcript.push({ id: `output-${transcript.length}`, seq: transcript.length + 1, localId: null,
        createdAt: Date.now(), updatedAt: Date.now(), content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', data: body } } } });
      return { persisted: true, delivered: true };
    };
    harness.session.enqueueSessionEventCommitted = async (event: unknown) => {
      transcript.push({ id: `event-${transcript.length}`, seq: transcript.length + 1, localId: null,
        createdAt: Date.now(), updatedAt: Date.now(), content: { t: 'plain', v: { role: 'event', content: { type: 'event', data: event } } } });
      return { persisted: true, delivered: true };
    };
    for (const key of ['createPermissionModeQueueStateFn', 'createSessionMetadataFn', 'createProviderEnforcedPermissionHandlerFn',
      'registerKillSessionHandlerFn', 'sendReadyWithPushNotificationFn', 'cleanupBackendRunResourcesFn']) delete harness.deps[key];
    // Only process bootstrap and the native Agent are substituted. Queue,
    // permissions, spawn normalization, input admission and observation stay real.
    harness.deps.initializeBackendRunSessionFn = async (params: InitializeBackendRunSessionOptions) => {
      metadata = params.metadata;
      return { session: harness.session, reconnectionHandle: null, reportedSessionId: harness.session.sessionId, attachedToExistingSession: false };
    };
    harness.runtime.openedWithoutConnectedServices = () => true;
    harness.runtime.resetOrDisposeRuntime = async () => { await harness.runtime.reset(); };
    harness.runtime.beginTurnLifecycle = () => { harness.runtime.beginTurn(); };
    harness.runtime.waitForTurnCompletion = async () => { await harness.runtime.flushTurn(); };
    harness.runtime.readSessionIdentity = () => ({ sessionId: null });
    harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied' });
    let providerOutcome: ((outcome: HostProviderInputOutcomeEvidence) => void) | null = null;
    harness.runtime.setOnPromptDeliveryOutcome = (handler: typeof providerOutcome) => { providerOutcome = handler; };
    harness.runtime.sendTurnPrompt = async (prompt: string, meta?: { localId?: string }) => {
      if (!meta?.localId || meta.localId !== inputLocalId) throw new Error('Lost Workflow input correspondence');
      prompts.push(prompt);
      providerOutcome?.({ type: 'input-accepted', localInputId: meta.localId, userMessageSeq: 1,
        delivery: { kind: 'newTurn', turnId: 'workflow-composed-turn' } });
      const base = { sessionId: harness.session.sessionId, emittedAtMs: Date.now() };
      harness.runtime.emitRuntimeMessage({ ...base, kind: 'transcript-message-committed', sequence: 1,
        messageId: 'workflow-answer', role: 'assistant', text: 'QA_FIN21_REPLY' });
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      loopReady.resolve();
      const message = await input.promise;
      if (!userHandler) throw new Error('Missing real Session queue callback');
      userHandler(message);
      await runPermissionModePromptLoop({ ...params, shouldExit: () => completed, sendReady: () => { params.sendReady(); completed = true; } });
    };
    const rawSession = () => createSessionRecordFixture({ id: harness.session.sessionId, active: true, encryptionMode: 'plain',
      machineId: 'machine-1', metadata: JSON.stringify(metadata) });
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body += chunk; });
      request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        response.setHeader('content-type', 'application/json');
        let data: unknown;
        if (path === CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH) {
          data = JSON.parse(body);
          authRequests.push(data);
          response.statusCode = ConnectedServiceAppliedParentSelectionRequestSchema.safeParse(data).success ? 200 : 400;
          data = { status: 'unavailable' };
        } else if (path === '/v1/account/encryption/currentness') data = { mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } };
        else if (path === '/v1/account/encryption') data = { mode: 'plain', updatedAt: 1 };
        else if (path === '/v1/machines/machine-1') data = { machine: {
          id: 'machine-1', kind: 'persistent', storageMode: 'plain',
          dataEncryptionKey: Buffer.from(JSON.stringify({ t: 'plain', v: null })).toString('base64'),
        } };
        else if (path === '/v2/sessions/lookup-by-tags') data = { sessions: [] };
        else if (path === `/v2/sessions/${harness.session.sessionId}`) data = { session: rawSession() };
        else if (path.includes('/messages/by-local-id/')) {
          const requestedLocalId = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
          const message = transcript.find(row => row.localId === requestedLocalId);
          if (!message) { response.statusCode = 404; data = { error: 'Message not found' }; }
          else data = { message };
        }
        else if (path === `/v1/sessions/${harness.session.sessionId}/messages`) data = { messages: transcript };
        else if (path === '/v1/account/settings') data = { settings: null, settingsVersion: 0 };
        else if (path === '/session-activity-changed') data = { success: true };
        // This transport fixture supplies exact HTTP facts, not a socket server
        // or a parent Run store. Optional invalidation/origin reads are unavailable.
        else if (path === '/v1/updates/' || path === '/v3/automations/runs/workflow-storage') {
          response.statusCode = 404; data = { error: 'Not found' };
        }
        else if (path.startsWith('/session/')) data = { success: true };
        else { unexpectedRequests.push(`${request.method} ${path}`); response.statusCode = 404; data = { error: 'Not found' }; }
        response.end(JSON.stringify(data));
      });
    });
    const privateHandlers = new Map<string, RpcHandler>();
    registerPrivateSpawnSessionRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => { privateHandlers.set(method, handler); } },
      spawnLifecycleHandler: createSpawnNewSessionLifecycleActionHandler({ spawnSession: async options => {
        Object.assign(harness.opts, options);
        runtimeRun = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
        // Process readiness is observed, not fabricated before host startup.
        await Promise.race([loopReady.promise, runtimeRun.then(() => { throw new Error('Runtime exited before readiness'); })]);
        return { type: 'success', sessionId: harness.session.sessionId,
          sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
      } }) });
    const rpc = vi.spyOn(machineRpcTransport, 'callMachineRpc').mockImplementation(async ({ method, request }) => {
      const handler = privateHandlers.get(method);
      if (!handler) throw new Error(`Unexpected Machine transport ${method}`);
      return handler(request);
    });
    // The external Home enrollment carrier is not needed to exercise creation.
    const auth = vi.spyOn(storedAuthTransport, 'validateStoredAuthTokenAgainstActiveServer').mockResolvedValue({ state: 'valid', httpStatus: 200 });
    const admission: NonNullable<Parameters<typeof createProductionFreshWorkflowSessionConversation>[0]['machineAdmissionTransport']> = async request => {
      if (request.content.t !== 'plain') throw new Error('Expected plain Account input');
      inputLocalId = request.localId;
      const message = { ...UserMessageSchema.parse(request.content.v), localId: request.localId };
      transcript.push({ id: 'workflow-input', seq: 1, localId: request.localId, createdAt: Date.now(), updatedAt: Date.now(), content: request.content });
      input.resolve(message);
      if (!runtimeRun) throw new Error('Input admitted without a spawned runtime');
      await runtimeRun;
      return { status: 'accepted', localId: request.localId };
    };
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
      envScope.patch({ HAPPIER_HOME_DIR: directory });
      reloadConfiguration();
      writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test-token' });
      const createFreshConversation = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1',
        machineId: 'machine-1', workDepth: 0, originRunId: 'workflow-composed-run', machineAdmissionTransport: admission });
      const execute = createProductionWorkflowSessionStepExecutor({ credentials, machineId: 'machine-1', workDepth: 0, machineAdmissionTransport: admission,
        createFreshConversation, resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        resolveExistingSessionConversation: async () => null });
      const params = { runId: 'workflow-composed-run', invocationRecordId: 'workflow-composed-invocation',
        step: { kind: 'step', id: 'agent', document: { text: 'Reply exactly QA_FIN21_REPLY.', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
        invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'agent', scope: [] }, attempt: '0', logicalInvocationRecordId: 'workflow-composed-invocation' },
        input: { text: 'Reply exactly QA_FIN21_REPLY.', references: [], attachments: [], values: [] },
        execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
          connectedServices: { v: 2, bindingsByServiceId: {} } }, executionTarget: { kind: 'session' },
        authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        workspace: { machineId: 'machine-1', directory, checkoutRootPath: directory }, beforeInputAdmission: async () => {},
        onInputAccepted: async () => {} } satisfies Parameters<WorkflowStepExecutor>[0];
      const result = await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => execute(params));
      expect(unexpectedRequests).toEqual([]);
      expect(result, JSON.stringify(transcript)).toEqual({ kind: 'completed', result: 'QA_FIN21_REPLY' });
      expect(authRequests).toEqual([expect.objectContaining({ agentId: 'claude', sessionId: harness.session.sessionId })]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Reply exactly QA_FIN21_REPLY.');
      expect(completed).toBe(true);
      expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({ kind: 'accepted', localId: inputLocalId }));
    } finally {
      rpc.mockRestore(); auth.mockRestore();
      await clearDaemonStateForTestTeardown(); envScope.restore(); reloadConfiguration();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the admitted creation tag for server create-or-load instead of minting a random tag', async () => {
    const harness = createHarness('session-1', { credentials: {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'runtime-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    // Use the real permission queue owner so startup exercises live-work admission.
    delete harness.deps.createPermissionModeQueueStateFn;
    const sessionCreationTag = 'create:v1:9Qf8pTqHIQxEYXv3sHohC0y7sD2pRqclZxY_V_GKcJ0';
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.opts.sessionCreationTag = sessionCreationTag as any;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      sessionTag: sessionCreationTag,
      terminalAgentLabel: harness.config.policyAgentId,
    }));
  });

  it('carries admitted creation correspondence into creation metadata and atomic placement', async () => {
    const harness = createHarness();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'runtime-correspondence-test',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/workspace/project' } },
        organization: { folderId: 'folder-1', tagIds: ['tag-1'] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        capabilitySelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.deps.createSessionMetadataFn = (params: CreateSessionMetadataOptions) => {
      if (!params.augmentMetadata) {
        throw new Error('Expected the host runtime metadata augmenter');
      }
      const metadata = harness.session.getMetadataSnapshot();
      if (!metadata) throw new Error('Expected fixture Session metadata');
      return {
        state: { controlledByUser: false },
        metadata: params.augmentMetadata(metadata),
      };
    };
    harness.opts.sessionCreationTag = sessionCreationTag;
    harness.opts.sessionCreationCorrespondence = sessionCreationCorrespondence;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      sessionTag: sessionCreationTag,
      organizationPlacement: sessionCreationCorrespondence.recipe.organization,
      metadata: expect.objectContaining({
        sessionCreationCorrespondenceV1: sessionCreationCorrespondence,
      }),
    }));
  });

  it('writes admitted Machine Pool placement origin into fresh creation metadata', async () => {
    const harness = createHarness();
    const placementOrigin = {
      kind: 'machine_pool' as const,
      poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
    };
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    harness.deps.createSessionMetadataFn = (params: CreateSessionMetadataOptions) => {
      if (!params.augmentMetadata) throw new Error('Expected the host runtime metadata augmenter');
      const metadata = harness.session.getMetadataSnapshot();
      if (!metadata) throw new Error('Expected fixture Session metadata');
      return {
        state: { controlledByUser: false },
        metadata: params.augmentMetadata(metadata),
      };
    };
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.opts.placementOrigin = placementOrigin;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ placementOrigin }),
    }));
  });

  it('places an admitted initial title in the fresh creation metadata before the create transaction', async () => {
    const harness = createHarness();
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    harness.opts.initialTitle = '  Atomic initial title  ';
    harness.deps.createSessionMetadataFn = (params: any) => ({
      state: { controlledByUser: false },
      metadata: params.augmentMetadata({
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
      }),
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        summary: expect.objectContaining({ text: 'Atomic initial title' }),
      }),
    }));
  });

  it('composes the bound UI Agent-realtime service through the host runtime RPC producer', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness('session-1', { credentials: {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'voice-receipt-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    harness.config.policyAgentId = 'codex';
    const provider = {
      pluginId: 'happier.agent.codex',
      localId: 'realtime-codex',
    } as const;
    const bundledAuthority = resolveBundledAgentSessionRealtimeVoiceAuthorityFixture({
      runtimeRegistry: runtimeRegistryLease?.registry ?? null,
      provider,
      policyAgentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
      agentGeneration: 'bundled-registry-generation',
    });
    setAgentSessionRealtimeVoiceAuthority(harness.config, bundledAuthority);
    const runtimeTerminalListeners = new Set<
      (event: AgentSessionRealtimeLifecycleEvent) => void
    >();
    const startGate = createDeferred<void>();
    let runtimeTerminal: AgentSessionRealtimeLifecycleEvent | null = null;
    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch(listener) {
        if (runtimeTerminal) listener(runtimeTerminal);
        else runtimeTerminalListeners.add(listener);
        return {
          dispose() {
            runtimeTerminalListeners.delete(listener);
          },
        };
      },
      dispose: vi.fn(),
    };
    const inspect = vi.fn(async () => ({
      status: 'available' as const,
      transport: 'webrtc' as const,
    }));
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => {
      await startGate.promise;
      return {
        status: 'started' as const,
        transport: {
          kind: 'webrtc' as const,
          answerSdp: 'v=0\r\na=answer:host-runtime\r\n',
        },
        handle: runtimeHandle,
      };
    });
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: { inspect, start },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    const rpcCalls: Array<Readonly<{
      sessionAddress: Readonly<{ serverId: string; sessionId: string }>;
      method: string;
      payload: unknown;
    }>> = [];
    // The attempt owner observes lifecycle through the handle the service
    // publishes on a successful start; there is no separate terminal callback.
    const onTerminal = vi.fn();
    const onStarted = vi.fn((handle: AgentSessionRealtimeHandle) => {
      handle.watch(onTerminal);
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        applicationAttemptId: 'voice:host-runtime-composition',
        signal: new AbortController().signal,
        sessionRpc: async ({ sessionAddress, method, payload }) => {
          rpcCalls.push({ sessionAddress, method, payload });
          const handler = harness.handlers.get(method);
          if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
          return await handler(payload);
        },
        onStarted,
      });

      await expect(service.inspect()).resolves.toEqual({
        status: 'available',
        transport: 'webrtc',
      });
      const startedPromise = service.start({
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:ui-service\r\n',
        },
      });
      const startSettled = vi.fn();
      void startedPromise.then(startSettled, startSettled);
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      expect(startSettled).not.toHaveBeenCalled();

      startGate.resolve();
      const started = await startedPromise;
      expect(onStarted).toHaveBeenCalledOnce();
      expect(started).toMatchObject({
        status: 'started',
        transport: {
          kind: 'webrtc',
          answerSdp: 'v=0\r\na=answer:host-runtime\r\n',
        },
      });
      await vi.waitFor(() => {
        expect(rpcCalls.map((call) => call.method)).toContain(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
        );
      });

      runtimeTerminal = {
        kind: 'terminal',
        reason: 'upstream_closed',
      };
      for (const listener of [...runtimeTerminalListeners]) {
        listener(runtimeTerminal);
      }
      runtimeTerminalListeners.clear();
      await vi.waitFor(() => {
        expect(onTerminal).toHaveBeenCalledWith(runtimeTerminal);
      });

      if (started.status !== 'started') {
        throw new Error('expected the composed Agent-realtime attempt to start');
      }
      await expect(started.handle.stop()).resolves.toEqual({
        status: 'already_stopped',
      });
    };

    await withEmptyVoicePromptCatalogFixture(harness.opts.credentials,
      () => runHostSessionRuntime(harness.opts, harness.config, harness.deps));

    expect(inspect).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(
      {
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:ui-service\r\n',
        },
        systemAppendBlocks: [],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(rpcCalls).toEqual([
      {
        sessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
        payload: { v: 1, provider },
      },
      {
        sessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
          transport: {
            kind: 'webrtc',
            offerSdp: 'v=0\r\na=offer:ui-service\r\n',
          },
        },
      },
      {
        sessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
        },
      },
      {
        sessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        payload: {
          v: 1,
          provider,
          applicationAttemptId: 'voice:host-runtime-composition',
        },
      },
    ]);
    expect(JSON.stringify(rpcCalls)).not.toMatch(
      /audio|pcm|voice_media|appendAudio|appendInputAudio|fallback/iu,
    );
    expect(runtimeHandle.stop).not.toHaveBeenCalled();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('preempts a delayed matching start when the bound Voice attempt aborts before daemon admission', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const provider = {
      pluginId: 'happier.agent.codex',
      localId: 'realtime-codex',
    } as const;
    const bundledAuthority = resolveBundledAgentSessionRealtimeVoiceAuthorityFixture({
      runtimeRegistry: runtimeRegistryLease?.registry ?? null,
      provider,
      policyAgentRef: { pluginId: 'happier.agent.codex', localId: 'codex' },
      agentGeneration: 'bundled-registry-generation',
    });
    setAgentSessionRealtimeVoiceAuthority(harness.config, bundledAuthority);

    const runtimeWatchDispose = vi.fn();
    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch: vi.fn(() => ({ dispose: runtimeWatchDispose })),
      dispose: vi.fn(),
    };
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => ({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: 'v=0\r\na=late-answer\r\n',
      },
      handle: runtimeHandle,
    }));
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: {
        inspect: vi.fn(async () => ({
          status: 'available' as const,
          transport: 'webrtc' as const,
        })),
        start,
      },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    const delayedStart = createDeferred<void>();
    const boundAttempt = new AbortController();
    const callerOperation = new AbortController();
    const rpcMethods: string[] = [];
    const stopResults: unknown[] = [];
    const startRpcSignals: AbortSignal[] = [];
    const onStarted = vi.fn();
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const service = createAgentSessionRealtimeService({
        provider,
        conversationSessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        applicationAttemptId: 'voice:stop-before-start',
        signal: boundAttempt.signal,
        sessionRpc: async ({ sessionAddress, method, payload, signal }) => {
          expect(sessionAddress).toEqual({ serverId: configuration.activeServerId, sessionId: 'session-1' });
          rpcMethods.push(method);
          const handler = harness.handlers.get(method);
          if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
          if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START) {
            startRpcSignals.push(signal);
            await delayedStart.promise;
          }
          const result = await handler(payload);
          if (method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP) {
            stopResults.push(result);
          }
          return result;
        },
        onStarted,
      });

      const startedPromise = service.start(
        {
          transport: {
            kind: 'webrtc',
            offerSdp: 'v=0\r\na=delayed-offer\r\n',
          },
        },
        { signal: callerOperation.signal },
      );
      await vi.waitFor(() => {
        expect(rpcMethods).toEqual([
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        ]);
      });

      boundAttempt.abort();
      await vi.waitFor(() => {
        expect(rpcMethods).toEqual([
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        ]);
      });
      await vi.waitFor(() => {
        expect(stopResults).toEqual([
          { ok: true, status: 'already_stopped' },
        ]);
      });
      const startObservedBoundAbort = startRpcSignals[0]?.aborted;
      delayedStart.resolve();

      await expect(startedPromise).resolves.toEqual({ status: 'aborted' });
      expect(startObservedBoundAbort).toBe(true);
      expect(callerOperation.signal.aborted).toBe(false);
      // A preempted attempt never publishes an owner handle, so the late daemon
      // admission is compensated by the host rather than surfaced to a consumer.
      expect(onStarted).not.toHaveBeenCalled();
      // Caller abort settles before the late START's preparation and compensation
      // tail; observe its existing STOP outcome before asserting the exact order.
      await vi.waitFor(() => {
        expect(stopResults).toEqual([
          { ok: true, status: 'already_stopped' },
          { ok: true, status: 'stopped' },
        ]);
      });
      expect(rpcMethods).toEqual([
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START,
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP,
      ]);
    };

    await withEmptyVoicePromptCatalogFixture(harness.opts.credentials,
      () => runHostSessionRuntime(harness.opts, harness.config, harness.deps));

    expect(start).toHaveBeenCalledOnce();
    expect(runtimeHandle.stop).toHaveBeenCalledOnce();
    expect(runtimeHandle.watch).toHaveBeenCalledOnce();
    expect(runtimeWatchDispose).toHaveBeenCalledOnce();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('authorizes a never-before-seen installed Agent-session Voice declaration from the selected runtime generation and fails closed otherwise', async () => {
    const createAgentSessionRealtimeService = await loadAgentSessionRealtimeService();
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const selectedAgent = {
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    } as const;
    const installedProvider = {
      pluginId: 'example.voice.never-seen',
      localId: 'agent-session-conversation',
    } as const;
    const wrongAgentProvider = {
      pluginId: installedProvider.pluginId,
      localId: 'wrong-agent',
    } as const;
    const malformedProvider = {
      pluginId: installedProvider.pluginId,
      localId: 'malformed',
    } as const;
    const installedDeclaration = {
      id: installedProvider.localId,
      title: 'Never-seen installed Voice',
      kind: 'conversation',
      roles: ['realtime_conversation'],
      platforms: ['web'],
      capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
        tools: { effectCalls: 'none' },
      },
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: selectedAgent,
        supportedRuntimeVersions: ['1.2.3'],
      },
      settings: {
        schemaVersion: 2,
        fields: [],
        connectedServicesBinding: {
          id: 'globalConnectedServices',
          title: 'Codex account',
          agent: selectedAgent,
          serviceIds: ['openai-codex'],
        },
      },
      client: {
        artifactId: 'installed-voice-runtime',
        exportName: 'activate',
      },
    } satisfies VoiceProviderContribution;
    const wrongAgentDeclaration = {
      ...installedDeclaration,
      id: wrongAgentProvider.localId,
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: { pluginId: 'happier.agent.other', localId: 'other' },
        supportedRuntimeVersions: ['1.2.3'],
      },
    } satisfies VoiceProviderContribution;
    const malformedDeclaration = {
      ...installedDeclaration,
      id: malformedProvider.localId,
      execution: {
        kind: 'experimental_agent_session_realtime',
        agent: 'happier.agent.codex/codex',
        supportedRuntimeVersions: ['1.2.3'],
      },
    } as unknown as Extract<
      VoiceProviderContribution,
      Readonly<{ kind: 'conversation' }>
    >;
    let generationCurrent = true;
    const generationRetirement = new AbortController();
    const installedAuthority = resolveAgentSessionRealtimeVoiceAuthority({
      runtimeRegistry: {
        contributes: {
          voiceProviders: [
            {
              pluginId: installedProvider.pluginId,
              identity: installedProvider,
              definition: installedDeclaration,
            },
            {
              pluginId: wrongAgentProvider.pluginId,
              identity: wrongAgentProvider,
              definition: wrongAgentDeclaration,
            },
            {
              pluginId: malformedProvider.pluginId,
              identity: malformedProvider,
              definition: malformedDeclaration,
            },
          ],
        },
        resolveVoiceProviderRuntimeLifecycle: () => ({
          occurrenceId: 'installed-provider-occurrence:42',
          isCurrent: () => generationCurrent,
          retirementSignal: generationRetirement.signal,
        }),
      },
      policyAgentRef: selectedAgent,
      agentRuntimeIdentity: {
        pluginId: selectedAgent.pluginId,
        agentId: selectedAgent.localId,
        occurrenceId: 'installed-occurrence:42',
        sourceCustody: {
          kind: 'managed',
          immutableGenerationId: 'installed-generation:42',
          installSource: 'npm',
        },
        isCurrent: () => generationCurrent,
      },
      agentRetirementSignal: generationRetirement.signal,
    });
    if (!installedAuthority) {
      throw new Error('expected installed Voice authority');
    }
    setAgentSessionRealtimeVoiceAuthority(harness.config, installedAuthority);

    const runtimeHandle: AgentSessionRealtimeHandle = {
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
    };
    const inspect = vi.fn(async () => ({
      status: 'available' as const,
      transport: 'webrtc' as const,
    }));
    const start = vi.fn<AgentSessionRealtimeConversation['start']>(async () => ({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: 'v=0\r\na=answer:installed\r\n',
      },
      handle: runtimeHandle,
    }));
    const nativeRuntime = {
      ...harness.runtime,
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: vi.fn(() => ({ dispose() {} })),
      dispose: vi.fn(),
      realtimeConversation: { inspect, start },
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: harness.runtime,
      nativeRuntime,
    }));

    harness.deps.runSessionLoopLifecycleFn = async () => {
      const invoke = async (method: string, payload: unknown) => {
        const handler = harness.handlers.get(method);
        if (!handler) throw new Error(`missing host runtime RPC producer: ${method}`);
        return await handler(payload);
      };
      for (const provider of [
        { pluginId: 'example.voice.unknown', localId: installedProvider.localId },
        wrongAgentProvider,
        malformedProvider,
      ]) {
        await expect(invoke(
          SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
          { v: 1, provider },
        )).resolves.toMatchObject({
          ok: false,
          status: 'unavailable',
          code: 'agent_realtime_declaration_unavailable',
        });
      }
      expect(inspect).not.toHaveBeenCalled();

      const service = createAgentSessionRealtimeService({
        provider: installedProvider,
        conversationSessionAddress: { serverId: configuration.activeServerId, sessionId: 'session-1' },
        applicationAttemptId: 'voice:installed-generation',
        signal: new AbortController().signal,
        sessionRpc: async ({ sessionAddress, method, payload }) => {
          expect(sessionAddress).toEqual({ serverId: configuration.activeServerId, sessionId: 'session-1' });
          return await invoke(method, payload);
        },
        onStarted: vi.fn(),
      });
      await expect(service.inspect()).resolves.toEqual({
        status: 'available',
        transport: 'webrtc',
      });
      await expect(service.start({
        transport: {
          kind: 'webrtc',
          offerSdp: 'v=0\r\na=offer:installed\r\n',
        },
      })).resolves.toMatchObject({
        status: 'started',
        transport: {
          kind: 'webrtc',
          answerSdp: 'v=0\r\na=answer:installed\r\n',
        },
      });

      generationCurrent = false;
      generationRetirement.abort();
      await expect(invoke(
        SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
        { v: 1, provider: installedProvider },
      )).resolves.toMatchObject({
        ok: false,
        status: 'unavailable',
        code: 'agent_realtime_declaration_unavailable',
      });
      expect(inspect).toHaveBeenCalledTimes(1);
    };

    await withEmptyVoicePromptCatalogFixture(harness.opts.credentials,
      () => runHostSessionRuntime(harness.opts, harness.config, harness.deps));
    expect(start).toHaveBeenCalledOnce();
    expect(runtimeHandle.dispose).toHaveBeenCalledOnce();
  });

  it('does not seed current-runtime Activity from an existing session tuple', async () => {
    const harness = createHarness();
    harness.opts.existingSessionId = 'session-1';
    harness.config.runtimeActivityApplicability = 'not_applicable';
    let initialRuntimeActivityMutation: unknown = null;

    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (_sessionRow: unknown, options: { initialRegisteredSessionStateFieldMutations?: readonly unknown[] }) => {
          initialRuntimeActivityMutation = options.initialRegisteredSessionStateFieldMutations?.[0] ?? null;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    harness.deps.initializeBackendRunSessionFn = async ({ api }: any) => {
      api.sessionSyncClient({
        id: 'session-1',
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 3,
        runtimeActivityObservedAt: 10,
        runtimeActivityRevision: 8,
      });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };
    setSessionRuntimeFactory(harness.config, () => {
      expect(initialRuntimeActivityMutation).toEqual(expect.objectContaining({
        fieldId: 'runtime.activity',
        op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
      }));
      return { operations: harness.runtime, nativeRuntime: harness.runtime };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('routes session-input transforms through the scoped daemon bridge', async () => {
    const harness = createHarness();
    const transformSessionInput = vi.fn(async (
      params: Readonly<{
        sessionId: string;
        payload: Readonly<Record<string, unknown>>;
      }>,
    ) => ({
      ...params.payload,
      text: 'transformed by daemon',
    }));
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(async () => ({
          kind: 'prompt' as const,
          toolContributions: [],
          assetContributions: [],
        })),
        resolveAgentComposition: vi.fn(async () => ({
          kind: 'composition' as const,
          managedPluginIds: [],
          selectedTools: [],
          selectedToolBindings: [],
          promptAssetBlocks: [],
          toolPromptContributions: [],
          additionalInstructions: [],
        })),
        resolveComposerReference: vi.fn(async () => {
          throw new Error('not used by this session-input transform test');
        }),
        resolveComposerAttachment: vi.fn(async () => {
          throw new Error('not used by this session-input transform test');
        }),
        transformAgentContext: vi.fn(async ({ payload }) => payload),
        transformSessionInput,
      },
    };

    let capturedTransformer:
      | ((payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)
      | undefined;
    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (
          _sessionRow: unknown,
          options: Readonly<{
            transformSessionInputBeforeCommit?: typeof capturedTransformer;
          }>,
        ) => {
          capturedTransformer = options.transformSessionInputBeforeCommit;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    let deferredPendingFirstInputCommit = false;
    harness.deps.initializeBackendRunSessionFn = async ({
      api,
      deferPendingFirstInputCommitUntilRuntimeReady,
    }: any) => {
      deferredPendingFirstInputCommit =
        deferPendingFirstInputCommitUntilRuntimeReady === true;
      api.sessionSyncClient({ id: 'session-1' });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    if (!capturedTransformer) {
      throw new Error('expected scoped session-input transformer');
    }
    const payload = {
      sessionId: 'session-1',
      localId: 'local-1',
      text: 'original',
      meta: {},
      timestampMs: 1,
    };
    await expect(capturedTransformer(payload)).resolves.toEqual({
      ...payload,
      text: 'transformed by daemon',
    });
    expect(transformSessionInput).toHaveBeenCalledWith({
      sessionId: 'session-1',
      payload,
    });
    expect(deferredPendingFirstInputCommit).toBe(true);
  });

  it('settles request-local staged media once and keeps a late conflicting outcome inert', async () => {
    const harness = createHarness();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'staged-media-settlement',
    });
    harness.opts.sessionCreationTag = sessionCreationTag;
    harness.opts.sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp/workspace' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        capabilitySelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });
    const settleComposerStagedMedia = vi.fn(async () => undefined);
    const settlement = {
      v: 1 as const,
      releaseIntents: [{
        handle: {
          v: 1 as const,
          id: 'composer-media-1',
          executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
          owner: { pluginId: 'com.example.media', localId: 'composer' },
          mediaKind: 'image' as const,
          mimeType: 'image/png' as const,
          name: 'review.png',
          sizeBytes: 67,
          sha256: 'a'.repeat(64),
        },
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        owner: { pluginId: 'com.example.media', localId: 'composer' },
        claimant: {
          composer: { kind: 'session' as const, sessionId: 'session-1' },
          attachmentInstanceId: 'attachment-1',
        },
      }],
      createdWorkspaceRelativePaths: [
        '.happier/uploads/messages/session-1/local-1/review.png',
      ],
      workingDirectory: '/tmp/session-1-workspace',
    };
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(async () => ({
          kind: 'prompt' as const,
          toolContributions: [],
          assetContributions: [],
        })),
        resolveAgentComposition: vi.fn(async () => ({
          kind: 'composition' as const,
          managedPluginIds: [],
          selectedTools: [],
          selectedToolBindings: [],
          promptAssetBlocks: [],
          toolPromptContributions: [],
          additionalInstructions: [],
        })),
        resolveComposerReference: vi.fn(async () => {
          throw new Error('not used by this staged-media settlement test');
        }),
        resolveComposerAttachment: vi.fn(async () => {
          throw new Error('not used by this staged-media settlement test');
        }),
        transformAgentContext: vi.fn(async ({ payload }) => payload),
        transformSessionInput: vi.fn(async ({ payload }) => ({
          ...payload,
          [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: settlement,
        })),
        settleComposerStagedMedia,
      },
    };

    let capturedTransformer: NonNullable<
      ApiSessionClientOptions['transformSessionInputBeforeCommit']
    > | undefined;
    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (
          _sessionRow: unknown,
          options: Readonly<{
            transformSessionInputBeforeCommit?: NonNullable<
              ApiSessionClientOptions['transformSessionInputBeforeCommit']
            >;
          }>,
        ) => {
          capturedTransformer = options.transformSessionInputBeforeCommit;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    harness.deps.initializeBackendRunSessionFn = async ({ api }: any) => {
      api.sessionSyncClient({ id: 'session-1' });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    if (!capturedTransformer) throw new Error('expected staged-media transformer');
    const output = await capturedTransformer({
      sessionId: 'session-1',
      localId: 'local-1',
      text: 'Review image.',
      meta: {},
      timestampMs: 1,
    });
    const maybeSettlement = typeof output === 'object' && output !== null && 'settlement' in output
      ? output.settlement
      : null;
    if (
      !maybeSettlement
      || typeof maybeSettlement !== 'object'
      || !('onDefinitiveAdmissionFailure' in maybeSettlement)
      || !('onAccepted' in maybeSettlement)
      || typeof maybeSettlement.onDefinitiveAdmissionFailure !== 'function'
      || typeof maybeSettlement.onAccepted !== 'function'
    ) {
      throw new Error('expected request-local staged-media settlement');
    }

    await maybeSettlement.onDefinitiveAdmissionFailure();
    await maybeSettlement.onAccepted();
    await maybeSettlement.onDefinitiveAdmissionFailure();

    expect(settleComposerStagedMedia).toHaveBeenCalledOnce();
    expect(settleComposerStagedMedia).toHaveBeenCalledWith({
      sessionId: 'session-1',
      outcome: 'definitiveFailure',
      settlement,
    });
  });

  it('routes post-admission Composer attachment notification through the scoped daemon bridge', async () => {
    const harness = createHarness();
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);
    type MachineAdmissionTransport = NonNullable<
      ApiSessionClientOptions['machineAdmissionTransport']
    >;
    type MachineAdmissionRequest = Parameters<MachineAdmissionTransport>[0];
    const admitSessionInput = vi.fn(async (params: Readonly<{
      sessionId: string;
      request: MachineAdmissionRequest;
      signal?: AbortSignal;
    }>) => ({
      status: 'accepted' as const,
      localId: params.request.localId,
    }));
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(async () => ({
          kind: 'prompt' as const,
          toolContributions: [],
          assetContributions: [],
        })),
        resolveAgentComposition: vi.fn(async () => ({
          kind: 'composition' as const,
          managedPluginIds: [],
          selectedTools: [],
          selectedToolBindings: [],
          promptAssetBlocks: [],
          toolPromptContributions: [],
          additionalInstructions: [],
        })),
        resolveComposerReference: vi.fn(async () => {
          throw new Error('not used by this attachment acceptance test');
        }),
        resolveComposerAttachment: vi.fn(async () => {
          throw new Error('not used by this attachment acceptance test');
        }),
        transformAgentContext: vi.fn(async ({ payload }) => payload),
        transformSessionInput: vi.fn(async ({ payload }) => payload),
        afterComposerAttachmentMessageAccepted,
        admitSessionInput,
      },
    };

    let capturedAfterMessageAccepted:
      | ((input: Readonly<{
        attachment: { pluginId: string; localId: string };
        event: {
          sessionId: string;
          localId: string;
          attachments: readonly Readonly<{
            instanceId: string;
            key: string;
            value: unknown;
          }>[];
        };
        signal: AbortSignal;
      }>) => Promise<void> | void)
      | undefined;
    let capturedMachineAdmissionTransport:
      | MachineAdmissionTransport
      | undefined;
    harness.deps.initializeBackendApiContextFn = async () => ({
      api: {
        push: () => ({ sendToAllDevices: () => undefined }),
        sessionSyncClient: (
          _sessionRow: unknown,
          options: Readonly<{
            afterComposerAttachmentMessageAccepted?:
              typeof capturedAfterMessageAccepted;
            machineAdmissionTransport?:
              typeof capturedMachineAdmissionTransport;
          }>,
        ) => {
          capturedAfterMessageAccepted =
            options.afterComposerAttachmentMessageAccepted;
          capturedMachineAdmissionTransport =
            options.machineAdmissionTransport;
          return harness.session;
        },
      },
      machineId: 'machine-1',
    });
    harness.deps.initializeBackendRunSessionFn = async ({ api }: any) => {
      api.sessionSyncClient({ id: 'session-1' });
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    if (!capturedAfterMessageAccepted) {
      throw new Error('expected scoped attachment acceptance notifier');
    }
    const signal = new AbortController().signal;
    const attachment = {
      pluginId: 'acme.review',
      localId: 'review-comment',
    };
    const event = {
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'review-1',
        key: 'review-1',
        value: { reviewId: '42' },
      }],
    } as const;

    await expect(capturedAfterMessageAccepted({
      attachment,
      event,
      signal,
    })).resolves.toBeUndefined();
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachment,
      event,
      signal,
    });

    if (!capturedMachineAdmissionTransport) {
      throw new Error('expected scoped machine admission transport');
    }
    const machineRequest = {
      v: 1 as const,
      sessionId: 'session-1',
      targetMachineId: 'machine-1',
      localId: 'local-1',
      content: {
        t: 'plain' as const,
        v: { role: 'user' as const, content: { type: 'text' as const, text: 'hello' } },
      },
      requestedAction: { v: 1 as const, kind: 'enqueue' as const },
    };
    await expect(capturedMachineAdmissionTransport(machineRequest, { signal }))
      .resolves.toEqual({ status: 'accepted', localId: 'local-1' });
    expect(admitSessionInput).toHaveBeenCalledWith({
      sessionId: 'session-1',
      request: machineRequest,
      signal,
    });
  });

  it('scopes next-turn composition tool selection through the existing native MCP session context', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.policyAgentId = 'claude';
    let mcpSession: Readonly<{
      getActiveAgentCompositionToolSelection?: () => unknown;
    }> | null = null;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async ({ session }: {
      session: typeof mcpSession;
    }) => {
      mcpSession = session;
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: {},
      };
    });
    const selection = {
      managedPluginIds: ['example.agent-context-companion'],
      selectedTools: [{
        pluginId: 'example.agent-context-companion',
        localId: 'review-summary-tool',
      }],
      selectedToolBindings: [{
        tool: {
          toolId: 'example.agent-context-companion/review-summary-tool',
          actionId: 'review-summary',
          name: 'review_summary',
          title: 'Review summary',
          description: 'Summarize the bounded review transcript.',
          inputSchema: { type: 'object', additionalProperties: false },
          surfaces: ['agent', 'mcp'],
        },
        expectedContributorOccurrenceId: 'occurrence-g',
      }],
    } as const;
    harness.deps.runSessionLoopLifecycleFn = async (params: Readonly<{
      setActiveAgentCompositionToolSelection: (value: typeof selection | null) => void;
    }>) => {
      expect(mcpSession?.getActiveAgentCompositionToolSelection?.()).toBeNull();
      params.setActiveAgentCompositionToolSelection(selection);
      expect(mcpSession?.getActiveAgentCompositionToolSelection?.()).toEqual(selection);
      params.setActiveAgentCompositionToolSelection(null);
      expect(mcpSession?.getActiveAgentCompositionToolSelection?.()).toBeNull();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.deps.resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
  });

  it('commits retained daemon-bridge first input after runtime open and before prompt admission', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const runtimeOpenStarted = createDeferred<void>();
    const releaseRuntimeOpen = createDeferred<void>();
    const commitPendingFirstInputAfterRuntimeReady = vi.fn(async () => {
      order.push('pending-input:commit');
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    });
    setSessionRuntimeFactory(harness.config, async () => {
      order.push('runtime:open-started');
      runtimeOpenStarted.resolve();
      await releaseRuntimeOpen.promise;
      order.push('runtime:opened');
      return { operations: harness.runtime, nativeRuntime: harness.runtime };
    });
    harness.deps.runSessionLoopLifecycleFn = async (params: Readonly<{
      startupCoordinator?: Readonly<{ start?: () => Promise<void> }> | null;
    }>) => {
      order.push('lifecycle:entered');
      await params.startupCoordinator?.start?.();
      order.push('prompt:admitted');
    };

    const running = runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    );
    await runtimeOpenStarted.promise;
    expect(commitPendingFirstInputAfterRuntimeReady).not.toHaveBeenCalled();
    releaseRuntimeOpen.resolve();
    await running;

    expect(commitPendingFirstInputAfterRuntimeReady).toHaveBeenCalledOnce();
    expect(order).toEqual([
      'runtime:open-started',
      'runtime:opened',
      'lifecycle:entered',
      'pending-input:commit',
      'prompt:admitted',
    ]);
  });

  it('applies a resumed initial goal after runtime open and before prompt admission', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const setGoal = vi.fn(async () => {
      order.push('goal:applied');
      return { status: 'applied' };
    });
    harness.runtime.setGoal = setGoal;
    setSessionRuntimeFactory(harness.config, async () => {
      order.push('runtime:opened');
      return { operations: harness.runtime, nativeRuntime: harness.runtime };
    });
    harness.deps.runSessionLoopLifecycleFn = async (params: Readonly<{
      startupCoordinator?: Readonly<{ start?: () => Promise<void> }> | null;
    }>) => {
      await params.startupCoordinator?.start?.();
      order.push('prompt:admitted');
    };
    process.env.HAPPIER_DAEMON_INITIAL_GOAL = JSON.stringify({ objective: 'Finish the review' });
    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(setGoal).toHaveBeenCalledWith('Finish the review', undefined);
      expect(order).toEqual(['runtime:opened', 'goal:applied', 'prompt:admitted']);
      expect(process.env.HAPPIER_DAEMON_INITIAL_GOAL).toBeUndefined();
    } finally {
      delete process.env.HAPPIER_DAEMON_INITIAL_GOAL;
    }
  });

  it('does not commit retained daemon-bridge first input when runtime open fails', async () => {
    const harness = createHarness();
    const commitPendingFirstInputAfterRuntimeReady = vi.fn();
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    });
    setSessionRuntimeFactory(harness.config, async () => {
      throw new Error('daemon session.open failed');
    });

    await expect(runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    )).rejects.toThrow('daemon session.open failed');
    expect(commitPendingFirstInputAfterRuntimeReady).not.toHaveBeenCalled();
  });

  it.each(['supported', 'not_applicable'] as const)('preserves eager provider startup through the actual host launch (%s Activity)', async applicability => {
    const { createNativeAgentSessionOperations } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession');
    const { AgentSessionRuntimeEventV1Schema } = await import('@happier-dev/protocol');
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = applicability;
    const sessionId = harness.session.sessionId;
    const cold = [
      { kind: 'transcript-message-committed', messageId: 'startup-input', role: 'user', text: 'EXTENSION_STARTUP_INPUT' },
      { kind: 'turn-start', turnId: 'startup-turn', startedBy: 'provider' },
      { kind: 'message-delta', turnId: 'startup-turn', channel: 'assistant', text: 'EXTENSION_STARTUP_ANSWER' },
      { kind: 'turn-complete', turnId: 'startup-turn' },
      { kind: 'provider-session-id', providerSessionId: 'startup-native-session' },
      { kind: 'runtime-activity-snapshot', state: 'idle', activeCount: 0 },
    ].map((event, index) => AgentSessionRuntimeEventV1Schema.parse({ ...event, sessionId, sequence: index + 1, emittedAtMs: index + 1 }));
    const listeners = new Set<(event: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeEvent) => void>();
    // The native provider is the external boundary: cold output is consumed by
    // its first watch, exactly as Pi and the public SDK Run adapter specify.
    const native: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntime = {
      send: async () => ({ status: 'admitted' }),
      watch(listener) {
        listeners.add(listener);
        for (const event of cold.splice(0)) listener(event);
        return { dispose() { listeners.delete(listener); } };
      },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(native, sessionId, undefined, undefined, undefined, undefined, undefined, {
      context: {} as import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeContext,
      cwd: '/tmp/workspace', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    const { withHostSessionRuntimeIdentityPublication } = await import('@/agent/runtime/identity/publication/withHostSession');
    const { HOST_SESSION_RUNTIME_PLAN_KIND } = await import('./lifecycle');
    const wrapped = withHostSessionRuntimeIdentityPublication({
      plan: { kind: HOST_SESSION_RUNTIME_PLAN_KIND, agentId: 'qwen', opts: harness.opts, config: harness.config },
      identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null },
    });
    Object.assign(harness.config, wrapped.config);
    const userInputs: string[] = [];
    Object.assign(harness.session, { enqueueUserTextMessageCommitted: async (text: string) => {
      userInputs.push(text);
      return { persisted: true as const, delivered: true as const };
    } });
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    harness.deps.runPermissionModePromptLoopFn = async () => undefined;
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    const committed = JSON.stringify(harness.session.enqueueAgentMessageCommitted.mock.calls);
    expect.soft(userInputs).toEqual(['EXTENSION_STARTUP_INPUT']);
    expect.soft(committed).toContain('EXTENSION_STARTUP_ANSWER');
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'startup-native-session' });
    expect(listeners.size).toBe(0);
  });

  it('binds the supported current-runtime observer and publishes idle before provider input starts', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    let observerBound = false;
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: any) => void) => {
      observerBound = true;
      handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'idle',
        activeCount: 0,
      });
      return () => undefined;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(observerBound).toBe(true);
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('waits for the initial Runtime Activity authority settlement before provider input starts', async () => {
    const harness = createHarness();
    const authoritySettlement = createDeferred<void>();
    harness.session.enqueueRegisteredSessionStateFieldMutation = vi.fn(
      async () => await authoritySettlement.promise,
    );
    const runPermissionModePromptLoopFn = vi.fn(async () => undefined);
    harness.deps.runPermissionModePromptLoopFn = runPermissionModePromptLoopFn;

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(harness.session.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldId: 'runtime.activity',
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }),
      );
    });
    await Promise.resolve();

    expect(runPermissionModePromptLoopFn).not.toHaveBeenCalled();

    authoritySettlement.resolve();
    await runPromise;
    expect(runPermissionModePromptLoopFn).toHaveBeenCalledOnce();
  });

  it('does not publish idle when supported observer installation fails', async () => {
    const harness = createHarness();
    const observerFailure = new Error('observer installation failed');
    harness.config.runtimeActivityApplicability = 'supported';
    harness.runtime.subscribeRuntimeEvents = vi.fn(() => {
      throw observerFailure;
    });

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(observerFailure);
    await Promise.resolve();
    expect(harness.session.enqueueRegisteredSessionStateFieldMutation.mock.calls)
      .not.toContainEqual([
        expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        }),
      ]);
  });

  it('preserves scoped unset environment keys through host option canonicalization', async () => {
    const harness = createHarness();
    harness.opts.unsetEnvironmentVariables = ['OPENAI_API_KEY', 'Gemini_Api_Key'];
    const beforeInitializeSession = harness.config.beforeInitializeSession;
    harness.config.beforeInitializeSession = (params) => {
      expect(params.opts.unsetEnvironmentVariables).toEqual(['OPENAI_API_KEY', 'Gemini_Api_Key']);
      beforeInitializeSession?.(params);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('rejects invalid unset environment keys at the host runtime boundary', async () => {
    const harness = createHarness();
    harness.opts.unsetEnvironmentVariables = ['OPENAI_API_KEY', 'BAD=NAME'];

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects.toThrow('Invalid environment variable unset key');
  });

  it('does not emit idle keepAlive heartbeats at the thinking cadence', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    let releaseLoop!: () => void;
    let resolveLoopStarted!: () => void;
    const loopStarted = new Promise<void>((resolve) => {
      resolveLoopStarted = resolve;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      resolveLoopStarted();
      await new Promise<void>((resolve) => {
        releaseLoop = resolve;
      });
    };

    const runtimePromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    try {
      await loopStarted;
      expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.session.keepAlive).toHaveBeenCalledTimes(1);
    } finally {
      releaseLoop?.();
      await runtimePromise;
      vi.useRealTimers();
    }
  });

  it('does not double-send keepAlive when a thinking update is immediately flushed', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      params.setThinking(true);
      params.keepAlive();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.keepAlive.mock.calls).toEqual([
      [false, 'remote'],
      [true, 'remote'],
    ]);
  });

  it('delegates the host-owned session lifecycle to the shared session loop scaffold', async () => {
    const harness = createHarness();
    const runSessionLoopLifecycleFn = vi.fn(async (params: unknown) => {
      const lifecycleParams = params as Readonly<{
        opts: unknown;
        config: unknown;
        session: Readonly<{
          sessionId: string;
          getMetadataSnapshot: () => unknown;
        }>;
      }>;
      expect(lifecycleParams.opts).toEqual(expect.objectContaining(harness.opts));
      expect((lifecycleParams.opts as any).agentModeId).toBeUndefined();
      expect((lifecycleParams.opts as any).agentModeUpdatedAt).toBeUndefined();
      expect(lifecycleParams.config).toMatchObject({
        ...harness.config,
        mcpServerIdentities: undefined,
        onAfterStart: expect.any(Function),
        onRuntimeStopReady: expect.any(Function),
        publishHostRuntimeEvent: expect.any(Function),
      });
      expect(lifecycleParams.session.sessionId).toBe(harness.session.sessionId);
      expect(lifecycleParams.session.getMetadataSnapshot()).toEqual(harness.session.getMetadataSnapshot());
    });
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runSessionLoopLifecycleFn).toHaveBeenCalledTimes(1);
    expect((runSessionLoopLifecycleFn.mock.calls[0]?.[0] as { session: unknown } | undefined)?.session).not.toBe(harness.session);
  });

  it('provides the host-owned session-state engine to runtime factories', async () => {
    const harness = createHarness();
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async () => undefined),
        readField: vi.fn(async () => null),
      },
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      sessionState: expect.objectContaining({
        applyHappierField: expect.any(Function),
        writeHappierField: expect.any(Function),
        readProviderField: expect.any(Function),
      }),
    }));
  });

  it('fences active runtime session-state metadata writes with exact publisher authority', async () => {
    const harness = createHarness();
    let runtimeSessionState: any = null;
    harness.config.createSessionRuntime = vi.fn((params) => {
      runtimeSessionState = params.sessionState;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });
    harness.config.sessionState = {
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
            providerToHappier: { supported: true, source: 'snapshot' },
          },
        },
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async () => {
      const genericCallsBefore = harness.session.updateMetadata.mock.calls.length;
      const focusedCallsBefore =
        harness.session.updateMetadataAsCurrentPublisher.mock.calls.length;
      harness.session.updateMetadataAsCurrentPublisher.mockRejectedValueOnce(
        Object.assign(new Error('publisher superseded'), {
          code: 'session_publisher_authority_lost',
          retryable: false,
        }),
      );

      await expect(runtimeSessionState.writeHappierField({
        sessionId: harness.session.sessionId,
        fieldId: 'display.title',
        value: 'stale predecessor title',
        reason: 'runtime-readback',
        metadataReason: 'runtime-readback',
        mirrorToProvider: false,
      })).resolves.toEqual({
        ok: false,
        reason: 'unknown_error',
      });

      expect(harness.session.updateMetadataAsCurrentPublisher.mock.calls)
        .toHaveLength(focusedCallsBefore + 1);
      expect(harness.session.updateMetadata.mock.calls)
        .toHaveLength(genericCallsBefore);
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('consumes provider binding materialization at the host-runtime ingress and passes it to the runtime factory', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };
    const materialization = {
      v: 1 as const,
      kind: 'engineConfig' as const,
      engineConfig: { model_provider: { name: 'gateway' } },
    };
    const sessionBindingMetadata = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 3,
      model: providerModelDescriptor,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      runtimeBindingBasis: externalProviderRuntimeBindingBasis({
        connectionId: 'pc_work',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        contributionKey: 'plugin.openrouter/openrouter',
        adapterBindingKey: 'openrouter',
        fingerprintScope: 'ingress',
      }),
      displaySnapshot: {
        providerName: 'OpenRouter',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    harness.config.createSessionRuntime = createSessionRuntime;
    let persistedMetadata: Record<string, unknown> = { path: '/tmp/workspace', permissionMode: 'default' };
    harness.deps.createSessionMetadataFn = (params: any) => {
      persistedMetadata = params.augmentMetadata(persistedMetadata);
      return {
        state: { controlledByUser: false },
        metadata: persistedMetadata,
      };
    };
    harness.session.getMetadataSnapshot = () => persistedMetadata;
    const previousHandoff = process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    harness.opts.environmentVariables = {
      [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
        serializeProviderBindingLaunchHandoffForEnv(
          materialization,
          sessionBindingMetadata,
        ),
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        providerBindingMaterialization: materialization,
        metadata: expect.objectContaining({ providerBindingV1: sessionBindingMetadata }),
      }));
      expect(process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]).toBeUndefined();
    } finally {
      if (previousHandoff === undefined) delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
      else process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] = previousHandoff;
    }
  });

  it.each(['foreground', 'managedRuntime'] as const)('uses a %s-admitted Provider binding as the active target without an early handoff', async (admission) => {
    const harness = createHarness();
    const connectionId = ProviderConnectionIdSchema.parse('pc_late');
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const handoff = lateExternalProviderBindingHandoff({
      connectionId,
      modelId: 'late-model',
      agentTargetKey,
    });
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'late-provider-binding-admission',
    });
    const modelSelection = {
      v: 1 as const,
      updatedAt: 1,
      ref: {
        agentTargetKey,
        providerConnectionId: connectionId,
        modelId: handoff.sessionBindingMetadata.model.id,
      },
    };
    let metadata: Record<string, unknown> = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.config.policyAgentId = 'codex';
    harness.opts.sessionCreationTag = sessionCreationTag;
    harness.opts.sessionCreationCorrespondence =
      SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp/workspace' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
          modelSelection,
          profileId: null,
          requestedPermissionMode: null,
          agentModeId: null,
          configuration: null,
          connectedServices: null,
          capabilitySelection: null,
          transcriptStorage: null,
          terminal: null,
          agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        },
      });
    harness.opts.backendTarget = {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    };
    harness.opts.modelSelection = modelSelection;
    if (admission === 'foreground') harness.opts.resolveLateEnvironment = async () => ({
      environmentVariables: {},
      unsetEnvironmentVariables: [],
      sensitiveEnvironmentVariableNames: [],
    });
    else harness.config.providerBindingAdmission = 'runtime';
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update as typeof metadata;
    });
    harness.config.createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
      admittedProviderBindingHandoff: handoff,
    } as any));
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({
      status: 'applied',
    });
    const authorizeProviderTarget = vi.fn(async (input: any) => {
      const model = {
        id: input.selection.modelId,
        name: input.selection.modelId,
      };
      return {
        selection: input.selection,
        policy: 'live' as const,
        model,
        sessionBindingMetadata: {
          ...handoff.sessionBindingMetadata,
          model,
        },
        runtimeBindingBasis:
          handoff.sessionBindingMetadata.runtimeBindingBasis,
      };
    });
    harness.deps.daemonModelTransitionAuthorizer = authorizeProviderTarget;
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(metadata.providerBindingV1).toEqual(
        handoff.sessionBindingMetadata,
      );
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const nextSelection = {
        agentTargetKey,
        providerConnectionId: connectionId,
        modelId: 'late-model-next',
      } as const;

      await expect(transition?.({
        v: 1,
        selection: nextSelection,
      })).resolves.toMatchObject({
        ok: true,
        status: 'applied',
        activeSelection: nextSelection,
      });
      expect(authorizeProviderTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          activeSessionBindingMetadata: handoff.sessionBindingMetadata,
        }),
      );
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: nextSelection.modelId,
          providerBinding: {
            connectionId,
            upstream: {
              protocol: 'openai-responses',
              normalizedUrl: 'https://provider.example/v1',
              credential: 'none',
            },
            model: {
              id: nextSelection.modelId,
              name: nextSelection.modelId,
            },
            materialization: handoff.materialization,
          },
        }),
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('does not construct a provider-bound runtime before fresh daemon session initialization ACKs', async () => {
    const createProviderBoundHarness = () => {
      const harness = createHarness();
      harness.config.policyAgentId = 'codex';
      harness.opts.startedBy = 'daemon';
      harness.opts.backendTarget = {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      };
      harness.opts.modelSelection = {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId:
            ProviderConnectionIdSchema.parse('pc_work'),
          modelId: providerModelDescriptor.id,
        },
      };
      harness.opts.environmentVariables = {
        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
          serializeProviderBindingLaunchHandoffForEnv(
            {
              v: 1,
              kind: 'engineConfig',
              engineConfig: { model_provider: { name: 'managed-gateway' } },
            },
            {
              v: 1,
              connectionId: ProviderConnectionIdSchema.parse('pc_work'),
              contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
              connectionRevision: 1,
              model: providerModelDescriptor,
              protocol: 'openai-responses',
              materialization: 'engineConfig',
              adapterBindingKey: 'cliproxyapi',
              compatibilityFingerprint: 'compatibility-v1',
              bindingSecurityFingerprint: 'security-v1',
              runtimeBindingBasis: externalProviderRuntimeBindingBasis({
                connectionId: 'pc_work',
                agentTargetKey: 'agent:happier.agent.codex/codex',
                contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
                adapterBindingKey: 'cliproxyapi',
                fingerprintScope: 'daemon-ack',
              }),
              displaySnapshot: {
                providerName: 'CLIProxyAPI',
                connectionName: 'CLIProxyAPI',
                connectionRole: 'default',
                connectionDisplayNameMode: 'automatic',
              },
            },
          ),
      };
      const createSessionRuntime = vi.fn(() => ({
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      }));
      harness.config.createSessionRuntime = createSessionRuntime;
      const createDeferredBootstrap = vi.fn();
      harness.config.startupBootstrap = {
        shouldCreate: ({ seed }) =>
          seed.modelSelection?.ref.providerConnectionId === null,
        create: createDeferredBootstrap,
      };
      return {
        harness,
        createSessionRuntime,
        createDeferredBootstrap,
      };
    };

    const pending = createProviderBoundHarness();
    const daemonAck = createDeferred<Awaited<
      ReturnType<typeof pending.harness.deps.initializeBackendRunSessionFn>
    >>();
    pending.harness.deps.initializeBackendRunSessionFn =
      vi.fn(async () => await daemonAck.promise);
    const run = runHostSessionRuntime(
      pending.harness.opts,
      pending.harness.config,
      pending.harness.deps,
    );

    await vi.waitFor(() => {
      expect(
        pending.harness.deps.initializeBackendRunSessionFn,
      ).toHaveBeenCalledOnce();
    });
    expect(pending.createDeferredBootstrap).not.toHaveBeenCalled();
    expect(pending.createSessionRuntime).not.toHaveBeenCalled();

    daemonAck.resolve({
      session: pending.harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'canonical-session',
      attachedToExistingSession: false,
    });
    await expect(run).resolves.toBeUndefined();
    expect(pending.createSessionRuntime).toHaveBeenCalledOnce();

    const failed = createProviderBoundHarness();
    failed.harness.deps.initializeBackendRunSessionFn =
      vi.fn(async () => {
        throw new Error('required daemon ACK failed');
      });
    await expect(runHostSessionRuntime(
      failed.harness.opts,
      failed.harness.config,
      failed.harness.deps,
    )).rejects.toThrow('required daemon ACK failed');
    expect(failed.createDeferredBootstrap).not.toHaveBeenCalled();
    expect(failed.createSessionRuntime).not.toHaveBeenCalled();
  });

  it('fails closed before runtime creation when a Provider handoff omits or mismatches the selected exact model', async () => {
    for (const { model, expectedError } of [
      {
        model: undefined,
        // A handoff without its launch model descriptor is not a validated binding at all.
        expectedError: 'Provider-bound model selection requires a validated provider binding handoff',
      },
      {
        model: { id: 'different-provider-model', name: 'Different Provider Model' },
        expectedError: 'Provider binding handoff model does not match the selected model',
      },
    ] as const) {
      const harness = createHarness();
      harness.config.policyAgentId = 'codex';
      harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
      harness.opts.modelSelection = {
        v: 1,
        updatedAt: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
          modelId: providerModelDescriptor.id,
        },
      };
      const createSessionRuntime = vi.fn(() => ({
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      }));
      harness.config.createSessionRuntime = createSessionRuntime;
      harness.opts.environmentVariables = {
        [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
          serializeProviderBindingLaunchHandoffForEnv(
            { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
            {
              v: 1,
              connectionId: ProviderConnectionIdSchema.parse('pc_work'),
              contributionKey: 'plugin.openrouter/openrouter',
              connectionRevision: 3,
              ...(model ? { model } : {}),
              protocol: 'openai-responses',
              materialization: 'engineConfig',
              adapterBindingKey: 'openrouter',
              compatibilityFingerprint: 'compatibility-v1',
              bindingSecurityFingerprint: 'security-v1',
              runtimeBindingBasis: externalProviderRuntimeBindingBasis({
                connectionId: 'pc_work',
                agentTargetKey: 'agent:happier.agent.codex/codex',
                contributionKey: 'plugin.openrouter/openrouter',
                adapterBindingKey: 'openrouter',
                fingerprintScope: 'model-mismatch',
              }),
              displaySnapshot: {
                providerName: 'OpenRouter',
                connectionName: 'Work',
                connectionRole: 'named',
                connectionDisplayNameMode: 'custom',
              },
            },
          ),
      };

      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow(expectedError);
      expect(createSessionRuntime).not.toHaveBeenCalled();
    }
  });

  it('keeps provider-owned child credentials redacted for the whole runtime lifetime and releases them on factory failure', async () => {
    const harness = createHarness();
    const credential = 'provider-runtime-redaction-secret-value';
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
    };
    process.env.HAPPIER_CODEX_PROVIDER_API_KEY = credential;
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
        {
          v: 1,
          connectionId: ProviderConnectionIdSchema.parse('pc_work'),
          contributionKey: 'plugin.openrouter/openrouter',
          connectionRevision: 3,
          model: providerModelDescriptor,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'openrouter',
          compatibilityFingerprint: 'compatibility-v1',
          bindingSecurityFingerprint: 'security-v1',
          runtimeBindingBasis: externalProviderRuntimeBindingBasis({
            connectionId: 'pc_work',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            contributionKey: 'plugin.openrouter/openrouter',
            adapterBindingKey: 'openrouter',
            fingerprintScope: 'factory-failure',
          }),
          displaySnapshot: {
            providerName: 'OpenRouter',
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
      );
    harness.config.createSessionRuntime = () => {
      expect(redactBugReportSensitiveText(credential)).toBe('[REDACTED]');
      throw new Error('factory failed');
    };

    try {
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow('factory failed');
      expect(redactBugReportSensitiveText(credential)).toBe(credential);
    } finally {
      delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
  });

  it('closes the current session when required continuation verification refuses during runtime creation', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    const continuationError = new Error('Agent session continuation is unreachable.');
    continuationError.name = 'AgentSessionContinuationUnreachableError';
    const reconnectionCancel = vi.fn(() => {
      throw new Error('injected reconnection cleanup failure');
    });
    const stopMcpServer = vi.fn(() => {
      throw new Error('injected MCP cleanup failure');
    });
    harness.deps.initializeBackendRunSessionFn = vi.fn(async () => ({
      session: harness.session,
      reconnectionHandle: { cancel: reconnectionCancel },
      reportedSessionId: 'session-1',
      attachedToExistingSession: false,
    }));
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: stopMcpServer },
      mcpServers: {},
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.config.createSessionRuntime = vi.fn(async () => {
      throw continuationError;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(continuationError);

    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(reconnectionCancel).toHaveBeenCalledOnce();
    expect(stopMcpServer).toHaveBeenCalledOnce();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('keeps provider-owned child credentials redacted while the session lifecycle is running', async () => {
    const harness = createHarness();
    const credential = 'provider-runtime-live-lifetime-secret';
    const lifecycleEntered = createDeferred<void>();
    const releaseLifecycle = createDeferred<void>();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'provider-model',
      },
    };
    const previousCredential = process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
    const previousHandoff = process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
    delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    harness.opts.environmentVariables = {
      HAPPIER_CODEX_PROVIDER_API_KEY: credential,
      [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]: serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { model_provider: { name: 'gateway' } } },
        {
          v: 1,
          connectionId: ProviderConnectionIdSchema.parse('pc_work'),
          contributionKey: 'plugin.openrouter/openrouter',
          connectionRevision: 3,
          model: providerModelDescriptor,
          protocol: 'openai-responses',
          materialization: 'engineConfig',
          adapterBindingKey: 'openrouter',
          compatibilityFingerprint: 'compatibility-v1',
          bindingSecurityFingerprint: 'security-v1',
          runtimeBindingBasis: externalProviderRuntimeBindingBasis({
            connectionId: 'pc_work',
            agentTargetKey: 'agent:happier.agent.codex/codex',
            contributionKey: 'plugin.openrouter/openrouter',
            adapterBindingKey: 'openrouter',
            fingerprintScope: 'live-lifetime',
          }),
          displaySnapshot: {
            providerName: 'OpenRouter',
            connectionName: 'Work',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
          },
        },
      ),
    };
    harness.deps.runSessionLoopLifecycleFn = async () => {
      lifecycleEntered.resolve();
      await releaseLifecycle.promise;
    };

    try {
      const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await lifecycleEntered.promise;
      expect(redactBugReportSensitiveText(credential)).toBe('[REDACTED]');
      releaseLifecycle.resolve();
      await running;
      expect(redactBugReportSensitiveText(credential)).toBe(credential);
    } finally {
      releaseLifecycle.resolve();
      if (previousCredential === undefined) delete process.env.HAPPIER_CODEX_PROVIDER_API_KEY;
      else process.env.HAPPIER_CODEX_PROVIDER_API_KEY = previousCredential;
      if (previousHandoff === undefined) delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
      else process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] = previousHandoff;
    }
  });

  it('fails closed when a provider-bound model selection reaches the host without its validated binding handoff', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects.toThrow('Provider-bound model selection requires a validated provider binding handoff');
  });

  it('fails closed when a provider handoff is paired with an explicit native model selection', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: null, modelId: 'native-model' },
    };
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        { v: 1, kind: 'engineConfig', engineConfig: { provider: 'gateway' } },
        {
          v: 1, connectionId: ProviderConnectionIdSchema.parse('pc_work'), contributionKey: 'plugin.gateway/gateway', connectionRevision: 1,
          protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'gateway',
          compatibilityFingerprint: 'compatibility-v1', bindingSecurityFingerprint: 'security-v1',
          displaySnapshot: { providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
        },
      );

    try {
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
        .rejects.toThrow('Native model selection cannot include a provider binding handoff');
    } finally {
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
  });

  it('publishes usage-limit recovery controls from native runtimes', async () => {
    const harness = createHarness();
    harness.runtime.enableUsageLimitWaitResume = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, recovery: { status: 'waiting', sessionId: request.sessionId } };
    });
    harness.runtime.cancelUsageLimitWaitResume = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, recovery: { status: 'cancelled', sessionId: request.sessionId } };
    });
    harness.runtime.checkUsageLimitRecoveryNow = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'waiting', sessionId: request.sessionId };
    });
    harness.runtime.consumeUsageLimitResetCredit = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string; issueFingerprint?: string }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'ready', sessionId: request.sessionId, issueFingerprint: request.issueFingerprint };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    expect(controls).toMatchObject({
      enableUsageLimitWaitResume: expect.any(Function),
      cancelUsageLimitWaitResume: expect.any(Function),
      checkUsageLimitRecoveryNow: expect.any(Function),
      consumeUsageLimitResetCredit: expect.any(Function),
    });

    await expect(controls.enableUsageLimitWaitResume({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      recovery: { status: 'waiting', sessionId: 'session-1' },
    });
    await expect(controls.cancelUsageLimitWaitResume({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      recovery: { status: 'cancelled', sessionId: 'session-1' },
    });
    await expect(controls.checkUsageLimitRecoveryNow({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      status: 'waiting',
      sessionId: 'session-1',
    });
    await expect(controls.consumeUsageLimitResetCredit({
      sessionId: 'session-1',
      issueFingerprint: 'usage-limit:codex:turn-1',
    })).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      sessionId: 'session-1',
      issueFingerprint: 'usage-limit:codex:turn-1',
    });
  });

  it('notifies every canonical accepted attachment before a Pending media settlement failure', async () => {
    const harness = createHarness();
    const settleComposerStagedMedia = vi.fn(async () => {
      throw new Error('release failed');
    });
    const afterComposerAttachmentMessageAccepted = vi.fn(async ({ attachment }: { attachment: { localId: string } }) => {
      if (attachment.localId === 'issue') throw new Error('first contributor failed');
    });
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(async () => ({
          kind: 'prompt' as const,
          toolContributions: [],
          assetContributions: [],
        })),
        resolveAgentComposition: vi.fn(async () => ({
          kind: 'composition' as const,
          managedPluginIds: [],
          selectedTools: [],
          selectedToolBindings: [],
          promptAssetBlocks: [],
          toolPromptContributions: [],
          additionalInstructions: [],
        })),
        resolveComposerReference: vi.fn(async () => {
          throw new Error('not used by Pending acceptance');
        }),
        resolveComposerAttachment: vi.fn(async () => {
          throw new Error('not used by Pending acceptance');
        }),
        transformAgentContext: vi.fn(async ({ payload }) => payload),
        transformSessionInput: vi.fn(async ({ payload }) => payload),
        settleComposerStagedMedia,
        afterComposerAttachmentMessageAccepted,
      },
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    const handle = {
      v: 1 as const,
      id: 'pending-stage-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      owner: { pluginId: 'acme.issues', localId: 'issue' },
      mediaKind: 'image' as const,
      mimeType: 'image/png' as const,
      name: 'issue.png',
      sizeBytes: 42,
      sha256: 'a'.repeat(64),
    };
    await expect(controls.acceptPendingMessageComposerAdmission({
      sessionId: 'session-1',
      localId: 'pending-successor-1',
      structuredInput: {
        v: 1,
        composerAttachments: [
          {
            v: 1,
            instanceId: 'issue-42',
            attachment: handle.owner,
            key: '42',
            value: { issueId: 420, prepared: true },
            presentation: { label: 'Prepared issue #420' },
            content: { kind: 'sessionMedia', mediaId: 'media-42' },
          },
          {
            v: 1,
            instanceId: 'review-7',
            attachment: { pluginId: 'acme.review', localId: 'review' },
            key: '7',
            value: { reviewId: 7, prepared: true },
            presentation: { label: 'Review #7' },
          },
        ],
      },
      stagedMediaHandles: [handle],
    })).rejects.toThrow('release failed');

    expect(settleComposerStagedMedia).toHaveBeenCalledWith({
      sessionId: 'session-1',
      outcome: 'accepted',
      settlement: {
        v: 1,
        releaseIntents: [{
          handle,
          executionTarget: handle.executionTarget,
          owner: handle.owner,
          claimant: {
            composer: { kind: 'session', sessionId: 'session-1' },
            attachmentInstanceId: 'issue-42',
          },
        }],
        createdWorkspaceRelativePaths: [],
        workingDirectory: 'accepted-pending-message',
      },
    });
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachment: handle.owner,
      event: {
        sessionId: 'session-1',
        localId: 'pending-successor-1',
        attachments: [{ instanceId: 'issue-42', key: '42', value: { issueId: 420, prepared: true } }],
      },
      signal: expect.any(AbortSignal),
    });
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachment: { pluginId: 'acme.review', localId: 'review' },
      event: {
        sessionId: 'session-1',
        localId: 'pending-successor-1',
        attachments: [{ instanceId: 'review-7', key: '7', value: { reviewId: 7, prepared: true } }],
      },
      signal: expect.any(AbortSignal),
    });
    expect(afterComposerAttachmentMessageAccepted.mock.invocationCallOrder[0])
      .toBeLessThan(settleComposerStagedMedia.mock.invocationCallOrder[0]!);

    const attachment = {
      v: 1 as const, instanceId: 'issue-42', attachment: handle.owner, key: '42',
      value: { issueId: 420, prepared: true }, presentation: { label: 'Prepared issue #420' },
      content: { kind: 'sessionMedia' as const, mediaId: 'media-42' },
    };
    const stagedMediaReleaseIntents = [
      { handle, executionTarget: handle.executionTarget, owner: handle.owner,
        claimant: { composer: { kind: 'session' as const, sessionId: 'session-1' }, attachmentInstanceId: attachment.instanceId } },
      { handle: { ...handle, id: 'raw-pending-snapshot' }, executionTarget: handle.executionTarget, owner: handle.owner,
        claimant: { composer: { kind: 'pendingMessage' as const, sessionId: 'session-1', localId: 'pending-original' },
          attachmentInstanceId: attachment.instanceId } },
    ];
    const request = {
      sessionId: 'session-1', localId: 'pending-successor-1',
      structuredInput: { v: 1 as const, composerAttachments: [attachment] },
      stagedMediaHandles: stagedMediaReleaseIntents.map(({ handle }) => handle),
      stagedMediaReleaseIntents,
    };
    await expect(controls.acceptPendingMessageComposerAdmission(request)).rejects.toThrow('release failed');
    expect(settleComposerStagedMedia).toHaveBeenLastCalledWith({
      sessionId: 'session-1', outcome: 'accepted', settlement: {
        v: 1, releaseIntents: stagedMediaReleaseIntents,
        createdWorkspaceRelativePaths: [], workingDirectory: 'accepted-pending-message',
      },
    });
    await expect(controls.abandonPendingMessageComposerAdmission({
      ...request, sessionMediaCleanup: { workingDirectory: '/pending-workspace', createdWorkspaceRelativePaths: ['.happier/uploads/image.png'] },
    })).rejects.toThrow('release failed');
    expect(settleComposerStagedMedia).toHaveBeenLastCalledWith({
      sessionId: 'session-1', outcome: 'definitiveFailure', settlement: {
        v: 1, releaseIntents: stagedMediaReleaseIntents,
        createdWorkspaceRelativePaths: ['.happier/uploads/image.png'], workingDirectory: '/pending-workspace',
      },
    });
    await expect(controls.acceptPendingMessageComposerAdmission({
      ...request,
      stagedMediaReleaseIntents: [{ ...stagedMediaReleaseIntents[0],
        claimant: { ...stagedMediaReleaseIntents[0]!.claimant, attachmentInstanceId: 'unrelated-attachment' } }],
    })).rejects.toThrow('attachment custody');
    await expect(controls.acceptPendingMessageComposerAdmission({
      ...request, stagedMediaReleaseIntents: [],
    })).rejects.toThrow('attachment custody');
  });

  it('publishes the incumbent structured-input resolvers for retained Run delivery', async () => {
    const harness = createHarness();
    const resolveComposerReference = vi.fn(async () => ({
      id: 'issue:42',
      label: 'Issue 42',
      context: 'Current issue context.',
    }));
    const resolveComposerAttachment = vi.fn(async () => ({ attachments: [] }));
    harness.deps.sessionLoopLifecycleDeps = {
      daemonTurnContributionsBridge: {
        resolvePrompt: vi.fn(),
        resolveAgentComposition: vi.fn(),
        resolveComposerReference,
        resolveComposerAttachment,
        afterComposerAttachmentMessageAccepted: vi.fn(),
        transformAgentContext: vi.fn(),
        transformSessionInput: vi.fn(),
        transformAgentRequest: vi.fn(),
      },
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    const signal = new AbortController().signal;
    await expect(controls.resolveComposerReference({
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      candidateId: 'issue:42',
      signal,
    })).resolves.toMatchObject({ id: 'issue:42' });
    await expect(controls.resolveComposerAttachmentForDispatch({
      sessionId: 'session-1',
      attachment: { pluginId: 'acme.review', localId: 'review' },
      request: {
        sessionId: 'session-1',
        localId: 'pending-input-1',
        attachments: [],
      },
      signal,
    })).resolves.toEqual({ attachments: [] });

    expect(resolveComposerReference).toHaveBeenCalledWith({
      sessionId: 'session-1',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      candidateId: 'issue:42',
      signal,
    });
    expect(resolveComposerAttachment).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachment: { pluginId: 'acme.review', localId: 'review' },
      request: {
        sessionId: 'session-1',
        localId: 'pending-input-1',
        attachments: [],
      },
      signal,
    });
  });

  it('publishes connected-account auth controls from the semantic runtime auth facet', async () => {
    const harness = createHarness();
    const apply = vi.fn(async (request: unknown) => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      request,
    }));
    const readIdentity = vi.fn(async (request: unknown) => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
      request,
    }));
    harness.runtime.runtimeAuth = { apply, readIdentity };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    const applyRequest = {
      serviceId: 'openai-codex',
      reason: 'manual',
      authGeneration: { credential: { kind: 'oauth' } },
      transportOnly: 'must-not-reach-plugin',
    };
    const identityRequest = {
      serviceId: 'openai-codex',
      reason: 'diagnostic',
      requireExactProof: true,
      transportOnly: 'must-not-reach-plugin',
    };

    await expect(controls.applyConnectedServiceAuthGeneration(applyRequest)).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
    });
    await expect(controls.readConnectedServiceRuntimeIdentity(identityRequest)).resolves.toEqual({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    });
    expect(apply).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'manual',
      authGeneration: { credential: { kind: 'oauth' } },
    });
    expect(readIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
      requireExactProof: true,
    });
  });

  it('publishes terminal composer clear controls from native runtimes', async () => {
    const harness = createHarness();
    harness.runtime.clearTerminalComposer = vi.fn(async function (
      this: unknown,
      request: Readonly<{ sessionId: string; expectedStateAtMs?: number }>,
    ) {
      expect(this).toBe(harness.runtime);
      return { ok: true, status: 'cleared', sessionId: request.sessionId };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const controls = harness.session.setSessionRuntimeControls.mock.calls[0]?.[0];
    expect(controls).toMatchObject({
      clearTerminalComposer: expect.any(Function),
    });

    await expect(controls.clearTerminalComposer({
      sessionId: 'session-1',
      expectedStateAtMs: 42,
    })).resolves.toMatchObject({
      ok: true,
      status: 'cleared',
      sessionId: 'session-1',
    });
    expect(harness.session.setSessionRuntimeControls).toHaveBeenLastCalledWith(null);
  });

  it('routes typed runtime turn events through durable session turn mutations', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 123,
        startedBy: 'host',
      });
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-complete',
        sequence: 2,
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 456,
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'begin',
      turnId: 'turn-1',
      agentTurnId: 'provider-turn-1',
      observedAt: 123,
    }));
    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      turnId: 'turn-1',
      agentTurnId: 'provider-turn-1',
      observedAt: 456,
    }));
  });

  it('observes canonical display.title metadata updates through the host session-state engine', async () => {
    const harness = createHarness();
    const applied: string[] = [];
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        }),
        readField: vi.fn(async () => null),
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async () => {
      await harness.session.updateMetadata((current: Record<string, unknown>) => ({
        ...current,
        summary: { text: 'Host bridge title', updatedAt: 123 },
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(applied).toEqual(['display.title:Host bridge title']);
  });

  it('mirrors a fork-inherited display.title to the provider after the new runtime starts', async () => {
    const harness = createHarness();
    const applied: string[] = [];
    const forkOverrides = resolveForkInheritedOverridesFromMetadata({
      summary: { text: 'Pre-existing title', updatedAt: 123 },
    }, null);
    harness.session.getMetadataSnapshot = () => ({
      path: '/tmp/workspace',
      ...forkOverrides.metadata,
    });
    harness.config.sessionState = {
      facet: {
        capabilities: {
          display: {
            title: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
              providerToHappier: { supported: true, source: 'snapshot' },
            },
          },
        },
        applyHappierField: vi.fn(async (_ctx, field, value) => {
          applied.push(`${field}:${String(value)}`);
        }),
        readField: vi.fn(async () => null),
      },
    };
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async (params: {
      config: { onAfterStart?: () => Promise<void> | void };
    }) => {
      await params.config.onAfterStart?.();
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    // A fork inherits the parent title with the canonical child suffix the fork
    // override resolver mints, and the host mirrors exactly that to the provider.
    expect(applied).toEqual(['display.title:Pre-existing title (fork 1)']);
  });

  it('keeps provider startup bootstrap inside the shared session loop instead of early-returning', async () => {
    const harness = createHarness();
    const resolvedModelSelection = {
      v: 1 as const,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'qwen-fast',
      },
    };
    const bootstrapCleanup = vi.fn(async () => undefined);
    const bootstrapStart = vi.fn(async (options?: Readonly<{
      prepareSession?: (session: ApiSessionClient) => void | Promise<void>;
    }>) => {
      await options?.prepareSession?.(harness.session);
    });
    const bootstrapPushSender = {
      sendToAllDevices: vi.fn(() => undefined),
      sendToAllDevicesAsync: vi.fn(async () => true),
    };
    let currentPermissionMode: PermissionMode | undefined;
    let currentPermissionModeUpdatedAt = 0;
    const writeRuntimeOverrides = vi.fn();
    const runSessionLoopLifecycleFn = vi.fn(async (params: any) => {
      await params.config.onAfterStart?.({
        session: params.session,
        runtime: params.hookRuntime,
      });
      params.permissionModeState.setCurrentPermissionMode('yolo');
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(999);
      await params.transitionModelSelection({
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'qwen-live',
      }, 'command');
    });
    const initializeBackendApiContextFn = vi.fn(harness.deps.initializeBackendApiContextFn);
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);

    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.deps.initializeBackendApiContextFn = initializeBackendApiContextFn;
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      currentPermissionMode = params.initialPermissionMode;
      return {
        messageQueue: harness.queue,
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => currentPermissionMode,
        setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
          currentPermissionMode = mode;
        },
        getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
        setCurrentPermissionModeUpdatedAt: (updatedAt: number) => {
          currentPermissionModeUpdatedAt = updatedAt;
        },
      };
    };
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({ status: 'applied' });
    harness.opts.permissionMode = 'acceptEdits';
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: async () => resolvedModelSelection,
    };
    harness.session.getMetadataSnapshot = () => null;
    type StartupBootstrapCreate = NonNullable<
      HostSessionRuntimeConfig['startupBootstrap']
    >['create'];
    const createBootstrap = vi.fn<StartupBootstrapCreate>(async (params) => {
      expect(params.seed).toEqual({
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: expect.any(Number),
        permissionModeSource: 'explicit',
        modelSelection: resolvedModelSelection,
      });
      return {
        api: {
          push: () => bootstrapPushSender,
        },
        session: harness.session,
        machineId: 'bootstrap-machine',
        metadata: {
          host: 'host',
          homeDir: '/tmp',
          happyHomeDir: '/tmp/.happy',
          happyLibDir: '/tmp/lib',
          happyToolsDir: '/tmp/tools',
          path: '/tmp/bootstrap-workspace',
          permissionMode: 'acceptEdits' as const,
          permissionModeUpdatedAt: Date.now(),
        },
        attachedToExistingSession: false,
        reconnectionHandle: null,
        start: bootstrapStart,
        cleanup: bootstrapCleanup,
      };
    });
    harness.config.startupBootstrap = {
      create: createBootstrap,
      writeRuntimeOverrides,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runSessionLoopLifecycleFn).toHaveBeenCalledTimes(1);
    const lifecycleParams = runSessionLoopLifecycleFn.mock.calls[0]?.[0] as Readonly<{
      session: Readonly<{ sessionId: string }>;
      runtimeMetadata: Readonly<{ path?: string }>;
      machineId: string;
      startupCoordinator: Readonly<{
        start: () => Promise<void>;
        cleanup: unknown;
      }> | null;
    }> | undefined;
    expect(lifecycleParams?.session.sessionId).toBe(harness.session.sessionId);
    expect(lifecycleParams?.runtimeMetadata).toEqual(expect.objectContaining({ path: '/tmp/bootstrap-workspace' }));
    expect(lifecycleParams?.machineId).toBe('bootstrap-machine');
    expect(lifecycleParams?.startupCoordinator).toEqual(expect.objectContaining({
      start: null,
      cleanup: bootstrapCleanup,
    }));
    expect(bootstrapStart).toHaveBeenCalledWith({
      prepareSession: expect.any(Function),
    });
    expect(initializeBackendApiContextFn).not.toHaveBeenCalled();
    expect(initializeBackendRunSessionFn).not.toHaveBeenCalled();
    expect(createBootstrap).toHaveBeenCalledOnce();
    expect(writeRuntimeOverrides).toHaveBeenLastCalledWith({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 999,
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'qwen-live',
        },
      },
    });
  });

  it('does not construct the provider runtime when deferred Session startup fails', async () => {
    const harness = createHarness();
    const startupFailure = Object.assign(new Error('durable Session unavailable'), {
      code: 'backend_run_session_unavailable' as const,
    });
    const createSessionRuntime = vi.fn(harness.config.createSessionRuntime!);
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.config.startupBootstrap = {
      create: async () => ({
        api: { push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }) },
        session: harness.session,
        machineId: 'machine-1',
        metadata: { path: '/tmp/workspace' } as never,
        attachedToExistingSession: false,
        reconnectionHandle: null,
        start: async () => { throw startupFailure; },
      }),
    };

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(startupFailure);

    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('constructs the provider runtime only after the real Session owns durable delivery', async () => {
    const harness = createHarness();
    const realSession = harness.session;
    const deferredSession = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-1234',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const createSessionRuntime = vi.fn((params: { session: ApiSessionClient }) => {
      expect(params.session.sessionId).toBe('session-1');
      expect(params.session.sessionId).not.toMatch(/^PID-/);
      expect(params.session.deactivateDurableMutationDelivery).toBeTypeOf('function');
      expect(realSession.activateDurableMutationDelivery).toHaveBeenCalledOnce();
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });
    harness.config.createSessionRuntime = createSessionRuntime as never;
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async ({ session }: {
      session: ApiSessionClient;
    }) => {
      expect(session.sessionId).toBe('session-1');
      expect(session.deactivateDurableMutationDelivery).toBeTypeOf('function');
    });
    harness.config.startupBootstrap = {
      create: async () => ({
        api: { push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }) },
        session: deferredSession as unknown as ApiSessionClient,
        machineId: 'machine-1',
        metadata: { path: '/tmp/workspace' } as never,
        attachedToExistingSession: false,
        reconnectionHandle: null,
        start: async (options) => {
          await deferredSession.attach(realSession, {
            beforeBufferedDrain: async () => {
              await options?.prepareSession?.(realSession);
            },
          });
        },
      }),
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionRuntime).toHaveBeenCalledOnce();
  });

  it('accepts an ordinary Session stop before deferred attachment and terminalizes before Agent admission', async () => {
    const harness = createHarness();
    const deferredSession = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-stop-before-attach',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    let continueAttachment!: () => void;
    const attachmentGate = new Promise<void>((resolve) => {
      continueAttachment = resolve;
    });
    let requestStop!: () => Promise<void>;
    const createSessionRuntime = vi.fn(harness.config.createSessionRuntime!);
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.config.onRuntimeStopReady = (stop) => {
      requestStop = stop;
    };
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.config.startupBootstrap = {
      create: async () => ({
        api: { push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }) },
        session: deferredSession as unknown as ApiSessionClient,
        machineId: 'machine-1',
        metadata: { path: '/tmp/workspace' } as never,
        attachedToExistingSession: true,
        reconnectionHandle: null,
        start: async (options) => {
          await attachmentGate;
          await deferredSession.attach(harness.session, {
            beforeBufferedDrain: async () => {
              await options?.prepareSession?.(harness.session);
            },
          });
        },
      }),
    };

    const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => expect(requestStop).toBeTypeOf('function'));
    const stopping = requestStop();
    const repeatedStopping = requestStop();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    continueAttachment();

    await expect(Promise.all([stopping, repeatedStopping])).resolves.toEqual([undefined, undefined]);
    await expect(running).resolves.toBeUndefined();
    expect(harness.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('preserves native return identity when Stop arrives during MCP preparation before Agent admission', async () => {
    const harness = createHarness();
    const home = await mkdtemp(join(tmpdir(), 'native-return-stopped-startup-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const mcpStarted = createDeferred<void>();
    const releaseMcp = createDeferred<void>();
    let requestStop!: () => Promise<void>;
    const resumeId = 'native-return-before-admission';
    const createSessionRuntime = vi.fn(harness.config.createSessionRuntime!);
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';
    harness.config.providerSessionMetadataKey = 'claudeSessionId';
    harness.opts.resume = resumeId;
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.config.onRuntimeStopReady = stop => { requestStop = stop; };
    harness.deps.resolveRunnerMcpServersFn = async () => {
      mcpStarted.resolve();
      await releaseMcp.promise;
      return { happierMcpServer: { stop() {} }, mcpServers: {} };
    };
    try {
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      const { createLocalAgentNativeResumeRecordStore } = await import('@/session/agentTransition/agentNativeReturn');
      const { resolveVendorResumeIdForExistingSession } = await import('@/daemon/spawn/resolveVendorResumeIdForExistingSession');
      const store = createLocalAgentNativeResumeRecordStore();
      const key = { happierSessionId: harness.session.sessionId, agentId: 'claude' as const };
      const record = { identity: { v: 1 as const, vendorResumeId: resumeId }, departureSeqInclusive: 12 };
      await store.writeAgentNativeResumeRecord({ ...key, ...record });
      await harness.session.updateMetadata((metadata: Metadata) => ({ ...metadata, flavor: 'claude', claudeSessionId: resumeId }));
      const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await mcpStarted.promise;
      const stopping = requestStop();
      releaseMcp.resolve();
      await Promise.all([running, stopping]);
      expect(createSessionRuntime).not.toHaveBeenCalled();
      expect(harness.session.endSessionAndClose).toHaveBeenCalledOnce();
      expect(harness.session.getMetadataSnapshot().claudeSessionId).toBe(resumeId);
      expect(resolveVendorResumeIdForExistingSession({ agent: 'claude', credentials: null,
        rawSession: {}, metadataRecord: harness.session.getMetadataSnapshot() })).toBe(resumeId);
      await expect(store.readAgentNativeResumeRecord(key)).resolves.toEqual(record);
    } finally {
      releaseMcp.resolve();
      envScope.restore();
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(['generic', 'identity_mismatch'] as const)('changes tracked native return identity only for proven resume failure (%s)', async failureKind => {
    const harness = createHarness();
    const home = await mkdtemp(join(tmpdir(), 'native-return-startup-failure-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const resumeId = 'native-return-startup-failure';
    const failure = Object.assign(new Error('Native startup failed'),
      failureKind === 'identity_mismatch' ? { happierNativeResumeIdentityMismatch: true } : {});
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';
    harness.config.providerSessionMetadataKey = 'claudeSessionId';
    harness.opts.resume = resumeId;
    setSessionRuntimeFactory(harness.config, () => { throw failure; });
    try {
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      const { createLocalAgentNativeResumeRecordStore } = await import('@/session/agentTransition/agentNativeReturn');
      const { resolveVendorResumeIdForExistingSession } = await import('@/daemon/spawn/resolveVendorResumeIdForExistingSession');
      const store = createLocalAgentNativeResumeRecordStore();
      const key = { happierSessionId: harness.session.sessionId, agentId: 'claude' as const };
      const record = { identity: { v: 1 as const, vendorResumeId: resumeId }, departureSeqInclusive: 12 };
      await store.writeAgentNativeResumeRecord({ ...key, ...record });
      await harness.session.updateMetadata((metadata: Metadata) => ({ ...metadata, flavor: 'claude', claudeSessionId: resumeId }));
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(failure);
      const expectedIdentity = failureKind === 'identity_mismatch' ? null : resumeId;
      expect(harness.session.getMetadataSnapshot().claudeSessionId ?? null).toBe(expectedIdentity);
      expect(resolveVendorResumeIdForExistingSession({ agent: 'claude', credentials: null,
        rawSession: {}, metadataRecord: harness.session.getMetadataSnapshot() })).toBe(expectedIdentity);
      await expect(store.readAgentNativeResumeRecord(key)).resolves.toEqual(
        failureKind === 'identity_mismatch' ? null : record,
      );
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('releases pre-runtime durable custody when the provider runtime factory fails', async () => {
    loggerDebugMock.mockClear();
    const harness = createHarness();
    harness.config.policyAgentId = 'grok';
    const factoryFailure = new Error('provider factory failed before runtime ownership');
    const reconnectionCancel = vi.fn(() => {
      throw new Error('private reconnection cleanup failure');
    });
    const stopMcpServer = vi.fn(() => {
      throw new Error('private MCP cleanup failure');
    });
    const bootstrapCleanup = vi.fn(async () => {
      throw new Error('private bootstrap cleanup failure');
    });
    const unsubscribeExecutionRunActivity = vi.fn();
    const deferredSession = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-5678',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    let metadataObserverSignal: AbortSignal | undefined;
    harness.session.subscribeExecutionRunActivitySnapshots = vi.fn(
      () => unsubscribeExecutionRunActivity,
    );
    harness.session.waitForMetadataUpdate = vi.fn(async (signal?: AbortSignal) => {
      metadataObserverSignal = signal;
      return false;
    });
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: stopMcpServer },
      mcpServers: {},
    }));
    harness.config.createSessionRuntime = vi.fn(async () => {
      throw factoryFailure;
    });
    harness.config.startupBootstrap = {
      create: async () => ({
        api: { push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }) },
        session: deferredSession as unknown as ApiSessionClient,
        machineId: 'machine-1',
        metadata: { path: '/tmp/workspace' } as never,
        attachedToExistingSession: false,
        reconnectionHandle: { cancel: reconnectionCancel },
        start: async (options) => {
          await deferredSession.attach(harness.session, {
            beforeBufferedDrain: async () => {
              await options?.prepareSession?.(harness.session);
            },
          });
        },
        cleanup: bootstrapCleanup,
      }),
    };

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(factoryFailure);

    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.session.endSessionAndClose).not.toHaveBeenCalled();
    expect(reconnectionCancel).toHaveBeenCalledOnce();
    expect(stopMcpServer).toHaveBeenCalledOnce();
    expect(bootstrapCleanup).toHaveBeenCalledOnce();
    expect(unsubscribeExecutionRunActivity).toHaveBeenCalledOnce();
    expect(metadataObserverSignal?.aborted).toBe(true);
    expect(JSON.stringify(loggerDebugMock.mock.calls)).not.toContain('private');
  });

  it('disposes the constructed runtime when post-factory authority reconciliation fails', async () => {
    const harness = createHarness();
    const reconciliationFailure = new Error(
      'active model authority reconciliation failed',
    );
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.session.updateMetadataAsCurrentPublisher = vi.fn(async () => {
      throw reconciliationFailure;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(reconciliationFailure);

    expect(harness.runtime.resetOrDisposeRuntime).toHaveBeenCalledOnce();
    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.session.endSessionAndClose).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('uses the resolved startup seed for the synchronous path when deferred creation is ineligible', async () => {
    const harness = createHarness();
    const lifecycleModelSelection = {
      v: 1 as const,
      updatedAt: 120,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'qwen-account',
      },
    };
    const cachedModelSelection = {
      v: 1 as const,
      updatedAt: 121,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'qwen-released-cache',
      },
    };
    const createSessionMetadataFn = vi.fn(harness.deps.createSessionMetadataFn);
    const initializeBackendRunSessionFn = vi.fn(harness.deps.initializeBackendRunSessionFn);
    const createBootstrap = vi.fn();
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: async () => lifecycleModelSelection,
    };
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => ({
        ...seed,
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 122,
        permissionModeSource: 'released_cache_v1',
        modelSelection: cachedModelSelection,
      }),
      shouldCreate: () => false,
      create: createBootstrap,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createBootstrap).not.toHaveBeenCalled();
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 122,
      modelSelectionIntent: {
        v: 1,
        updatedAt: 121,
        selection: cachedModelSelection.ref,
      },
    }));
    expect(initializeBackendRunSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      startupMetadataOverrides: {
        permissionModeOverride: {
          mode: 'safe-yolo',
          updatedAt: 122,
        },
        modelOverride: {
          v: 1,
          updatedAt: 121,
          selection: cachedModelSelection.ref,
        },
      },
    }));
  });

  it('commits a fallback-derived live permission override only after its paired timestamp update', async () => {
    const harness = createHarness();
    const writeRuntimeOverrides = vi.fn();
    let fallbackSeed:
      | Readonly<{ permissionMode: PermissionMode; permissionModeUpdatedAt: number }>
      | null = null;
    let currentPermissionMode: PermissionMode | undefined;
    let currentPermissionModeUpdatedAt = 0;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      currentPermissionMode = params.initialPermissionMode;
      return {
        messageQueue: harness.queue,
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => currentPermissionMode,
        setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
          currentPermissionMode = mode;
        },
        getCurrentPermissionModeUpdatedAt: () => currentPermissionModeUpdatedAt,
        setCurrentPermissionModeUpdatedAt: (updatedAt: number) => {
          currentPermissionModeUpdatedAt = updatedAt;
        },
      };
    };
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => {
        fallbackSeed = seed;
        return seed;
      },
      shouldCreate: () => false,
      create: vi.fn(),
      writeRuntimeOverrides,
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.config.onAfterStart?.({
        session: params.session,
        runtime: params.hookRuntime,
      });
      if (!fallbackSeed) throw new Error('expected fallback startup seed');
      params.permissionModeState.setCurrentPermissionMode(fallbackSeed.permissionMode);
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(
        fallbackSeed.permissionModeUpdatedAt,
      );
      expect(writeRuntimeOverrides).not.toHaveBeenCalled();

      params.permissionModeState.setCurrentPermissionMode('yolo');
      expect(writeRuntimeOverrides).not.toHaveBeenCalled();
      params.permissionModeState.setCurrentPermissionModeUpdatedAt(
        fallbackSeed.permissionModeUpdatedAt + 1,
      );
      expect(writeRuntimeOverrides).toHaveBeenCalledWith(expect.objectContaining({
        permissionMode: 'yolo',
        permissionModeUpdatedAt: fallbackSeed.permissionModeUpdatedAt + 1,
      }));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(writeRuntimeOverrides).toHaveBeenCalledOnce();
  });

  it('persists an authoritative account-default startup override', async () => {
    const harness = createHarness();
    const writeRuntimeOverrides = vi.fn();
    harness.config.startupBootstrap = {
      resolveSeed: ({ seed }) => ({
        ...seed,
        permissionModeSource: 'account_default',
      }),
      shouldCreate: () => false,
      create: vi.fn(),
      writeRuntimeOverrides,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(writeRuntimeOverrides).toHaveBeenCalledOnce();
  });

  it('uses default ready sender and runs lifecycle hooks', async () => {
    const harness = createHarness();

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.beforeInitializeCalls).toBe(1);
    expect(harness.metrics.onAfterStartCalls).toBe(1);
    expect(harness.metrics.onAfterResetCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(1);
    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it('persists shared runtime publication events into session metadata during the host session lifecycle', async () => {
    const harness = createHarness();
    // Host-owned identity facts travel the typed host-private publication
    // channel, not a `{ type: 'event', name: 'runtime.*' }` pseudo-event beside
    // the canonical Agent Session event union.
    // Apply every metadata update once, in real order, the way a session
    // client does. Replaying captured updaters after the run re-enters
    // publication closures that already advanced their own state, so the
    // reconstruction — not the publication — decides the result.
    let liveMetadata: Record<string, unknown> = harness.session.getMetadataSnapshot();
    harness.session.updateMetadata = vi.fn(
      async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
        liveMetadata = updater(liveMetadata);
      },
    );
    const identityPublicationHandlers = new Set<(publication: unknown) => void>();
    harness.runtime.subscribeRuntimeIdentityPublication = vi.fn(
      (handler: (publication: unknown) => void) => {
        identityPublicationHandlers.add(handler);
        return () => {
          identityPublicationHandlers.delete(handler);
        };
      },
    );
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      for (const handler of identityPublicationHandlers) handler({
        fact: 'runtimeDescriptor',
        value: {
          v: 1,
          agentId: 'acme.provider',
          agent: {
            backendMode: 'native',
          },
        },
      });
      for (const handler of identityPublicationHandlers) handler({
        fact: 'runtimeCapabilities',
        value: {
          backend: {
            sessions: {
              supported: true,
            },
          },
        },
      });
      for (const handler of identityPublicationHandlers) handler({
        fact: 'runtimeFacets',
        value: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      });
      await params.onAfterStart?.();
      await params.onAfterReset?.();
      params.sendReady();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const resultingMetadata = liveMetadata;

    expect(resultingMetadata.runtimeDescriptorV1).toEqual({
      v: 1,
      agentId: 'acme.provider',
      agent: {
        backendMode: 'native',
      },
    });
    expect(resultingMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(resultingMetadata.agentRuntimeCapabilitiesV1).toMatchObject({
      backend: {
        sessions: {
          supported: true,
        },
      },
    });
    expect(resultingMetadata.agentRuntimeFacetsV1).toEqual({
      v: 1,
      transcriptSource: {
        supported: true,
      },
    });
  });

  it('passes eager runtime start through to the permission loop when configured', async () => {
    const harness = createHarness();
    harness.config.startRuntimeBeforeFirstPrompt = true;

    let capturedStartRuntimeBeforeFirstPrompt: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (params: unknown) => {
      capturedStartRuntimeBeforeFirstPrompt = (
        params as Readonly<{ startRuntimeBeforeFirstPrompt?: boolean }>
      ).startRuntimeBeforeFirstPrompt;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedStartRuntimeBeforeFirstPrompt).toBe(true);
  });

  it('runs terminal remote switching through the shared lifecycle when the session factory binds a mode loop', async () => {
    const harness = createHarness();
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async () => 0);
    const modeLoop = {
      startingMode: 'remote' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runTerminalRemoteSessionModeLoopFn).toHaveBeenCalledWith(expect.objectContaining({
      startingMode: 'remote',
      remoteExitCode: 0,
      runTerminal: expect.any(Function),
      runRemote: expect.any(Function),
    }));
  });

  it('does not infer terminal remote switching from runtime method presence', async () => {
    const harness = createHarness();
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async () => 0);
    (
      harness.runtime as unknown as Record<string, unknown>
    ).resolveTerminalRemoteSessionModeLoop = () => createTerminalRemoteModeLoopFixture();
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runTerminalRemoteSessionModeLoopFn).not.toHaveBeenCalled();
  });

  it('defers server pending materialization while the primary runtime turn is active', async () => {
    const harness = createHarness();
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));

    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      harness.runtime.emitRuntimeMessage({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 123,
        startedBy: 'host',
      });

      await expect(params.beforePendingMaterialize?.()).resolves.toBe(false);

      harness.runtime.emitRuntimeMessage({
        kind: 'turn-complete',
        sequence: 2,
        sessionId: 'session-1',
        turnId: 'turn-1',
        agentTurnId: 'provider-turn-1',
        emittedAtMs: 456,
      });

      await expect(params.beforePendingMaterialize?.()).resolves.toBe(true);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('defers server pending materialization while an exclusive terminal turn is active', async () => {
    const harness = createHarness();
    const publishedStates: Array<Record<string, unknown>> = [];
    const emptyAgentState: Record<string, unknown> = {};
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 2);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 2, pendingVersion: 1 }));
    harness.session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const next = updater(publishedStates.at(-1) ?? emptyAgentState);
      publishedStates.push(next);
    });

    let resolveModeLoop: ((value: number) => void) | null = null;
    const modeLoopDone = new Promise<number>((resolve) => {
      resolveModeLoop = resolve;
    });
    let resolveActiveTurnObserved: (() => void) | null = null;
    const activeTurnObserved = new Promise<void>((resolve) => {
      resolveActiveTurnObserved = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        turnId: 'turn-active',
        emittedAtMs: 1,
        startedBy: 'host',
      });
      resolveActiveTurnObserved?.();
      return await modeLoopDone;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      try {
        await activeTurnObserved;
        expect(params.beforePendingMaterialize).toBeTypeOf('function');
        const allowed = await params.beforePendingMaterialize?.();
        expect(allowed).toBe(false);
      } finally {
        resolveModeLoop?.(0);
      }
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(publishedStates.some((state) => 'pendingHandoffV1' in ((state.terminalControl as Record<string, unknown> | undefined) ?? {}))).toBe(false);
    expect(harness.session.updateAgentState).not.toHaveBeenCalled();
  });

  it('does not inspect server pending rows when local pending state is empty', async () => {
    const harness = createHarness();
    harness.session.shouldAttemptPendingMaterialization = vi.fn(() => false);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 0, pendingVersion: 4 }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => {
      throw new Error('server pending queue should not be inspected for empty local state');
    });

    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.peekPendingMessageQueueV2Count).not.toHaveBeenCalled();
  });

  it('does not treat terminal attachment itself as an active terminal turn for pending handoff', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({ ok: true }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let terminalIterationStarted: (() => void) | null = null;
    const terminalIteration = new Promise<void>((resolve) => {
      terminalIterationStarted = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      terminalIterationStarted?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalIteration;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith('pending_queue_after_terminal_boundary');
  });

  it('requests a graceful remote handoff before pending materialization after an exclusive terminal boundary', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({ ok: true }));
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let resolveTerminalBoundary: (() => void) | null = null;
    const terminalBoundary = new Promise<void>((resolve) => {
      resolveTerminalBoundary = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
      runTerminal: (params: { entry: 'initial' | 'switch' }) => Promise<{ type: 'switch' } | { type: 'exit'; code: number }>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        turnId: 'turn-boundary',
        emittedAtMs: 1,
        startedBy: 'host',
      });
      harness.runtime.emitRuntimeMessage?.({
        kind: 'turn-complete',
        sequence: 2,
        sessionId: 'session-1',
        turnId: 'turn-boundary',
        emittedAtMs: 2,
      });
      await opts.runTerminal({ entry: 'initial' });
      resolveTerminalBoundary?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalBoundary;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledWith('pending_queue_after_terminal_boundary');
  });

  it('does not silently retry a failed terminal handoff while pending rows remain queued', async () => {
    const harness = createHarness();
    const requestGracefulRemoteHandoff = vi.fn(async () => ({
      ok: false,
      detail: 'switch handler unavailable',
    }));
    const publishedStates: Array<Record<string, unknown>> = [];
    const emptyAgentState: Record<string, unknown> = {};
    harness.session.peekPendingMessageQueueV2Count = vi.fn(async () => 1);
    harness.session.getPendingQueueState = vi.fn(() => ({ known: true, pendingCount: 1, pendingVersion: 1 }));
    harness.session.updateAgentState = vi.fn(async (
      updater: (state: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const next = updater(publishedStates.at(-1) ?? emptyAgentState);
      publishedStates.push(next);
    });
    harness.runtime.getSessionId = vi.fn(() => 'runtime-session-1');

    let resolveTerminalBoundary: (() => void) | null = null;
    const terminalBoundary = new Promise<void>((resolve) => {
      resolveTerminalBoundary = resolve;
    });
    const runTerminalRemoteSessionModeLoopFn = vi.fn(async (opts: Readonly<{
      onBeforeIteration?: (mode: 'terminal' | 'remote') => void | Promise<void>;
    }>) => {
      await opts.onBeforeIteration?.('terminal');
      harness.runtime.emitRuntimeMessage?.({
        kind: 'turn-start',
        sequence: 1,
        sessionId: 'session-1',
        turnId: 'turn-failed-switch',
        emittedAtMs: 1,
        startedBy: 'host',
      });
      harness.runtime.emitRuntimeMessage?.({
        kind: 'turn-complete',
        sequence: 2,
        sessionId: 'session-1',
        turnId: 'turn-failed-switch',
        emittedAtMs: 2,
      });
      resolveTerminalBoundary?.();
      return 0;
    });
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      requestGracefulRemoteHandoff,
      runTerminal: vi.fn(async () => ({ type: 'switch' } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      beforePendingMaterialize?: () => boolean | Promise<boolean>;
    }>) => {
      await terminalBoundary;
      expect(await params.beforePendingMaterialize?.()).toBe(false);
      expect(await params.beforePendingMaterialize?.()).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(requestGracefulRemoteHandoff).toHaveBeenCalledTimes(1);
    expect(publishedStates.some((state) => 'pendingHandoffV1' in ((state.terminalControl as Record<string, unknown> | undefined) ?? {}))).toBe(false);
    expect(JSON.stringify(publishedStates)).not.toContain('switch handler unavailable');
  });

  it('surfaces terminal remote mode loop errors after the prompt loop exits first', async () => {
    const harness = createHarness();
    const modeLoopError = new Error('mode loop failed after prompt exit');
    const modeLoopControl: { reject?: (error: Error) => void } = {};
    const runTerminalRemoteSessionModeLoopFn = vi.fn(() => new Promise<number>((_resolve, reject) => {
      modeLoopControl.reject = reject;
    }));
    const modeLoop = {
      startingMode: 'terminal' as const,
      remoteExitCode: 0,
      runTerminal: vi.fn(async () => ({ type: 'exit', code: 0 } as const)),
      runRemote: vi.fn(async () => 'exit' as const),
      onModeChange: vi.fn(),
    };
    setTerminalRemoteModeLoop(harness.config, modeLoop);
    harness.deps.runPermissionModePromptLoopFn = async () => undefined;
    harness.deps.sessionLoopLifecycleDeps = {
      runTerminalRemoteSessionModeLoopFn,
    };

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    await vi.waitFor(() => {
      expect(runTerminalRemoteSessionModeLoopFn).toHaveBeenCalledOnce();
      expect(modeLoopControl.reject).toBeTypeOf('function');
    });
    modeLoopControl.reject?.(modeLoopError);

    await expect(runPromise).rejects.toBe(modeLoopError);
  });

  it('applies lifecycle hook initial model resolution before creating session metadata', async () => {
    const harness = createHarness();
    let capturedModelSelectionIntent: unknown;
    harness.config.lifecycleHooks = {
      // A native selection keeps this case on the metadata-creation ordering it owns;
      // a provider-bound selection additionally requires its validated binding handoff,
      // which the provider-binding ingress cases above cover.
      resolveInitialModelSelection: async () => ({
        v: 1,
        updatedAt: 123,
        ref: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'gemini-2.5-pro',
        },
      }),
    };
    harness.deps.createSessionMetadataFn = (params: Readonly<{ modelSelectionIntent?: unknown }>) => {
      capturedModelSelectionIntent = params.modelSelectionIntent;
      return {
        state: { controlledByUser: false },
        metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedModelSelectionIntent).toEqual({
      v: 1,
      updatedAt: 123,
      selection: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'gemini-2.5-pro',
      },
    });
  });

  it('passes the requested directory into session metadata creation', async () => {
    const harness = createHarness();
    Object.assign(harness.opts, { directory: '/tmp/requested-workspace' });
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/requested-workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/requested-workspace',
    }));
  });

  it('forwards provider-specific initialize-session options into shared session setup', async () => {
    const harness = createHarness();
    harness.config.initializeSession = {
      startupSideEffectsOrder: 'persist-first',
    };

    let capturedStartupSideEffectsOrder: 'report-first' | 'persist-first' | undefined;
    harness.deps.initializeBackendRunSessionFn = async ({ startupSideEffectsOrder }: any) => {
      capturedStartupSideEffectsOrder = startupSideEffectsOrder;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedStartupSideEffectsOrder).toBe('persist-first');
  });

  it.each(['ordinary', 'deferred'] as const)('runs the session-initialized lifecycle hook before runtime creation (%s)', async startup => {
    const harness = createHarness();
    const callOrder: string[] = [];
    let startupSignal: AbortSignal | undefined;
    harness.config.lifecycleHooks = {
      onSessionInitialized: async ({ attachedToExistingSession, session, signal }) => {
        startupSignal = signal;
        expect(signal.aborted).toBe(false);
        callOrder.push(`initialized:${attachedToExistingSession}:${session.sessionId}`);
      },
    };
    harness.deps.initializeBackendRunSessionFn = async () => {
      callOrder.push('session-created');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };
    if (startup === 'deferred') {
      harness.config.startupBootstrap = { create: async () => ({
        api: { push: () => null }, session: harness.session, machineId: 'machine-1',
        metadata: createTestMetadata({ path: '/tmp/workspace' }), attachedToExistingSession: true,
        reconnectionHandle: null,
        start: async options => {
          callOrder.push('session-created');
          await options?.prepareSession?.(harness.session);
        },
      }) };
    }
    setSessionRuntimeFactory(harness.config, () => {
      callOrder.push('runtime-created');
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(callOrder).toEqual([
      'session-created',
      'initialized:true:session-1',
      'runtime-created',
    ]);
    expect(startupSignal?.aborted).toBe(true);
  });

  it.each(['initialization-hook', 'runtime-construction'] as const)('retires initialized startup admission after %s failure', async failure => {
    const harness = createHarness();
    const failureCause = new Error('startup-admission-failure');
    let startupSignal: AbortSignal | undefined;
    let admissionRetired = false;
    harness.config.lifecycleHooks = {
      onSessionInitialized: async ({ signal }) => {
        startupSignal = signal;
        signal.addEventListener('abort', () => { admissionRetired = true; }, { once: true });
        if (failure === 'initialization-hook') throw failureCause;
      },
    };
    setSessionRuntimeFactory(harness.config, () => { throw failureCause; });

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(failureCause);

    expect(startupSignal?.aborted).toBe(true);
    expect(admissionRetired).toBe(true);
  });

  it('does not create the provider runtime while backend session initialization is pending', async () => {
    const harness = createHarness();
    let resolveInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    });
    const initializeBackendRunSessionFn = vi.fn(async () => {
      await initializationGate;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(initializeBackendRunSessionFn).toHaveBeenCalledOnce();
      expect(createSessionRuntime).not.toHaveBeenCalled();
    });

    resolveInitialization();
    await runPromise;
    expect(createSessionRuntime).toHaveBeenCalledOnce();
  });

  it('waits for exact external-linked admission before runtime-side effects', async () => {
    const harness = createHarness();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'external-linked-admission-ordering',
    });
    harness.opts.sessionCreationTag = sessionCreationTag;
    harness.opts.sessionCreationCorrespondence =
      SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp/workspace' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.qwen', localId: 'qwen' },
          },
          modelSelection: null,
          profileId: null,
          requestedPermissionMode: null,
          agentModeId: null,
          configuration: null,
          connectedServices: null,
          capabilitySelection: null,
          transcriptStorage: null,
          terminal: null,
          agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        },
      });
    const admission = createDeferred<void>();
    const admit = vi.fn(async (correlation) => {
      expect(correlation).toEqual({
        mode: 'external_linked',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        publisherPrecondition: {
          machineId: 'machine-1',
          committedFenceMs: 1,
          publisherGeneration: '1',
        },
      });
      expect(
        harness.handlers.has(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION),
      ).toBe(false);
      expect(
        harness.session.activateDurableMutationDelivery,
      ).not.toHaveBeenCalled();
      await admission.promise;
    });
    harness.opts.persistedTakeoverAdmission = {
      mode: 'external_linked',
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.deps.reportPersistedTakeoverRuntimeBoundFn =
      vi.fn(async () => undefined);
    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: {},
    }));
    harness.deps.resolveRunnerMcpServersFn = resolveRunnerMcpServersFn;
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(admit).toHaveBeenCalledOnce();
      expect(createSessionRuntime).not.toHaveBeenCalled();
    });
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
    expect(harness.session.activateDurableMutationDelivery).not.toHaveBeenCalled();
    expect(resolveRunnerMcpServersFn).not.toHaveBeenCalled();
    expect(harness.metrics.defaultReadyCalls).toBe(0);

    admission.resolve();
    await runPromise;

    expect(createSessionRuntime).toHaveBeenCalledOnce();
    expect(harness.session.activateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(createSessionRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({
        persistedTakeoverAdmission: expect.anything(),
      }),
    );
  });

  it('reports runtime_bound after required host bindings and before the long-lived loop', async () => {
    const harness = createHarness();
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'runtime-bound-ordering',
    });
    harness.opts.sessionCreationTag = sessionCreationTag;
    harness.opts.sessionCreationCorrespondence =
      SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp/workspace' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.qwen', localId: 'qwen' },
          },
          modelSelection: null,
          profileId: null,
          requestedPermissionMode: null,
          agentModeId: null,
          configuration: null,
          connectedServices: null,
          capabilitySelection: null,
          transcriptStorage: null,
          terminal: null,
          agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        },
      });
    const runtimeBound = createDeferred<void>();
    const reportRuntimeBound = vi.fn(async (correlation) => {
      expect(correlation).toEqual({
        mode: 'persisted',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        publisherPrecondition: {
          machineId: 'machine-1',
          committedFenceMs: 1,
          publisherGeneration: '1',
        },
      });
      expect(harness.session.setSessionRuntimeControls).toHaveBeenCalledOnce();
      await runtimeBound.promise;
    });
    harness.opts.persistedTakeoverAdmission = {
      mode: 'persisted',
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = vi.fn(async () => undefined);
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = reportRuntimeBound;
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    setSessionRuntimeFactory(harness.config, vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    })));

    const runPromise = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await vi.waitFor(() => {
      expect(reportRuntimeBound).toHaveBeenCalledOnce();
      expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
    });
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();

    runtimeBound.resolve();
    await runPromise;
    expect(runSessionLoopLifecycleFn).toHaveBeenCalledOnce();
  });

  it('does not enter the long-lived loop when runtime_bound remains ambiguous', async () => {
    const harness = createHarness();
    const ambiguousFailure = new Error(
      'persisted takeover runtime_bound response remained ambiguous',
    );
    harness.opts.persistedTakeoverAdmission = {
      mode: 'persisted',
      operationId: 'operation-1',
      attemptId: 'attempt-1',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn =
      vi.fn(async () => undefined);
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = vi.fn(async () => {
      throw ambiguousFailure;
    });
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(ambiguousFailure);

    expect(createSessionRuntime).toHaveBeenCalledOnce();
    expect(harness.session.setSessionRuntimeControls).toHaveBeenCalledOnce();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('consumes the one-shot persisted-takeover environment handoff even when an injected correlation wins', async () => {
    const previousAdmission =
      process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
    process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
      serializePersistedTakeoverAdmissionForEnv({
        mode: 'persisted',
        operationId: 'stale-operation',
        attemptId: 'stale-attempt',
      });
    try {
      const harness = createHarness();
      const admit = vi.fn(async () => undefined);
      harness.opts.persistedTakeoverAdmission = {
        mode: 'persisted',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
      };
      harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
      harness.deps.reportPersistedTakeoverRuntimeBoundFn =
        vi.fn(async () => undefined);

      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(admit).toHaveBeenCalledWith({
        mode: 'persisted',
        operationId: 'operation-1',
        attemptId: 'attempt-1',
        publisherPrecondition: {
          machineId: 'machine-1',
          committedFenceMs: 1,
          publisherGeneration: '1',
        },
      });
      expect(
        process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY],
      ).toBeUndefined();
    } finally {
      if (previousAdmission === undefined) {
        delete process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY];
      } else {
        process.env[HAPPIER_PERSISTED_TAKEOVER_ADMISSION_ENV_KEY] =
          previousAdmission;
      }
    }
  });

  it('opens no native runtime when persisted-takeover admission fails ambiguously', async () => {
    const harness = createHarness();
    const ambiguousFailure = new Error('persisted takeover admission response was ambiguous');
    const admit = vi.fn(async () => {
      throw ambiguousFailure;
    });
    harness.opts.persistedTakeoverAdmission = {
      mode: 'persisted',
      operationId: 'operation-2',
      attemptId: 'attempt-2',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.session.materializeNextPendingMessageSafely = vi.fn(async () => ({
      type: 'no_pending' as const,
    }));
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(ambiguousFailure);

    expect(admit).toHaveBeenCalledOnce();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(harness.session.materializeNextPendingMessageSafely).not.toHaveBeenCalled();
    expect(harness.session.wakePendingMaterialization).not.toHaveBeenCalled();
    expect(harness.session.sendAgentMessage).not.toHaveBeenCalled();
    expect(harness.metrics.defaultReadyCalls).toBe(0);
  });

  it('fails closed as upgrade-required when the daemon reports persisted-takeover admission unsupported', async () => {
    const harness = createHarness();
    harness.opts.persistedTakeoverAdmission = {
      mode: 'persisted',
      operationId: 'operation-3',
      attemptId: 'attempt-3',
    };
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = async () => {
      throw Object.assign(
        new Error('Persisted takeover admission requires a current daemon'),
        { code: 'persisted_takeover_admission_upgrade_required' },
      );
    };
    const createSessionRuntime = vi.fn(() => ({
      operations: harness.runtime,
      nativeRuntime: harness.runtime,
    }));
    setSessionRuntimeFactory(harness.config, createSessionRuntime);

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toMatchObject({
      code: 'persisted_takeover_admission_upgrade_required',
    });

    expect(createSessionRuntime).not.toHaveBeenCalled();
  });

  it('does not invoke persisted-takeover admission for an ordinary host runtime start', async () => {
    const harness = createHarness();
    const admit = vi.fn(async () => undefined);
    const reportRuntimeBound = vi.fn(async () => undefined);
    harness.deps.admitPersistedTakeoverBeforeRuntimeFn = admit;
    harness.deps.reportPersistedTakeoverRuntimeBoundFn = reportRuntimeBound;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(admit).not.toHaveBeenCalled();
    expect(reportRuntimeBound).not.toHaveBeenCalled();
  });

  it('rejects the retirement callback compatibility seam and requires createSessionRuntime', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'grok';
    const deferredSession = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-missing-factory',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const reconnectionCancel = vi.fn();
    const stopMcpServer = vi.fn();
    const bootstrapCleanup = vi.fn(async () => undefined);
    const unsubscribeExecutionRunActivity = vi.fn();
    let metadataObserverSignal: AbortSignal | undefined;
    harness.session.subscribeExecutionRunActivitySnapshots = vi.fn(
      () => unsubscribeExecutionRunActivity,
    );
    harness.session.waitForMetadataUpdate = vi.fn(async (signal?: AbortSignal) => {
      metadataObserverSignal = signal;
      return false;
    });
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: stopMcpServer },
      mcpServers: {},
    }));
    harness.config.startupBootstrap = {
      create: async () => ({
        api: { push: () => ({
          sendToAllDevices: vi.fn(),
          sendToAllDevicesAsync: vi.fn(async () => true),
        }) },
        session: deferredSession as unknown as ApiSessionClient,
        machineId: 'machine-1',
        metadata: { path: '/tmp/workspace' } as never,
        attachedToExistingSession: false,
        reconnectionHandle: { cancel: reconnectionCancel },
        start: async (options) => {
          await deferredSession.attach(harness.session, {
            beforeBufferedDrain: async () => {
              await options?.prepareSession?.(harness.session);
            },
          });
        },
        cleanup: bootstrapCleanup,
      }),
    };
    harness.config.createSessionRuntime = undefined;

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toThrow(
      'Host session runtime config must define createSessionRuntime',
    );

    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.session.endSessionAndClose).not.toHaveBeenCalled();
    expect(reconnectionCancel).toHaveBeenCalledOnce();
    expect(stopMcpServer).toHaveBeenCalledOnce();
    expect(bootstrapCleanup).toHaveBeenCalledOnce();
    expect(unsubscribeExecutionRunActivity).toHaveBeenCalledOnce();
    expect(metadataObserverSignal?.aborted).toBe(true);
  });

  it('rejects legacy loop-compatible runtimes on the shared session path', async () => {
    const harness = createHarness();
    const legacyRuntime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => false),
      steerPrompt: vi.fn(async () => undefined),
      flushTurn: vi.fn(async () => undefined),
      reset: vi.fn(async () => undefined),
      getSessionId: vi.fn(() => null),
      cancel: vi.fn(async () => undefined),
      setSessionMode: vi.fn(async () => undefined),
      setSessionConfigOption: vi.fn(async () => undefined),
      setSessionModel: vi.fn(async () => undefined),
    };
    // Intentional test-only invalid fixture: the shared runtime path must reject legacy loop-shaped objects.
    setSessionRuntimeFactory(harness.config, (() => ({
      operations: legacyRuntime as any,
    })) as unknown as NonNullable<HostSessionRuntimeConfig['createSessionRuntime']>);

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toThrow(
      'Shared host session runtime requires RuntimeTurnOperations',
    );
  });

  it('passes a transcript session port that follows session swaps', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    initialSession.enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true,
      delivered: true,
    }));
    initialSession.sendAgentMessageEphemeral = vi.fn();

    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;
    swappedSession.enqueueAgentMessageCommitted = vi.fn(async () => ({
      persisted: true,
      delivered: true,
    }));
    swappedSession.sendAgentMessageEphemeral = vi.fn();

    let swapSession: ((nextSession: any) => Promise<void> | void) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let transcriptSession: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      transcriptSession = params.transcriptSession;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      await transcriptSession.enqueueAgentMessageCommitted(
        'qwen',
        { type: 'message', message: 'final text' },
        {
          localId: 'segment-1',
          provenance: { kind: 'non_dependent', source: 'external' },
        },
      );
      transcriptSession.sendAgentMessageEphemeral?.(
        'qwen',
        { type: 'message', message: 'live text' },
        { localId: 'segment-1', createdAt: 1, updatedAt: 2 },
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(initialSession.sendAgentMessageEphemeral).not.toHaveBeenCalled();
    expect(swappedSession.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen',
      { type: 'message', message: 'final text' },
      {
        localId: 'segment-1',
        provenance: { kind: 'non_dependent', source: 'external' },
      },
    );
    expect(swappedSession.sendAgentMessageEphemeral).toHaveBeenCalledWith(
      'qwen',
      { type: 'message', message: 'live text' },
      { localId: 'segment-1', createdAt: 1, updatedAt: 2 },
    );
  });

  it('passes a runtime session client that follows session swaps', async () => {
    const harness = createHarness();
    const initialSession = harness.session;

    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;

    let swapSession: ((nextSession: any) => Promise<void> | void) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let runtimeSession: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      runtimeSession = params.session;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      expect(runtimeSession.sessionId).toBe('session-2');
      await runtimeSession.updateMetadata((metadata: Record<string, unknown>) => ({
        ...metadata,
        fromRuntimeSession: true,
      }));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.getMetadataSnapshot()).not.toHaveProperty('fromRuntimeSession');
    expect(swappedSession.getMetadataSnapshot()).toMatchObject({ fromRuntimeSession: true });
  });

  it('binds exact provider outcomes and pre-provider rejections to the one current-session host normalizer', async () => {
    const harness = createHarness();
    let deliveryHandler: ((outcome: any) => void) | null = null;
    let rejectedHandler: ((info: any) => void) | null = null;
    let blockerClearedHandler: ((info: any) => void) | null = null;
    const observedSettlements: unknown[] = [];
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn((outcome: unknown) => {
      observedSettlements.push(outcome);
    });
    const runtime = {
      ...harness.runtime,
      setOnPromptDeliveryOutcome: vi.fn((handler: ((outcome: any) => void) | null) => {
        deliveryHandler = handler;
      }),
      setOnPromptTerminallyRejectedBeforeProvider: vi.fn((handler: ((info: any) => void) | null) => {
        rejectedHandler = handler;
      }),
      setOnPromptDeliveryBlockerCleared: vi.fn((handler: ((info: any) => void) | null) => {
        blockerClearedHandler = handler;
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      params.onProviderPromptDispatchPrepared({
        localIds: ['local-exact'],
        selection: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'model-at-dispatch',
        },
      });
      deliveryHandler?.({
        type: 'input-accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        userMessageSeqs: [21],
        delivery: { kind: 'newTurn', turnId: 'turn-exact' },
      });
      rejectedHandler?.({
        localIds: ['local-blocked'],
        userMessageSeq: 23,
        userMessageSeqs: [23],
        deliveryBlockedReason: 'runtime_config_blocked',
      });
      blockerClearedHandler?.({ deliveryBlockedReason: 'runtime_config_blocked' });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(observedSettlements).toEqual([
      {
        kind: 'accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        userMessageSeqs: [21],
        providerTurnId: 'turn-exact',
        providerDeliveryKind: 'newTurn',
        appliedModel: {
          provider: 'qwen',
          selection: {
            agentTargetKey: 'agent:happier.agent.qwen/qwen',
            providerConnectionId: null,
            modelId: 'model-at-dispatch',
          },
        },
      },
      {
        kind: 'rejected_before_effect',
        localId: 'local-blocked',
        userMessageSeq: 23,
        userMessageSeqs: [23],
        reason: 'runtime_config_blocked',
        diagnostic: { code: 'runtime_config_blocked', severity: 'error' },
        retryable: true,
      },
    ]);
    expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
    expect(runtime.setOnPromptDeliveryOutcome).toHaveBeenLastCalledWith(null);
    expect(runtime.setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenLastCalledWith(null);
    expect(runtime.setOnPromptDeliveryBlockerCleared).toHaveBeenLastCalledWith(null);
  });

  it('routes exact provider acceptance to every correlated effect and discards them on rejection', async () => {
    const harness = createHarness();
    let deliveryHandler: ((outcome: any) => void) | null = null;
    harness.session.hasPendingProviderInput = vi.fn(
      (localId: string) => localId === 'local-exact' || localId === 'local-rejected',
    );
    harness.session.observeProviderInputSettlement = vi.fn();
    const runtime = {
      ...harness.runtime,
      setOnPromptDeliveryOutcome: vi.fn((handler: ((outcome: any) => void) | null) => {
        deliveryHandler = handler;
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));

    const effects: string[] = [];
    const replayEffect = vi.fn(() => {
      effects.push('replay');
      throw new Error('replay settlement failed');
    });
    const followEffect = vi.fn(() => { effects.push('follow'); });
    const rejectedEffect = vi.fn(() => { effects.push('rejected'); });
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(params.registerProviderAcceptedEffect).toBeTypeOf('function');
      params.registerProviderAcceptedEffect('local-exact', replayEffect);
      params.registerProviderAcceptedEffect('local-exact', followEffect);
      params.registerProviderAcceptedEffect('local-rejected', rejectedEffect);
      deliveryHandler?.({
        type: 'input-rejected',
        localId: 'local-rejected',
        userMessageSeq: 22,
        diagnostic: { code: 'provider_rejected', severity: 'error' },
        retryable: true,
      });
      deliveryHandler?.({
        type: 'input-accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        delivery: { kind: 'newTurn', turnId: 'turn-exact' },
      });
      deliveryHandler?.({
        type: 'input-accepted',
        localId: 'local-exact',
        userMessageSeq: 21,
        delivery: { kind: 'newTurn', turnId: 'turn-exact' },
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledTimes(2);
    expect(replayEffect).toHaveBeenCalledOnce();
    expect(followEffect).toHaveBeenCalledOnce();
    expect(rejectedEffect).not.toHaveBeenCalled();
    expect(effects).toEqual(['replay', 'follow']);
  });

  it('registers abort control RPCs on the active swapped session manager without authoring a cancellation transcript', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      const abort = swappedSessionFixture.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      await abort?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialSession.sendAgentMessage).not.toHaveBeenCalled();
    expect(swappedSession.sendAgentMessage).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'turn_cancelled' }),
    );
    expect(harness.runtime.cancelTurn).toHaveBeenCalledOnce();
  });

  it('registers the exact model-transition RPC on the active swapped session manager', async () => {
    const harness = createHarness();
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    let swappedMetadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    swappedSessionFixture.session.getMetadataSnapshot = () => swappedMetadata;
    swappedSessionFixture.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        swappedMetadata = typeof update === 'function'
          ? (update as (metadata: typeof swappedMetadata) => typeof swappedMetadata)(swappedMetadata)
          : update;
      },
    );

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSessionFixture.session);
      const transition = swappedSessionFixture.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      expect(transition).toBeTypeOf('function');
      const runtimeUpdateCount = harness.runtime.updateSessionRuntimeConfig.mock.calls.length;
      const selection = {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'default',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toEqual({
        ok: true,
        status: 'already_active',
        activeSelection: selection,
      });
      expect(swappedMetadata.modelSelectionIntentV1).toMatchObject({
        v: 1,
        selection,
      });
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(
        runtimeUpdateCount,
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it.each(['plugin_generation_stale', 'AGENT_RESUME_PROVIDER_STATE_MISSING', 'native_agent_session_mode_unavailable'])(
    'preserves startup cleanup for a plugin error without host-proven input refusal (%s)', async code => {
      const { PluginError } = await import('@happier-dev/plugin-sdk');
      const harness = createHarness();
      const failure = new PluginError({ code, message: 'Startup failed', retryable: false });
      setSessionRuntimeFactory(harness.config, () => { throw failure; });
      await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(failure);
      expect(harness.session.close).toHaveBeenCalledOnce();
      expect(harness.session.observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(harness.metrics.defaultReadyCalls).toBe(0);
    },
  );

  it('settles late originals after a typed native startup refusal without reporting Ready or dispatching them', async () => {
    const harness = createHarness();
    let contextReadyObservations = 0;
    harness.session.waitForExecutionRunWorkerUpdateChange = async () => {
      // A ready worker remains ready until taken. Fail promptly if the failed
      // host repeats that readiness wake rather than serving Pending originals.
      if (++contextReadyObservations > 1) throw new Error('Unconsumed worker readiness was observed again');
      return true;
    };
    const [{ assertNativeAgentSessionModeAvailable }, { createNativeAgentSessionPublications }] = await Promise.all([
      import('@/agent/runtime/registry/engineRegistry/nativeAgentSession'),
      import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications'),
    ]);
    let stop: (() => Promise<void>) | undefined;
    harness.config.onRuntimeStopReady = value => { stop = value; };
    const pending = new Set<string>();
    harness.session.hasPendingProviderInput = (localId?: string) => localId === undefined ? pending.size > 0 : pending.has(localId);
    const rejected: unknown[] = [];
    harness.session.observeProviderInputSettlement = async (outcome: import('@/agent/runtime/session/input/providerInputOutcome').SessionProviderInputOutcome) => {
      rejected.push(outcome);
      if (outcome.kind === 'rejected_before_effect' && !outcome.retryable) pending.delete(outcome.localId);
      return false;
    };
    setSessionRuntimeFactory(harness.config, () => {
      const publications = createNativeAgentSessionPublications({ agentId: 'acme.external', session: null,
        signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
      // The external Agent publishes its real catalog; the host owns refusal.
      publications.services.modes.bind({ read: () => ({ modes: [{ id: 'build', name: 'Build' }], currentModeId: 'build' }),
        subscribe: () => ({ dispose() {} }) });
      assertNativeAgentSessionModeAvailable({ mode: { value: 'default', updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: null, updatedAtMs: 0 }, options: {} }, publications);
      throw new Error('Expected the real native mode refusal');
    });
    const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    // Observe early rejection without allowing an unhandled promise in RED.
    let finished = false;
    const result = running.then(() => { finished = true; return null; }, error => { finished = true; return error; });
    try {
      for (const localId of ['late-protected-original', 'another-protected-original']) {
        pending.add(localId);
        harness.queue.pushIsolate({ text: 'Must not execute', localId }, { permissionMode: 'default' });
        await vi.waitFor(() => expect(rejected).toContainEqual(expect.objectContaining({
          localId, kind: 'rejected_before_effect', retryable: false,
          reason: 'provider_rejected_before_acceptance', diagnostic: { code: 'native_agent_session_mode_unavailable', severity: 'error' },
        })));
      }
      expect(pending.size).toBe(0);
      expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
      expect(harness.metrics.defaultReadyCalls).toBe(0);
      expect(harness.metrics.onAfterStartCalls).toBe(0);
      expect(harness.session.close).not.toHaveBeenCalled();
      expect(harness.session.enqueueSessionTurnMutation).not.toHaveBeenCalled();
    } finally {
      if (!finished) await stop?.();
      await result;
    }
    expect(harness.session.endSessionAndClose).toHaveBeenCalledOnce();
    expect(contextReadyObservations).toBe(0);
  });

  it.each(['external', 'opencode', 'missing_inventory'] as const)('settles a Workflow parent from a native-open refusal only with bound mode evidence (%s)', async source => {
    const miswired = source === 'missing_inventory';
    const [{ createLightSqliteHarness }, { db }, { createAuthenticatedTestApp },
      { registerSessionTurnMutationRoute }, { createRuntimeSessionClientDurableMutationOutbox },
      { SessionTurnsProjectionV1Schema }] = await Promise.all([
      import('../../../../../../server/sources/testkit/lightSqliteHarness'),
      import('../../../../../../server/sources/storage/db'),
      import('../../../../../../server/sources/app/api/testkit/sqliteFastify'),
      import('../../../../../../server/sources/app/api/routes/session/registerSessionTurnMutationRoute'),
      import('@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox'),
      import('@happier-dev/protocol/sessions/turns/sessionTurnV1'),
    ]);
    const database = await createLightSqliteHarness({ tempDirPrefix: 'native-refusal-turns-', initAuth: false });
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const storedSession = await db.session.create({ data: {
      accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
    } });
    const app = createAuthenticatedTestApp();
    app.addHook('onRequest', async (request: import('fastify').FastifyRequest) => { request.headers['x-test-user-id'] = account.id; });
    registerSessionTurnMutationRoute(app);
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const turns = createRuntimeSessionClientDurableMutationOutbox({ token: 'fixture', serverUrl,
      sessionId: storedSession.id, getSocket: () => null, requestReconnect: () => undefined });
    onTestFinished(async () => { await turns.close(); await app.close(); await database.close(); });
    const [{ createNativeAgentRuntimeSessionPlan }, fixtures, { buildPluginSessionBindingInput },
      { PluginError }, { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore }] = await Promise.all([
      import('@/agent/runtime/registry/engineRegistry/nativeAgentSession'),
      import('@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit'),
      import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch'),
      import('@happier-dev/plugin-sdk'),
      import('@/daemon/workflows/workflowCoordinator.testkit'),
    ]);
    const credentials = { token: 'startup-refusal-fixture', encryption: null };
    const harness = createHarness(storedSession.id, { credentials });
    const agentId = 'acme-startup-refusal';
    const contributions = fixtures.createExternalContributionFixtures(agentId);
    const failure = new PluginError({ code: 'native_agent_session_mode_unavailable', retryable: false });
    const plan = await createNativeAgentRuntimeSessionPlan({
      ...contributions, lease: fixtures.createLease(agentId),
      runtime: { sessions: { open: async (_request, context) => {
        if (source === 'opencode') {
          const [{ createOpenCodeServerRuntimeAssembly }, { createContextFixture }] = await Promise.all([
            import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly'),
            import('../../../../../../../packages/plugins/opencode/src/agent/runtime/server/assembly.managedServices.testkit'),
          ]);
          const ctx = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213',
            managedServerRequest: async input => {
              const path = input.pathAndQuery.split('?')[0];
              const body = path === '/session' ? { id: 'native-refusal-session' }
                : path === '/agent' ? [{ name: 'build', mode: 'primary' }] : {};
              return { ok: true, status: 200, headers: { 'content-type': 'application/json' },
                body: new Response(JSON.stringify(body)).body };
            } });
          return (await createOpenCodeServerRuntimeAssembly({ ctx, directory: _request.cwd,
            happierSessionId: _request.sessionId, request: _request, endpoint: { mode: 'managed-spawn' },
            modes: context.session.services.modes, models: context.session.services.models })).runtime;
        }
        if (!miswired) context.session.services.modes.bind({
          read: () => ({ modes: [{ id: 'build', name: 'Build' }], currentModeId: 'build' }),
          subscribe: () => ({ dispose() {} }),
        });
        // The external plugin applies configuration during open, before returning a Session.
        throw failure;
      } } },
      createSessionHostServiceOwners: fixtures.createSessionHostServiceOwners,
      sessionInput: buildPluginSessionBindingInput({ credentials, directory: '/repo',
        backendTarget: { kind: 'backend', backendId: agentId }, sessionModeId: 'default' }),
    });
    if (!plan.config.createSessionRuntime) throw new Error('Native Session factory missing');
    setSessionRuntimeFactory(harness.config, plan.config.createSessionRuntime);
    harness.session.enqueueSessionTurnMutation = vi.fn(async (input: unknown) => {
      const mutation = SessionTurnMutationV1Schema.parse(input);
      // HTTP authentication is the boundary fixture. Native open, host refusal,
      // durable journal, mutation route, SQLite and the projection reader are real.
      if (mutation.action === 'end_session') throw new Error('Expected a runtime turn mutation');
      await turns.enqueueSessionTurnMutation(mutation);
      if (mutation.action === 'fail') {
        expect(mutation.issue.code).toBe(miswired ? 'agent_session_error' : failure.code);
      }
    });
    const readTurns = async () => {
      await turns.flush('flush');
      const response = await app.inject({ method: 'GET', url: `/v1/sessions/${storedSession.id}/turns` });
      expect(response.statusCode).toBe(200);
      return SessionTurnsProjectionV1Schema.parse(response.json());
    };
    let stop: (() => Promise<void>) | undefined;
    harness.config.onRuntimeStopReady = value => { stop = value; };
    const blocked = new Set<string>();
    const delivered: string[] = [];
    const custody = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: harness.session.sessionId }), {
      metadataAuthority: { kind: 'owner', credentials },
      transport: { serverId: 'startup-refusal-home', serverUrl: 'https://startup-refusal.example',
        createSessionSocketTransport: () => { throw new Error('Socket supplied by the transport fixture'); } },
    });
    harness.session.hasPendingProviderInput = custody.hasPendingProviderInput.bind(custody);
    harness.session.observeProviderInputSettlement = custody.observeProviderInputSettlement.bind(custody);
    // Home is the boundary. Real native open, host failure service, Pending
    // settlement/transport, exact-input reader, step executor and coordinator remain composed.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, options) => {
      if (url.startsWith(serverUrl)) {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        expect(response.status).toBe(200);
        return { status: response.status, data: await response.json() };
      }
      const match = new URL(url).pathname.match(/\/pending\/([^/]+)\/delivery\/block$/);
      if (!match || data.reason !== 'provider_rejected_before_acceptance') throw new Error(`Unexpected refusal write: ${url}`);
      blocked.add(decodeURIComponent(match[1]!));
      return { status: 200, data: { ok: true } };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (url.endsWith('/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      const reply = new URL(url).pathname.match(/\/messages\/by-local-id\/([^/]+)\/reply$/);
      if (reply) return { status: 200, data: blocked.has(decodeURIComponent(reply[1]!))
        ? { v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing', outcome: { kind: 'failed' } } }
        : { v: 1, status: 'none' } };
      if (url.includes('/messages/by-local-id/')) throw Object.assign(new Error('Message not found'), {
        isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
      });
      if (url.endsWith(`/v2/sessions/${harness.session.sessionId}`)) return { status: 200, data: { session:
        createSessionRecordFixture({ id: harness.session.sessionId, active: true, encryptionMode: 'plain',
          machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo' }) }) } };
      if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
      if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId: harness.session.sessionId, updatedAt: 1, turns: [] } };
      throw new Error(`Unexpected refusal read: ${url}`);
    });
    const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    let finished = false;
    const result = running.then(() => { finished = true; }, error => { finished = true; return error; });
    try {
      if (miswired) {
        expect(await result).toMatchObject({ code: failure.code, retryable: false });
        expect(harness.session.close).toHaveBeenCalledOnce();
        expect(blocked.size).toBe(0);
        expect((await readTurns()).turns).toEqual([expect.objectContaining({ status: 'failed' })]);
        return;
      }
      expect(finished).toBe(false);
      const store = createInMemoryWorkflowCoordinatorStore();
      const executionTarget = { kind: 'session' as const };
      const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent-plugin', localId: agentId } };
      const executeStep = createProductionWorkflowSessionStepExecutor({ credentials, machineId: 'machine-1',
        machineAdmissionTransport: async request => {
          delivered.push(request.localId);
          // Model the Pending transport's materialization receipt, then let the
          // real SessionClient own the terminal durable write and custody release.
          const materialization = custody as unknown as {
            materializationRuntime: { markPendingQueueMaterializedLocalId(localId: string): void };
          };
          materialization.materializationRuntime.markPendingQueueMaterializedLocalId(request.localId);
          harness.queue.pushIsolate({ text: 'Must not execute', localId: request.localId }, { permissionMode: 'default' });
          await vi.waitFor(() => expect(blocked.has(request.localId)).toBe(true));
          return { status: 'accepted', localId: request.localId };
        },
        createFreshConversation: async () => ({ sessionId: harness.session.sessionId, machineId: 'machine-1', directory: '/repo' }),
        resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
        resolveExistingSessionConversation: async () => null,
      });
      const coordinator = createTestWorkflowCoordinator({ store, executeStep,
        resolveWorkspace: async () => ({ ok: true, workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }),
        isAcceptedAuthorizationCurrent: async () => true,
      });
      const run = { runId: 'startup-refused-workflow', inputs: {}, executionTarget,
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        definition: { version: 1 as const, inputs: [], defaults: { agentTarget }, blocks: [{
          kind: 'step' as const, id: 'work', document: { text: 'Must not execute', references: [], attachments: [] },
          input: [], result: { kind: 'text' as const }, execution: { conversation: { kind: 'fresh' as const } },
        }] },
      };
      expect(await coordinator.run(run)).toMatchObject({ state: 'interrupted', reason: 'session_input_failed' });
      expect(store.list()).toContainEqual(expect.objectContaining({ blockId: 'work', lifecycle: 'failed',
        execution: expect.objectContaining({ sessionId: harness.session.sessionId, localInputId: delivered[0] }) }));
      expect(delivered).toHaveLength(1);
      expect(custody.hasPendingProviderInput(delivered[0])).toBe(false);
      expect(await coordinator.run(run)).toMatchObject({ state: 'interrupted' });
      expect(delivered).toHaveLength(1);
      expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
      expect(harness.metrics.defaultReadyCalls).toBe(0);
      expect(harness.metrics.onAfterStartCalls).toBe(0);
      expect(harness.session.enqueueSessionTurnMutation).not.toHaveBeenCalled();
      expect((await readTurns()).turns).toEqual([]);
    } finally {
      if (!finished) await stop?.();
      await result;
      await custody.close();
      post.mockRestore(); get.mockRestore();
    }
  });

  it('publishes confirmed idle open through the turn lifecycle before entering the loop', async () => {
    const harness = createHarness();
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const mutations = harness.session.enqueueSessionTurnMutation.mock.calls.map(([mutation]: readonly unknown[]) =>
        SessionTurnMutationV1Schema.parse(mutation));
      expect(mutations).toContainEqual(expect.objectContaining({ action: 'session_opened', sessionId: harness.session.sessionId }));
      expect(mutations.some(mutation => mutation.action === 'begin')).toBe(false);
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps a confirmed runtime usable when open-projection custody is unavailable', async () => {
    const harness = createHarness();
    harness.session.enqueueSessionTurnMutation.mockRejectedValue(new Error('fixture durable custody unavailable'));
    const enterLoop = vi.fn(async () => {});
    harness.deps.runSessionLoopLifecycleFn = enterLoop;
    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).resolves.toBeUndefined();
    expect(enterLoop).toHaveBeenCalledOnce();
    expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'home-http'] as const)('retains initial input and publishes a retryable preparation issue when startup metadata cannot be confirmed (%s)', async source => {
    const harness = createHarness();
    const { createHttpStatusError } = await import('@/api/client/httpStatusError');
    const failure = source === 'home-http' ? createHttpStatusError(500, 'Private Home failure') : Object.assign(new Error('Session metadata tuple result is ambiguous'), {
      code: 'metadata_tuple_ambiguous', retryable: false,
    });
    // The Session HTTP boundary has exhausted its reconciliation budget. Host
    // construction and lifecycle publication remain real, including Pending custody.
    harness.session.updateMetadataAsCurrentPublisher.mockRejectedValue(failure);
    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(failure);
    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail', issue: expect.objectContaining({ code: 'preparation_pending', source: 'dependency_failure' }),
    }));
    expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
    expect(harness.session.confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalled();
    const { SessionTurnMutationV1Schema } = await import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1');
    const { reportSessionRunnerFailure } = await import('@/cli/resolveSessionRunnerFailureExitCode');
    const mutations: unknown[] = harness.session.enqueueSessionTurnMutation.mock.calls.map(([mutation]: readonly unknown[]) => mutation);
    const failed = mutations.map(mutation => SessionTurnMutationV1Schema.parse(mutation)).find(mutation => mutation.action === 'fail');
    if (!failed || failed.action !== 'fail') throw new Error('Expected startup lifecycle failure');
    const resumed = createDeferred<void>();
    const respawnedSessionIds: Array<string | undefined> = [];
    const manager = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0,
      isSessionAlreadyRunning: () => false, readStartupFailure: async () => failed.issue,
      spawnSession: async options => {
        // A real respawn starts another process, not another host in this process.
        respawnedSessionIds.push(options.existingSessionId);
        return { type: 'success' };
      },
      onRespawnSuccess: () => resumed.resolve(),
      onRespawnTerminal: () => resumed.resolve(),
      random: () => 0, logDebug: () => {}, logWarn: () => {},
    });
    try {
      const exitCode = reportSessionRunnerFailure(failure);
      expect(exitCode).toBe(1);
      expect(manager.handleUnexpectedExit({ startedBy: 'daemon', pid: 111, happySessionId: harness.session.sessionId,
        processStartTimeMs: 0, spawnOptions: { directory: '/tmp' } }, { reason: 'process-exit', code: exitCode, signal: null })).toBe('scheduled');
      await resumed.promise;
      expect(respawnedSessionIds).toEqual([harness.session.sessionId]);
      expect(harness.session.getPendingQueueState().pendingCount).toBe(1);
      expect(harness.session.confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
    } finally {
      manager.markStopRequested(harness.session.sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
    }
  });

  it('attributes a held startup publisher claim before custody and model publication complete', async () => {
    const harness = createHarness();
    const releaseClaim = createDeferred<void>();
    const claimEntered = createDeferred<void>();
    const diagnostics = vi.spyOn(logger, 'infoFile');
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = async () => {
      claimEntered.resolve();
      await releaseClaim.promise;
      return { status: 'claimed' as const };
    };
    const startup = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    try {
      await claimEntered.promise;
      expect(diagnostics).toHaveBeenCalledWith('[Qwen] Startup authority phase', expect.objectContaining({
        phase: 'publisher_claim', status: 'started', sessionId: harness.session.sessionId,
      }));
    } finally {
      releaseClaim.resolve();
      await startup;
    }
    const completed = diagnostics.mock.calls.filter(([label, fields]) => label === '[Qwen] Startup authority phase'
      && (fields as { status?: string })?.status === 'completed').map(([, fields]) => fields);
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'publisher_claim', durationMs: expect.any(Number) }),
      expect.objectContaining({ phase: 'required_snapshot', durationMs: expect.any(Number) }),
      expect.objectContaining({ phase: 'durable_delivery_activation', durationMs: expect.any(Number) }),
      expect.objectContaining({ phase: 'active_model_facts', durationMs: expect.any(Number) }),
    ]));
  });

  it('establishes durable Session custody before runtime creation, then reconciles fresh model intent', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const freshSelection = {
      agentTargetKey: 'agent:happier.agent.qwen/qwen',
      providerConnectionId: null,
      modelId: 'fresh-model',
    } as const;
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update;
    });
    harness.session.rpcHandlerManager.registerHandler = vi.fn(
      (name: string, handler: (payload?: unknown) => unknown) => {
        harness.handlers.set(name, handler);
        if (name === SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION) {
          order.push('handler');
        }
      },
    );
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        expect(harness.handlers.has(
          SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
        )).toBe(false);
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      expect(harness.handlers.has(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      )).toBe(false);
      expect(order).toEqual([
        'claim',
        'refresh',
      ]);
      order.push('durable-delivery');
    });
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh');
        metadata = {
          ...metadata,
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 41,
            selection: freshSelection,
          },
        };
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (update.modelId === freshSelection.modelId) {
          order.push('reconcile');
        }
        return { status: 'applied' as const };
      },
    );
    setSessionRuntimeFactory(harness.config, () => {
      order.push('runtime');
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      expect(order).toEqual([
        'claim',
        'refresh',
        'durable-delivery',
        'runtime',
        'handler',
        'reconcile',
        'loop',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.refreshSessionSnapshotFromServerRequired).toHaveBeenCalledWith({
      reason: 'startup-drain',
    });
  });

  it('does not expose model-transition effects until authoritative refresh and runtime creation complete', async () => {
    const harness = createHarness();
    const refreshEntered = createDeferred<void>();
    const releaseRefresh = createDeferred<void>();
    const releaseLoop = createDeferred<void>();
    const order: string[] = [];
    const persistedSelection = {
      agentTargetKey: 'agent:happier.agent.qwen/qwen',
      providerConnectionId: null,
      modelId: 'persisted-before-claim',
    } as const;
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update;
    });
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh:start');
        refreshEntered.resolve();
        await releaseRefresh.promise;
        metadata = {
          ...metadata,
          modelSelectionIntentV1: {
            v: 1,
            updatedAt: 41,
            selection: persistedSelection,
          },
        };
        order.push('refresh:end');
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (typeof update.modelId === 'string') {
          order.push(`apply:${update.modelId}`);
        }
        return { status: 'applied' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      order.push('durable-delivery');
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      await releaseLoop.promise;
    };

    const run = runHostSessionRuntime(
      harness.opts,
      harness.config,
      harness.deps,
    );
    await refreshEntered.promise;

    expect(harness.handlers.has(
      SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
    )).toBe(false);
    expect(harness.config.createSessionRuntime).toBeTypeOf('function');
    expect(order).toEqual(['claim', 'refresh:start']);

    releaseRefresh.resolve();
    await vi.waitFor(() => {
      expect(harness.handlers.has(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      )).toBe(true);
    });
    releaseLoop.resolve();
    await run;

    expect(order).toContain(`apply:${persistedSelection.modelId}`);
    expect(order).toContain('durable-delivery');
    expect(order).toContain('loop');
  });

  it('keeps released-server startup compatible while refusing model-transition RPCs without authoritative routing', async () => {
    const harness = createHarness();
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => ({
        status: 'unsupported' as const,
        reason: 'publisher_authority_check_unsupported' as const,
      }),
    );
    let transitionRejection: unknown = null;
    harness.deps.runSessionLoopLifecycleFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      expect(transition).toBeTypeOf('function');
      try {
        await transition?.({
          v: 1,
          selection: {
            agentTargetKey: 'agent:happier.agent.qwen/qwen',
            providerConnectionId: null,
            modelId: 'must-not-apply',
          },
        });
      } catch (error) {
        transitionRejection = error;
      }
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(transitionRejection).toMatchObject({
      code: 'publisher_authority_check_unsupported',
      retryable: false,
    });
    expect(harness.runtime.updateSessionRuntimeConfig).not.toHaveBeenCalled();
    expect(
      harness.session.activateDurableMutationDelivery,
    ).toHaveBeenCalledTimes(1);
  });

  it('publishes initial active facts and runtime models in one publisher acquisition after durable custody', async () => {
    const harness = createHarness();
    const order: string[] = [];
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    const modelsSnapshot = {
      currentModelId: 'current-model',
      models: [
        { id: 'current-model', name: 'Current model' },
      ],
    };
    harness.runtime.models = {
      read: () => modelsSnapshot,
      subscribe: (
        listener: (snapshot: typeof modelsSnapshot) => void,
      ) => {
        listener(modelsSnapshot);
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: unknown) => {
      const previous = metadata;
      const next: typeof metadata = typeof update === 'function'
        ? (update as (current: typeof metadata) => typeof metadata)(metadata)
        : update as typeof metadata;
      if (
        previous.sessionModelsV1 === undefined
        && next.sessionModelsV1 !== undefined
      ) {
        order.push('models');
      }
      metadata = next;
    });
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(
      async () => {
        order.push('refresh');
      },
    );
    harness.session.claimCurrentSessionPublisherAuthorityForStartup = vi.fn(
      async () => {
        order.push('claim');
        return { status: 'claimed' as const };
      },
    );
    harness.session.activateDurableMutationDelivery = vi.fn(async () => {
      order.push('durable-delivery');
    });
    harness.deps.runSessionLoopLifecycleFn = async () => {
      order.push('loop');
      expect(order).toEqual([
        'claim',
        'refresh',
        'durable-delivery',
        'models',
        'loop',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(harness.session.updateMetadataAsCurrentPublisher).toHaveBeenCalledTimes(1);
    expect(metadata.sessionModelsV1).toMatchObject({
      agentId: 'qwen',
      availableModels: [{ id: 'current-model', name: 'Current model' }],
    });
  });

  it('drains queued runtime-model publication before terminal session close', async () => {
    const harness = createHarness();
    const order: string[] = [];
    let closed = false;
    let releaseMetadataWrite!: () => void;
    const metadataWriteReleased = new Promise<void>((resolve) => {
      releaseMetadataWrite = resolve;
    });
    let notifyMetadataWriteStarted!: () => void;
    const metadataWriteStarted = new Promise<void>((resolve) => {
      notifyMetadataWriteStarted = resolve;
    });
    let blockMetadataWrites = false;
    let modelListener: ((snapshot: { models: readonly { id: string; name: string }[] | null }) => void) | null = null;
    harness.runtime.models = {
      read: () => ({ models: null }),
      subscribe: (listener: (snapshot: { models: readonly { id: string; name: string }[] | null }) => void) => {
        modelListener = listener;
        listener({ models: null });
        return { dispose: () => { modelListener = null; } };
      },
    };
    harness.session.updateMetadata.mockImplementation(async () => {
      if (!blockMetadataWrites) return;
      order.push('metadata:start');
      notifyMetadataWriteStarted();
      await metadataWriteReleased;
      if (closed) throw new Error('session_closed');
      order.push('metadata:end');
    });
    harness.session.close.mockImplementation(async () => {
      closed = true;
      order.push('close');
    });
    harness.deps.runSessionLoopLifecycleFn = async (params: {
      deps: { onBeforeSessionClose?: () => Promise<void> };
      session: { close(): Promise<void> };
      startupCoordinator?: { start(): Promise<void> } | null;
    }) => {
      await params.startupCoordinator?.start();
      blockMetadataWrites = true;
      modelListener?.({ models: [{ id: 'runtime', name: 'Runtime' }] });
      await metadataWriteStarted;
      const onBeforeSessionClose = params.deps.onBeforeSessionClose;
      expect(onBeforeSessionClose).toBeTypeOf('function');
      let drained = false;
      const drain = onBeforeSessionClose!().then(() => { drained = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(order).toEqual(['metadata:start']);
      releaseMetadataWrite();
      await drain;
      await params.session.close();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(order).toEqual(['metadata:start', 'metadata:end', 'close']);
  });

  it('fails startup closed without activating durable delivery when the required authoritative refresh fails', async () => {
    const harness = createHarness();
    const refreshFailure = new Error('authoritative refresh unavailable');
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.session.refreshSessionSnapshotFromServerRequired = vi.fn(async () => {
      throw refreshFailure;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(refreshFailure);

    expect(harness.handlers.has(
      SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
    )).toBe(false);
    expect(
      harness.session.activateDurableMutationDelivery,
    ).not.toHaveBeenCalled();
    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.session.endSessionAndClose).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('preserves exact capture and conditional refusal through the registered live model RPC owner', async () => {
    const harness = createHarness('session-1', { credentials: {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner-account' })).toString('base64url')}.signature`, encryption: null,
    } });
    let swapSession: InitializeBackendRunSessionOptions['onSessionSwap'] | undefined;
    const initialize = harness.deps.initializeBackendRunSessionFn;
    harness.deps.initializeBackendRunSessionFn = async (options: InitializeBackendRunSessionOptions) => {
      swapSession = options.onSessionSwap;
      return await initialize(options);
    };
    const before = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'old-model' };
    harness.config.policyAgentId = 'claude';
    harness.opts.modelSelection = { v: 1, updatedAt: 10, ref: before };
    let metadata: Record<string, unknown> = { path: '/tmp/workspace', permissionMode: 'default',
      modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: before } };
    // The Session fixture is the durable transport boundary; the host, actual
    // authorizer, coordinator and metadata candidate remain real beneath it.
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (update: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>)) => {
      metadata = typeof update === 'function' ? update(metadata) : update;
    });
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(async () => ({ status: 'applied' as const }));
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION);
      expect(transition).toBeTypeOf('function');
      const next = { ...before, modelId: 'next-model' };
      const applied = await transition?.({ v: 1, selection: next, captureBefore: true });
      expect(applied).toMatchObject({ ok: true, reversal: { before, applied: next, scope: { accountId: 'owner-account', sessionId: 'session-1' } } });
      if (!applied || typeof applied !== 'object' || !('reversal' in applied)) throw new Error('Expected exact owner receipt');
      const reversal = SessionModelMutationReversalV1Schema.parse(applied.reversal);
      if (reversal.owner !== 'active') throw new Error('Expected live owner receipt');
      const expected = { owner: 'active' as const, scope: reversal.scope, runId: reversal.runId, selection: reversal.applied, updatedAt: reversal.updatedAt };
      const incumbent = metadata;
      expect(await transition?.({ v: 1, selection: before, expected: { ...expected, scope: { ...expected.scope, serverId: 'another-home' } } }))
        .toMatchObject({ ok: false, status: 'superseded' });
      expect(metadata).toBe(incumbent);
      expect(await transition?.({ v: 1, selection: before, expected })).toMatchObject({ ok: true, activeSelection: before });
      expect(metadata.modelSelectionIntentV1).toMatchObject({ selection: before });
      const swapped = harness.createSessionFixture('session-2');
      let swappedMetadata: Record<string, unknown> = { path: '/tmp/workspace', permissionMode: 'default',
        modelSelectionIntentV1: { v: 1, updatedAt: 10, selection: before } };
      swapped.session.getMetadataSnapshot = () => swappedMetadata;
      swapped.session.updateMetadata.mockImplementation(async (update: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>)) => {
        swappedMetadata = typeof update === 'function' ? update(swappedMetadata) : update;
      });
      await swapSession?.(swapped.session);
      const swappedTransition = swapped.handlers.get(SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION);
      const swappedApplied = await swappedTransition?.({ v: 1, selection: next, captureBefore: true });
      expect(swappedApplied)
        .toMatchObject({ ok: true, reversal: { before, applied: next, scope: { accountId: 'owner-account', sessionId: 'session-2' } } });
      if (!swappedApplied || typeof swappedApplied !== 'object' || !('reversal' in swappedApplied)) throw new Error('Expected replacement owner receipt');
      const swappedReversal = SessionModelMutationReversalV1Schema.parse(swappedApplied.reversal);
      if (swappedReversal.owner !== 'active') throw new Error('Expected replacement live owner receipt');
      const swappedExpected = { owner: 'active' as const, scope: swappedReversal.scope, runId: swappedReversal.runId,
        selection: swappedReversal.applied, updatedAt: swappedReversal.updatedAt };
      expect(SessionModelMutationReversalV1Schema.parse(applied.reversal).scope.sessionId).toBe('session-1');
      const swappedIncumbent = swappedMetadata;
      expect(await swappedTransition?.({ v: 1, selection: before, expected: { ...swappedExpected, scope: reversal.scope } }))
        .toMatchObject({ ok: false, status: 'superseded' });
      expect(swappedMetadata).toBe(swappedIncumbent);
      expect(await swappedTransition?.({ v: 1, selection: before, expected: swappedExpected }))
        .toMatchObject({ ok: true, activeSelection: before });
      expect(swappedMetadata.modelSelectionIntentV1).toMatchObject({ selection: before });
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('classifies a spawn-only Agent native model change as restart-required before runtime effect', async () => {
    const harness = createHarness();
    let metadata: Record<string, unknown> = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(async (
      update:
        | Record<string, unknown>
        | ((current: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      metadata = typeof update === 'function' ? update(metadata) : update;
    });
    harness.config.policyAgentId = 'codex';
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;
      const runtimeUpdateCount =
        harness.runtime.updateSessionRuntimeConfig.mock.calls.length;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: false,
        status: 'restart_required',
        activeSelection: harness.opts.modelSelection?.ref,
        requestedSelection: selection,
      });
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(
        runtimeUpdateCount,
      );
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('atomically transfers the run-host model fence into prompt dispatch custody', async () => {
    const harness = createHarness();
    const activeSelection = {
      agentTargetKey: 'agent:happier.agent.qwen/qwen',
      providerConnectionId: null,
      modelId: 'active-model',
    } as const;
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: activeSelection,
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: activeSelection,
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      let providerAccepted = false;
      const result = await params.transitionModelSelection(
        activeSelection,
        'prompt',
        async (transferPromptAdmission: (opts: {
          abortSignal: AbortSignal;
          dispatch: () => Promise<void>;
        }) => Promise<{ status: 'dispatched' | 'cancelled' }>) => {
          const outcome = await transferPromptAdmission({
            abortSignal: new AbortController().signal,
            dispatch: async () => {
              providerAccepted = true;
            },
          });
          expect(outcome.status).toBe('dispatched');
        },
      );
      expect(result).toMatchObject({
        ok: true,
        status: 'already_active',
        activeSelection,
      });
      expect(providerAccepted).toBe(true);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps input fenced when a live transition returns no authoritative runtime outcome', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue(undefined);

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: false,
        status: 'reconciliation_required',
        activeSelection: null,
        requestedSelection: selection,
        reason: 'runtime_model_transition_outcome_unproven',
      });
      expect(metadata.modelSelectionIntentV1.selection).toEqual(selection);
      expect(metadata.sessionModelsV1).toMatchObject({
        currentModelId: 'old-model',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('publishes active facts and releases input after exact live-runtime model readback', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    let currentModelId = 'old-model';
    const readModels = () => ({
      currentModelId,
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockImplementation(
      async (update: { modelId?: string | null }) => {
        if (typeof update.modelId === 'string') {
          currentModelId = update.modelId;
        }
        return undefined;
      },
    );

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: true,
        status: 'applied',
        activeSelection: selection,
      });
      expect(metadata.modelSelectionIntentV1.selection).toEqual(selection);
      expect(metadata.sessionModelsV1.currentModelId).toBe('next-model');
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('revokes stale active proof when contradictory runtime readback cannot be restored', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    let currentModelId = 'old-model';
    const readModels = () => ({
      currentModelId,
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    const modelListeners = new Set<
      (snapshot: ReturnType<typeof readModels>) => void
    >();
    const publishModels = () => {
      const snapshot = readModels();
      for (const listener of modelListeners) listener(snapshot);
    };
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        modelListeners.add(listener);
        listener(readModels());
        return { dispose: () => modelListeners.delete(listener) };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.runtime.updateSessionRuntimeConfig
      .mockImplementationOnce(async (update: { modelId?: string | null }) => {
        currentModelId = update.modelId ?? currentModelId;
        publishModels();
        return { status: 'applied' as const };
      })
      .mockResolvedValueOnce({
        status: 'failed' as const,
        reason: 'runtime_restore_failed',
      });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: true,
        status: 'applied',
        activeSelection: selection,
      });
      expect(metadata.sessionModelsV1.activeSelectionV1.selection)
        .toEqual(selection);

      currentModelId = 'old-model';
      publishModels();

      await vi.waitFor(() => {
        expect(harness.runtime.updateSessionRuntimeConfig)
          .toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(metadata.sessionModelsV1.currentModelId).toBe('old-model');
        expect(metadata.sessionModelsV1.activeSelectionV1?.selection.modelId)
          .toBe('old-model');
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('does not publish exact active proof from a startup fallback without runtime readback', async () => {
    const harness = createHarness();
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
    };
    const readModels = () => ({
      currentModelId: null,
      models: [{ id: 'default', name: 'Default' }],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(metadata.sessionModelsV1?.activeSelectionV1).toBeUndefined();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps a before-next-prompt active selection authoritative while runtime model readback still lags', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    const readModels = () => ({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    const metadataListeners = new Set<() => void>();
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.on.mockImplementation((event: string, listener: () => void) => {
      if (event === 'metadata-updated') metadataListeners.add(listener);
      return harness.session;
    });
    harness.session.off.mockImplementation((event: string, listener: () => void) => {
      if (event === 'metadata-updated') metadataListeners.delete(listener);
      return harness.session;
    });
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
        for (const listener of metadataListeners) listener();
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({
      status: 'applied',
      timing: 'before_next_prompt',
    });

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      const selection = {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'next-model',
      } as const;

      await expect(transition?.({ v: 1, selection })).resolves.toMatchObject({
        ok: true,
        status: 'applied',
        activeSelection: selection,
      });
      expect(metadata.modelSelectionIntentV1.selection).toEqual(selection);
      expect(metadata.sessionModelsV1.currentModelId).toBe('next-model');
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps prompt admission fenced and skips rollback when active publication loses publisher authority after the runtime effect', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    const readModels = () => ({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (listener: (snapshot: ReturnType<typeof readModels>) => void) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        const next = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
        if (next.sessionModelsV1?.currentModelId === 'next-model') {
          throw Object.assign(new Error('publisher superseded'), {
            code: 'session_publisher_authority_lost',
            retryable: false,
          });
        }
        metadata = next;
      },
    );
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({
      status: 'applied',
      timing: 'before_next_prompt',
    });

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      await expect(transition?.({
        v: 1,
        selection: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'next-model',
        },
      })).resolves.toMatchObject({
        ok: false,
        status: 'owner_unavailable',
      });
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(1);
      expect(
        harness.session.updateMetadataAsCurrentPublisher,
      ).toHaveBeenCalled();
      expect(params.inputConsumer.readProviderInputAdmission()).toMatchObject({
        kind: 'action_required',
        reason: 'generation_pending',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('retains prompt admission when a successor claims after active publication but before the custody check', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    const readModels = () => ({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (
        listener: (snapshot: ReturnType<typeof readModels>) => void,
      ) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.session.checkCurrentPublisherAuthority
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({
      status: 'applied',
      timing: 'before_next_prompt',
    });

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      await expect(transition?.({
        v: 1,
        selection: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'next-model',
        },
      })).resolves.toMatchObject({
        ok: false,
        status: 'owner_unavailable',
      });
      expect(metadata.sessionModelsV1.currentModelId).toBe('next-model');
      expect(harness.session.checkCurrentPublisherAuthority)
        .toHaveBeenCalledTimes(2);
      expect(harness.runtime.updateSessionRuntimeConfig).toHaveBeenCalledTimes(1);
      expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
      expect(params.inputConsumer.readProviderInputAdmission()).toMatchObject({
        kind: 'action_required',
        reason: 'generation_pending',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('does not start runtime apply when a successor claims before the immediate effect check', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 1,
      ref: {
        agentTargetKey: 'agent:happier.agent.qwen/qwen',
        providerConnectionId: null,
        modelId: 'old-model',
      },
    };
    let metadata: any = {
      path: '/tmp/workspace',
      permissionMode: 'default',
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: harness.opts.modelSelection.ref,
      },
    };
    const readModels = () => ({
      currentModelId: 'old-model',
      models: [
        { id: 'old-model', name: 'Old model' },
        { id: 'next-model', name: 'Next model' },
      ],
    });
    harness.runtime.models = {
      read: readModels,
      subscribe: (
        listener: (snapshot: ReturnType<typeof readModels>) => void,
      ) => {
        listener(readModels());
        return { dispose: () => undefined };
      },
    };
    harness.session.getMetadataSnapshot = () => metadata;
    harness.session.updateMetadata.mockImplementation(
      async (update: unknown) => {
        metadata = typeof update === 'function'
          ? (update as (current: typeof metadata) => typeof metadata)(metadata)
          : update;
      },
    );
    harness.session.checkCurrentPublisherAuthority.mockResolvedValue(false);
    harness.runtime.updateSessionRuntimeConfig.mockResolvedValue({
      status: 'applied',
      timing: 'before_next_prompt',
    });

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      const transition = harness.handlers.get(
        SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION,
      );
      await expect(transition?.({
        v: 1,
        selection: {
          agentTargetKey: 'agent:happier.agent.qwen/qwen',
          providerConnectionId: null,
          modelId: 'next-model',
        },
      })).resolves.toMatchObject({
        ok: false,
        status: 'owner_unavailable',
      });
      expect(metadata.sessionModelsV1.currentModelId).toBe('old-model');
      expect(harness.session.checkCurrentPublisherAuthority)
        .toHaveBeenCalledTimes(1);
      expect(harness.runtime.updateSessionRuntimeConfig).not.toHaveBeenCalled();
      expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
      expect(params.inputConsumer.readProviderInputAdmission()).toMatchObject({
        kind: 'action_required',
        reason: 'generation_pending',
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('starts fresh provider input admitted after passive connected-service metadata reconstruction', async () => {
    const harness = createHarness();
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'group' as const,
          profileId: 'primary',
          groupId: 'team',
        },
      },
    };
    harness.deps.createSessionMetadataFn = () => ({
      state: { controlledByUser: false },
      metadata: {
        path: '/tmp/workspace',
        permissionMode: 'default',
        permissionModeUpdatedAt: Date.now(),
        connectedServices,
      },
    });
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{ inputConsumer?: any }>) => {
      const consumer = params.inputConsumer;
      expect(consumer?.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
      const initialRpc = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(initialRpc).toBeTypeOf('function');

      await swapSession?.(swappedSessionFixture.session);
      const swappedRpc = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(swappedRpc).toBeTypeOf('function');
      expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('registers kill control handlers on the active swapped session manager', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const swappedSession = swappedSessionFixture.session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSession);
      const killRpc = swappedSessionFixture.handlers.get(RPC_METHODS.KILL_SESSION);
      expect(killRpc).toBeTypeOf('function');
      await killRpc?.();
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('registers rollback control RPCs by default on the active swapped session manager', async () => {
    const harness = createHarness();
    const swappedSessionFixture = harness.createSessionFixture('session-2');
    const rollbackConversation = vi.fn(async () => ({
      ok: true,
      target: { type: 'latest_turn' as const },
    }));
    const sessionRestore = vi.fn(async () => ({
      ok: true,
      status: 'succeeded' as const,
      source: 'happier_scm' as const,
      restoredScopes: ['workspace' as const],
      receipts: [],
    }));

    setSessionRuntimeFactory(harness.config, () => ({
      operations: {
        ...harness.runtime,
        rollbackConversation,
        sessionRestore,
      },
      nativeRuntime: {
        ...harness.runtime,
        rollbackConversation,
        sessionRestore,
      },
    }));

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async () => {
      await swapSession?.(swappedSessionFixture.session);
      const rollback = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_ROLLBACK);
      expect(rollback).toBeTypeOf('function');
      await rollback?.({ v: 1, target: { type: 'latest_turn' } });
      const restore = swappedSessionFixture.handlers.get(SESSION_RPC_METHODS.SESSION_RESTORE);
      expect(restore).toBeTypeOf('function');
      await restore?.({
        v: 1,
        sessionId: 'session-2',
        scopes: ['workspace'],
        candidate: {
          source: 'happier_scm',
          checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
        },
        confirmation: { sourceChoiceConfirmed: true },
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(rollbackConversation).toHaveBeenCalledWith({
      v: 1,
      target: { type: 'latest_turn' },
    });
    expect(sessionRestore).toHaveBeenCalledWith({
      v: 1,
      sessionId: 'session-2',
      scopes: ['workspace'],
      candidate: {
        source: 'happier_scm',
        checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1',
      },
      confirmation: { sourceChoiceConfirmed: true },
    });
  });

  it('can defer session swap application until the loop boundary through a shared strategy hook', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    let pendingApply: (() => Promise<void>) | null = null;
    harness.config.onSessionSwap = vi.fn(async ({ session }: any) => {
      callOrder.push(`swap:${session.sessionId}`);
    });
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          callOrder.push('request');
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          callOrder.push('flush:start');
          await pendingApply?.();
          pendingApply = null;
          callOrder.push('flush:end');
        },
      }),
    };

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      await onSessionSwap({
        ...harness.session,
        sessionId: 'session-2',
      });
      callOrder.push('after-notify');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      callOrder.push('before-boundary');
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      callOrder.push('after-boundary');
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(callOrder).toEqual([
      'request',
      'after-notify',
      'before-boundary',
      'flush:start',
      'swap:session-2',
      'flush:end',
      'after-boundary',
    ]);
  });

  it('keeps a constructed replacement inactive until swap apply then deactivates and closes the prior client', async () => {
    const harness = createHarness();
    const order: string[] = [];
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    initialSession.deactivateDurableMutationDelivery = vi.fn(() => order.push('old:deactivate'));
    initialSession.close = vi.fn(async () => { order.push('old:close'); });
    replacement.stageInitialDurableMutationSnapshots = vi.fn(async () => { order.push('replacement:stage'); });
    replacement.activateDurableMutationDelivery = vi.fn(async () => { order.push('replacement:activate'); });
    replacement.flushDurableMutationDelivery = vi.fn(async () => { order.push('replacement:flush'); });
    let pendingApply: (() => Promise<void>) | null = null;
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          await pendingApply?.();
          pendingApply = null;
        },
      }),
    };
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      expect(order).toEqual([]);
      expect(initialSession.close).not.toHaveBeenCalled();
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      expect(order).toEqual([]);
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      expect(order).toEqual([
        'old:deactivate',
        'replacement:stage',
        'replacement:activate',
        'old:close',
        'replacement:flush',
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('exposes native activity through the production input consumer and activity RPC independently of child runs', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const handlers = new Set<(event: AgentSessionRuntimeEventV1) => void>();
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: AgentSessionRuntimeEventV1) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    });
    harness.session.subscribeExecutionRunActivitySnapshots = (observe: (count: number) => void) => {
      observe(3);
      return () => undefined;
    };
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const read = async () => await harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)!({ action: 'activity_read' });
      await expect(read()).resolves.toMatchObject({ nativeRuntimeActivity: 'unknown' });
      for (const handler of handlers) handler({ kind: 'runtime-activity-snapshot',
        sessionId: 'session-1', sequence: 1, emittedAtMs: 1, state: 'active', activeCount: 1 });
      await expect(read()).resolves.toMatchObject({ nativeRuntimeActivity: 'active' });
      for (const handler of handlers) handler({ kind: 'runtime-activity-snapshot',
        sessionId: 'session-1', sequence: 2, emittedAtMs: 2, state: 'idle', activeCount: 0 });
      await expect(read()).resolves.toMatchObject({ nativeRuntimeActivity: 'settled' });
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 3 } },
        })));
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('retains Activity slot truth across a same-session client swap', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    const unsubscribeRuntimeActivity = vi.fn();
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => {
        runtimeActivityHandlers.delete(handler);
        unsubscribeRuntimeActivity();
      };
    });
    let pendingApply: (() => Promise<void>) | null = null;
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          await pendingApply?.();
          pendingApply = null;
        },
      }),
    };
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      for (const handler of runtimeActivityHandlers) {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 1,
          sessionId: 'session-1',
          emittedAtMs: 1,
          state: 'active',
          activeCount: 1,
        });
      }
      await vi.waitFor(() => expect(initialSession.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      // The host has several independent runtime-event subscribers (turn lifecycle,
      // identity publication, Activity). What a same-session swap must not do is
      // retire and re-establish any of them, so compare across the swap boundary
      // instead of pinning an absolute subscriber count.
      const runtimeSubscriptionsBeforeSwap =
        harness.runtime.subscribeRuntimeEvents.mock.calls.length;

      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });

      expect(harness.runtime.subscribeRuntimeEvents)
        .toHaveBeenCalledTimes(runtimeSubscriptionsBeforeSwap);
      expect(unsubscribeRuntimeActivity).not.toHaveBeenCalled();
      expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        }));

      for (const handler of runtimeActivityHandlers) {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 2,
          sessionId: 'session-1',
          emittedAtMs: 2,
          state: 'idle',
          activeCount: 0,
        });
      }
      await vi.waitFor(() => expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('rebinds Activity to a different session while retaining the native runtime source', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const initialSession = harness.session;
    const replacementFixture = harness.createSessionFixture('session-2');
    const replacement = replacementFixture.session;
    const subscriptions: Array<{
      handler: (event: any) => void;
      unsubscribe: ReturnType<typeof vi.fn>;
    }> = [];
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: any) => void) => {
      // The native runtime keeps its original source Session identity after
      // the host swaps the destination Session client.
      const unsubscribe = vi.fn(() => {
        handler({
          kind: 'runtime-activity-snapshot',
          sequence: 99,
          sessionId: 'session-1',
          emittedAtMs: 99,
          state: 'active',
          activeCount: 9,
        });
      });
      subscriptions.push({ handler, unsubscribe });
      return unsubscribe;
    });
    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    // Fan events out as the retained native runtime does, without pinning
    // the Activity consumer's position among the lifecycle subscribers.
    const emitToAll = (
      registrations: readonly Readonly<{ handler(event: any): void }>[],
      event: Readonly<Record<string, unknown>>,
    ): void => {
      for (const registration of registrations) registration.handler(event);
    };
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const runtimeSubscribers = [...subscriptions];
      expect(runtimeSubscribers.length).toBeGreaterThan(0);
      emitToAll(runtimeSubscribers, {
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      });
      await vi.waitFor(() => expect(initialSession.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      await expect(harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)!({ action: 'activity_read' }))
        .resolves.toMatchObject({ nativeRuntimeActivity: 'active' });
      const initialCallsBeforeSwap = initialSession.enqueueRegisteredSessionStateFieldMutation.mock.calls.length;
      await swapSession?.(replacement);
      await expect(replacementFixture.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)!({ action: 'activity_read' }))
        .resolves.toMatchObject({ nativeRuntimeActivity: 'unknown' });
      expect(subscriptions).toHaveLength(runtimeSubscribers.length);
      expect(initialSession.enqueueRegisteredSessionStateFieldMutation.mock.calls
        .slice(initialCallsBeforeSwap)).not.toContainEqual([
        expect.objectContaining({
          op: expect.objectContaining({ value: expect.objectContaining({ activeCount: 9 }) }),
        }),
      ]);

      const callsBeforeForeignSource = replacement.enqueueRegisteredSessionStateFieldMutation.mock.calls.length;
      emitToAll(runtimeSubscribers, {
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-2',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 9,
      });
      await Promise.resolve();
      expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenCalledTimes(callsBeforeForeignSource);

      emitToAll(runtimeSubscribers, {
        kind: 'runtime-activity-snapshot',
        sequence: 3,
        sessionId: 'session-1',
        emittedAtMs: 3,
        state: 'active',
        activeCount: 2,
      });
      await expect(replacementFixture.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)!({ action: 'activity_read' }))
        .resolves.toMatchObject({ nativeRuntimeActivity: 'active' });
      await vi.waitFor(() => expect(replacement.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    for (const registration of subscriptions) {
      expect(registration.unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('delivers a reply after dispatch-initiated replacement through the public host owner', async () => {
    const harness = createHarness();
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: true }));
    let replacementLifecycle: HostRuntimeReplacementLifecycle | undefined;
    harness.runtime.setRuntimeReplacementLifecycle = (lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      const consumer = params.inputConsumer!;
      await expect(consumer.runProviderInputDispatch({
        abortSignal: new AbortController().signal,
        dispatch: async () => {
          await replacementLifecycle!.beforeReplacement();
          expect(consumer.readProviderInputAdmission()).toMatchObject({ groupId: 'primary-runtime' });
          await replacementLifecycle!.onSuccessorBound();
          await replacementLifecycle!.onSuccessorUsable();
          harness.runtime.emitRuntimeMessage({
            kind: 'transcript-message-committed', sequence: 1, sessionId: 'session-1', emittedAtMs: 1,
            turnId: 'turn-1', messageId: 'reply-1', role: 'assistant', text: 'replacement reply',
          });
        },
      })).resolves.toMatchObject({ status: 'dispatched' });
      expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(harness.session.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'qwen', expect.objectContaining({ message: 'replacement reply' }), expect.anything(),
    );
  });

  it('keeps external replacement waiting for an in-flight dispatch through the public host owner', async () => {
    const harness = createHarness();
    let replacementLifecycle: HostRuntimeReplacementLifecycle | undefined;
    harness.runtime.setRuntimeReplacementLifecycle = (lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      const release = createDeferred<void>();
      const consumer = params.inputConsumer!;
      const dispatch = consumer.runProviderInputDispatch({
        abortSignal: new AbortController().signal,
        dispatch: async () => await release.promise,
      });
      let replaced = false;
      const replacing = replacementLifecycle!.beforeReplacement().then(() => { replaced = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(consumer.readProviderInputAdmission()).toMatchObject({ groupId: 'primary-runtime' });
      expect(replaced).toBe(false);
      release.resolve();
      await Promise.all([dispatch, replacing]);
      expect(replaced).toBe(true);
      await replacementLifecycle!.onSuccessorBound();
      await replacementLifecycle!.onSuccessorUsable();
      expect(consumer.readProviderInputAdmission()).toEqual({ kind: 'admitted' });
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps Activity unknown during retirement and until a replacement provider reports its snapshot', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    let replacementLifecycle: Readonly<{
      beforeReplacement(): Promise<void>;
      onSuccessorBound(): Promise<void>;
      onSuccessorUsable(): Promise<void>;
    }> | null = null;
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => runtimeActivityHandlers.delete(handler);
    });
    harness.runtime.setRuntimeReplacementLifecycle = vi.fn((lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(replacementLifecycle).not.toBeNull();
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      await replacementLifecycle!.beforeReplacement();
      // Physical retirement has not proved any provider stop at this boundary;
      // failure or a stalled retirement must not manufacture idle Activity.
      expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
        }));
      await replacementLifecycle!.onSuccessorBound();
      expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'unknown', activeCount: 0 } },
        }));
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        state: 'idle',
        activeCount: 0,
      }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'idle', activeCount: 0 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('restores the current producer binding when replacement observation-loss publication rejects', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    const runtimeActivityHandlers = new Set<(event: any) => void>();
    const publicationFailure = new Error('replacement observation-loss publication rejected');
    let rejectNextUnknown = false;
    harness.session.enqueueRegisteredSessionStateFieldMutation.mockImplementation(async (mutation: Readonly<{
      op?: Readonly<{ value?: Readonly<{ state?: unknown }> }>;
    }>) => {
      if (rejectNextUnknown && mutation.op?.value?.state === 'unknown') {
        rejectNextUnknown = false;
        throw publicationFailure;
      }
    });
    let replacementLifecycle: Readonly<{
      beforeReplacement(): Promise<void>;
      onSuccessorBound(): Promise<void>;
      onSuccessorUsable(): Promise<void>;
    }> | null = null;
    harness.runtime.subscribeRuntimeEvents = vi.fn((handler: (event: any) => void) => {
      runtimeActivityHandlers.add(handler);
      return () => runtimeActivityHandlers.delete(handler);
    });
    harness.runtime.setRuntimeReplacementLifecycle = vi.fn((lifecycle: typeof replacementLifecycle) => {
      replacementLifecycle = lifecycle;
    });
    harness.deps.runPermissionModePromptLoopFn = async () => {
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 1,
        sessionId: 'session-1',
        emittedAtMs: 1,
        state: 'active',
        activeCount: 1,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        })));

      rejectNextUnknown = true;
      await expect(replacementLifecycle!.beforeReplacement()).rejects.toBe(publicationFailure);
      runtimeActivityHandlers.forEach((handler) => handler({
        kind: 'runtime-activity-snapshot',
        sequence: 2,
        sessionId: 'session-1',
        emittedAtMs: 2,
        state: 'active',
        activeCount: 2,
      }));
      await vi.waitFor(() => expect(harness.session.enqueueRegisteredSessionStateFieldMutation)
        .toHaveBeenLastCalledWith(expect.objectContaining({
          op: { kind: 'set', value: { state: 'active', activeCount: 2 } },
        })));
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('reactivates the prior delivery owner when replacement baseline persistence fails', async () => {
    const harness = createHarness();
    harness.config.runtimeActivityApplicability = 'supported';
    // The host registers several runtime-event consumers (Activity, runtime
    // publication, session loop) against one runtime, so disposal is asserted
    // per registration rather than through one shared spy.
    const runtimeEventUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    harness.runtime.subscribeRuntimeEvents = vi.fn(() => {
      const unsubscribe = vi.fn();
      runtimeEventUnsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    const order: string[] = [];
    const initialSession = harness.session;
    const replacement = harness.createSessionFixture('session-1').session;
    initialSession.deactivateDurableMutationDelivery = vi.fn(() => order.push('old:deactivate'));
    initialSession.activateDurableMutationDelivery = vi.fn(async () => { order.push('old:reactivate'); });
    initialSession.close = vi.fn(async () => { order.push('old:close'); });
    replacement.stageInitialDurableMutationSnapshots = vi.fn(async () => {
      order.push('replacement:stage');
      expect(runtimeEventUnsubscribes.some((unsubscribe) => unsubscribe.mock.calls.length > 0))
        .toBe(false);
      throw new Error('replacement baseline persistence rejected');
    });
    replacement.activateDurableMutationDelivery = vi.fn(async () => { order.push('replacement:activate'); });
    let pendingApply: (() => Promise<void>) | null = null;
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          await pendingApply?.();
          pendingApply = null;
        },
      }),
    };
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      await onSessionSwap(replacement);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      order.length = 0;
      await expect(params.onAfterLoopBoundary?.({ reason: 'turn_completed' })).rejects.toThrow(
        'replacement baseline persistence rejected',
      );
      expect(order).toEqual([
        'old:deactivate',
        'replacement:stage',
        'old:reactivate',
      ]);
      expect(replacement.activateDurableMutationDelivery).not.toHaveBeenCalled();
      expect(initialSession.close).not.toHaveBeenCalled();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(runtimeEventUnsubscribes.length).toBeGreaterThan(0);
    for (const unsubscribe of runtimeEventUnsubscribes) {
      expect(unsubscribe).toHaveBeenCalledOnce();
    }
  });

  it('preserves the opaque initial resume id before enabling strict resume mode', async () => {
    const harness = createHarness();
    harness.opts.resume = '  resume-id  ';

    let receivedInitialResumeId: string | undefined;
    let receivedStrictInitialResume: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (
      params: Readonly<{ initialResumeId?: string; strictInitialResume?: boolean }>,
    ) => {
      receivedInitialResumeId = params.initialResumeId;
      receivedStrictInitialResume = params.strictInitialResume;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(receivedInitialResumeId).toBe('  resume-id  ');
    expect(receivedStrictInitialResume).toBe(true);
  });

  it('passes resolved MCP servers to the provider runtime', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';

    let capturedMcpServers: any = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedMcpServers = params.mcpServers;
      return createRuntime(params);
    });

    harness.deps.resolveRunnerMcpServersFn = async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' }, extra: { command: 'extra' } },
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' }, extra: { command: 'extra' } });
  });

  it('passes resolved MCP servers to an external Agent that declares native MCP delivery', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const agentId = 'com.acme.review/review';
    const catalog = getResolvedContributionRegistry();
    readAgentCatalogSnapshotOverride.mockReturnValue({
      ...catalog,
      catalogEntriesById: {
        ...catalog.catalogEntriesById,
        [agentId]: {
          id: agentId,
          cliSubcommand: 'acme-review',
          toolDelivery: 'native_mcp',
        },
      },
    });
    harness.config.policyAgentId = agentId;

    let capturedMcpServers: unknown = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) throw new Error('Expected session runtime factory in harness');
    setSessionRuntimeFactory(harness.config, (params) => {
      capturedMcpServers = params.mcpServers;
      return createRuntimeOriginal(params);
    });
    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        resolveRunnerMcpServersFn,
      });

      expect(resolveRunnerMcpServersFn).toHaveBeenCalledOnce();
      expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' } });
    } finally {
      readAgentCatalogSnapshotOverride.mockReset();
    }
  });

  it('releases durable custody when MCP resolution fails before runtime construction', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const mcpFailure = new Error('MCP resolution failed before provider construction');
    const createSessionRuntime = vi.fn(harness.config.createSessionRuntime!);
    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.config.flavor = 'grok';
    harness.config.policyAgentId = 'grok';
    harness.config.createSessionRuntime = createSessionRuntime;
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => {
      throw mcpFailure;
    });

    await expect(
      runHostSessionRuntime(harness.opts, harness.config, harness.deps),
    ).rejects.toBe(mcpFailure);

    expect(harness.session.deactivateDurableMutationDelivery).toHaveBeenCalledOnce();
    expect(harness.session.close).toHaveBeenCalledOnce();
    expect(harness.session.endSessionAndClose).not.toHaveBeenCalled();
    expect(createSessionRuntime).not.toHaveBeenCalled();
    expect(runSessionLoopLifecycleFn).not.toHaveBeenCalled();
  });

  it('admits Session startup with a typed notice when optional daemon plugin tools are unavailable', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.flavor = 'grok';
    harness.config.policyAgentId = 'grok';
    let admittedMcpServers: unknown;
    const createRuntime = harness.config.createSessionRuntime!;
    setSessionRuntimeFactory(harness.config, params => {
      admittedMcpServers = params.mcpServers;
      return createRuntime(params);
    });
    // Exercise real MCP/catalog logic; the loopback daemon is the network boundary.
    delete harness.deps.resolveRunnerMcpServersFn;
    const home = await mkdtemp(join(tmpdir(), 'catalog-startup-failure-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ kind: 'unavailable', code: 'daemon_unavailable' }));
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected daemon listener');
      envScope.patch({ HAPPIER_HOME_DIR: home });
      reloadConfiguration();
      // The daemon refusal is downstream of the already admitted Account MCP
      // catalog. Publish that prerequisite through its canonical snapshot owner.
      harness.opts.accountSettingsContext = {
        source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: Date.now(), settingsSecretsReadKeys: [], whenRefreshed: null,
      };
      setActiveAccountSettingsSnapshot({
        ...harness.opts.accountSettingsContext,
        scopeKey: resolveAccountSettingsScopeKey(harness.opts.credentials),
        mcpServerCatalog: { status: 'ready', catalog: emptyMcpServerCatalogV1(), revision: 1, authority: 'active', diagnostics: [] },
      });
      writeDaemonState({ pid: process.pid, httpPort: address.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test-token' });
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(admittedMcpServers).toMatchObject({ happier: expect.objectContaining({ command: expect.any(String) }) });
      expect(harness.session.enqueueSessionEventCommitted).toHaveBeenCalledWith(expect.objectContaining({
        type: 'message', capabilityNoticeV1: { v: 1, items: [{
          kind: 'mcp_server', name: 'MCP plugin tools', code: 'daemon_plugin_catalog_unavailable',
        }] },
      }));
      expect(harness.session.enqueueSessionTurnMutation).not.toHaveBeenCalledWith(expect.objectContaining({
        action: 'fail',
        issue: expect.objectContaining({ code: 'daemon_plugin_catalog_unavailable', source: 'dependency_failure' }),
      }));
      expect(harness.metrics.cleanupCalls).toBe(1);
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
      await clearDaemonStateForTestTeardown();
      envScope.restore();
      reloadConfiguration();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  });

  it('records the runtime issue when an admitted Session loses Account context before its next person turn', async () => {
    const harness = createHarness();
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'context-refusal-account' })).toString('base64url')}.signature`, encryption: null };
    const scopeKey = resolveAccountSettingsScopeKey(credentials);
    const account = { scopeKey, source: 'network' as const, settings: accountSettingsParse({}),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null };
    harness.opts.credentials = credentials;
    harness.opts.accountSettingsContext = account;
    setActiveAccountSettingsSnapshot({ ...account, promptLibraryCatalog: { status: 'ready', rows: [], diagnostics: [],
      tombstones: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1 })) } });
    let settled = false;
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      // A sign-out/lifetime retirement is an external Account-state transition.
      // Keep the actual prompt resolver, dispatch loop and lifecycle wiring.
      resetActiveAccountSettingsSnapshotForTests();
      params.messageQueue.push({ text: 'Continue the goal', localId: 'person-context-refusal' }, { permissionMode: 'default' });
      await runPermissionModePromptLoop({ ...params, shouldExit: () => settled,
        sendReady: () => { settled = true; } });
    };
    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(harness.runtime.sendPrompt).not.toHaveBeenCalled();
      expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
        action: 'fail', issue: expect.objectContaining({ code: 'preparation_pending', source: 'dependency_failure' }),
      }));
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([
    ['Role', 503], ['Role', 403], ['Project', 503], ['Project', 403], ['Account currentness', 503],
  ] as const)('classifies a Home %s startup read and lets existing respawn recover only transient failures (HTTP %s)', async (source, status) => {
    let preparationReads = 0;
    const requests: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      requests.push(path);
      const preparationPath = source === 'Role' ? '/v1/artifacts' : source === 'Account currentness'
        ? '/v1/account/encryption/currentness' : `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`;
      const unavailable = path === preparationPath && ++preparationReads === 1;
      response.statusCode = unavailable ? status : 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(unavailable ? { error: status === 503 ? 'database_connection_unavailable' : 'forbidden', private: 'PRIVATE_RESPONSE' }
        : path === '/v1/artifacts' ? []
        : path === '/v1/account/encryption' ? { mode: 'plain', updatedAt: 1 }
        : path === '/v1/account/encryption/currentness' ? { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 }
        : path === '/v1/account/entity-rows/mcp' ? { status: 'present', revision: 1,
          content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } }
        : path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list` ? ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] })
        : {}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected Home listener');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'role-start-account' })).toString('base64url')}.signature`, encryption: null };
    const snapshot = { source: 'network' as const,
      settings: accountSettingsParse(source === 'Account currentness' ? { mcpServersStrictMode: true } : {}), rawSettings: {},
      scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], whenRefreshed: null,
      promptLibraryCatalog: { status: 'ready' as const, rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1,
        record: emptyPromptLibraryRecordV1(key) })), tombstones: [], diagnostics: [] } };
    const admitted: string[] = [];
    const promptFailures: string[] = [];
    let pendingInitialInput = true;
    const cancellation = new AbortController();
    const attempts: ReturnType<typeof createHarness>[] = [];
    const start = async () => {
      setActiveAccountSettingsSnapshot(snapshot);
      const harness = createHarness('session-1', { managedMcpSelection: source === 'Account currentness' ? 'account-default' : 'empty' });
      attempts.push(harness);
      harness.opts.credentials = credentials;
      harness.opts.accountSettingsContext = snapshot;
      if (source === 'Account currentness') delete harness.deps.resolveRunnerMcpServersFn;
      const metadata = harness.session.getMetadataSnapshot();
      harness.session.getMetadataSnapshot = () => ({ ...metadata, work: { sessionRolesV1: {
        roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '',
      } } });
      vi.spyOn(harness.session, 'getServerBinding').mockReturnValue({ ...harness.session.getServerBinding(), serverUrl });
      // The Pending transport and native Agent are boundaries. The retained
      // local id, real Role preparation, host lifecycle and prompt loop stay real.
      harness.runtime.updateSessionRuntimeConfig = async () => ({ status: 'applied', timing: 'current_window' });
      harness.runtime.sendPrompt.mockImplementation(async (prompt: string) => { admitted.push(prompt); pendingInitialInput = false; });
      harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
        let settled = false;
        if (pendingInitialInput) params.messageQueue.push({ text: 'RETAINED_INITIAL_PROMPT', localId: 'initial-role-start' }, { permissionMode: 'default' });
        await runPermissionModePromptLoop({ ...params, getAbortSignal: () => cancellation.signal,
          formatPromptErrorMessage: error => { promptFailures.push(String(error)); return params.formatPromptErrorMessage(error); },
          shouldExit: () => settled || cancellation.signal.aborted, sendReady: () => { settled = true; } });
      };
      return runWithServerHttpBaseUrl(serverUrl, () => runHostSessionRuntime(harness.opts, harness.config, harness.deps));
    };
    const diagnostics = vi.spyOn(logger, 'infoFile');
    onTestFinished(() => {
      cancellation.abort();
    });
    try {
      const failureError: unknown = await start().catch((error: unknown) => error);
      expect(failureError).toMatchObject(source === 'Account currentness'
        ? { code: 'mcp_catalog_unavailable', reason: 'unreachable' }
        : { code: status === 503 ? 'preparation_pending' : 'attachment_unavailable',
          reason: status === 503 ? 'unavailable' : 'locked' });
      expect(preparationReads).toBe(1);
      expect(admitted).toEqual([]);
      expect(pendingInitialInput).toBe(true);
      const mutations: unknown[] = attempts[0]!.session.enqueueSessionTurnMutation.mock.calls.map(([mutation]: readonly unknown[]) => mutation);
      const failure = mutations.map(mutation => SessionTurnMutationV1Schema.parse(mutation)).find(mutation => mutation.action === 'fail');
      if (!failure || failure.action !== 'fail') throw new Error('Expected published startup failure');
      expect(failure.issue).toMatchObject({ code: status === 503 ? 'preparation_pending' : 'attachment_unavailable', source: 'dependency_failure' });
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_RESPONSE');
      if (source !== 'Account currentness') expect(diagnostics.mock.calls).toContainEqual(['[Session] Home preparation read failed', expect.objectContaining({
        kind: status === 503 ? 'server_error' : 'auth_failed', statusCode: status, retryable: status === 503,
      })]);
      let respawned = false;
      const terminal: string[] = [];
      const recovery = createDeferred<void>();
      const manager = createSessionRunnerRespawnManager({ enabled: true, maxRestarts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0,
        isSessionAlreadyRunning: () => false, readStartupFailure: async () => failure.issue,
        spawnSession: async () => { await start(); respawned = true; return { type: 'success' }; },
        onRespawnSuccess: () => recovery.resolve(),
        onRespawnTerminal: ({ reason }) => { terminal.push(reason); recovery.resolve(); }, random: () => 0, logDebug: () => {}, logWarn: () => {} });
      manager.handleUnexpectedExit({ startedBy: 'daemon', pid: 111, happySessionId: 'session-1', processStartTimeMs: 0,
        spawnOptions: { directory: '/tmp' } }, { reason: 'process-exit', code: resolveSessionRunnerFailureExitCode(failureError), signal: null });
      await recovery.promise;
      if (status === 503) {
        expect(respawned).toBe(true);
        expect(preparationReads).toBeGreaterThan(1);
        expect(promptFailures).toEqual([]);
        expect(admitted).toEqual([expect.stringContaining('RETAINED_INITIAL_PROMPT')]);
        expect(pendingInitialInput).toBe(false);
      } else {
        expect(respawned).toBe(false);
        expect(terminal).toEqual(['startup_dependency_failure']);
        expect(preparationReads).toBe(1);
      }
      expect(requests).toContain(source === 'Role' ? '/v1/artifacts' : source === 'Account currentness'
        ? '/v1/account/entity-rows/mcp' : `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`);
      manager.markStopRequested('session-1', { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
    } finally {
      cancellation.abort();
      diagnostics.mockRestore();
      resetActiveAccountSettingsSnapshotForTests();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each(['preparation_pending', 'profile_missing', 'context_source_unavailable', 'role_overrides_unavailable', 'role_source_incomplete'] as const)('publishes typed %s before releasing Session startup custody', async (code) => {
    const { PromptStackPreparationError } = await import('@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1');
    const { HomeTargetResolutionError } = await import('@happier-dev/cli-common/homeTarget');
    const harness = createHarness();
    const failure = code === 'context_source_unavailable' || code === 'role_overrides_unavailable' || code === 'role_source_incomplete'
      ? Object.assign(new Error('private preparation content'), { code,
        reason: code === 'role_source_incomplete' ? 'private-reason' : 'scope-retired',
        contextSource: code === 'role_source_incomplete' ? 'private-source' : 'account_lifetime' })
      : new PromptStackPreparationError('unavailable', { kind: 'doc', artifactId: 'private-prompt' });
    if (code === 'profile_missing') Object.assign(failure, {
      cause: new HomeTargetResolutionError('profile_missing', 'private Home reference'),
    });
    // The Agent runtime factory is the plugin boundary; host lifecycle and publication stay real.
    setSessionRuntimeFactory(harness.config, async () => { throw failure; });
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const publishedCode = code === 'profile_missing' ? code : 'preparation_pending';
    const run = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    if (publishedCode === 'preparation_pending') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toBe(failure);
    const diagnosticIndex = diagnostic.mock.calls.findIndex(([message]) => message.includes('Session construction failed'));
    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
    const diagnosticFields = diagnostic.mock.calls[diagnosticIndex]?.[1];
    expect(diagnosticFields).toMatchObject({
      originalCode: code === 'profile_missing' ? 'preparation_pending' : code,
      reason: code === 'role_source_incomplete' ? 'unknown'
        : code === 'context_source_unavailable' || code === 'role_overrides_unavailable' ? 'scope-retired' : 'unavailable',
      contextSource: code === 'context_source_unavailable' || code === 'role_overrides_unavailable' ? 'account_lifetime' : 'unknown',
      phase: 'agent_runtime_open',
    });
    expect(JSON.stringify(diagnosticFields)).not.toContain('private');
    expect(harness.session.enqueueSessionTurnMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'fail',
      issue: expect.objectContaining({ code: publishedCode, source: 'dependency_failure' }),
    }));
    const failureCallIndex = harness.session.enqueueSessionTurnMutation.mock.calls
      .findIndex((call: readonly unknown[]) => {
        const [mutation] = call;
        return mutation !== null && typeof mutation === 'object'
          && 'action' in mutation && mutation.action === 'fail';
      });
    expect(harness.session.enqueueSessionTurnMutation.mock.invocationCallOrder[failureCallIndex])
      .toBeLessThan(harness.session.deactivateDurableMutationDelivery.mock.invocationCallOrder[0]!);
    expect(diagnostic.mock.invocationCallOrder[diagnosticIndex])
      .toBeLessThan(harness.session.enqueueSessionTurnMutation.mock.invocationCallOrder[failureCallIndex]!);
    expect(harness.session.close).toHaveBeenCalledOnce();
    diagnostic.mockRestore();
  });

  it('publishes a typed compatibility failure before a created Session runner exits', async () => {
    const harness = createHarness();
    const failure = Object.assign(new Error('private incompatible server response'), {
      code: 'metadata_privacy_upgrade_required',
    });
    setSessionRuntimeFactory(harness.config, async () => { throw failure; });

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps)).rejects.toBe(failure);

    const { SessionTurnMutationV1Schema } = await import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1');
    const mutations = harness.session.enqueueSessionTurnMutation.mock.calls
      .map(([mutation]: readonly [unknown]) => SessionTurnMutationV1Schema.parse(mutation));
    expect(mutations).toContainEqual(expect.objectContaining({
      action: 'fail',
      issue: expect.objectContaining({
        code: 'metadata_privacy_upgrade_required',
        source: 'dependency_failure',
        sanitizedPreview: 'Session startup needs a compatible Home. Update or reconnect, then retry the Session.',
      }),
    }));
    expect(harness.session.enqueueSessionTurnMutation.mock.invocationCallOrder.at(-1))
      .toBeLessThan(harness.session.deactivateDurableMutationDelivery.mock.invocationCallOrder[0]!);
    expect(harness.session.close).toHaveBeenCalledOnce();
  });

  it('resolves and passes native MCP servers for the Grok catalog policy', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.flavor = 'grok';
    harness.config.policyAgentId = 'grok';

    let capturedMcpServers: unknown = null;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    setSessionRuntimeFactory(harness.config, (params) => {
      capturedMcpServers = params.mcpServers;
      return createRuntime(params);
    });

    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, {
      ...harness.deps,
      resolveRunnerMcpServersFn,
    });

    expect(resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
    expect(capturedMcpServers).toEqual({ happier: { command: 'built-in' } });
  });

  it('passes the MCP account settings snapshot to the provider runtime', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const runnerAccountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            approvalRequiredSurfaces: ['agent'],
          },
        },
      },
    };
    let capturedAccountSettings: unknown = null;
    const savedSecretResources = [{
      resourceId: 'shared-mcp-secret',
      ownerAccountId: 'owner-account',
      displayName: 'Shared MCP token',
      kind: 'apiKey',
      encryptionMode: 'plain',
      revision: 1,
      storedContent: {
        t: 'plain',
        v: { v: 1, name: 'Shared MCP token', kind: 'apiKey', value: 'shared-token' },
      },
      materialStatus: 'ready',
    }] as const;
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: runnerAccountSettings as never,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      savedSecretResources,
      savedSecretCatalogState: 'ready',
      whenRefreshed: null,
    };
    // Saved Secret material follows the current Account lifetime, not the
    // invocation's preference snapshot.
    setActiveAccountSettingsSnapshot({
      ...harness.opts.accountSettingsContext,
      scopeKey: resolveAccountSettingsScopeKey(harness.opts.credentials),
      mcpServerCatalog: { status: 'ready', catalog: emptyMcpServerCatalogV1(), revision: 1, authority: 'active', diagnostics: [] },
    });
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) {
      throw new Error('Expected session runtime factory in harness');
    }
    const createRuntime = createRuntimeOriginal;
    harness.config.resolveRunnerMcpServersAccountSettings = () => runnerAccountSettings as never;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async (params: any) => {
      expect(params.accountSettings).toBe(runnerAccountSettings);
      expect(params.savedSecretResources).toBe(savedSecretResources);
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: { happier: { command: 'built-in' } },
      };
    });
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedAccountSettings = params.accountSettings;
      return createRuntime(params);
    });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(capturedAccountSettings).toBe(runnerAccountSettings);
    } finally {
      resetActiveAccountSettingsSnapshotForTests();
    }
  });

  it('threads an explicitly scoped Action policy to the Session tool transports without ambient Account settings', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const scopedActionsSettings = {
      v: 1 as const,
      actions: {
        'session.title.set': {
          enabled: true,
          approvalRequiredSurfaces: ['agent'] as const,
        },
      },
    };
    const actionsSettingsProvider = Object.freeze({
      getActionsSettings: () => scopedActionsSettings,
    });
    const pluginRuntimeRegistryLease = Object.freeze({
      registry: Object.freeze({}),
      source: 'ephemeral' as const,
      durableRevision: 7,
      release: vi.fn(async () => undefined),
    });
    Object.assign(harness.config, {
      runtimeActionSettingsProvider: actionsSettingsProvider,
      pluginRuntimeRegistryLease,
    });
    harness.opts.accountSettingsContext = undefined;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async (params: any) => {
      expect(params.accountSettings).toBeNull();
      expect(params.actionsSettingsProvider).toBe(actionsSettingsProvider);
      expect(params.actionsSettingsProvider.getActionsSettings()).toBe(scopedActionsSettings);
      expect(params.pluginRuntimeRegistryLease).toBe(pluginRuntimeRegistryLease);
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: { happier: { command: 'built-in' } },
      };
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.deps.resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
  });

  it('passes the scoped Session credential reader to native Agent services without the ambient Account reader', async () => {
    const harness = createHarness();
    const sessionCredentials = { token: 'runner-session-token', encryption: null } as const;
    harness.config.runtimeAuthority = {
      scope: 'session',
      sessionCredentials,
      accountCredentials: null,
    };
    let readCredentials: (() => Promise<unknown>) | undefined;
    const createRuntimeOriginal = harness.config.createSessionRuntime;
    if (!createRuntimeOriginal) throw new Error('Expected session runtime factory in harness');
    setSessionRuntimeFactory(harness.config, (params: any) => {
      readCredentials = params.readCredentials;
      return createRuntimeOriginal(params);
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(readCredentials).toBeTypeOf('function');
    await expect(readCredentials!()).resolves.toEqual(sessionCredentials);
  });

  it('sanitizes ambient Account settings before Session-scoped callbacks and MCP resolution', async () => {
    const harness = createHarness();
    const sessionCredentials = { token: 'runner-session-token', encryption: null } as const;
    const accountSettingsContext = {
      source: 'network' as const,
      settings: { sessionDefaultPermissionModeByTargetKey: { claude: 'yolo' } },
      settingsVersion: 4,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [new Uint8Array([1, 2, 3])],
      whenRefreshed: null,
    };
    harness.opts.accountSettingsContext = accountSettingsContext as never;
    harness.config.runtimeAuthority = {
      scope: 'session',
      sessionCredentials,
      accountCredentials: null,
    };
    const resolveRunnerMcpServersAccountSettings = vi.fn(() => accountSettingsContext.settings as never);
    harness.config.resolveRunnerMcpServersAccountSettings = resolveRunnerMcpServersAccountSettings;
    let lifecycleOpts: unknown = null;
    harness.deps.runSessionLoopLifecycleFn = vi.fn(async (params: any) => {
      lifecycleOpts = params.opts;
    }) as never;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(resolveRunnerMcpServersAccountSettings).not.toHaveBeenCalled();
    expect((lifecycleOpts as any)?.accountSettingsContext).toBeNull();
  });

  it('does not use ambient Account pending-queue timing for a Session-scoped runtime', async () => {
    const harness = createHarness();
    harness.opts.accountSettingsContext = {
      source: 'network' as const,
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' },
      settingsVersion: 4,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    } as never;
    harness.config.runtimeAuthority = {
      scope: 'session',
      sessionCredentials: { token: 'runner-session-token', encryption: null },
      accountCredentials: null,
    };
    let observedPendingQueueDeliveryTiming: unknown;
    harness.deps.runPermissionModePromptLoopFn = async (params: { pendingQueueDeliveryTiming?: unknown }) => {
      observedPendingQueueDeliveryTiming = params.pendingQueueDeliveryTiming;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(observedPendingQueueDeliveryTiming).toBe(DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING);
  });

  it('uses attached session metadata for runtime metadata, runtime directory, and MCP directory resolution', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    harness.config.flavor = 'claude';
    harness.config.policyAgentId = 'claude';
    const attachedMetadata = {
      path: '/srv/attached-workspace',
      permissionMode: 'ask',
      permissionModeUpdatedAt: 42,
      profileId: 'profile-attached',
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.deps.createSessionMetadataFn = () => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/local-workspace', permissionMode: 'default', permissionModeUpdatedAt: 1 },
    });
    harness.deps.initializeBackendRunSessionFn = async ({ metadata }: any) => {
      expect(metadata.path).toBe('/tmp/local-workspace');
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    };

    let capturedRuntimeParams: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedRuntimeParams = params;
      return {
        operations: harness.runtime,
        nativeRuntime: harness.runtime,
      };
    });

    let capturedShouldRenderMetadata: any = null;
    harness.config.shouldRenderTerminalDisplay = ({ metadata }: any) => {
      capturedShouldRenderMetadata = metadata;
      return false;
    };

    let capturedMcpDirectory: string | null = null;
    let capturedSessionMetadata: any = null;
    let capturedSessionLocation: any = null;
    harness.deps.resolveRunnerMcpServersFn = async (params: any) => {
      capturedMcpDirectory = params.directory;
      capturedSessionMetadata = params.sessionMetadata;
      capturedSessionLocation = params.session.getCurrentSessionLocation?.();
      return {
        happierMcpServer: { stop: () => undefined },
        mcpServers: {},
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedShouldRenderMetadata).toMatchObject({ path: '/srv/attached-workspace' });
    expect(capturedRuntimeParams).toMatchObject({
      directory: '/srv/attached-workspace',
      metadata: expect.objectContaining({ path: '/srv/attached-workspace', profileId: 'profile-attached' }),
    });
    expect(capturedMcpDirectory).toBe('/srv/attached-workspace');
    expect(capturedSessionMetadata).toMatchObject({ path: '/srv/attached-workspace', profileId: 'profile-attached' });
    expect(capturedSessionLocation).toEqual({
      path: '/srv/attached-workspace',
      host: harness.config.machineMetadata.host,
      machineId: 'machine-1',
    });
  });

  it('refreshes provider binding metadata on an attached session before creating its runtime', async () => {
    const harness = createHarness();
    harness.config.policyAgentId = 'codex';
    harness.opts.backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'provider-model' },
    };
    const materialization = {
      v: 1 as const,
      kind: 'engineConfig' as const,
      engineConfig: { model_provider: { name: 'gateway' } },
    };
    const nextBinding = {
      v: 1 as const,
      connectionId: ProviderConnectionIdSchema.parse('pc_work'),
      contributionKey: 'plugin.openrouter/openrouter',
      connectionRevision: 4,
      model: providerModelDescriptor,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'openrouter',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      runtimeBindingBasis: externalProviderRuntimeBindingBasis({
        connectionId: 'pc_work',
        agentTargetKey: 'agent:happier.agent.codex/codex',
        contributionKey: 'plugin.openrouter/openrouter',
        adapterBindingKey: 'openrouter',
        fingerprintScope: 'attached-refresh',
      }),
      displaySnapshot: {
        providerName: 'OpenRouter', connectionName: 'Work', connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    let attachedMetadata: Record<string, unknown> = {
      path: '/srv/attached-workspace',
      providerBindingV1: { ...nextBinding, connectionRevision: 3 },
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.session.updateMetadata = vi.fn(async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      attachedMetadata = updater(attachedMetadata);
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session,
      reconnectionHandle: null,
      reportedSessionId: 'session-1',
      attachedToExistingSession: true,
    });
    const createSessionRuntime = vi.fn(() => ({ operations: harness.runtime, nativeRuntime: harness.runtime }));
    harness.config.createSessionRuntime = createSessionRuntime;
    process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY] =
      serializeProviderBindingLaunchHandoffForEnv(
        materialization,
        nextBinding,
      );

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

      expect(harness.session.updateMetadata).toHaveBeenCalled();
      expect(
        harness.session.updateMetadataAsCurrentPublisher,
      ).toHaveBeenCalled();
      expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ providerBindingV1: nextBinding }),
      }));
    } finally {
      delete process.env[HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY];
    }
  });

  it('clears stale provider binding metadata when an attached session explicitly restarts on a native model', async () => {
    const harness = createHarness();
    harness.opts.backendTarget = { kind: 'backend', backendId: 'qwen', sourceKind: 'built_in' };
    harness.opts.modelSelection = {
      v: 1,
      updatedAt: 10,
      ref: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: null, modelId: 'native-model' },
    };
    let attachedMetadata: Record<string, unknown> = {
      path: '/srv/attached-workspace',
      providerBindingV1: {
        v: 1, connectionId: 'pc_old', contributionKey: 'plugin:old:old', connectionRevision: 1,
        protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'old',
        compatibilityFingerprint: 'compatibility-v1', bindingSecurityFingerprint: 'security-v1',
        displaySnapshot: { providerName: 'Old', connectionName: 'Old', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
      },
    };
    harness.session.getMetadataSnapshot = () => attachedMetadata;
    harness.session.updateMetadata = vi.fn(async (updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      attachedMetadata = updater(attachedMetadata);
    });
    harness.deps.initializeBackendRunSessionFn = async () => ({
      session: harness.session, reconnectionHandle: null, reportedSessionId: 'session-1', attachedToExistingSession: true,
    });
    const createSessionRuntime = vi.fn(() => ({ operations: harness.runtime, nativeRuntime: harness.runtime }));
    harness.config.createSessionRuntime = createSessionRuntime;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.updateMetadata).toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ providerBindingV1: expect.anything() }),
    }));
  });

  it('does not pass attach metadata cleanup keys through the canonical shared startup contract for existing-session attaches', async () => {
    const harness = createHarness();
    harness.opts.existingSessionId = 'existing-123';

    const initializeBackendRunSessionFn = vi.fn(async (
      params: InitializeBackendRunSessionOptions,
    ) => {
      expect(params.metadataKeysToUnsetOnAttach).toBeUndefined();
      expect(params.requireDaemonAckOnAttach).toBeUndefined();
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: true,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledTimes(1);
  });

  it('requires the existing daemon acknowledgement for authority-backed runner attaches', async () => {
    const harness = createHarness();
    harness.opts.existingSessionId = 'existing-runner-123';
    const previousBootstrap =
      process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
    const previousAuthority =
      process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
    process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY] =
      '/tmp/runner-bootstrap.json';
    process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY] =
      '/tmp/runner-authority.json';

    const initializeBackendRunSessionFn = vi.fn(async (
      params: InitializeBackendRunSessionOptions,
    ) => {
      expect(params.requireDaemonAckOnAttach).toBe(true);
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'existing-runner-123',
        attachedToExistingSession: true,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(initializeBackendRunSessionFn).toHaveBeenCalledTimes(1);
    } finally {
      if (previousBootstrap === undefined) {
        delete process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
      } else {
        process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY] =
          previousBootstrap;
      }
      if (previousAuthority === undefined) {
        delete process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      } else {
        process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY] =
          previousAuthority;
      }
    }
  });

  it('does not seed ACP transport metadata from the generic shared host-session path', async () => {
    const harness = createHarness();
    harness.config.augmentSessionMetadata = (metadata) => ({
      ...metadata,
      acpTransportV1: {
        v: 1,
        agentId: 'configured-acp',
      },
    });
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.not.objectContaining({
      acpProviderId: expect.any(String),
    }));
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      augmentMetadata: expect.any(Function),
    }));
  });

  it('rejects legacy raw createSessionRuntime returns on the canonical host-session path', async () => {
    const harness = createHarness();
    harness.config.createSessionRuntime = () => harness.runtime;

    await expect(runHostSessionRuntime(harness.opts, harness.config, harness.deps))
      .rejects
      .toThrow('Shared host session runtime requires explicit operations/nativeRuntime binding');
  });

  it('uses canonical session-mode carriers and retires the legacy host-session hook boundary', async () => {
    const harness = createHarness();
    (harness.opts as any).sessionModeId = 'plan';
    (harness.opts as any).sessionModeUpdatedAt = 42;
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    const initializeBackendRunSessionFn = vi.fn(async ({ startupMetadataOverrides }: any) => {
      expect(startupMetadataOverrides).toBeTruthy();
      expect(startupMetadataOverrides?.acpSessionModeOverride).toBeUndefined();
      expect(startupMetadataOverrides?.sessionModeOverride).toBeUndefined();
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    });
    harness.deps.initializeBackendRunSessionFn = initializeBackendRunSessionFn;
    harness.config.lifecycleHooks = {
      resolveInitialModelSelection: ({ opts }) => {
        expect((opts as any).agentModeId).toBeUndefined();
        expect((opts as any).agentModeUpdatedAt).toBeUndefined();
        expect((opts as any).sessionModeId).toBe('plan');
        expect((opts as any).sessionModeUpdatedAt).toBe(42);
        return null;
      },
      onSessionInitialized: ({ opts }) => {
        expect((opts as any).agentModeId).toBeUndefined();
        expect((opts as any).agentModeUpdatedAt).toBeUndefined();
        expect((opts as any).sessionModeId).toBe('plan');
        expect((opts as any).sessionModeUpdatedAt).toBe(42);
      },
    };
    harness.config.beforeInitializeSession = ({ opts }: any) => {
      expect((opts as any).agentModeId).toBeUndefined();
      expect((opts as any).agentModeUpdatedAt).toBeUndefined();
      expect((opts as any).sessionModeId).toBe('plan');
      expect((opts as any).sessionModeUpdatedAt).toBe(42);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initializeBackendRunSessionFn).toHaveBeenCalledTimes(1);
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      sessionModeId: 'plan',
      sessionModeUpdatedAt: 42,
    }));
    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.not.objectContaining({
      agentModeId: 'plan',
      agentModeUpdatedAt: 42,
    }));
  });

  it('skips native MCP resolution for shell-bridge providers', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    await useShellBridgeRuntimeFixture(harness.config);

    let capturedMcpServers: any = null;
    setSessionRuntimeFactory(harness.config, (params: any) => {
      capturedMcpServers = params.mcpServers;
      const nativeRuntime = {
        ...harness.runtime,
        getSessionId: vi.fn(() => null),
      };
      return {
        operations: nativeRuntime,
        nativeRuntime,
      };
    });

    const resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, {
      ...harness.deps,
      resolveRunnerMcpServersFn,
    });

    expect(resolveRunnerMcpServersFn).not.toHaveBeenCalled();
    expect(capturedMcpServers).toEqual({});
    expect(harness.handlers.has(SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1)).toBe(true);
  });

  it('uses the Happier session id, not the vendor runtime session id, for shell-bridge prompt instructions', async () => {
    const harness = createHarness();
    await useShellBridgeRuntimeFixture(harness.config);

    harness.runtime.getSessionId = vi.fn(() => 'vendor-session-123');

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(resolvedPrompt).toContain("'--session-id' 'session-1'");
    expect(resolvedPrompt).not.toContain('vendor-session-123');
  });

  it('adds shell-bridge startup guidance for an external Agent that declares that delivery', async () => {
    const harness = createHarness();
    await useShellBridgeRuntimeFixture(harness.config);

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(resolvedPrompt).toContain("'tools' 'call'");
    expect(resolvedPrompt).toContain("'--session-id' 'session-1'");
  });

  it('uses the swapped Happier session id for shell-bridge prompt instructions after a session swap', async () => {
    const harness = createHarness();
    await useShellBridgeRuntimeFixture(harness.config);
    const swappedSession = harness.createSessionFixture('session-2').session;

    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    let resolvedPrompt = '';
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      resolveFreshSessionSystemPrompt?: (args: { baseOverride?: string | null }) => Promise<string>;
    }>) => {
      await swapSession?.(swappedSession);
      resolvedPrompt = await params.resolveFreshSessionSystemPrompt?.({ baseOverride: 'BASE' }) ?? '';
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(resolvedPrompt).toContain("'--session-id' 'session-2'");
    expect(resolvedPrompt).not.toContain("'--session-id' 'session-1'");
  });

  it.each([
    { wiring: 'production', omitActiveModeHook: false },
    { wiring: 'missing active mode hook', omitActiveModeHook: true },
  ])('applies each in-flight input mode against the real active turn without changing the owner baseline ($wiring)', async ({ omitActiveModeHook }) => {
    const harness = createHarness();
    delete harness.deps.createPermissionModeQueueStateFn;
    delete harness.deps.createProviderEnforcedPermissionHandlerFn;
    if (omitActiveModeHook) {
      // Deliberate composition fault: keep the real queue owner, but omit the
      // host's new turn-mode reader at its existing factory seam.
      harness.deps.createPermissionModeQueueStateFn = (params: Parameters<typeof createPermissionModeQueueState>[0]) => {
        if (!params.inFlightSteer) throw new Error('Expected the host steer controller');
        const { readActivePermissionMode: _omitted, ...inFlightSteer } = params.inFlightSteer;
        return createPermissionModeQueueState({ ...params, inFlightSteer });
      };
    }
    let userMessageHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: typeof userMessageHandler) => { userMessageHandler = handler; };
    harness.session.getCommittedUserMessageSeq = (localId: string) =>
      ['initial-read-only', 'steer-default-1', 'steer-read-only', 'steer-default-2'].indexOf(localId) + 1;
    const createRuntime = harness.config.createSessionRuntime!;
    let permissionHandler: Parameters<typeof createRuntime>[0]['permissionHandler'] | null = null;
    harness.config.createSessionRuntime = (params) => {
      permissionHandler = params.permissionHandler;
      return createRuntime(params);
    };
    let turnInFlight = false;
    let completed = false;
    const effects: string[] = [];
    const runtime = harness.runtime;
    runtime.supportsInFlightSteer = () => true;
    runtime.isTurnInFlight = () => turnInFlight;
    runtime.canSteerPrompt = () => turnInFlight;
    runtime.applyConfigDeltaInFlight = async (delta: { permissionMode: PermissionMode }) => {
      const mode = AgentPermissionIntentV1Schema.parse(delta.permissionMode);
      effects.push(`config:${mode}`);
      return { status: 'applied' as const };
    };
    runtime.sendTurnPrompt = async () => {
      expect(permissionHandler?.getPermissionMode()).toBe('read-only');
      expect(harness.session.getMetadataSnapshot().permissionMode).toBe('default');
      turnInFlight = true;
    };
    runtime.steerPrompt = vi.fn(async (_prompt: string, meta?: { localId?: string }) => {
      effects.push(`steer:${meta?.localId}:${permissionHandler?.getPermissionMode()}`);
    });
    runtime.waitForTurnCompletion = async () => {
      if (!userMessageHandler) throw new Error('Expected the real Session queue callback');
      // Admit all three before dispatch settles, so each must re-read the active
      // mode after the preceding native config application.
      for (const [localId, permissionMode] of [
        ['steer-default-1', undefined],
        ['steer-read-only', 'read-only'],
        ['steer-default-2', undefined],
      ] as const) {
        userMessageHandler({ role: 'user', content: { type: 'text', text: localId }, localId,
          meta: permissionMode ? { permissionMode } : {} });
      }
      await vi.waitFor(() => expect(runtime.steerPrompt).toHaveBeenCalledTimes(3));
      turnInFlight = false;
      completed = true;
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      if (!userMessageHandler) throw new Error('Expected the real Session queue callback');
      userMessageHandler({ role: 'user', content: { type: 'text', text: 'Start a read-only turn' },
        localId: 'initial-read-only', meta: { permissionMode: 'read-only' } });
      await runPermissionModePromptLoop({ ...params, shouldExit: () => completed });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const expectedEffects = [
      'config:default', 'steer:steer-default-1:default',
      'config:read-only', 'steer:steer-read-only:read-only',
      'config:default', 'steer:steer-default-2:default',
    ];
    if (omitActiveModeHook) {
      expect(effects).not.toEqual(expectedEffects);
      expect(effects).toEqual([
        'steer:steer-default-1:read-only',
        'config:read-only', 'steer:steer-read-only:read-only',
        'steer:steer-default-2:read-only',
      ]);
    } else {
      expect(effects).toEqual(expectedEffects);
    }
    expect(harness.session.getMetadataSnapshot().permissionMode).toBe('default');
  });

  it('in-flight steer controller preserves the admitted causal authority at the runtime boundary', async () => {
    const harness = createHarness();

    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async function (this: unknown) {
        if (this !== runtime) {
          throw new Error('steerPrompt called with wrong receiver');
        }
      }),
      supportsInFlightSteer: vi.fn(() => true),
    };

    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));


    let inFlightSteer: any = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      inFlightSteer = params.inFlightSteer;
      return {
        messageQueue: harness.queue,
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(inFlightSteer).not.toBeNull();
      await inFlightSteer.steerText('hello', {
        localId: 'local-steer-1',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'acme.plugin',
            sourceRef: 'message-1',
            sourceRevisionOrEpoch: 'revision-1',
            admittedPermissionCeiling: 'read-only',
            remoteApprovalMaxScope: 'request',
          },
        },
      });
      params.sendReady();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(runtime.steerPrompt).toHaveBeenCalledWith('hello', {
      localId: 'local-steer-1',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
        sourceAuthority: {
          kind: 'mediatedExternal',
          mediatorPluginId: 'acme.plugin',
          sourceRef: 'message-1',
          sourceRevisionOrEpoch: 'revision-1',
          admittedPermissionCeiling: 'read-only',
          remoteApprovalMaxScope: 'request',
        },
      },
    });
  });

  it('queues unavailable nonconditional steer and settles conditional steer exactly once without queue fallback', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    let providerRejectedHandler: ((info: Readonly<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>) => void) | null = null;
    const observeProviderInputSettlement = vi.fn();
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => (
      localId === 'local-exact-steer-unavailable' ? 92
        : localId === 'local-conditional-steer-unavailable' ? 94 : null
    ));
    harness.session.hasPendingProviderInput = vi.fn((localId: string) => (
      localId === 'local-exact-steer-unavailable' || localId === 'local-conditional-steer-unavailable'
    ));
    harness.session.observeProviderInputSettlement = observeProviderInputSettlement;

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => true),
      setOnPromptTerminallyRejectedBeforeProvider: vi.fn((handler: typeof providerRejectedHandler) => {
        providerRejectedHandler = handler;
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      expect(userMessageHandler).toBeTypeOf('function');
      expect(providerRejectedHandler).toBeTypeOf('function');

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact steer only' },
        localId: 'local-exact-steer-unavailable',
        meta: {},
        pendingProviderAction: 'steer',
        pendingRequestedAction: { v: 1, kind: 'steer_now' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(params.messageQueue.size()).toBe(1);
      expect(observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(await params.messageQueue.waitForMessagesAndGetAsString()).toMatchObject({
        message: { text: 'exact steer only', localId: 'local-exact-steer-unavailable' },
      });

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'conditional steer only' },
        localId: 'local-conditional-steer-unavailable',
        meta: {},
        pendingProviderAction: 'steer',
        pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(params.messageQueue.size()).toBe(0);
      expect(observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
        kind: 'rejected_before_effect',
        localId: 'local-conditional-steer-unavailable',
        userMessageSeq: 94,
        userMessageSeqs: [94],
        reason: 'conditional_steer_unavailable',
        diagnostic: {
          code: 'conditional_steer_unavailable',
          severity: 'error',
        },
        retryable: false,
      });

      // A duplicate provider-side terminal rejection traverses the same host normalizer and must
      // not settle Pending twice.
      providerRejectedHandler?.({
        localIds: ['local-conditional-steer-unavailable'],
        userMessageSeq: 94,
        userMessageSeqs: [94],
      });
      expect(observeProviderInputSettlement).toHaveBeenCalledTimes(1);

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'ambient input still queues' },
        localId: 'local-ambient-input',
        meta: {},
      });
      expect(params.messageQueue.size()).toBe(1);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('keeps the foreground turn alive when a conditional pre-effect steer rejection cannot be settled', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn(() => 93);
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn(() => {
      throw new Error('settlement owner unavailable');
    });

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => false),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact steer only' },
        localId: 'local-exact-steer-settlement-unavailable',
        meta: {},
        pendingProviderAction: 'steer',
        pendingRequestedAction: { v: 1, kind: 'steer_if_active' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(params.messageQueue.size()).toBe(0);
      expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'rejected_before_effect',
        localId: 'local-exact-steer-settlement-unavailable',
        reason: 'conditional_steer_unavailable',
      }));
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'task_complete' }),
      ]);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'turn_failed' }),
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('classifies an invoked exact steer throw as uncertainty without queue fallback or foreground completion', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.getCommittedUserMessageSeq = vi.fn(() => 94);
    harness.session.hasPendingProviderInput = vi.fn(() => true);
    harness.session.observeProviderInputSettlement = vi.fn();

    const runtime = {
      ...harness.runtime,
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
      canSteerPrompt: vi.fn(() => true),
      steerPrompt: vi.fn(async () => {
        throw new Error('provider response lost after steer invocation');
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'exact ambiguous steer' },
        localId: 'local-exact-steer-ambiguous',
        meta: {},
        pendingProviderAction: 'steer',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      expect(params.messageQueue.size()).toBe(0);
      expect(harness.session.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith({
        kind: 'effect_may_have_occurred',
        localId: 'local-exact-steer-ambiguous',
        userMessageSeq: 94,
        userMessageSeqs: [94],
        issue: { code: 'provider_steer_outcome_unknown', severity: 'error' },
        detail: 'provider_steer_outcome_unknown',
      });
      expect(runtime.isTurnInFlight()).toBe(true);
      expect(harness.session.sendAgentMessage.mock.calls).not.toContainEqual([
        expect.anything(),
        expect.objectContaining({ type: 'task_complete' }),
      ]);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('routes in-flight steer input through the admitted queue until the exact generation epoch clears', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    let steerCallsWhileAdmitted = -1;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    harness.session.waitForMetadataUpdate = vi.fn(async () => false);
    harness.session.shouldAttemptPendingMaterialization = vi.fn(() => true);
    harness.session.reconcilePendingQueueState = vi.fn(async () => undefined);
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => (
      localId === 'local-admitted-steer' ? 91 : null
    ));

    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async () => undefined),
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      const admission = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(admission).toBeTypeOf('function');
      await admission?.({
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        reason: 'generation_pending',
        epochId: 'generation:43',
      });

      expect(userMessageHandler).toBeTypeOf('function');
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'wait for exact generation' },
        localId: 'local-admitted-steer',
        meta: {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      steerCallsWhileAdmitted = runtime.steerPrompt.mock.calls.length;
      if (steerCallsWhileAdmitted > 0) return;

      const abortController = new AbortController();
      let releasedBatch: unknown = null;
      const release = params.inputConsumer.waitForNextInput({
        abortSignal: abortController.signal,
      }).then((batch: unknown) => {
        releasedBatch = batch;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(admission?.({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:42',
      })).resolves.toEqual({ status: 'not_matched' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(releasedBatch).toBeNull();
      expect(runtime.steerPrompt).not.toHaveBeenCalled();

      await expect(admission?.({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:43',
      })).resolves.toEqual({ status: 'cleared' });
      await release;
      expect(releasedBatch).toEqual(expect.objectContaining({
        message: expect.objectContaining({
          text: 'wait for exact generation',
          localId: 'local-admitted-steer',
          localIds: ['local-admitted-steer'],
          userMessageSeq: 91,
          userMessageSeqs: [91],
        }),
      }));
      expect(runtime.steerPrompt).not.toHaveBeenCalled();

      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'direct steer after clear' },
        localId: 'local-direct-steer',
        meta: {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      expect(runtime.steerPrompt).toHaveBeenCalledWith(expect.stringContaining('direct steer after clear'), {
        localId: 'local-direct-steer',
        localIds: ['local-direct-steer'],
      });
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.deps.runPermissionModePromptLoopFn({ runtime: params.runtime });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(steerCallsWhileAdmitted).toBe(0);
  });

  it('keeps enforcement behind ACP or Claude steer preparation that already owns provider dispatch custody', async () => {
    const harness = createHarness();
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    let steerPreparationStartedResolve: () => void = () => {};
    const steerPreparationStarted = new Promise<void>((resolve) => {
      steerPreparationStartedResolve = resolve;
    });
    let releaseSteerPreparation: () => void = () => {};
    const steerPreparationPaused = new Promise<void>((resolve) => {
      releaseSteerPreparation = resolve;
    });
    const runtime = {
      ...harness.runtime,
      steerPrompt: vi.fn(async () => {
        // ACP waits for backend creation here; Claude Unified waits for terminal readiness here.
        steerPreparationStartedResolve();
        await steerPreparationPaused;
      }),
      supportsInFlightSteer: vi.fn(() => true),
      isTurnInFlight: vi.fn(() => true),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: runtime,
      nativeRuntime: runtime,
    }));
    delete harness.deps.createPermissionModeQueueStateFn;

    harness.deps.runPermissionModePromptLoopFn = async () => {
      const admission = harness.handlers.get(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION);
      expect(admission).toBeTypeOf('function');
      if (!admission) throw new Error('provider input admission handler was not registered');
      expect(userMessageHandler).toBeTypeOf('function');
      userMessageHandler?.({
        role: 'user',
        content: { type: 'text', text: 'steer while provider prepares' },
        localId: 'local-steer-preparation',
        meta: {},
      });
      await steerPreparationStarted;

      const enforcement = Promise.resolve(admission({
        action: 'enforce',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        reason: 'generation_pending',
        epochId: 'generation:steer-preparation',
      }));
      const enforcementSettled = vi.fn();
      void enforcement.then(enforcementSettled, enforcementSettled);
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        expect(enforcementSettled).not.toHaveBeenCalled();
      } finally {
        releaseSteerPreparation();
      }
      await expect(enforcement).resolves.toEqual({ status: 'enforced' });
      expect(runtime.steerPrompt).toHaveBeenCalledTimes(1);
      await expect(Promise.resolve(admission({
        action: 'clear',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        epochId: 'generation:steer-preparation',
      }))).resolves.toEqual({ status: 'cleared' });
    };
    harness.deps.runSessionLoopLifecycleFn = async (params: any) => {
      await params.deps.runPermissionModePromptLoopFn({ runtime: params.runtime });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('passes direct native runtime-turn operations through unchanged', async () => {
    const harness = createHarness();
    const nativeRuntime = {
      beginTurnLifecycle: vi.fn(),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      setOnPromptDeliveryOutcome: vi.fn(),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
      shouldResumeAfterPermissionModeChange: vi.fn(() => false),
    };
    setSessionRuntimeFactory(harness.config, () => ({
      operations: nativeRuntime as any,
      nativeRuntime: nativeRuntime as any,
    }));

    const runSessionLoopLifecycleFn = vi.fn(async () => undefined);
    harness.deps.runSessionLoopLifecycleFn = runSessionLoopLifecycleFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    const lifecycleParams = (runSessionLoopLifecycleFn.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as {
      runtime?: unknown;
      hookRuntime?: { sendTurnPrompt?: unknown };
    } | undefined;
    expect(lifecycleParams?.runtime).toBe(nativeRuntime);
    expect(lifecycleParams?.hookRuntime).toBe(nativeRuntime);
    expect(typeof lifecycleParams?.hookRuntime?.sendTurnPrompt).toBe('function');
  });

  it('preserves native runtime restart policy when driving RuntimeTurnOperations', async () => {
    const harness = createHarness();
    const operations = {
      beginTurnLifecycle: vi.fn(),
      sendTurnPrompt: vi.fn(async () => undefined),
      steerInFlightTurn: vi.fn(async () => undefined),
      waitForTurnCompletion: vi.fn(async () => undefined),
      subscribeRuntimeEvents: vi.fn(() => () => undefined),
      cancelTurn: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(async () => undefined),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const nativeRuntime = {
      ...harness.runtime,
      shouldResumeAfterPermissionModeChange: vi.fn(() => false),
    };
    harness.config.createSessionRuntime = vi.fn(() => ({
      operations,
      nativeRuntime,
    }));

    let capturedShouldResume: boolean | undefined;
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      runtime: Readonly<{
        shouldResumeAfterPermissionModeChange?: () => boolean;
      }>;
    }>) => {
      capturedShouldResume = params.runtime.shouldResumeAfterPermissionModeChange?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(capturedShouldResume).toBe(false);
    expect(nativeRuntime.shouldResumeAfterPermissionModeChange).toHaveBeenCalledTimes(1);
  });

  it('uses custom ready sender when provided', async () => {
    const harness = createHarness();
    harness.config.createSendReady = () => () => {
      harness.metrics.bumpCustomReadyCalls();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.customReadyCalls).toBe(1);
    expect(harness.metrics.defaultReadyCalls).toBe(0);
  });

  it('uses provider-controlled keep-alive mode when configured', async () => {
    const harness = createHarness();
    const keepAliveModes: string[] = [];
    harness.session.keepAlive = vi.fn((_thinking: boolean, mode: string) => {
      keepAliveModes.push(mode);
    });
    (harness.config as any).resolveKeepAliveMode = () => 'terminal';

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(keepAliveModes[0]).toBe('local');
  });

  it('skips terminal rendering when the provider disables the remote terminal UI', async () => {
    const harness = createHarness();
    const renderFn = vi.fn(() => ({ unmount: vi.fn() }));
    (harness.config as any).shouldRenderTerminalDisplay = () => false;

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).not.toHaveBeenCalled();
  });

  it('yields the runner TTY to a provider attach and restores the remote display afterward', async () => {
    const harness = createHarness();
    const { runPermissionModePromptLoop } = await import('@/agent/runtime/runPermissionModePromptLoop');
    const { cleanupBackendRunResources } = await import('@/agent/runtime/cleanupBackendRunResources');
    harness.session.hasPendingProviderInput.mockReturnValue(false);
    harness.deps.runPermissionModePromptLoopFn = runPermissionModePromptLoop;
    harness.deps.cleanupBackendRunResourcesFn = cleanupBackendRunResources;
    const unmounts: Array<ReturnType<typeof vi.fn>> = [];
    const renderFn = vi.fn(() => {
      const unmount = vi.fn();
      unmounts.push(unmount);
      return { unmount };
    });
    (harness.opts as typeof harness.opts & { startingMode: 'terminal' }).startingMode = 'terminal';
    harness.config.shouldRenderTerminalDisplay = () => true;
    setTerminalRemoteModeLoop(harness.config, {
      startingMode: 'terminal',
      remoteExitCode: 0,
      topology: 'shared',
      remoteWritable: true,
      ownsCurrentTerminalDisplay: true,
      runTerminal: async () => {
        expect(unmounts[0]).toHaveBeenCalledOnce();
        return { type: 'switch' as const };
      },
      runRemote: async () => {
        expect(renderFn).toHaveBeenCalledTimes(2);
        expect(unmounts[1]).not.toHaveBeenCalled();
        return 'exit';
      },
      onModeChange: vi.fn(),
    });

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).toHaveBeenCalledTimes(2);
    expect(unmounts[0]).toHaveBeenCalledTimes(1);
    expect(unmounts[1]).toHaveBeenCalledTimes(1);
  });

  it('uses static remote control instead of Ink for daemon-started tmux sessions', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    harness.opts.terminalRuntime = { mode: 'tmux' };
    harness.config.shouldRenderTerminalDisplay = () => true;
    setTerminalRemoteModeLoop(harness.config, createTerminalRemoteModeLoopFixture());

    const renderFn = vi.fn(() => ({ unmount: vi.fn() }));
    const stopStaticControl = vi.fn(async () => undefined);
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: stopStaticControl }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).not.toHaveBeenCalled();
    expect(startRemoteModeStaticControlFn).toHaveBeenCalledWith(expect.objectContaining({
      providerName: 'Qwen Code',
      allowSwitchToTerminal: false,
    }));
    expect(stopStaticControl).toHaveBeenCalledTimes(1);
  });

  it('mounts the remote-only terminal display instead of static control for daemon-started tmux sessions without terminal runtime support', async () => {
    const harness = createHarness();
    function InteractiveTerminalDisplay(): null {
      return null;
    }
    function RemoteOnlyTerminalDisplay(_props: Readonly<{
      messageBuffer: MessageBuffer;
      backendDisplayName: string;
      requestedMode: 'terminal' | 'remote';
      logPath?: string;
      onExit: () => void | Promise<void>;
    }>): null {
      return null;
    }
    harness.opts.startedBy = 'daemon';
    harness.opts.terminalRuntime = { mode: 'tmux' };
    (harness.opts as typeof harness.opts & { startingMode: 'terminal' }).startingMode = 'terminal';
    harness.config.loadTerminalDisplay = async () => InteractiveTerminalDisplay;
    harness.config.shouldRenderTerminalDisplay = () => true;

    const renderedElements: Array<Readonly<{
      type: unknown;
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const renderFn = vi.fn((element: unknown) => {
      renderedElements.push(element as Readonly<{
        type: unknown;
        props: Readonly<Record<string, unknown>>;
      }>);
      return { unmount: vi.fn() };
    });
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: vi.fn(async () => undefined) }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
        sessionLoopLifecycleDeps: {
          remoteOnlyTerminalDisplayComponent: RemoteOnlyTerminalDisplay,
        },
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(startRemoteModeStaticControlFn).not.toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalledTimes(1);
    const renderedElement = renderedElements[0];
    expect(renderedElement?.type).toBe(RemoteOnlyTerminalDisplay);
    expect(renderedElement?.props).toEqual(expect.objectContaining({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'terminal',
      messageBuffer: expect.any(MessageBuffer),
      onExit: expect.any(Function),
    }));
  });

  it('mounts the remote-only terminal display when terminal mode is requested without terminal runtime support', async () => {
    const harness = createHarness();
    function InteractiveTerminalDisplay(): null {
      return null;
    }
    function RemoteOnlyTerminalDisplay(_props: Readonly<{
      messageBuffer: MessageBuffer;
      backendDisplayName: string;
      requestedMode: 'terminal' | 'remote';
      logPath?: string;
      onExit: () => void | Promise<void>;
    }>): null {
      return null;
    }
    harness.opts.startedBy = 'terminal';
    (harness.opts as typeof harness.opts & { startingMode: 'terminal' }).startingMode = 'terminal';
    harness.config.loadTerminalDisplay = async () => InteractiveTerminalDisplay;
    harness.config.shouldRenderTerminalDisplay = () => true;

    const renderedElements: Array<Readonly<{
      type: unknown;
      props: Readonly<Record<string, unknown>>;
    }>> = [];
    const renderFn = vi.fn((element: unknown) => {
      renderedElements.push(element as Readonly<{
        type: unknown;
        props: Readonly<Record<string, unknown>>;
      }>);
      return { unmount: vi.fn() };
    });
    const startRemoteModeStaticControlFn = vi.fn(() => ({ stop: vi.fn(async () => undefined) }));

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
        startRemoteModeStaticControlFn,
        sessionLoopLifecycleDeps: {
          remoteOnlyTerminalDisplayComponent: RemoteOnlyTerminalDisplay,
        },
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(startRemoteModeStaticControlFn).not.toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalledTimes(1);
    const renderedElement = renderedElements[0];
    expect(renderedElement?.type).toBe(RemoteOnlyTerminalDisplay);
    expect(renderedElement?.props).toEqual(expect.objectContaining({
      backendDisplayName: 'Qwen Code',
      requestedMode: 'terminal',
      messageBuffer: expect.any(MessageBuffer),
      onExit: expect.any(Function),
    }));
  });

  it('exposes a terminal display controller for provider-managed mount and unmount transitions', async () => {
    const harness = createHarness();
    const renderUnmounts: Array<ReturnType<typeof vi.fn>> = [];
    const renderFn = vi.fn(() => {
      const unmount = vi.fn();
      renderUnmounts.push(unmount);
      return { unmount };
    });
    let controller:
      | {
        mount: () => Promise<void>;
        unmount: () => Promise<void>;
        isMounted: () => boolean;
      }
      | null = null;

    harness.config.shouldRenderTerminalDisplay = () => false;
    (harness.config as any).onTerminalDisplayControllerReady = (value: typeof controller) => {
      controller = value;
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      if (!controller) throw new Error('Expected terminal display controller');
      expect(controller.isMounted()).toBe(false);
      await controller.mount();
      expect(controller.isMounted()).toBe(true);
      await controller.unmount();
      expect(controller.isMounted()).toBe(false);
      await controller.mount();
      params.sendReady();
    };

    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await runHostSessionRuntime(harness.opts, harness.config, {
        ...harness.deps,
        renderFn,
      });
    } finally {
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }

    expect(renderFn).toHaveBeenCalledTimes(2);
    const firstUnmount = renderUnmounts.at(0);
    const secondUnmount = renderUnmounts.at(1);
    expect(firstUnmount).toBeDefined();
    expect(secondUnmount).toBeDefined();
    expect(firstUnmount).toHaveBeenCalledTimes(1);
    expect(secondUnmount).toHaveBeenCalledTimes(1);
  });

  it('awaits async provider-specific session swap hooks before continuing', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    let swappedHookParams: unknown = null;
    let finishHook: (() => void) | null = null;
    const onSessionSwap = vi.fn(async (params: unknown) => {
      swappedHookParams = params;
      callOrder.push('hook:start');
      await new Promise<void>((resolve) => {
        finishHook = () => {
          callOrder.push('hook:end');
          resolve();
        };
      });
    });
    harness.config.onSessionSwap = onSessionSwap as any;

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      const swappedSession = {
        ...harness.session,
        sessionId: 'session-2',
      };
      callOrder.push('before-notify');
      let notifyFinished = false;
      const notifyPromise = Promise.resolve(notifySessionSwap(swappedSession)).then(() => {
        notifyFinished = true;
        callOrder.push('after-notify');
      });
      try {
        await vi.waitFor(() => expect(finishHook).toBeTypeOf('function'));
        expect(notifyFinished).toBe(false);
      } finally {
        finishHook?.();
        await notifyPromise;
      }
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(onSessionSwap).toHaveBeenCalledTimes(1);
    expect(swappedHookParams).toMatchObject({
      session: expect.objectContaining({ sessionId: 'session-2' }),
    });
    expect(callOrder).toEqual(['before-notify', 'hook:start', 'hook:end', 'after-notify']);
  });

  it('rebinds permission-mode queue delivery to the swapped session before continuing', async () => {
    const harness = createHarness();
    const rebindSession = vi.fn();
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue: harness.queue,
      rebindSession,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });

    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap, metadata }: any) => {
      expect((metadata as any).auggieAllowIndexing).toBe(true);
      const swappedSession = {
        ...harness.session,
        sessionId: 'session-2',
      };
      await notifySessionSwap(swappedSession);
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(rebindSession).toHaveBeenCalledTimes(1);
    expect(rebindSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-2' }));
  });

  it('rebases host lifecycle ready, keepalive, and prompt-loop session reads after a deferred session swap', async () => {
    const harness = createHarness();
    const initialSession = harness.session;
    initialSession.keepAlive = vi.fn();
    initialSession.enqueueSessionEventCommitted = vi.fn(async () => ({
      persisted: true,
      delivered: true,
    }));
    initialSession.getMetadataSnapshot = vi.fn(() => ({ profileId: 'profile-1' }));
    initialSession.waitForMetadataUpdate = vi.fn(async () => false);
    initialSession.popPendingMessage = vi.fn(async () => false);

    const swappedSession = {
      ...initialSession,
      sessionId: 'session-2',
      keepAlive: vi.fn(),
      enqueueSessionEventCommitted: vi.fn(async () => ({
        persisted: true,
        delivered: true,
      })),
      getMetadataSnapshot: vi.fn(() => ({ profileId: 'profile-2' })),
      waitForMetadataUpdate: vi.fn(async () => true),
      popPendingMessage: vi.fn(async () => true),
    };

    let pendingApply: (() => Promise<void>) | null = null;
    let metadataAfterBoundary: unknown = null;
    let metadataWaitAfterBoundary: boolean | undefined;
    let popPendingAfterBoundary: boolean | undefined;

    harness.config.createSendReady = ({ session }) => () => {
      void session.enqueueSessionEventCommitted?.({ type: 'ready' });
    };
    harness.config.lifecycleHooks = {
      createSessionSwapStrategy: () => ({
        requestSessionSwap: ({ applyImmediately }) => {
          pendingApply = applyImmediately;
        },
        flushPendingSessionSwap: async () => {
          await pendingApply?.();
          pendingApply = null;
        },
      }),
    };
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap: notifySessionSwap }: any) => {
      await notifySessionSwap(swappedSession);
      return {
        session: initialSession,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Readonly<{
      session: Readonly<{
        getMetadataSnapshot: () => unknown;
        waitForMetadataUpdate: () => Promise<boolean>;
        popPendingMessage: () => Promise<boolean>;
      }>;
      keepAlive: () => void;
      sendReady: () => void;
      onAfterLoopBoundary?: (args: { reason: 'turn_completed' }) => Promise<void> | void;
    }>) => {
      await params.onAfterLoopBoundary?.({ reason: 'turn_completed' });
      params.keepAlive();
      params.sendReady();
      metadataAfterBoundary = params.session.getMetadataSnapshot();
      metadataWaitAfterBoundary = await params.session.waitForMetadataUpdate();
      popPendingAfterBoundary = await params.session.popPendingMessage();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(swappedSession.keepAlive).toHaveBeenCalledWith(false, 'remote');
    expect(swappedSession.enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready' });
    expect(metadataAfterBoundary).toEqual({ profileId: 'profile-2' });
    expect(metadataWaitAfterBoundary).toBe(true);
    expect(popPendingAfterBoundary).toBe(true);
    expect(initialSession.enqueueSessionEventCommitted).not.toHaveBeenCalledWith({ type: 'ready' });
  });

  it('runs provider-specific dispose hooks during cleanup', async () => {
    const harness = createHarness();
    const callOrder: string[] = [];
    const onDispose = vi.fn(async () => {
      callOrder.push('dispose');
    });
    harness.config.onDispose = onDispose as any;
    harness.config.lifecycleHooks = {
      onBeforeDispose: async () => {
        callOrder.push('beforeDispose');
      },
    };
    harness.deps.cleanupBackendRunResourcesFn = async ({ stopKeepAlive, unmountUi }: Parameters<typeof cleanupBackendRunResources>[0]) => {
      callOrder.push('cleanup');
      stopKeepAlive();
      await unmountUi?.();
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(onDispose).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['beforeDispose', 'cleanup', 'dispose']);
  });

  it('invokes abort handler lifecycle when abort RPC fires', async () => {
    const harness = createHarness();
    harness.deps.runPermissionModePromptLoopFn = async () => {
      const abort = harness.handlers.get('abort');
      expect(abort).toBeTypeOf('function');
      // Read the actual production root's MCP port after its lifecycle binds it.
      const mcpSession: HappyMcpSessionClient = harness.session;
      const containingSignal = mcpSession.getHostTurnAbortSignal?.() ?? null;
      expect(containingSignal).toBeInstanceOf(AbortSignal);
      expect(containingSignal?.aborted).toBe(false);
      await abort?.();
      expect(containingSignal?.aborted).toBe(true);
      const nextSignal = mcpSession.getHostTurnAbortSignal?.() ?? null;
      expect(nextSignal).not.toBe(containingSignal);
      expect(nextSignal?.aborted).toBe(false);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.metrics.queueResetCalls).toBe(0);
    expect(harness.metrics.permissionResetCalls).toBe(1);
  });

  it('invokes kill handler lifecycle without archiving the session', async () => {
    const harness = createHarness();
    harness.opts.startedBy = 'daemon';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    harness.deps.runPermissionModePromptLoopFn = async () => {
      expect(harness.metrics.killHandler).toBeTypeOf('function');
      await harness.metrics.killHandler?.();
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      exitSpy.mockRestore();
    }

    expect(harness.metrics.cleanupCalls).toBe(1);
  });

  it('passes a permission-mode queue key resolver when provided', async () => {
    const harness = createHarness();
    const resolvePermissionModeQueueKey = (mode: string) => `key:${mode}`;
    (harness.config as any).resolvePermissionModeQueueKey = resolvePermissionModeQueueKey;

    let observed: unknown = null;
    harness.deps.createPermissionModeQueueStateFn = (params: any) => {
      observed = params.resolvePermissionModeQueueKey ?? null;
      return {
        messageQueue: harness.queue,
        rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0,
        setCurrentPermissionModeUpdatedAt: () => undefined,
      };
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(observed).toBe(resolvePermissionModeQueueKey);
  });

  it('maps configured ACP flavors onto generic ACP permission semantics', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'acp:custom-kiro';
    harness.config.policyAgentId = 'customAcp';
    harness.opts.backendTarget = 'backend:acp:configured:custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'acp:custom-kiro',
      permissionMode: 'yolo',
    }));
  });

  it('uses an explicit policy agent id instead of inferring customAcp from the flavor', async () => {
    const harness = createHarness('session-1', { managedMcpSelection: 'account-default' });
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'acp:custom-kiro';
    harness.config.policyAgentId = 'claude';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'read-only',
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;
    harness.deps.resolveRunnerMcpServersFn = vi.fn(async () => ({
      happierMcpServer: { stop: () => undefined },
      mcpServers: { happier: { command: 'built-in' } },
    }));

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'acp:custom-kiro',
      permissionMode: 'read-only',
    }));
    expect(harness.deps.resolveRunnerMcpServersFn).toHaveBeenCalledTimes(1);
  });

  it('treats unknown ACP flavors as custom ACP policy family instead of falling back to the default built-in agent', async () => {
    const harness = createHarness();
    const createSessionMetadataFn = vi.fn(() => ({
      state: { controlledByUser: false },
      metadata: { path: '/tmp/workspace', permissionMode: 'default', permissionModeUpdatedAt: Date.now() },
    }));

    harness.config.flavor = 'custom-kiro';
    harness.config.policyAgentId = 'customAcp';
    harness.opts.backendTarget = 'backend:acp:configured:custom-kiro';
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionDefaultPermissionModeByTargetKey: {
          [buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })]: 'read-only',
          [buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'custom-kiro' })]: 'yolo',
        },
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.createSessionMetadataFn = createSessionMetadataFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createSessionMetadataFn).toHaveBeenCalledWith(expect.objectContaining({
      flavor: 'custom-kiro',
      permissionMode: 'yolo',
    }));
  });

  it('passes account settings secret read keys into the provider-enforced permission handler', async () => {
    const harness = createHarness();
    let observedGetAccountSettingsSecretsReadKeys:
      | (() => ReadonlyArray<Uint8Array>)
      | undefined;
    const createProviderEnforcedPermissionHandlerFn = vi.fn((params: {
      getAccountSettingsSecretsReadKeys?: () => ReadonlyArray<Uint8Array>;
    }) => {
      observedGetAccountSettingsSecretsReadKeys = params.getAccountSettingsSecretsReadKeys;
      return {
        setPermissionMode: () => undefined,
        reset: () => undefined,
        updateSession: () => undefined,
      };
    });
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;
    const settingsSecretsReadKeys = [new Uint8Array(32).fill(4)];
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {} as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys,
      whenRefreshed: null,
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        getAccountSettingsSecretsReadKeys: expect.any(Function),
      }),
    );
    expect(observedGetAccountSettingsSecretsReadKeys?.()).toEqual(settingsSecretsReadKeys);
  });

  it('lets a restricted runtime truthfully declare that Activity owner delivery requires the Home', async () => {
    const harness = createHarness();
    const createProviderEnforcedPermissionHandlerFn = vi.fn(() => ({
      setPermissionMode: () => undefined,
      reset: () => undefined,
      updateSession: () => undefined,
    }));
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;
    harness.deps.initializeBackendApiContextFn = async () => ({
      api: { push: () => null } as never,
      machineId: 'machine-1',
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(harness.session.setOwnerActivityDelivery).toHaveBeenCalledWith('home_required');
    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({ pushSender: null }),
    );
  });

  it('passes pending queue delivery timing from account settings into the permission prompt loop', async () => {
    const harness = createHarness();
    let observedPendingQueueDeliveryTiming: unknown;
    harness.opts.accountSettingsContext = {
      source: 'network',
      settings: {
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      } as any,
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: { pendingQueueDeliveryTiming?: unknown }) => {
      observedPendingQueueDeliveryTiming = params.pendingQueueDeliveryTiming;
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(observedPendingQueueDeliveryTiming).toBe('after_runtime_idle');
  });

  it('refits a taken worker wake against the final shared optional allowance after authoritative usage changes', async () => {
    const harness = createHarness();
    harness.opts.modelSelection = {
      v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: null, modelId: 'budget-model' },
    };
    harness.session.observePendingSessionFollow = vi.fn(async () => ({
      ok: true as const, publisherGeneration: 1, currentSourceSessionIds: [], observations: [],
    }));
    const update = {
      v: 1 as const, workerKind: 'session' as const, workerId: 'budget-worker',
      ownerState: 'settled' as const, wake: 'finished' as const,
      headline: 'Result', result: 'é'.repeat(4_000), canInspect: true,
      transcriptPointer: { kind: 'session' as const, sessionId: 'budget-worker' },
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      const prepare = params.prepareHostContext!;
      const before = await prepare({ signal: new AbortController().signal, requiredPrompt: 'required', contextOnlyWorkerUpdate: update });
      expect(before?.contextOnlyWorkerUpdate?.truncated).toBe(true);
      expect(before?.contextOnlyWorkerUpdate?.transcriptPointer).toEqual(update.transcriptPointer);
      const modelId = params.readActiveModelSelection?.().modelId ?? null;
      expect(modelId).toBeTypeOf('string');
      harness.runtime.emitRuntimeMessage({
        kind: 'usage-observed', sequence: 1, sessionId: 'session-1', emittedAtMs: 1,
        observationId: 'worker-budget-usage', source: 'provider', scope: 'session_cumulative', modelId,
        context: {
          v: 1, modelId, usedTokens: 96, windowTokens: 100,
          totalProcessedTokens: null, baselineTokens: null, isAutoCompactEnabled: null,
          categories: null, observedAtMs: 1, source: 'provider_live',
        },
      });
      const after = await prepare({ signal: new AbortController().signal, requiredPrompt: 'required', contextOnlyWorkerUpdate: update });
      expect(after?.contextOnlyWorkerUpdate).toBeNull();
      expect(after?.contextOnlyWorkerDisposition).toBe('deferred');
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
  });

  it('composes the canonical Follow reconciler into a real host prompt and ACKs the exact observed frontier only after provider acceptance', async () => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const accountGet = vi.mocked(axios.get).getMockImplementation();
    if (!accountGet) throw new Error('Expected the canonical Project Account HTTP boundary');
    const harness = createHarness('session-1', { accountId: 'follow-account' });
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
    let userMessageHandler: ((message: unknown) => boolean | void) | null = null;
    harness.session.onUserMessage = (handler: (message: unknown) => boolean | void) => {
      userMessageHandler = handler;
    };
    delete harness.deps.createPermissionModeQueueStateFn;

    const observed = {
      transcriptSeq: 8,
      readyEventSeq: 3,
      agentStateVersion: 5,
      turn: { id: 'source-turn', status: 'completed' as const },
    };
    const delivered = {
      transcriptSeq: 7,
      readyEventSeq: 2,
      agentStateVersion: 4,
      turn: null,
    };
    const admitted = createAdmittedFollowInputFixture({ destinationSessionId: harness.session.sessionId,
      sourceSessionId: 'source-session', sourceLocalId: 'source-message-8', delivered, observed });
    onTestFinished(installFollowHomeReadinessBoundary(harnessHomeFeatures.features));
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => localId === admitted.localId ? 41 : null);
    harness.session.observePendingSessionFollow = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      sessionId: 'session-1',
      publisherGeneration: '17',
      currentSourceSessionIds: ['source-session'],
      observations: [admitted.observation],
    }));
    harness.session.acknowledgeSessionFollow = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      destinationSessionId: 'session-1',
      sourceSessionId: 'source-session',
      delivered: observed,
    }));
    const source = createSessionRecordFixture({
      id: 'source-session', encryptionMode: 'plain', seq: observed.transcriptSeq,
      metadata: JSON.stringify({ path: '/workspace/source', host: 'source-host' }),
      active: true, activeAt: 9_000, updatedAt: 9_000,
      agentStateVersion: observed.agentStateVersion,
    });
    // HTTP is the source-content boundary; transport, decoding, hydration and frontier selection stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const request = new URL(String(url));
      if (request.pathname === admitted.lookupPath) return admitted.lookupResponse;
      if (request.pathname === admitted.mutePath) return { status: 200, data: { scopes: [] } };
      if (request.pathname === '/v1/features') return { status: 200, data: harnessHomeFeatures.features };
      if (request.pathname === '/v1/auth/ping') return { status: 200, data: {} };
      if (request.pathname === '/v1/account/encryption') return await accountGet(url);
      if (normalizeServerHttpBaseUrl(request.origin) !== new URL(normalizeServerHttpBaseUrl(harness.session.getServerBinding().serverUrl)).origin) {
        throw new Error('Follow source read escaped the destination Home');
      }
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (request.pathname === '/v2/sessions/source-session') return { status: 200, data: { session: source } };
      if (request.pathname === '/v1/sessions/source-session/messages') return { status: 200, data: {
        messages: [{
          id: 'source-message-8', seq: 8, localId: 'source-message-8', createdAt: 8_000, updatedAt: 8_000,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'source context accepted by the provider' },
            meta: { [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'cli' } } } },
        }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected Follow source request: ${request.pathname}`);
    });
    const sourceHome = createTestApiSessionClient(ApiSessionClient, harness.opts.credentials.token, createPlainSessionFixture({ id: 'session-1' }), {
      localMachineId: 'machine-1',
      getServerFeaturesSnapshot: harness.session.getServerFeaturesSnapshot.bind(harness.session),
      metadataAuthority: { kind: 'owner', credentials: harness.opts.credentials },
      transport: admitted.transport(harness.session.getServerBinding(), harness.opts.credentials.token),
    });
    harness.session.runSessionFollowSourceRequest = sourceHome.runSessionFollowSourceRequest.bind(sourceHome);
    harness.session.reconcileSessionInputForProviderDispatch = sourceHome.reconcileSessionInputForProviderDispatch.bind(sourceHome);

    let providerOutcome: ((outcome: HostProviderInputOutcomeEvidence) => void) | null = null;
    const runtime = harness.runtime;
    runtime.setOnPromptDeliveryOutcome = vi.fn((handler: ((outcome: HostProviderInputOutcomeEvidence) => void) | null) => {
      providerOutcome = handler;
    });
    runtime.sendTurnPrompt = vi.fn(async (_prompt: string, meta?: { localId?: string }) => {
      expect(harness.session.acknowledgeSessionFollow).not.toHaveBeenCalled();
      if (!meta?.localId) throw new Error('Expected the admitted destination input identity');
      providerOutcome?.({
        type: 'input-accepted',
        localInputId: meta.localId,
        userMessageSeq: 41,
        delivery: { kind: 'newTurn', turnId: 'destination-turn' },
      });
    });
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      let shouldExit = false;
      expect(userMessageHandler).toBeTypeOf('function');
      userMessageHandler?.(admitted.message);
      await runPermissionModePromptLoop({
        ...params,
        shouldExit: () => shouldExit,
        sendReady: () => { shouldExit = true; },
      });
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      try {
        await sourceHome.close();
      } finally {
        get.mockRestore();
      }
    }

    expect(runtime.sendTurnPrompt).toHaveBeenCalled();
    expect(harness.session.observePendingSessionFollow).toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      expect.stringContaining('<session_follow>'),
      expect.objectContaining({ localId: admitted.localId, userMessageSeq: 41 }),
    );
    expect(runtime.sendTurnPrompt.mock.calls[0]?.[0]).not.toContain('source context accepted by the provider');
    expect(harness.session.acknowledgeSessionFollow).toHaveBeenCalledWith({
      sourceSessionId: 'source-session',
      localInputId: admitted.localId,
      expectedPublisherGeneration: '17',
      expected: delivered,
      observed,
      consumed: observed,
      acceptance: { kind: 'admitted_input', localInputId: admitted.localId, userMessageSeq: 41 },
    });
  });

  it('withdraws a Follow wake at the final recheck without committing a host event or sending a provider prompt', async () => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const accountGet = vi.mocked(axios.get).getMockImplementation();
    if (!accountGet) throw new Error('Expected the canonical Account HTTP boundary');
    const harness = createHarness('session-1', { accountId: 'follow-account' });
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    delete harness.deps.createPermissionModeQueueStateFn;
    let userMessageHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
    harness.session.onUserMessage = handler => { userMessageHandler = handler; };
    const delivered = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const admitted = createAdmittedFollowInputFixture({ destinationSessionId: harness.session.sessionId,
      sourceSessionId: 'source-session', sourceLocalId: 'source-human-2', delivered, observed });
    onTestFinished(installFollowHomeReadinessBoundary(harnessHomeFeatures.features));
    harness.session.getCommittedUserMessageSeq = vi.fn(() => 41);
    let shouldExit = false;
    harness.session.observePendingSessionFollow = vi.fn(async () => {
      // Initial admission and post-hydration admission succeed; withdraw at dispatch.
      const withdrawn = harness.session.observePendingSessionFollow.mock.calls.length > 2;
      if (withdrawn) { admitted.withdraw(); shouldExit = true; }
      return {
        ok: true as const,
        v: 1 as const,
        sessionId: 'session-1',
        publisherGeneration: '17',
        currentSourceSessionIds: withdrawn ? [] : ['source-session'],
        observations: [{ ...admitted.observation, effectiveDelivery: withdrawn ? null : 'wake' as const }],
      };
    });
    harness.session.acknowledgeSessionFollow = vi.fn();
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
    const source = createSessionRecordFixture({
      id: 'source-session', encryptionMode: 'plain', seq: observed.transcriptSeq,
      metadata: JSON.stringify({ path: '/workspace/source', host: 'source-host' }),
      active: true, activeAt: 9_000, updatedAt: 9_000,
      agentStateVersion: observed.agentStateVersion,
    });
    // Mock HTTP, not hydration/admission: the final recheck must withdraw a real hydrated wake.
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const request = new URL(String(url));
      if (request.pathname === '/v1/account/encryption') return await accountGet(url);
      if (request.pathname === admitted.lookupPath) return admitted.lookupResponse;
      if (request.pathname === admitted.mutePath) return { status: 200, data: { scopes: [] } };
      if (request.pathname === '/v1/features') return { status: 200, data: harnessHomeFeatures.features };
      if (request.pathname === '/v1/auth/ping') return { status: 200, data: {} };
      if (normalizeServerHttpBaseUrl(request.origin) !== new URL(normalizeServerHttpBaseUrl(harness.session.getServerBinding().serverUrl)).origin) {
        throw new Error('Follow source read escaped the destination Home');
      }
      if (request.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (request.pathname === '/v2/sessions/source-session') return { status: 200, data: { session: source } };
      if (request.pathname === '/v1/sessions/source-session/messages') return { status: 200, data: {
        messages: [{
          id: 'source-human-2', seq: 2, localId: 'source-human-2', createdAt: 2_000, updatedAt: 2_000,
          content: { t: 'plain', v: {
            role: 'user', content: { type: 'text', text: 'Context withdrawn before delivery' },
            meta: { [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'cli' } },
          } },
        }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected Follow source request: ${request.pathname}`);
    });
    const sourceHome = createTestApiSessionClient(ApiSessionClient, harness.opts.credentials.token, createPlainSessionFixture({ id: 'session-1' }), {
      localMachineId: 'machine-1',
      getServerFeaturesSnapshot: harness.session.getServerFeaturesSnapshot.bind(harness.session),
      metadataAuthority: { kind: 'owner', credentials: harness.opts.credentials },
      transport: admitted.transport(harness.session.getServerBinding(), harness.opts.credentials.token),
    });
    harness.session.runSessionFollowSourceRequest = sourceHome.runSessionFollowSourceRequest.bind(sourceHome);
    harness.session.reconcileSessionInputForProviderDispatch = sourceHome.reconcileSessionInputForProviderDispatch.bind(sourceHome);
    const runtime = {
      ...harness.runtime,
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(unsupportedRuntimeConfigUpdate),
      beginTurnLifecycle: vi.fn(),
      waitForTurnCompletion: vi.fn(async () => undefined),
      sendTurnPrompt: vi.fn(async () => undefined),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      if (!userMessageHandler) throw new Error('Expected the production admitted-input binding');
      userMessageHandler(admitted.message);
      await runPermissionModePromptLoop({ ...params, shouldExit: () => shouldExit });
    };

    try {
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      try {
        await sourceHome.close();
      } finally {
        get.mockRestore();
      }
    }

    expect(harness.session.observePendingSessionFollow).toHaveBeenCalledTimes(3);
    expect(harness.session.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(runtime.beginTurnLifecycle).not.toHaveBeenCalled();
    expect(harness.session.acknowledgeSessionFollow).not.toHaveBeenCalled();
  });

  it.each(['attached', 'wake', 'step'] as const)('pulls an originating workflow through the default host context owner (%s)', async (delivery) => {
    const accountId = 'origin-account';
    const harness = createHarness('session-1', { credentials: {
      token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null,
    } });
    const run: WorkflowRunSummaryV1 = { sourceArtifactId: null, ownerAccountId: accountId, visibleTeamId: null,
      id: 'origin-run', origin: { kind: 'direct', originSessionId: 'session-1' }, machineId: 'machine-1',
      state: delivery === 'step' ? 'running' : 'succeeded', revision: 3,
      workflowCustodyState: delivery === 'step' ? 'pending' : 'settled', originDeliveryAckRevision: delivery === 'step' ? null : 0,
      attentionRequired: false, createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
      availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
    };
    const definition: WorkflowAcceptedSnapshotV1['definition'] = { version: 1, inputs: [], defaults: {}, blocks: [
      { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: run.id },
      acceptedSnapshot: {
        definition, authoredDefinition: definition, startedBy: 'user', materializedLeaves: [], frozenChildren: {}, metadata: null,
        source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId: 'session-1' },
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
        resultDelivery: { kind: 'originating_session', originSessionId: 'session-1',
          ...(delivery === 'wake' ? { reportPolicy: { preset: 'everything' as const } } : {}) }, workDepth: 1,
      },
    }));
    const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'final_result', accountId, runId: run.id },
      finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'DEFAULT_ORIGIN_RESULT' }, producerInvocation: { recordId: 'producer' } },
    }));
    const census: WorkflowRunRecipientCensusResponseV1 = {
      runId: run.id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', visibleTeamId: null,
      ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
      dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
    };
    const requests: string[] = [];
    const invocationId = 'upkeep';
    const localInputId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId: run.id, invocationRecordId: invocationId });
    const index = { id: invocationId, runId: run.id, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0',
      lifecycle: 'admitting', contentRevision: '0', createdAt: run.createdAt, updatedAt: run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId: run.id, recordId: invocationId,
        sequence: index.sequence, parentRecordId: index.parentRecordId, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
        attempt: '0', logicalInvocationRecordId: invocationId,
        input: { document: { text: 'DEFAULT_ORIGIN_RESULT', references: [], attachments: [] }, input: [], renderedText: 'DEFAULT_ORIGIN_RESULT' },
        resultContract: { kind: 'text' }, execution: { kind: 'session', sessionId: harness.session.sessionId, localInputId } },
    }));
    // HTTP is the real storage/currentness boundary; the context consumer, schemas and codecs remain real.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const operation = (body as Readonly<{ operation: string }>).operation;
      requests.push(operation);
      const data = operation === 'delivery.pull' ? { runs: [{ run, acceptedEnvelope,
        resultEnvelope: delivery === 'step' ? null : resultEnvelope, hasOriginInputCandidates: delivery === 'step' }] }
        : operation === 'run-key.census' ? census
        : operation === 'invocations.list' ? { invocations: [index], progressEnvelopesByInvocationId: { [invocationId]: contentEnvelope } }
        : operation === 'invocations.get' || operation === 'invocations.current' ? { invocation: delivery === 'step' ? { index, contentEnvelope } : null }
        : operation === 'delivery.ack' ? { acknowledgedRevision: 3 }
        : operation === 'get' ? { run, acceptedEnvelope, resultEnvelope }
        : (() => { throw new Error(`unexpected mutation: ${operation}`); })();
      return { status: 200, data };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.includes('/messages/by-local-id/')) throw Object.assign(new Error('Message not found'), {
        isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
      });
      return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
    });
    try {
      if (delivery !== 'attached') {
        const [{ createClaudeNativeSessionRuntimeFromOperations }, { createClaudeAgentSdkTurnOperations }, fixtures,
          { createNativeAgentSessionOperations }, { createTurnAssistantTextSnapshotStore }, { SessionTurnMutationV1Schema }] = await Promise.all([
          import('../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime'),
          import('../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session'),
          import('../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit'),
          import('@/agent/runtime/registry/engineRegistry/nativeAgentSession'),
          import('@/api/session/turns/assistantTextSnapshotStore'),
          import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1'),
        ]);
        const exec = fixtures.createSdkExecFixture();
        const ctx = fixtures.createPluginContextFixture(fixtures.createTerminalHostFixture().service,
          fixtures.createEventsFixture().service, { exec: exec.service });
        // SDK host services are the OS/resource boundary; Claude codecs and both lifecycle owners are real.
        const context = { signal: new AbortController().signal, services: { exec: exec.service }, session: { services: {
          activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
        } } } as unknown as import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeContext;
        const native = createClaudeNativeSessionRuntimeFromOperations(createClaudeAgentSdkTurnOperations({
          ctx, directory: '/tmp/host-wake', launchEnv: {}, permissionMode: 'default', happierSessionId: harness.session.sessionId,
          initialModelId: 'claude-haiku-4-5', initialEffort: 'low', publishTranscriptMessages: true,
        }), { kind: 'create', sessionId: harness.session.sessionId, cwd: '/tmp/host-wake' }, context);
        const runtime = createNativeAgentSessionOperations(native, harness.session.sessionId, undefined, undefined, undefined, undefined, undefined, {
          context, cwd: '/tmp/host-wake', connectedAccounts: [],
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: true },
          cancellation: { declared: true }, configuration: { declared: false }, compaction: { capability: null },
        });
        const snapshot = createTurnAssistantTextSnapshotStore();
        let observedSeq = 16;
        let finalAssistantSeq: number | null = null;
        const events: unknown[] = [];
        const mutations: import('@happier-dev/protocol').SessionTurnMutationV1[] = [];
        Object.assign(harness.session, {
          hasPendingProviderInput: () => false,
          getLastObservedMessageSeq: () => observedSeq,
          getCommittedUserMessageSeq: () => null,
          getTurnAssistantTextSnapshotStore: () => snapshot,
          enqueueSessionTurnMutation: async (value: unknown) => { mutations.push(SessionTurnMutationV1Schema.parse(value)); },
          sendAgentMessageEphemeral: () => ({ accepted: true as const, epoch: 0 }),
          enqueueAgentMessageCommitted: async (provider: Parameters<ApiSessionClient['enqueueAgentMessageCommitted']>[0], body: import('@/api/session/sessionMessageTypes').ACPMessageData,
            options: Parameters<ApiSessionClient['enqueueAgentMessageCommitted']>[2]) => {
            events.push(body);
            observedSeq += 1;
            const assistant = extractAssistantTextSnapshotFromAcpMessage(provider, body);
            if (assistant) {
              snapshot.observe({ ...assistant, localId: options.localId, seq: observedSeq, source: 'committed' });
              finalAssistantSeq = observedSeq;
            }
            return { persisted: true as const, delivered: true as const, committedSequence: observedSeq };
          },
        });
        setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
        let finished = false;
        const testController = new AbortController();
        harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
          await runPermissionModePromptLoop({ ...params, getAbortSignal: () => testController.signal,
            shouldExit: () => finished, sendReady: () => { finished = true; } });
          // The next pull flushes the Workflow owner's accepted-delivery ACKs.
          await params.prepareHostContext?.({ signal: new AbortController().signal, requiredPrompt: '' });
        };
        const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
        void running.catch(() => undefined);
        try {
          await vi.waitFor(() => expect(exec.written, JSON.stringify({ requests,
            workflowErrors: loggerDebugMock.mock.calls.filter(([label]) => String(label).includes('Workflow origin context unavailable')),
          })).toHaveLength(1));
          expect(JSON.stringify(exec.written)).toContain('DEFAULT_ORIGIN_RESULT');
          const { resolveCausalPermissionMode } = await import('@/agent/permissions/causalPermissionMode');
          const witness = runtime.readActiveTurnPermissionWitness?.();
          const permission = resolveCausalPermissionMode({ currentPermissionMode: 'yolo', context: {
            causalPermissionAuthority: witness?.causalPermissionAuthority ?? null,
          } });
          await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-wake-session' });
          await exec.emit({ type: 'assistant', uuid: 'wake-answer', session_id: 'native-wake-session',
            message: { id: 'wake-message', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
              content: [{ type: 'text', text: 'WAKE_COMPLETE' }], stop_reason: 'end_turn', stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 } } });
          await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-wake-session',
            result: 'WAKE_COMPLETE', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 } });
          await exec.resolveExit();
          await running;
          if (delivery === 'step') expect(permission)
            .toMatchObject({ ok: true, authority: 'admittedSessionInputV1', effectiveMode: 'default' });
          expect(mutations).toContainEqual(expect.objectContaining({ action: 'begin',
            ...(delivery === 'step' ? { initiator: 'workflow', workDepth: 1,
              workflowInvocation: { runId: run.id, invocationRecordId: invocationId } } : { initiator: 'host' }) }));
          const completed = mutations.find(value => value.action === 'complete');
          expect(finalAssistantSeq).toBeTypeOf('number');
          expect(completed).toMatchObject({ transcriptAnchors: { startSeqInclusive: 18, endSeqInclusive: observedSeq,
            finalAssistantMessageSeq: finalAssistantSeq } });
          expect(completed && 'transcriptAnchors' in completed ? completed.transcriptAnchors : null)
            .not.toHaveProperty('startUserMessageSeq');
          expect(events).toContainEqual(expect.objectContaining({ type: 'event', data: expect.objectContaining(delivery === 'step'
            ? { type: 'message', message: 'Workflow step input' }
            : { type: 'worker-update', update: expect.objectContaining({ workerKind: 'workflow_run', workerId: run.id }) }) }));
          if (delivery === 'step') expect(requests).toContain('invocations.current');
          else expect(requests).toContain('delivery.ack');
        } finally {
          finished = true;
          testController.abort();
          await exec.resolveExit();
          await runtime.resetOrDisposeRuntime('session_end');
          await running;
        }
        return;
      }
      harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
        const input = { signal: new AbortController().signal, requiredPrompt: 'normal user input' };
        const context = await params.prepareHostContext?.(input);
        expect(context?.workerUpdates, JSON.stringify({ requests, workflowErrors: loggerDebugMock.mock.calls.filter(([label]) => String(label).includes('Workflow origin context unavailable')) })).toEqual([
          expect.objectContaining({ workerKind: 'workflow_run', workerId: run.id, result: 'DEFAULT_ORIGIN_RESULT' }),
        ]);
        expect(requests).not.toContain('delivery.ack');
        context?.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'normal-input', userMessageSeq: null });
        await params.prepareHostContext?.(input);
        expect(requests).toContain('delivery.ack');
      };
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    } finally {
      post.mockRestore();
      get.mockRestore();
    }
  });

  it('coalesces worker updates into one host turn while retaining a card event for each worker', async () => {
    const harness = createHarness();
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue: queue, rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0, setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    const update = (workerId: string): import('@happier-dev/protocol').WorkerUpdateV1 => ({
      v: 1, workerKind: 'execution_run', workerId, ownerState: 'succeeded', wake: 'finished',
      headline: workerId, result: `result from ${workerId}`, canInspect: true,
      transcriptPointer: { kind: 'execution_run', sessionId: harness.session.sessionId, runId: workerId },
    });
    let available = true;
    let accepted = false;
    harness.config.hostContextOnlyInput = {
      take: async () => {
        if (!available) return null;
        available = false;
        return { kind: 'worker_update', localId: 'worker-batch', update: update('run-one'),
          recheckAdmission: async () => true, acknowledgeAccepted: () => { accepted = true; } };
      },
      prepareWorkerUpdates: async () => [{ localId: 'run-two-completion', update: update('run-two'), recheckAdmission: async () => true, acknowledgeAccepted: () => { accepted = true; } }],
      waitForChange: () => new Promise<boolean>(() => {}),
      isWorkflowStepDeliverable: async () => false, reportWorkflowStepWithdrawn: async () => undefined,
    };
    const events: unknown[] = [];
    harness.session.enqueueAgentMessageCommitted = vi.fn(async (_provider: string, body: unknown) => {
      events.push(body);
      return { persisted: true, delivered: false };
    });
    const prompts: string[] = [];
    const runtime = {
      ...harness.runtime, readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(unsupportedRuntimeConfigUpdate), beginTurnLifecycle: vi.fn(),
      sendTurnPrompt: vi.fn(async (prompt: string) => { prompts.push(prompt); }),
      waitForTurnCompletion: vi.fn(async () => undefined),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    let completed = false;
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      await runPermissionModePromptLoop({ ...params, shouldExit: () => completed, sendReady: () => { completed = true; } });
    };
    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    expect(prompts).toEqual([expect.stringContaining('result from run-one')]);
    expect(prompts[0]).toContain('result from run-two');
    expect(events).toEqual([
      expect.objectContaining({ id: 'worker-batch', type: 'event', data: expect.objectContaining({ type: 'worker-update', update: expect.objectContaining({ workerId: 'run-one' }) }) }),
      expect.objectContaining({ id: 'run-two-completion', type: 'event', data: expect.objectContaining({ type: 'worker-update', update: expect.objectContaining({ workerId: 'run-two' }) }) }),
    ]);
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ followWakeEventLocalId: expect.any(String) }) }),
    ]));
    expect(accepted).toBe(false);
    expect(harness.session.confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
  });

  it('includes another retained execution completion when the taken wake already owns its optional allowance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-host-worker-allowance-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: directory });
    reloadConfiguration();
    try {
      const [{ ExecutionRunHostBridge }, { finishExecutionRun }] = await Promise.all([
        import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge'),
        import('@/agent/runtime/bridges/executionRun/finishExecutionRun'),
      ]);
      const harness = createHarness();
      const firstResult = `FIRST_COMPLETION ${'x'.repeat(1_800)}`;
      const secondResult = `SECOND_COMPLETION ${'y'.repeat(700)}`;
      for (const [index, output] of [firstResult, secondResult].entries()) {
        const run: import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState = {
          runId: `allowance-run-${index}`, callId: `allowance-call-${index}`, sidechainId: `allowance-side-${index}`,
          sessionId: harness.session.sessionId, depth: 0, intent: 'agent',
          backendTarget: { kind: 'builtInAgent', agentId: 'acme.actual' }, backendId: 'acme.actual',
          instructions: 'Implement the change.', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'bounded', ioMode: 'request_response', notifyParentOnCompletion: true,
          status: 'running', startedAtMs: index + 1,
        };
        await finishExecutionRun({
          runId: run.runId, next: { status: index === 0 ? 'failed' : 'succeeded', finishedAtMs: index + 2 }, toolResult: { output },
          runs: new Map([[run.runId, run]]), controllers: new Map(), budgetRegistry: null,
          parentProvider: 'acme.parent', sendAcp: async () => undefined,
          enqueueMarkerWrite: async (_runId, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
        });
      }
      const bridge = new ExecutionRunHostBridge({
        parentProvider: 'acme.parent', cwd: directory, happyHomeDir: directory, sendAcp: async () => undefined,
      });
      harness.session.hasPendingProviderInput = vi.fn(() => false);
      harness.session.takeExecutionRunWorkerUpdate = (signal: AbortSignal) => bridge.takeWorkerUpdate(harness.session.sessionId, signal);
      harness.session.prepareExecutionRunWorkerUpdates = (input: Readonly<{ signal: AbortSignal }>) => bridge.prepareWorkerUpdates(harness.session.sessionId, input);
      harness.session.waitForExecutionRunWorkerUpdateChange = (signal: AbortSignal) => bridge.waitForWorkerUpdateChange(harness.session.sessionId, signal);
      harness.session.observePendingSessionFollow = vi.fn(async () => ({
        ok: true as const, publisherGeneration: 1, currentSourceSessionIds: [], observations: [],
      }));
      const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
      harness.deps.createPermissionModeQueueStateFn = () => ({
        messageQueue: queue, rebindSession: () => undefined,
        getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => undefined,
        getCurrentPermissionModeUpdatedAt: () => 0, setCurrentPermissionModeUpdatedAt: () => undefined,
      });
      const events: unknown[] = [];
      harness.session.enqueueAgentMessageCommitted = vi.fn(async (_provider: string, body: unknown) => {
        events.push(body);
        return { persisted: true, delivered: false };
      });
      const prompts: string[] = [];
      const runtime = {
        ...harness.runtime, readSessionIdentity: vi.fn(() => ({ sessionId: null })),
        updateSessionRuntimeConfig: vi.fn(unsupportedRuntimeConfigUpdate), beginTurnLifecycle: vi.fn(),
        sendTurnPrompt: vi.fn(async (prompt: string) => { prompts.push(prompt); }),
        waitForTurnCompletion: vi.fn(async () => undefined),
      };
      setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
      let completed = false;
      harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
        await runPermissionModePromptLoop({ ...params, shouldExit: () => completed, sendReady: () => { completed = true; } });
      };
      await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(firstResult);
      expect(prompts[0]).toContain(secondResult);
      expect(events).toHaveLength(2);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'event', data: expect.objectContaining({ type: 'worker-update', update: expect.objectContaining({ workerId: 'allowance-run-0' }) }) }),
        expect.objectContaining({ type: 'event', data: expect.objectContaining({ type: 'worker-update', update: expect.objectContaining({ workerId: 'allowance-run-1' }) }) }),
      ]));
      expect(harness.session.confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { delivery: 'newTurn', persisted: true }, { delivery: 'steer', persisted: true },
    { delivery: 'newTurn', persisted: false }, { delivery: 'steer', persisted: false },
  ] as const)('durably represents sibling execution completions before native acceptance retires their custody ($delivery, persisted=$persisted)', async ({ delivery, persisted }) => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const directory = await mkdtemp(join(tmpdir(), 'happier-host-worker-natural-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    envScope.patch({ HAPPIER_HOME_DIR: directory });
    reloadConfiguration();
    const controller = new AbortController();
    try {
      const [{ ExecutionRunHostBridge }, { finishExecutionRun }, registry,
        { createClaudeNativeSessionRuntimeFromOperations }, { createClaudeUnifiedTerminalTurnOperations }, fixtures,
        { createNativeAgentSessionOperations }, { TranscriptRawAgentEventV1Schema },
        { createNativeAgentSessionPublications }, { createNativeAgentHostSessionRuntimePlan },
        { buildPluginSessionBindingInput }] = await Promise.all([
        import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge'),
        import('@/agent/runtime/bridges/executionRun/finishExecutionRun'),
        import('@/daemon/executionRunRegistry'),
        import('../../../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime'),
        import('../../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations'),
        import('../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit'),
        import('@/agent/runtime/registry/engineRegistry/nativeAgentSession'),
        import('@happier-dev/protocol/sessions/messages/transcriptRawRecordV1'),
        import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications'),
        import('@/plugins/runtime/runtimeCore/plugin/session'),
        import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch'),
      ]);
      const harness = createHarness('session-1', { accountId: 'worker-update-account' });
      const runIds = ['natural-sibling-one', 'natural-sibling-two'];
      const finishSiblings = async () => await Promise.all(runIds.map(async (runId) => {
        const run: import('@/agent/runtime/bridges/executionRun/executionRunTypes').ExecutionRunState = {
          runId, callId: `${runId}-call`, sidechainId: `${runId}-side`, sessionId: harness.session.sessionId,
          depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'acme.actual' }, backendId: 'acme.actual',
          instructions: 'Complete the task.', permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'bounded', ioMode: 'request_response', notifyParentOnCompletion: true, status: 'running', startedAtMs: 1,
        };
        await finishExecutionRun({
          runId, next: { status: 'succeeded', finishedAtMs: 2 }, toolResult: { output: `RESULT_${runId}` },
          runs: new Map([[runId, run]]), controllers: new Map(), budgetRegistry: null,
          parentProvider: 'acme.parent', sendAcp: async () => undefined,
          enqueueMarkerWrite: async (_runId, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
        });
      }));
      const bridge = new ExecutionRunHostBridge({ parentProvider: 'acme.parent', cwd: directory,
        happyHomeDir: directory, sendAcp: async () => undefined });
      const signal = controller.signal;
      if (delivery === 'newTurn') await finishSiblings();
      let userMessageHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
      harness.session.onUserMessage = (handler: typeof userMessageHandler) => { userMessageHandler = handler; };
      delete harness.deps.createPermissionModeQueueStateFn;
      harness.session.hasPendingProviderInput = vi.fn(() => false);
      harness.session.takeExecutionRunWorkerUpdate = (input: AbortSignal) => bridge.takeWorkerUpdate(harness.session.sessionId, input);
      harness.session.prepareExecutionRunWorkerUpdates = (input: Readonly<{ signal: AbortSignal }>) => bridge.prepareWorkerUpdates(harness.session.sessionId, input);
      harness.session.waitForExecutionRunWorkerUpdateChange = (input: AbortSignal) => bridge.waitForWorkerUpdateChange(harness.session.sessionId, input);
      harness.session.observePendingSessionFollow = vi.fn(async () => ({
        ok: true as const, publisherGeneration: 1, currentSourceSessionIds: [], observations: [],
      }));
      const workerEvents: { localId: string; update: import('@happier-dev/protocol').WorkerUpdateV1 }[] = [];
      const preparationErrors: string[] = [];
      let publicationAttempted = false;
      // Persistent transcript transport boundary: validate the real producer through its strict reader.
      // Production terminal projection, sealed custody, preparation, queue, native codec and ACK stay real.
      harness.session.enqueueAgentMessageCommitted = vi.fn(async (_provider: string, body: unknown,
        options: Parameters<ApiSessionClient['enqueueAgentMessageCommitted']>[2]) => {
        const parsed = TranscriptRawAgentEventV1Schema.safeParse(
          body && typeof body === 'object' && 'data' in body ? body.data : null);
        if (parsed.success && parsed.data.type === 'message') preparationErrors.push(parsed.data.message);
        if (parsed.success && parsed.data.type === 'worker-update') {
          publicationAttempted = true;
          if (!persisted) return { persisted: false, delivered: false };
          workerEvents.push({ localId: options.localId, update: parsed.data.update });
        }
        return { persisted: true, delivered: false };
      });
      const terminal = fixtures.createTerminalHostFixture();
      const captureFixtureInput = terminal.service.captureInputState;
      const captureIdleInput = vi.fn(async (...args: Parameters<typeof captureFixtureInput>) => ({
        ...await captureFixtureInput(...args), observedAt: Date.now(),
      }));
      terminal.service.captureInputState = captureIdleInput;
      const ctx = fixtures.createPluginContextFixture(terminal.service, fixtures.createEventsFixture().service);
      const written = () => vi.mocked(terminal.service.injectUserPrompt).mock.calls.map(([, input]) => input.text);
      const publications = createNativeAgentSessionPublications({ agentId: 'acme.actual', session: null,
        signal, isCurrent: () => !signal.aborted, supportsInFlightSteer: true });
      const context = { signal, session: { services: publications.services } } as unknown as
        import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeContext;
      const provider = createClaudeUnifiedTerminalTurnOperations({ ctx, directory, launchEnv: {},
        hostPreference: 'zellij', permissionMode: 'default', happierSessionId: harness.session.sessionId });
      const native = createClaudeNativeSessionRuntimeFromOperations(provider,
        { kind: 'create', sessionId: harness.session.sessionId, cwd: directory }, context);
      const nativeEvents: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionRuntimeEvent[] = [];
      const nativeSubscription = native.watch(event => nativeEvents.push(event));
      const runtime = createNativeAgentSessionOperations(native, harness.session.sessionId, undefined, undefined, undefined, undefined, undefined, {
        context, cwd: directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn', 'steer'], cancel: true },
        cancellation: { declared: true }, configuration: { declared: false }, compaction: { capability: null },
      }, publications);
      const contribution = createExternalContributionFixtures('acme.actual');
      const plan = await createNativeAgentHostSessionRuntimePlan({ backend: contribution.backend, agent: contribution.agent,
        createSessionRuntime: () => runtime, policyAgentId: 'acme.actual',
        sessionInput: buildPluginSessionBindingInput({ credentials: harness.opts.credentials }) });
      if (!plan.config.createSessionRuntime) throw new Error('Expected the production native Session composition');
      setSessionRuntimeFactory(harness.config, plan.config.createSessionRuntime);
      let finished = false;
      harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
        if (!userMessageHandler) throw new Error('Expected the production input binding');
        userMessageHandler({ role: 'user', content: { type: 'text', text: 'Continue the lead task.' },
          localId: 'natural-lead-input', meta: {} });
        await runPermissionModePromptLoop({ ...params, getAbortSignal: () => signal,
          formatPromptErrorMessage: error => {
            preparationErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
            return params.formatPromptErrorMessage(error);
          },
          shouldExit: () => finished, sendReady: () => { finished = true; } });
      };
      const running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      let runtimeError: unknown;
      let runtimeFinished = false;
      void running.then(() => { runtimeFinished = true; }, error => { runtimeError = error; });
      try {
        await vi.waitFor(() => expect(written().length > 0 || publicationAttempted, JSON.stringify({
          finished, preparationErrors, runtimeError: runtimeError instanceof Error ? runtimeError.stack : runtimeError,
          diagnostics: loggerDebugMock.mock.calls.slice(-12),
        })).toBe(true), { timeout: 10_000 });
        if (delivery === 'steer') {
          expect(written()).toHaveLength(1);
          await provider.observeTerminalLifecycle({ agentId: 'claude', type: 'prompt_submitted',
            turnId: null, promptText: written()[0], observedAtMs: Date.now(), source: 'hook' });
          terminal.service.captureInputState = vi.fn(async () => ({ stable: true,
            currentInput: '✻ Pondering… (esc to interrupt)\n│ > │', observedAt: Date.now() }));
          await vi.waitFor(() => expect(runtime.canSteerPrompt?.()).toBe(true));
          await finishSiblings();
          if (!userMessageHandler) throw new Error('Expected the production steer binding');
          userMessageHandler({ role: 'user', content: { type: 'text', text: 'Consider the completed siblings.' },
            localId: 'steered-lead-input', meta: {} });
          await vi.waitFor(() => expect(written().length > 1 || publicationAttempted, JSON.stringify({
            preparationErrors, diagnostics: loggerDebugMock.mock.calls.slice(-12),
            supportsSteer: runtime.supportsInFlightSteer?.(), canSteer: runtime.canSteerPrompt?.(),
          })).toBe(true), { timeout: 10_000 });
        }
        const pending = await registry.readPendingExecutionRunWorkerUpdates();
        expect(pending.map(item => item.update.workerId).sort()).toEqual(runIds);
        if (!persisted) {
          expect(publicationAttempted).toBe(true);
          expect(written()).toHaveLength(delivery === 'steer' ? 1 : 0);
          expect(workerEvents).toEqual([]);
          const restarted = new ExecutionRunHostBridge({ parentProvider: 'acme.parent', cwd: directory,
            happyHomeDir: directory, sendAcp: async () => undefined });
          expect((await restarted.prepareWorkerUpdates(harness.session.sessionId, { signal })).map(item => item.localId).sort())
            .toEqual(pending.map(item => item.localId).sort());
          for (const runId of runIds) expect((await registry.readRetainedExecutionRunRecord(runId))?.terminalEventId).toBeTruthy();
          return;
        }
        await vi.waitFor(() => expect(written(), JSON.stringify({ preparationErrors,
          diagnostics: loggerDebugMock.mock.calls.slice(-12) })).toHaveLength(delivery === 'steer' ? 2 : 1));
        for (const runId of runIds) expect(JSON.stringify(written())).toContain(`RESULT_${runId}`);
        expect(workerEvents.map(event => event.update.workerId).sort()).toEqual(runIds);
        expect(workerEvents.map(event => event.localId).sort()).toEqual(pending.map(item => item.localId).sort());
        // Native transport submission alone cannot retire either completion.
        expect(await registry.readPendingExecutionRunWorkerUpdates()).toHaveLength(2);
        await provider.observeTerminalLifecycle({ agentId: 'claude', type: 'prompt_submitted',
          turnId: null, promptText: written().at(-1), observedAtMs: Date.now(),
          source: delivery === 'steer' ? 'transcript' : 'hook',
          ...(delivery === 'steer' ? { providerEvidence: 'queued_command' as const,
            acceptanceEvidenceId: 'native-steered-lead-input' } : {}) });
        expect(nativeEvents).toContainEqual(expect.objectContaining({ kind: 'input-accepted',
          inputIds: [delivery === 'steer' ? 'steered-lead-input' : 'natural-lead-input'],
          delivery: expect.objectContaining({ kind: delivery }) }));
        terminal.service.captureInputState = captureIdleInput;
        await provider.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate',
          turnId: null, source: 'hook' });
        await vi.waitFor(() => expect(runtimeFinished, JSON.stringify({
          runtimeError: runtimeError instanceof Error ? runtimeError.message : runtimeError,
          finished, providerInFlight: provider.isTurnInFlight(), preparationErrors,
          nativeEvents: nativeEvents.map(event => ({ kind: event.kind, ...('turnId' in event ? { turnId: event.turnId } : {}) })),
          diagnostics: loggerDebugMock.mock.calls.slice(-12),
        })).toBe(true), { timeout: 10_000 });
        await running;
        expect(await bridge.prepareWorkerUpdates(harness.session.sessionId, { signal })).toEqual([]);
        expect(await registry.readPendingExecutionRunWorkerUpdates()).toEqual([]);
        for (const runId of runIds) expect((await registry.readRetainedExecutionRunRecord(runId))?.terminalEventId).toBeUndefined();
        const restarted = new ExecutionRunHostBridge({ parentProvider: 'acme.parent', cwd: directory,
          happyHomeDir: directory, sendAcp: async () => undefined });
        expect(await restarted.prepareWorkerUpdates(harness.session.sessionId, { signal })).toEqual([]);
      } finally {
        finished = true;
        controller.abort();
        await runtime.resetOrDisposeRuntime('session_end');
        nativeSubscription.dispose();
        publications.dispose();
        await running.catch(error => {
          if (!(controller.signal.aborted && error instanceof Error && error.name === 'AbortError')) throw error;
        });
      }
    } finally {
      envScope.restore();
      reloadConfiguration();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('dispatches consecutive workflow steps as separate complete turns and never steers a busy provider', async () => {
    const harness = createHarness();
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue: queue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    const steps = [
      { localInputId: 'isolated-step-1', text: 'FIRST_REQUIRED_STEP' },
      { localInputId: 'isolated-step-2', text: 'SECOND_REQUIRED_STEP' },
    ];
    harness.config.hostContextOnlyInput = {
      take: async () => {
        const step = steps.shift();
        return step ? {
          kind: 'workflow_step', ...step,
          workflowInvocation: { runId: 'isolated-run', invocationRecordId: step.localInputId },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
          workDepth: 2,
          acknowledgeAccepted: () => undefined,
        } : null;
      },
      waitForChange: () => new Promise<boolean>(() => {}),
      isWorkflowStepDeliverable: async () => true,
      reportWorkflowStepWithdrawn: async () => undefined,
    };
    const firstTurnWaiting = createDeferred<void>();
    const finishFirstTurn = createDeferred<void>();
    let shouldExit = false;
    let completedTurns = 0;
    const sendTurnPrompt = vi.fn(async (_prompt: string) => undefined);
    const runtime = {
      ...harness.runtime,
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(unsupportedRuntimeConfigUpdate),
      beginTurnLifecycle: vi.fn(),
      supportsInFlightSteer: () => true,
      canSteerPrompt: () => true,
      steerInFlightTurn: vi.fn(async () => undefined),
      sendTurnPrompt,
      waitForTurnCompletion: vi.fn(async () => {
        if (completedTurns === 0) {
          firstTurnWaiting.resolve();
          await finishFirstTurn.promise;
        }
      }),
    };
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      await runPermissionModePromptLoop({
        ...params, shouldExit: () => shouldExit,
        sendReady: () => { completedTurns += 1; shouldExit = completedTurns === 2; },
      });
    };
    const run = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await firstTurnWaiting.promise;
    expect(sendTurnPrompt.mock.calls.map(([prompt]) => prompt)).toEqual(['FIRST_REQUIRED_STEP']);
    expect(runtime.steerInFlightTurn).not.toHaveBeenCalled();
    finishFirstTurn.resolve();
    await run;

    expect(sendTurnPrompt.mock.calls.map(([prompt]) => prompt)).toEqual(['FIRST_REQUIRED_STEP', 'SECOND_REQUIRED_STEP']);
    expect(runtime.beginTurnLifecycle).toHaveBeenCalledTimes(2);
    expect(runtime.steerInFlightTurn).not.toHaveBeenCalled();
    expect(harness.session.confirmUserMessageLocallyConsumed).not.toHaveBeenCalled();
    expect(harness.session.observeProviderInputSettlement).not.toHaveBeenCalled();
  });

  it('lets user input arriving during the workflow deliverability recheck run before the step host event', async () => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const harness = createHarness();
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    harness.deps.createPermissionModeQueueStateFn = () => ({
      messageQueue: queue,
      rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0,
      setCurrentPermissionModeUpdatedAt: () => undefined,
    });
    let stepAvailable = true;
    let rechecks = 0;
    harness.config.hostContextOnlyInput = {
      take: async () => {
        if (!stepAvailable) return null;
        return {
          kind: 'workflow_step', localInputId: 'step-after-user', text: 'WORKFLOW_AFTER_USER',
          workflowInvocation: { runId: 'priority-run', invocationRecordId: 'priority-invocation' },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
          workDepth: 1,
          acknowledgeAccepted: () => { stepAvailable = false; },
        };
      },
      waitForChange: () => new Promise<boolean>(() => {}),
      isWorkflowStepDeliverable: async () => {
        rechecks += 1;
        if (rechecks === 1) queue.push({ text: 'USER_FIRST', localId: 'priority-user' }, { permissionMode: 'default' });
        return true;
      },
      reportWorkflowStepWithdrawn: async () => undefined,
    };
    const order: string[] = [];
    const hostEvents: unknown[] = [];
    harness.session.enqueueAgentMessageCommitted = vi.fn(async (_provider: string, body: unknown, options?: { localId?: string }) => {
      hostEvents.push(body);
      order.push(`host:${options?.localId}`);
      return { persisted: true, delivered: false };
    });
    const runtime = harness.runtime;
    // This Agent boundary starts fresh and completes each dispatched turn immediately.
    runtime.readSessionIdentity = vi.fn(() => ({ sessionId: null }));
    runtime.updateSessionRuntimeConfig = vi.fn(unsupportedRuntimeConfigUpdate);
    runtime.beginTurnLifecycle = vi.fn();
    runtime.waitForTurnCompletion = vi.fn(async () => undefined);
    const prompts: string[] = [];
    runtime.sendTurnPrompt = vi.fn(async (prompt: string, meta?: { localId?: string }) => {
      prompts.push(prompt);
      order.push(`provider:${meta?.localId}`);
    });
    let completedTurns = 0;
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      await runPermissionModePromptLoop({
        ...params, shouldExit: () => completedTurns === 2,
        sendReady: () => { completedTurns += 1; },
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(order, JSON.stringify(hostEvents)).toEqual(['provider:priority-user', 'host:step-after-user', 'provider:step-after-user']);
    expect(prompts).toEqual([expect.stringContaining('USER_FIRST'), 'WORKFLOW_AFTER_USER']);
  });

  it.each(['session_changed', 'reconnect'] as const)('re-observes an internal Follow failure on %s and admits the same Discussion original into Pending', async recovery => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const accountGet = vi.mocked(axios.get).getMockImplementation();
    if (!accountGet) throw new Error('Expected the canonical Account HTTP boundary');
    const [{ createApiSessionSocketStub, resolveApiSessionSocketDefaultAck }, { createSocketTransportAdapter },
      { FeaturesResponseSchema }, { SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, SessionFollowObservePendingRequestV1Schema,
        SessionFollowObservePendingResponseV1Schema, deriveDiscussionFollowInputLocalIdV1 }] = await Promise.all([
      import('@/testkit/backends/apiSessionSocketHarness'), import('@happier-dev/sync-client'),
      import('@happier-dev/protocol/features/payload/featuresResponseSchema'),
      import('@happier-dev/protocol/sessions/follow/sessionFollowTransportV1'),
    ]);
    const destination = 'c123456789012345678901234';
    const harness = createHarness(destination, { credentials: { token: 'discussion-reobserve-token', encryption: null } });
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: destination };
    const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
    const actor = { v: 1, accountId: 'owner', profile: null };
    const question = { id: addressing.messageId, discussionId: addressing.discussionId, localId: 'question', seq: 2,
      authorAccountId: 'owner', accountActor: actor, producerV1: null, createdAt: 1,
      content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'What changed?' },
        { t: 'mention', participant: { kind: 'session', sessionId: destination } }] } },
      mentionedAccountIds: [], addressingV1: { throughSeq: 2, participantSessionIds: [destination] } };
    const features = FeaturesResponseSchema.parse({ features: {
      sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } },
    }, capabilities: { serverIdentity: { serverIdentityId: 'srv_discussion_reobserve' } } });
    const home = 'https://discussion-reobserve.example';
    const originalFetch = globalThis.fetch;
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === home) return url.pathname === '/v1/features'
        ? Response.json(features) : new Response('{}', { status: 404 });
      return await originalFetch(input, init);
    });
    const target = createSessionRecordFixture({ id: destination, encryptionMode: 'plain', active: true,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', claudeSessionId: 'native',
        runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }) });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, ...options) => {
      const path = new URL(String(url)).pathname;
      if (path === `/v2/sessions/${destination}`) return { status: 200, data: { session: target } };
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path.endsWith('/messages/reply-capability')) return { status: 200, data: { v: 1, protocolVersions: [1] } };
      if (path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      return await accountGet(url, ...options);
    });
    const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
      const path = new URL(String(config.url)).pathname;
      if (path === '/v2/sessions' || path === '/v2/sessions/archived') return { status: 200, data: {
        sessions: [], nextCursor: null, hasNext: false } };
      if (path.endsWith('/messages')) return { status: 200, data: { messages: [question], hasMoreOlder: false, messageSeq: 2 } };
      if (path === '/v1/discussions/discussion') return { status: 200, data: { discussion: {
        id: 'discussion', ownerAccountId: 'owner', encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true,
        dataEncryptionKey: null, creationLocalId: 'creation', titleContent: { t: 'plain', v: { v: 1, title: 'Question' } },
        latestMessage: { id: question.id, localId: question.localId, seq: 2, authorAccountId: 'owner', accountActor: actor,
          producerV1: null, createdAt: 1 }, messageSeq: 2, lastReadSeq: 0, unreadCount: 1, unreadMentionCount: 0,
        recentAuthorAccountIds: ['owner'], archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true,
          restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
      } } };
      throw new Error(`Unexpected Discussion HTTP boundary: ${path}`);
    });
    // Only HTTP and authenticated Socket.IO boundaries are substituted. Host waiting,
    // invalidation registration, observe parsing, intake and Pending admission stay real.
    let observations = 0;
    const responses: ReturnType<typeof SessionFollowObservePendingResponseV1Schema.parse>[] = [];
    const admissions: Parameters<NonNullable<ApiSessionClientOptions['machineAdmissionTransport']>>[0][] = [];
    const answer = (event: string, payload: unknown) => {
      if (event !== SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1) return resolveApiSessionSocketDefaultAck(event, payload);
      expect(SessionFollowObservePendingRequestV1Schema.parse(payload).sessionId).toBe(destination);
      observations += 1;
      const response = SessionFollowObservePendingResponseV1Schema.parse(observations === 1
        ? { ok: false, v: 1, error: 'internal' }
        : { ok: true, v: 1, sessionId: destination, publisherGeneration: '17', currentSourceSessionIds: [],
          observations: admissions.length ? [] : [{ source: { kind: 'discussion', discussionId: 'discussion' },
            destinationSessionId: destination, addressing, policy: { preset: 'quiet' },
            event: { kind: 'needs_you', type: 'decision', mode: 'wait' } }] });
      responses.push(response);
      return response;
    };
    const socket = createApiSessionSocketStub({ disconnectReason: 'transport close', emitWithAck: answer });
    const reconnectedSocket = createApiSessionSocketStub({ emitWithAck: answer });
    let connections = 0;
    let invalidations = 0;
    const sourceHome = new ApiSessionClient(harness.opts.credentials.token, createPlainSessionFixture({ id: destination }), {
      metadataAuthority: { kind: 'shared_editor' }, localMachineId: 'machine-1',
      getServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      machineAdmissionTransport: async admission => { admissions.push(admission); return { status: 'accepted', localId: admission.localId }; },
      onSessionFollowInvalidated: () => { invalidations += 1; publishSessionFollowWakeInvalidation(); },
      transport: { serverId: 'discussion-reobserve-home', serverUrl: home,
        createAccountUpdatesSocket: () => socket as never,
        createSessionSocketTransport: () => {
          const current = connections++ === 0 ? socket : reconnectedSocket;
          return { socket: current as never, transport: createSocketTransportAdapter(current as never) };
        } },
    });
    harness.session.getServerBinding = sourceHome.getServerBinding.bind(sourceHome);
    harness.session.getServerFeaturesSnapshot = sourceHome.getServerFeaturesSnapshot.bind(sourceHome);
    harness.session.getMachineAdmissionTransport = sourceHome.getMachineAdmissionTransport.bind(sourceHome);
    harness.session.runSessionFollowSourceRequest = sourceHome.runSessionFollowSourceRequest.bind(sourceHome);
    harness.session.observePendingSessionFollow = sourceHome.observePendingSessionFollow.bind(sourceHome);
    harness.session.acknowledgeSessionFollow = vi.fn();
    harness.session.hasPendingProviderInput = vi.fn(() => admissions.length > 0);
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode,
      { batcher: combinePermissionModeQueuedPrompts });
    harness.deps.createPermissionModeQueueStateFn = () => ({ messageQueue: queue, rebindSession: () => undefined,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => undefined,
      getCurrentPermissionModeUpdatedAt: () => 0, setCurrentPermissionModeUpdatedAt: () => undefined });
    const controller = new AbortController();
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      await runPermissionModePromptLoop({ ...params, getAbortSignal: () => controller.signal,
        shouldExit: () => controller.signal.aborted });
    };
    let running: Promise<void> | undefined;
    try {
      // Finish the initial connection invalidation before testing recovery from
      // the later failed observation; it must not accidentally repair the case.
      await vi.waitFor(() => expect(invalidations).toBe(1));
      running = runHostSessionRuntime(harness.opts, harness.config, harness.deps);
      await vi.waitFor(() => expect(observations).toBe(1));
      expect(responses).toEqual([{ ok: false, v: 1, error: 'internal' }]);
      expect(admissions).toEqual([]);
      expect(harness.runtime.sendTurnPrompt).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
      if (recovery === 'session_changed') socket.trigger('session', { id: 'reobserve-original', createdAt: 2,
        body: { t: 'session-changed', sessionId: destination } });
      else {
        socket.disconnect();
        // Match the existing Session reconnect integration fixture's allowance
        // for the connection supervisor's own reconnect schedule.
        await vi.waitFor(() => expect(reconnectedSocket.connect).toHaveBeenCalledTimes(1), { timeout: 3_000 });
        await vi.waitFor(() => expect(invalidations).toBe(2));
      }
      await vi.waitFor(() => expect(admissions).toHaveLength(1));
      expect(observations).toBeGreaterThanOrEqual(2);
      expect(admissions[0]).toMatchObject({ localId, sessionId: destination, requestedAction: { v: 1, kind: 'enqueue' },
        reply: { mode: 'return', discussion: addressing }, content: { t: 'plain', v: { meta: {
          happierInputRequestV1: { discussionAddressing: addressing, replyIntent: { mode: 'return' } },
        } } } });
      expect(harness.session.acknowledgeSessionFollow).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      try { await running; } finally {
        await sourceHome.close(); get.mockRestore(); request.mockRestore(); fetchBoundary.mockRestore();
      }
    }
  });

  it.each(['follower', 'manager'] as const)('commits one stable %s Follow wake identity before delivery and ACKs that identity', async (relation) => {
    onTestFinished(installEmptyProjectAccountRowsHttpBoundary());
    const accountGet = vi.mocked(axios.get).getMockImplementation();
    if (!accountGet) throw new Error('Expected the canonical Account HTTP boundary');
    const harness = createHarness('session-1', { accountId: 'follow-account' });
    harness.session.hasPendingProviderInput = vi.fn(() => false);
    delete harness.deps.createPermissionModeQueueStateFn;
    let userMessageHandler: ((message: import('@/api/types').UserMessage) => boolean | void) | null = null;
    harness.session.onUserMessage = handler => { userMessageHandler = handler; };
    const delivered = { transcriptSeq: 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const admitted = createAdmittedFollowInputFixture({ destinationSessionId: harness.session.sessionId,
      sourceSessionId: 'source-session', sourceLocalId: 'source-human-2', delivered, observed, relation });
    onTestFinished(installFollowHomeReadinessBoundary(harnessHomeFeatures.features));
    harness.session.getCommittedUserMessageSeq = vi.fn((localId: string) => localId === admitted.localId ? 41 : 42);
    harness.session.observePendingSessionFollow = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      sessionId: 'session-1',
      publisherGeneration: '17',
      currentSourceSessionIds: ['source-session'],
      observations: [admitted.observation],
    }));
    harness.session.acknowledgeSessionFollow = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost ACK response'))
      .mockResolvedValueOnce({
        ok: true as const,
        v: 1 as const,
        destinationSessionId: 'session-1',
        sourceSessionId: 'source-session',
        delivered: observed,
      });
    harness.session.enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true, delivered: false }));
    const source = createSessionRecordFixture({ id: 'source-session', encryptionMode: 'plain', seq: 2,
      metadata: JSON.stringify({ path: '/workspace/source', host: 'source-host' }), active: true, activeAt: 9_000 });
    // Only HTTP is substituted. Receipt admission, queue binding, hydration and ACK retry stay real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return await accountGet(url);
      if (path === admitted.lookupPath) return admitted.lookupResponse;
      if (path === admitted.mutePath) return { status: 200, data: { scopes: [] } };
      if (path === '/v1/features') return { status: 200, data: harnessHomeFeatures.features };
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/sessions/source-session') return { status: 200, data: { session: source } };
      if (path === '/v1/sessions/source-session/messages') return { status: 200, data: {
        messages: [{ id: 'source-human-2', seq: 2, localId: 'source-human-2', createdAt: 2_000, updatedAt: 2_000,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Please re-check the destination' },
            meta: { [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'cli' } } } } }],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      } };
      throw new Error(`Unexpected Follow source request: ${path}`);
    });
    onTestFinished(() => get.mockRestore());
    const sourceHome = createTestApiSessionClient(ApiSessionClient, harness.opts.credentials.token, createPlainSessionFixture({ id: 'session-1' }), {
      localMachineId: 'machine-1',
      transport: admitted.transport(harness.session.getServerBinding(), harness.opts.credentials.token),
      getServerFeaturesSnapshot: harness.session.getServerFeaturesSnapshot.bind(harness.session),
    });
    onTestFinished(() => sourceHome.close());
    harness.session.runSessionFollowSourceRequest = sourceHome.runSessionFollowSourceRequest.bind(sourceHome);
    harness.session.reconcileSessionInputForProviderDispatch = sourceHome.reconcileSessionInputForProviderDispatch.bind(sourceHome);

    let deliveryHandler: ((outcome: HostProviderInputOutcomeEvidence) => void) | null = null;
    const runtime = {
      ...harness.runtime,
      readSessionIdentity: vi.fn(() => ({ sessionId: null })),
      updateSessionRuntimeConfig: vi.fn(unsupportedRuntimeConfigUpdate),
      beginTurnLifecycle: vi.fn(),
      waitForTurnCompletion: vi.fn(async () => undefined),
      setOnPromptDeliveryOutcome: vi.fn((handler: ((outcome: HostProviderInputOutcomeEvidence) => void) | null) => {
        deliveryHandler = handler;
      }),
      sendTurnPrompt: vi.fn(async (_prompt: string, meta?: { localId?: string }) => {
        if (!meta?.localId) throw new Error('Expected a committed Pending input');
        expect(harness.session.getCommittedUserMessageSeq(meta.localId)).toBeGreaterThan(0);
        deliveryHandler?.({
          type: 'input-accepted',
          localInputId: meta.localId,
          userMessageSeq: meta.localId === admitted.localId ? 41 : 42,
          delivery: { kind: 'newTurn', turnId: `wake-turn-${runtime.sendTurnPrompt.mock.calls.length}` },
        });
      }),
    };
    setSessionRuntimeFactory(harness.config, () => ({ operations: runtime, nativeRuntime: runtime }));
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      if (!userMessageHandler) throw new Error('Expected the production admitted-input binding');
      userMessageHandler(admitted.message);
      let completedTurns = 0;
      let shouldExit = false;
      await runPermissionModePromptLoop({
        ...params,
        shouldExit: () => shouldExit,
        sendReady: () => {
          completedTurns += 1;
          if (completedTurns === 1) userMessageHandler?.({ role: 'user', localId: 'after-follow-acceptance',
            content: { type: 'text', text: 'Continue after accepting the original.' }, meta: {} });
          else shouldExit = true;
        },
      });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);
    await Promise.resolve();

    expect(runtime.sendTurnPrompt).toHaveBeenCalledTimes(2);
    expect(harness.session.observePendingSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
      inputLocalIds: [admitted.localId],
    }));
    expect(runtime.sendTurnPrompt.mock.calls[0]?.[0]).toContain('<session_follow>');
    expect(runtime.sendTurnPrompt.mock.calls[0]?.[0]).not.toContain('Please re-check the destination');
    expect(runtime.sendTurnPrompt.mock.calls[0]?.[1]).toMatchObject({ localId: admitted.localId, userMessageSeq: 41 });
    expect(runtime.sendTurnPrompt.mock.calls[1]?.[0]).not.toContain('<session_follow>');
    expect(harness.session.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(harness.session.acknowledgeSessionFollow).toHaveBeenCalledTimes(2);
    expect(harness.session.acknowledgeSessionFollow).toHaveBeenNthCalledWith(2, {
      sourceSessionId: 'source-session',
      localInputId: admitted.localId,
      expectedPublisherGeneration: '17',
      expected: delivered,
      observed,
      consumed: observed,
      acceptance: {
        kind: 'admitted_input', localInputId: admitted.localId, userMessageSeq: 41,
      },
    });
  });

  it('keeps the one Follow reconciler bound to the authoritative Session after handoff', async () => {
    const harness = createHarness();
    const initialObserve = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      sessionId: 'session-1',
      publisherGeneration: '1',
      currentSourceSessionIds: [],
      observations: [],
    }));
    harness.session.observePendingSessionFollow = initialObserve;
    const replacementFixture = harness.createSessionFixture('session-1');
    const replacementObserve = vi.fn(async () => ({
      ok: true as const,
      v: 1 as const,
      sessionId: 'session-1',
      publisherGeneration: '2',
      currentSourceSessionIds: [],
      observations: [],
    }));
    replacementFixture.session.observePendingSessionFollow = replacementObserve;
    let swapSession: ((nextSession: any) => Promise<void>) | null = null;
    harness.deps.initializeBackendRunSessionFn = async ({ onSessionSwap }: any) => {
      swapSession = onSessionSwap;
      return {
        session: harness.session,
        reconnectionHandle: null,
        reportedSessionId: 'session-1',
        attachedToExistingSession: false,
      };
    };
    harness.deps.runPermissionModePromptLoopFn = async (params: Parameters<typeof runPermissionModePromptLoop>[0]) => {
      const prepare = params.prepareHostContext;
      if (!prepare) throw new Error('Expected the host context owner');
      const signal = new AbortController().signal;
      await prepare({ signal, requiredPrompt: 'before handoff' });
      await swapSession?.(replacementFixture.session);
      await prepare({ signal, requiredPrompt: 'after handoff' });
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(initialObserve).toHaveBeenCalledOnce();
    expect(replacementObserve).toHaveBeenCalledOnce();
  });

  it('reads the live applied timing for each claim and wakes only when it broadens eligibility', async () => {
    const harness = createHarness();
    const setTiming = (timing: 'after_foreground_ready' | 'after_runtime_idle', version: number) => {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: { sessionPendingQueueDeliveryTiming: timing } as any,
        settingsVersion: version,
        loadedAtMs: version,
        settingsSecretsReadKeys: [],
        scopeKey: 'run-host-live-timing',
      });
    };
    setTiming('after_runtime_idle', 1);
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    harness.session.materializeNextPendingMessageSafely = materializeNextPendingMessageSafely;
    harness.session.wakePendingMaterialization.mockClear();
    harness.deps.runPermissionModePromptLoopFn = async (params: any) => {
      setTiming('after_foreground_ready', 2);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
      await params.inputConsumer.drainPending({ maxPopPerWake: 1, reason: 'live-timing' });
      setTiming('after_runtime_idle', 2);
      setTiming('after_runtime_idle', 1);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
      setTiming('after_runtime_idle', 3);
      expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
    };

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith(expect.objectContaining({
      reconcileWhenEmpty: 'force',
      deliveryTiming: 'after_foreground_ready',
    }));
    setTiming('after_foreground_ready', 4);
    expect(harness.session.wakePendingMaterialization).toHaveBeenCalledTimes(1);
  });

  it('does not stamp provider-enforced permission traces from the shared host path by default', async () => {
    const harness = createHarness();
    let observedToolTrace: unknown;
    const createProviderEnforcedPermissionHandlerFn = vi.fn((params: {
      toolTrace?: unknown;
    }) => {
      observedToolTrace = params.toolTrace;
      return {
        setPermissionMode: () => undefined,
        reset: () => undefined,
        updateSession: () => undefined,
      };
    });
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        toolTrace: expect.objectContaining({ protocol: 'acp' }),
      }),
    );
    expect(observedToolTrace).toBeNull();
  });

  it('passes provider-owned permission trace adapters through the shared host path', async () => {
    const harness = createHarness();
    const createProviderEnforcedPermissionHandlerFn = vi.fn(() => ({
      setPermissionMode: () => undefined,
      reset: () => undefined,
      updateSession: () => undefined,
    }));
    harness.deps.createProviderEnforcedPermissionHandlerFn = createProviderEnforcedPermissionHandlerFn;
    harness.config.resolvePermissionToolTrace = () => ({
      protocol: 'claude',
      provider: 'claude',
    });

    await runHostSessionRuntime(harness.opts, harness.config, harness.deps);

    expect(createProviderEnforcedPermissionHandlerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolTrace: {
          protocol: 'claude',
          provider: 'claude',
        },
      }),
    );
  });
});
