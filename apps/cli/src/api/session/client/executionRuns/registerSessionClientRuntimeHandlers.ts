import { randomUUID } from 'node:crypto';

import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import { notifyDaemonConnectedServiceUsageLimitWaitResumeCancel } from '@/daemon/controlClient';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { readStoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import type { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
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
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import {
    DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Metadata } from '@/api/types';
import type { ACPMessageData, ACPProvider } from '../../sessionMessageTypes';
import {
    deriveVoiceAgentTurnLocalId,
    readAcpConfiguredBackendV1FromMetadata,
    readVoiceAgentTurnPayloadFromMeta,
    type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
import type { ExecutionRunPermissionRequestStoreProvider } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { EphemeralSendResult } from '@/api/session/client/transcript/ephemeralSendOutcome';
import type { VoiceAgentTranscriptTurnCommitParams } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createExecutionRunTranscriptCustodyError } from '@/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';

export function resolveSessionClientParentProvider(metadata: unknown): ACPProvider {
    const configuredAcpBackendId = typeof readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId === 'string'
        ? String(readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId).trim()
        : '';
    if (configuredAcpBackendId) {
        return configuredAcpBackendId;
    }

    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (agentId) return agentId;

    throw new Error('Missing canonical session parent provider identity');
}

function createExecutionBudgetRegistry(): ExecutionBudgetRegistry | undefined {
    const hasBudgetCaps =
        configuration.executionRunsMaxConcurrentPerSession !== null
        || configuration.oneShotTasksMaxConcurrentPerSession !== null
        || typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
        || (configuration.executionBudgetMaxConcurrentByClass && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0);
    if (!hasBudgetCaps) {
        return undefined;
    }

    return new ExecutionBudgetRegistry({
        maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
        maxConcurrentOneShotTasks: configuration.oneShotTasksMaxConcurrentPerSession,
        ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
            : {}),
        ...(configuration.executionBudgetMaxConcurrentByClass
            && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
            ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
            : {}),
    });
}

export function registerSessionClientRuntimeHandlers(
    params: Readonly<{
        rpcHandlerManager: RpcHandlerManager;
        token: string;
        metadataPath: string;
        metadata: unknown;
        sessionId: string;
        getSessionMetadata: () => Metadata | null;
        sessionRuntimeControls?: SessionRuntimeControls | null;
        enqueueSessionUserMessage: (request: Readonly<{
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
        }>) => Promise<void> | void;
        enqueueUserTextMessageCommitted: (
            text: string,
            opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        enqueueAgentMessageCommitted: (
            provider: ACPProvider,
            body: ACPMessageData,
            opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        enqueueVoiceAgentTranscriptTurnCommitted: (
            provider: ACPProvider,
            params: VoiceAgentTranscriptTurnCommitParams,
        ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
        sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number }) => EphemeralSendResult;
        sendAgentMessageEphemeralDelta?: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> }) => EphemeralSendResult;
        getEphemeralStreamConnectionEpoch?: () => number;
        enqueueRegisteredSessionStateFieldMutation?: (mutation: RegisteredSessionStateFieldMutationV1) => void | Promise<void>;
        getTranscriptQueryContext: () => Readonly<
            | { encryptionMode: 'plain' }
            | {
                encryptionMode: 'e2ee';
                encryptionKey: Uint8Array;
                encryptionVariant: 'legacy' | 'dataKey';
            }
        >;
        getAgentStateRequestStore?: ExecutionRunPermissionRequestStoreProvider;
        getBrowserDaemonControlRoutes?: (() => BrowserDaemonControlRoutes | null) | null;
        getBrowserDaemonContextRoutes?: (() => BrowserContextRoutes | null) | null;
        getBrowserDaemonAutomationRoutes?: (() => BrowserAutomationRoutes | null) | null;
        getBrowserDiagnosticsActionRoutes?: (() => BrowserDiagnosticsActionRoutes | null) | null;
        getBrowserRecordingRoutes?: (() => BrowserRecordingRoutes | null) | null;
        attachBrowserRecordingToComposer?: (
            input: BrowserRecordingComposerAttachInput,
        ) => Promise<BrowserRecordingComposerAttachResult>;
        getLocalServicesRuntimeActionRoutes?: (() => LocalServicesRuntimeActionRoutes | null) | null;
        getSimulatorPreviewRoutes?: (() => SimulatorPreviewRoutes | null) | null;
        getPeerMediationObservabilityRuntimeActionContext?: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null;
        getServerFeaturesSnapshot?: (() => CliServerFeaturesSnapshot | undefined) | null;
        createCapabilitiesApiClient?: NonNullable<
            Parameters<typeof registerCapabilitiesHandlers>[1]
        >['createApiClient'];
        persistVoiceAgentRunMetadataFromPublicRun: (run: unknown, welcomedEpoch?: number) => void;
        socketEmitExecutionRunUpdated: (run: unknown) => void;
        observeExecutionRunPublicState?: (run: unknown) => void;
    }>,
): void {
    const parentProvider = resolveSessionClientParentProvider(params.metadata);
    const workingDirectory = params.metadataPath ?? process.cwd();
    const executionBudgetRegistry = createExecutionBudgetRegistry();
    const transcriptQueryContext = params.getTranscriptQueryContext();
    const transcriptTransportContext: SessionStoredContentCryptoContext =
        transcriptQueryContext.encryptionMode === 'plain'
            ? { mode: 'plain', ctx: null }
            : { mode: 'e2ee', ctx: transcriptQueryContext };
    const transcriptActionExecutor = createCliActionExecutor({
        token: params.token,
        sessionId: params.sessionId,
        ...transcriptTransportContext,
        transcriptSessionId: params.sessionId,
        transcriptStore: createServerBackedSessionTranscriptStore({
            token: params.token,
            sessionId: params.sessionId,
            ctx: transcriptTransportContext.ctx,
        }),
        // A.13 watcher bound floor: idle TTL must be >= 600_000 ms (10 min) per packet body section 2.
        transcriptFollowLeaseRegistry: createSessionTranscriptFollowLeaseRegistry({
            maxLeases: 16,
            idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
        }),
        writeTranscriptItems: async (_sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
            await importHistoricalSessionTranscript({
                token: params.token,
                sessionId: params.sessionId,
                items,
            }),
        sessionLogAccess: {
            workingDirectory,
            accessPolicy: { kind: 'osUser' },
        },
    });

    registerSessionHandlers(params.rpcHandlerManager, workingDirectory, {
        sessionId: params.sessionId,
        ...(params.createCapabilitiesApiClient
            ? { createCapabilitiesApiClient: params.createCapabilitiesApiClient }
            : {}),
        getSessionMetadata: () => params.getSessionMetadata(),
        sessionRuntimeControls: params.sessionRuntimeControls ?? null,
        enqueueSessionUserMessage: (request: Readonly<{
            text: string;
            localId?: string;
            meta?: Record<string, unknown>;
        }>) => params.enqueueSessionUserMessage(request),
        transcriptActionExecutor,
        notifyUsageLimitWaitResumeCancelled: async (request) =>
            await notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(request),
    });

    const transcriptWriter = {
        appendUserTextCommitted: async (
            text: string,
            options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => {
            const admission = await params.enqueueUserTextMessageCommitted(text, {
                localId: options.localId,
                meta: options.meta,
                provenance: { kind: 'non_dependent', source: 'external' },
            });
            if (!admission.persisted) {
                throw new Error('Execution-run user transcript row was not admitted to durable custody');
            }
            return admission;
        },
        appendAssistantTextCommitted: async (
            text: string,
            options: Readonly<{ localId: string; meta: Record<string, unknown> }>,
        ) => {
            return await params.enqueueAgentMessageCommitted(
                parentProvider as ACPProvider,
                { type: 'message', message: text },
                {
                    localId: options.localId,
                    meta: options.meta,
                    provenance: { kind: 'non_dependent', source: 'external' },
                },
            );
        },
        commitVoiceAgentTranscriptTurn: async (turn: Readonly<{
            turnId: string;
            user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }>;
            assistant: Readonly<{ text: string; meta: Record<string, unknown> }>;
        }>) => {
            const userTurn = readVoiceAgentTurnPayloadFromMeta(turn.user.meta);
            const assistantTurn = readVoiceAgentTurnPayloadFromMeta(turn.assistant.meta);
            if (!userTurn || !assistantTurn) {
                throw new Error('Voice-agent transcript turn metadata is required for durable pair commit');
            }
            if (
                userTurn.role !== 'user'
                || assistantTurn.role !== 'assistant'
                || userTurn.streamId !== turn.turnId
                || assistantTurn.streamId !== turn.turnId
                || userTurn.voiceAgentId !== assistantTurn.voiceAgentId
                || userTurn.runId !== assistantTurn.runId
                || userTurn.epoch !== assistantTurn.epoch
            ) {
                throw new Error('Voice-agent transcript pair must describe one canonical user/assistant turn');
            }
            return await params.enqueueVoiceAgentTranscriptTurnCommitted(parentProvider as ACPProvider, {
                turnId: turn.turnId,
                user: {
                    text: turn.user.text,
                    localId: turn.user.localId,
                    meta: turn.user.meta,
                },
                assistant: {
                    text: turn.assistant.text,
                    localId: deriveVoiceAgentTurnLocalId(assistantTurn),
                    meta: turn.assistant.meta,
                },
            });
        },
    };

    registerExecutionRunHandlers(params.rpcHandlerManager, {
        sessionId: params.sessionId,
        cwd: workingDirectory,
        ...(typeof (params.metadata as { machineId?: unknown })?.machineId === 'string'
            && (params.metadata as { machineId: string }).machineId.trim().length > 0
            ? { machineId: (params.metadata as { machineId: string }).machineId.trim() }
            : {}),
        serverUrl: configuration.serverUrl,
        parentProvider,
        browserControl: params.getBrowserDaemonControlRoutes?.() ?? null,
        browserContext: params.getBrowserDaemonContextRoutes?.() ?? null,
        browserAutomation: params.getBrowserDaemonAutomationRoutes?.() ?? null,
        browserDiagnostics: params.getBrowserDiagnosticsActionRoutes?.() ?? null,
        browserRecording: params.getBrowserRecordingRoutes?.() ?? null,
        attachBrowserRecordingToComposer: params.attachBrowserRecordingToComposer,
        localServices: params.getLocalServicesRuntimeActionRoutes?.() ?? null,
        simulatorPreview: params.getSimulatorPreviewRoutes?.() ?? null,
        peerMediationObservability: params.getPeerMediationObservabilityRuntimeActionContext?.() ?? null,
        // G9-E: forward the daemon-wide cached server-features accessor so the runtime-action front
        // door's feature gate reads the live server bits cold instead of failing closed.
        ...(params.getServerFeaturesSnapshot ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot } : {}),
        sendAcp: async (provider, body, opts) => {
            const normalizedBody = body as ACPMessageData;
            const localId = 'id' in normalizedBody && typeof normalizedBody.id === 'string'
                ? normalizedBody.id
                : randomUUID();
            const admission = await params.enqueueAgentMessageCommitted(
                provider as ACPProvider,
                normalizedBody,
                {
                    localId,
                    ...(opts?.meta ? { meta: opts.meta } : {}),
                    provenance: {
                        kind: 'non_dependent',
                        source: 'sidechainId' in normalizedBody && typeof normalizedBody.sidechainId === 'string'
                            ? 'sidechain'
                            : 'external',
                    },
                },
            );
            if (!admission.persisted) {
                throw createExecutionRunTranscriptCustodyError();
            }
        },
        streamedTranscriptSession: {
            sendAgentMessageEphemeral: (provider, body, opts) =>
                params.sendAgentMessageEphemeral(provider as ACPProvider, body as ACPMessageData, opts),
            sendAgentMessageEphemeralDelta:
                typeof params.sendAgentMessageEphemeralDelta === 'function'
                    ? (provider, body, opts) =>
                        params.sendAgentMessageEphemeralDelta!(provider as ACPProvider, body as ACPMessageData, opts)
                    : undefined,
            getEphemeralStreamConnectionEpoch: params.getEphemeralStreamConnectionEpoch,
            enqueueAgentMessageCommitted: (provider, body, opts) =>
                params.enqueueAgentMessageCommitted(provider as ACPProvider, body as ACPMessageData, opts),
        },
        transcriptWriter,
        budgetRegistry: executionBudgetRegistry,
        getPermissionRequestStore: params.getAgentStateRequestStore,
        parentSessionStateTarget: typeof params.enqueueRegisteredSessionStateFieldMutation === 'function'
            ? {
                sessionId: params.sessionId,
                enqueueRegisteredSessionStateFieldMutation: params.enqueueRegisteredSessionStateFieldMutation,
            }
            : null,
        onExecutionRunPublicStateUpdated: (run) => {
            try {
                params.observeExecutionRunPublicState?.(run);
                params.persistVoiceAgentRunMetadataFromPublicRun(run);
                params.socketEmitExecutionRunUpdated(run);
            } catch {
                // best effort
            }
        },
        onExecutionRunVoiceAgentWelcomed: (run, welcomedEpoch) => {
            params.persistVoiceAgentRunMetadataFromPublicRun(run, welcomedEpoch);
        },
        policy: {
            maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
            boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
            reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
            maxTurns: configuration.executionRunsMaxTurns,
            maxDepth: configuration.executionRunsMaxDepth,
        },
        resolveAccountSettings: async () => {
            const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
            if (activeSettings) return activeSettings;
            const credentials = await readStoredCredentials();
            if (!credentials) return null;
            const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
            return context.settings ?? null;
        },
        actionApprovalDeps: createExecutionRunRpcApprovalDeps({
            readCredentials: readStoredCredentials,
        }),
    });
}
