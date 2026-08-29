/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readStoredCredentials } from '@/persistence';
import {
    readCurrentMessageActionReferenceRowV1,
    resolveMessageActionReferenceSnapshotV1,
} from '@/api/session/messageActionReference';
import {
    createAccountScopedCryptoMaterialSnapshotV1,
    sealAccountScopedBlobCiphertext,
    ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1,
    type ConnectedServiceExecutionAuthorityV1,
} from '@happier-dev/protocol';
import { fetchAccountProfile } from './accountProfile';
import { fetchAccountEncryptionCurrentness } from './client/connectedServiceCredentialApi';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createCurrentMachineExecutionOriginContextResolver } from './machine/resolveCurrentMachineExecutionOriginContext';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import type { SocketRpcCallResponse } from './types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerAutomationReplyHandoffRpcHandler } from '@/rpc/handlers/automationReplyHandoff';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
    resolveExternalSessionOperationAccountScope,
    type ExternalSessionOperationAccountScope,
} from '@/session/actions/externalSessions/operationRecordStore';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
    createTrackedSessionHandoffCoordinator,
    createHostActionOperationRuntime,
    type HostActionOperationRuntime,
} from '@/daemon/actionOperations';
import {
    registerDaemonLocalServicePreviewSnapshotHandler,
} from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import {
    registerDaemonLocalServicesMachineRpcHandlers,
    type DaemonLocalServicesMachineRpcRoutes,
} from '@/rpc/handlers/daemonLocalServices';
import {
    registerDaemonBrowserControlHandler,
} from '@/rpc/handlers/daemonBrowserControl';
import {
    registerDaemonBrowserContextHandler,
} from '@/rpc/handlers/daemonBrowserContext';
import {
    registerDaemonBrowserDiagnosticsSnapshotHandler,
} from '@/rpc/handlers/daemonBrowserDiagnosticsSnapshot';
import {
    registerDaemonBrowserRecordingHandlers,
} from '@/rpc/handlers/daemonBrowserRecording';
import {
    registerDaemonSimulatorPreviewHandlers,
} from '@/rpc/handlers/daemonSimulatorPreview';
import {
    registerDaemonLiveStreamRelayHandlers,
    type DaemonLiveStreamRelayRoutes,
} from '@/rpc/handlers/daemonLiveStreamRelay';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { registerWorkspaceAnchorHandlers } from '@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers';
import { registerWorkspaceFaviconHandlers } from '@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers';
import { backoff } from '@/utils/time';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServices/connectedServicesProjectionRetryScheduler';
import { isConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import {
    RpcHandlerManager,
    type RpcHandlerRegistrationReadiness,
} from './rpc/RpcHandlerManager';
import type { RpcHandlerActiveExecution, RpcHandlerInvoker } from './rpc/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
    EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    TRANSFER_RELAY_V2_SOCKET_EVENT,
    type ExternalSessionTranscriptInvalidationV1,
    type ExternalSessionOperationSocketCommandV1,
    type ExternalSessionOperationSocketResponseV1,
    type ExternalSessionStatusDemandDaemonMessageV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineTransferReceiveEnvelope,
    type MachineTransferSendEnvelope,
    type PeerTcpTunnelRelayEnvelope,
    type ExactSessionTurnEndMutationV1,
    type TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { readAccountChangesCursor, writeAccountChangesCursor } from '@/persistence';
import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountSettingsWatchInvalidation,
    readPluginAccountCollectionWatchInvalidations,
    readPluginAccountSettingsWatchInvalidations,
    retirePluginAccountCollectionWatchScope,
} from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { createAuthenticationHttpStatusError, isAuthenticationError, isAuthenticationStatus } from './client/httpStatusError';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import {
    createSessionSyncPendingInputServerContractController,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { ConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import {
    readAuthoritativeSessionDeletionChangeV1,
} from '@happier-dev/protocol/changes';
import {
    registerMachineRpcHandlers,
    type MachineRpcHandlerDeps,
    type MachineRpcHandlers,
    type MachineRpcLifecycleRegistration,
} from './machine/rpcHandlers';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import {
    createMachineContentCodec,
    type MachineContentCodec,
} from './machine/machineStoredContent';
import {
    registerMachineConnectedAccountRpcHandlers,
} from './machine/rpcHandlers.connectedAccounts';
import { authorizeMachineRpcRequest } from './machine/machineRpcAuthorization';
import { projectIncomingMachineRpcDebugPayload } from './machine/projectIncomingMachineRpcDebugPayload';
import { projectMachineRpcTransportAcknowledgement } from './machine/projectMachineRpcTransportAcknowledgement';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';
import {
    requireCurrentAccountStoredContentServerCompatibility,
} from '@/api/clientCompatibility/accountStoredContentActivation';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import {
    emitSocketWithAck,
    SocketAckAbortError,
    SocketAckError,
} from '@/session/transport/shared/socketAck';
import { resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    createDaemonSessionClientDurableMutationOutbox,
    type DaemonSessionClientDurableMutationOutbox,
} from './session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import {
    discoverDaemonSessionClientDurableMutationJournalSessionIds,
} from './session/client/transport/mutations/sessionClientDurableMutationPersistence';
import {
    MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
    MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
    MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
    SESSION_SERVER_START_INGRESS_EVENT_V1,
    MachineSessionTerminalCaptureResponseV1Schema,
    MachineSessionTerminalFinalizeResponseV1Schema,
    MachineUpdateOperationProtocolCapabilitiesRequestV1Schema,
    MachineUpdateOperationProtocolCapabilitiesResponseV1Schema,
    SessionPendingEnqueueByMachineRequestV1Schema,
    SessionPendingEnqueueByMachineResponseV1Schema,
    SessionServerStartDispatchResultV1Schema,
    SessionServerStartIngressRequestV1Schema,
    SessionServerStartIngressResponseV1Schema,
    type MachineOperationProtocolCapabilitiesV1,
    type MachineSessionTerminalAuthorityV1,
    type MachineSessionTerminalCaptureResponseV1,
    type MachineSessionTerminalFinalizeResponseV1,
    type SessionPendingEnqueueByMachineRequestV1,
    type SessionInputAdmissionResultV1,
    type SessionServerStartDispatchResultV1,
    type SessionServerStartIngressRequestV1,
} from '@happier-dev/protocol';

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

const REQUIRED_MACHINE_CONTROL_RPC_METHODS = Object.freeze([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
]);
const MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS = 10_000;

// Published only after the authenticated Machine enqueue and exact target
// settlement paths are both installed. The server uses this leaf as a strict
// admission prerequisite, so absent/older daemons continue to fail closed.
const CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1:
    MachineOperationProtocolCapabilitiesV1 = Object.freeze({
        sessionInputAdmission: { protocolVersions: [1] },
        sessionSpawn: { protocolVersions: [1] },
        pluginWebhookClaim: { protocolVersions: [1] },
    });

export type AccountSettingsVersionHintNotification = Readonly<{
    settingsVersion: number | null;
    source: AccountSettingsVersionHintSource;
}>;

export type PendingSessionActivationHintNotification = Readonly<{
    sessionId: string;
    requestId: string;
    pendingVersion: number;
    source: 'changes' | 'live';
}>;

export type SessionDeletedChangeNotification = Readonly<{
    sessionId: string;
    cursor: number;
    /**
     * Pinned operation scope of the authenticated Account whose changes feed
     * delivered this durable deletion fact. Authoritative cleanup targets
     * exactly this Account's partition even if the ambient credentials rotate
     * before the listener runs.
     */
    accountScope: ExternalSessionOperationAccountScope;
}>;

export type ConnectedServicesProjectionNotification = Readonly<{
    source: AccountSettingsVersionHintSource | 'startup' | 'reconnect' | 'live';
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
    signal: AbortSignal;
    connectedServicesV2: unknown;
    connectedServiceCredentialRevisionsV1: unknown;
}>;

export type ApiMachineClientLifecycleDependencies = Readonly<{
    isDaemonQuiescing?: () => boolean;
    requireCurrentAccountStoredContentCompatibility?: () => Promise<void>;
    createCapabilitiesApiClient?: MachineRpcHandlerDeps['createCapabilitiesApiClient'];
    /** Test seam for the canonical Resource lifecycle owner. */
    resourceSessionLifecycle?: Pick<
        PluginReloadController,
        'applyResourceSessionAccessWitness'
    >;
}>;

export type ApiMachineDaemonStatePublicationOptions = Readonly<{
    allowWhileQuiescing?: boolean;
}>;

export type MachinePublicationOutcome = 'published' | 'unchanged' | 'suppressed';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function classifyMachineTransportErrorToProbeResult(
    error: unknown,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    void error;
    return null;
}

function readSocketConnectErrorDiagnostic(error: unknown): Readonly<{
    message?: string;
    name?: string;
    code?: string;
    statusCode?: number;
}> {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw)
        ? statusRaw
        : null;
    return {
        ...(typeof record?.message === 'string' && record.message.trim() ? { message: record.message.trim() } : {}),
        ...(typeof record?.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
        ...(typeof record?.code === 'string' && record.code.trim() ? { code: record.code.trim() } : {}),
        ...(statusCode !== null ? { statusCode } : {}),
    };
}

function isMachineReplacedSocketError(error: unknown): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = typeof data?.error === 'string' ? data.error.trim() : '';
    const message = typeof record?.message === 'string' ? record.message.trim() : '';
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;
    return statusCode === 410 && (errorCode === 'machine-replaced' || errorCode === 'machine_replaced' || message === 'machine-replaced');
}

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private readonly connectedClientRpcMethods = new Set<string>();
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private readonly connectedServicesProjectionRetry = createConnectedServicesProjectionRetryScheduler();
    private projectionSchedulingClosed = false;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private accountSettingsVersionHintListeners = new Set<(hint: AccountSettingsVersionHintNotification) => void | Promise<void>>();
    private pendingSessionActivationHintListeners = new Set<(
        hint: PendingSessionActivationHintNotification,
    ) => void | Promise<void>>();
    private sessionDeletedChangeListeners = new Set<(
        change: SessionDeletedChangeNotification,
    ) => void | Promise<void>>();
    private connectedServicesProjectionListener: ((notification: ConnectedServicesProjectionNotification) => void | Promise<void>) | null = null;
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private transferRelayV2Listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    private peerTcpTunnelRelayListeners = new Set<(payload: PeerTcpTunnelRelayEnvelope) => void>();
    private machineLiveStreamRelayListeners = new Set<(payload: MachineLiveStreamRelayEnvelopeV1) => void>();
    private externalSessionStatusDemandListeners = new Set<(payload: ExternalSessionStatusDemandDaemonMessageV1) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private daemonTerminalSessionMutationOutboxes = new Map<string, DaemonSessionClientDurableMutationOutbox>();
    private readonly machineRpcWorkingDirectory: string;
    private readonly filesystemAccessPolicy: FilesystemAccessPolicy;
    private additionalAllowedReadDirs: string[] = [];
    private additionalAllowedWriteDirs: string[] = [];
    private readonly transientSessionMediaReadAllowance = createTransientSessionMediaReadAllowance();
    private readonly fileSystemTransferRelayOwner: TransferRelayV2DownloadSessionOwner;
    private readonly rpcLifecycleRegistrations: MachineRpcLifecycleRegistration[] = [];
    private connectedAccountDaemonRuntime: ConnectedAccountDaemonRuntime | null = null;
    private connectedAccountPurposeBindingRuntime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    > | null = null;
    private sessionSpawnV1OutcomeRequired = false;
    private agentCatalogObservation: AgentProviderCatalogObservationService | null = null;
    private activeTransportGeneration = 0;
    private advertisedOperationProtocolCapabilitiesGeneration: number | null = null;
    private machineControlRunningGeneration: number | null = null;
    private machineControlReadinessPublication: Readonly<{
        generation: number;
        promise: Promise<boolean>;
    }> | null = null;
    private readonly sessionSyncPendingInputServerContractController:
        ReturnType<typeof createSessionSyncPendingInputServerContractController>;
    private sessionSyncPendingInputServerContractResult:
        SessionSyncPendingInputServerContractResult | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private readonly ownershipMetadata: Readonly<{
        runtimeId?: string;
        cliVersion?: string;
        publicReleaseChannel?: string;
        startupSource?: string;
        serviceManaged?: boolean;
        serviceLabel?: string;
    }>;
    private readonly lifecycleDependencies: ApiMachineClientLifecycleDependencies;
    private readonly machineContentCodec: MachineContentCodec;
    private readonly actionOperationRuntime: HostActionOperationRuntime;

    private async requirePlainMachineCompatibility(): Promise<void> {
        if (this.machine.encryptionMode !== 'plain') return;
        await (
            this.lifecycleDependencies.requireCurrentAccountStoredContentCompatibility
            ?? requireCurrentAccountStoredContentServerCompatibility
        )();
    }

    private shouldSuppressMachinePublication(allowWhileQuiescing = false): boolean {
        return !allowWhileQuiescing
            && this.lifecycleDependencies.isDaemonQuiescing?.() === true;
    }

    private teardownActiveSocket(): void {
        this.connectedClientRpcMethods.clear();
        if (!this.socket) {
            this.sessionSyncPendingInputServerContractResult = null;
            return;
        }
        this.sessionSyncPendingInputServerContractResult =
            this.sessionSyncPendingInputServerContractController.invalidate({
                sessionConnectionEpoch: this.activeTransportGeneration,
                socket: this.socket,
            });
        this.rpcHandlerManager.onSocketDisconnect();
        this.stopKeepAlive();
        this.socket = null;
    }

    private async publishMachineControlReadinessWhenReady(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
        timeoutMs: number;
    }>): Promise<Readonly<{
        ready: boolean;
        readiness: RpcHandlerRegistrationReadiness;
    }>> {
        const { socket, transportGeneration, timeoutMs } = params;
        const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
            (method) => !this.rpcHandlerManager.hasHandler(method),
        );
        if (missingCoreHandlers.length > 0) {
            return {
                ready: false,
                readiness: { status: 'disconnected', missingMethods: missingCoreHandlers },
            };
        }

        const readiness = await this.rpcHandlerManager.waitForRegisteredHandlers(
            REQUIRED_MACHINE_CONTROL_RPC_METHODS,
            { timeoutMs },
        );
        if (
            readiness.status !== 'ready'
            || this.socket !== socket
            || this.activeTransportGeneration !== transportGeneration
            || socket.connected !== true
        ) {
            return { ready: false, readiness };
        }
        if (this.machineControlRunningGeneration === transportGeneration) {
            return { ready: true, readiness };
        }
        if (this.machineControlReadinessPublication?.generation === transportGeneration) {
            const published = await this.machineControlReadinessPublication.promise;
            return { ready: published, readiness };
        }

        // A successful core registration receipt proves that the server has
        // installed its post-authentication RPC listener. Replay the manager's
        // complete current set once for this readiness publication so optional
        // registrations emitted during the admission fence are not silently
        // lost. The guards above prevent later optional acknowledgements from
        // repeatedly replaying the remaining set.
        this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();

        const promise = (async () => {
            const capabilities = this.currentMachineOperationProtocolCapabilities();
            if (
                capabilities !== null
                && this.advertisedOperationProtocolCapabilitiesGeneration !== transportGeneration
            ) {
                // A rejected publication leaves the server's projection unknown, so it is
                // deliberately not recorded as advertised and is allowed to reject this
                // whole publication: without the running mark, the next registration
                // acknowledgement re-enters here and publishes the capabilities again.
                await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
                this.advertisedOperationProtocolCapabilitiesGeneration = transportGeneration;
            }
            if (
                this.socket !== socket
                || this.activeTransportGeneration !== transportGeneration
                || socket.connected !== true
            ) {
                return false;
            }
            await this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now(),
            }));
            if (
                this.socket === socket
                && this.activeTransportGeneration === transportGeneration
                && socket.connected === true
            ) {
                this.machineControlRunningGeneration = transportGeneration;
                // Pairs with the unready warning below: an operator reading the daemon log
                // can tell a connection that recovered from one that never did.
                logger.info('[API MACHINE] Core machine-control RPC registration ready', {
                    advertisesOperationProtocolCapabilities: capabilities !== null,
                });
            }
            return true;
        })().catch((error) => {
            logger.warn('[API MACHINE] Failed to publish machine-control readiness; session spawn stays unadvertised until the next registration acknowledgement or reconnect', {
                message: error instanceof Error ? error.message : String(error),
            });
            return false;
        }).finally(() => {
            if (this.machineControlReadinessPublication?.generation === transportGeneration) {
                this.machineControlReadinessPublication = null;
            }
        });
        this.machineControlReadinessPublication = { generation: transportGeneration, promise };
        const published = await promise;
        return { ready: published, readiness };
    }

    private isCurrentConnectionState(state: ManagedConnectionState): boolean {
        return this.currentConnectionState.phase === state.phase
            && this.currentConnectionState.reason === state.reason
            && this.currentConnectionState.attempt === state.attempt
            && this.currentConnectionState.nextRetryAt === state.nextRetryAt
            && this.currentConnectionState.lastConnectedAt === state.lastConnectedAt
            && this.currentConnectionState.lastDisconnectedAt === state.lastDisconnectedAt
            && this.currentConnectionState.lastErrorMessage === state.lastErrorMessage;
    }

    private isActiveTransportGeneration(generation: number): boolean {
        return generation === this.activeTransportGeneration;
    }

    private handleTransportSocketDisconnect(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number): void {
        logger.debug('[API MACHINE] Disconnected from server');
        if (!this.isActiveTransportGeneration(generation) || this.socket !== socket) {
            return;
        }
        this.teardownActiveSocket();
    }

    private normalizeMachineScopedRpcMethod(method: string): string | null {
        const trimmed = method.trim();
        if (!trimmed) return null;
        return trimmed.includes(':') ? trimmed : `${this.machine.id}:${trimmed}`;
    }

    private normalizeConnectedClientRpcAvailabilityMethod(method: unknown): string | null {
        if (typeof method !== 'string') return null;
        const trimmed = method.trim();
        const prefix = `${this.machine.id}:`;
        if (!trimmed.startsWith(prefix)) return null;
        const unprefixedMethod = trimmed.slice(prefix.length).trim();
        if (!unprefixedMethod) return null;
        if (this.rpcHandlerManager.hasHandler(unprefixedMethod)) return null;
        return `${this.machine.id}:${unprefixedMethod}`;
    }

    constructor(
        private token: string,
        private machine: Machine,
        ownershipMetadata?: Readonly<{
            runtimeId?: string;
            cliVersion?: string;
            publicReleaseChannel?: string;
            startupSource?: string;
            serviceManaged?: boolean;
            serviceLabel?: string;
        }>,
        lifecycleDependencies?: ApiMachineClientLifecycleDependencies,
    ) {
        this.ownershipMetadata = ownershipMetadata ?? {};
        this.lifecycleDependencies = lifecycleDependencies ?? {};
        this.machineContentCodec = createMachineContentCodec(this.machine);
        this.sessionSyncPendingInputServerContractController =
            createSessionSyncPendingInputServerContractController({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            });
        const rpcTransportConfig = this.machine.encryptionMode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : {
                encryptionMode: 'e2ee' as const,
                encryptionKey: this.machine.encryptionKey,
                encryptionVariant: this.machine.encryptionVariant,
            };
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            ...rpcTransportConfig,
            authorizeRequest: authorizeMachineRpcRequest,
            projectTransportAcknowledgement: projectMachineRpcTransportAcknowledgement,
            logger: (msg, data) => logger.debug(msg, data),
            onRegistrationError: (error) => {
                const probe = classifyMachineTransportErrorToProbeResult(error);
                const supervisor = this.connectionSupervisor;
                const scope = supervisor?.captureProbeReportScope?.();
                if (probe && scope) {
                    supervisor?.reportProbeResult?.(probe, scope);
                }
            },
            onRegistrationAcknowledged: () => {
                const socket = this.socket;
                if (!socket) {
                    return;
                }
                void this.publishMachineControlReadinessWhenReady({
                    socket,
                    transportGeneration: this.activeTransportGeneration,
                    timeoutMs: 0,
                });
            },
        });
        this.actionOperationRuntime = createHostActionOperationRuntime({
            machineId: this.machine.id,
            resolveAccountId: async () => await this.getAccountId(),
            publishSnapshot: (() => {
                let pending = Promise.resolve();
                return (snapshot) => {
                    pending = pending.then(async () => {
                        const credentials = await readStoredCredentials().catch(() => null);
                        if (!credentials?.encryption) return;
                        const material = credentials.encryption.type === 'legacy'
                            ? { type: 'legacy' as const, secret: credentials.encryption.secret }
                            : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
                        const ciphertext = sealAccountScopedBlobCiphertext({
                            kind: 'action_operation_snapshot',
                            material,
                            payload: snapshot,
                            randomBytes: (length) => new Uint8Array(randomBytes(length)),
                        });
                        this.socket?.emit(ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1, {
                            v: 1,
                            machineId: this.machine.id,
                            ciphertext,
                        });
                    }).catch((error) => {
                        logger.warn('Failed to publish Action operation snapshot', { error });
                    });
                };
            })(),
            supportsCoreCancellation: (actionId, input) => {
                if (actionId !== 'session.spawn_new') return true;
                if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
                const executionTarget = (input as Readonly<Record<string, unknown>>).executionTarget;
                return Boolean(
                    executionTarget
                    && typeof executionTarget === 'object'
                    && !Array.isArray(executionTarget)
                    && (executionTarget as Readonly<Record<string, unknown>>).machineId === this.machine.id,
                );
            },
        });

        this.machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        this.filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: configuration.serverUrl,
            resolveCurrentMachineId: () => this.machine.id,
            timeoutMs: 1_500,
        });
        registerSessionHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            ...(this.lifecycleDependencies.createCapabilitiesApiClient
                ? {
                    createCapabilitiesApiClient:
                        this.lifecycleDependencies.createCapabilitiesApiClient,
                }
                : {}),
            activateCapabilitiesPurposeBindings: (input) => {
                const runtime = this.connectedAccountPurposeBindingRuntime;
                if (!runtime) {
                    throw new Error('Connected Account purpose authority is unavailable for this capability probe');
                }
                return runtime.activatePurposeBindings(input);
            },
            getAgentCatalogObservation: () => this.agentCatalogObservation
                ? { machineId: this.machine.id, service: this.agentCatalogObservation }
                : null,
            machineAdmissionTransport: async (request, options) =>
                await this.enqueueSessionPendingByMachine(request, options),
            // G-RC4: thread the live server-features snapshot into the plugin-UI-tier projection so
            // a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the daemon
            // projection (master §3.5 "server disables X → daemon refuses"). Reuses the one fetch
            // source — no fresh probe path is introduced.
            daemonPluginInvocationLogs: {
                resolveCurrentTarget: async ({ signal }) => await resolveCurrentMachineExecutionOriginContext(signal),
            },
            daemonContributionRegistryProjection: {
                observePluginExecution: this.actionOperationRuntime.observePluginExecution,
                resolveServerFeaturesSnapshot: async () => await fetchServerFeaturesSnapshot({
                    serverUrl: configuration.serverUrl,
                    timeoutMs: 1_500,
                }),
                resolvePluginProjectionExecutionOriginContext: async () =>
                    await resolveCurrentMachineExecutionOriginContext(),
                resolveMessageActionReference: async ({ reference, signal }) => {
                    const credentials = await readStoredCredentials().catch(() => null);
                    signal?.throwIfAborted();
                    if (!credentials) return { status: 'unavailable' as const };
                    return await resolveMessageActionReferenceSnapshotV1({
                        token: this.token,
                        reference,
                        ...(signal ? { signal } : {}),
                        readCurrentMessage: async ({ reference, durableMessage, signal: rowSignal }) =>
                            await readCurrentMessageActionReferenceRowV1({
                                credentials,
                                token: this.token,
                                reference,
                                durableMessage,
                                ...(rowSignal ? { signal: rowSignal } : {}),
                            }),
                    });
                },
                requestCurrentIntent: async (request) => {
                    const credentials = await readStoredCredentials().catch(() => null);
                    if (!credentials) {
                        return {
                            status: 'unavailable' as const,
                            code: 'plugin_action_current_intent_unavailable',
                        };
                    }
                    return await createCredentialedTargetActionCurrentIntent(credentials)(request);
                },
                resolveConnectedAccountPurposeBindingRuntime: () => (
                    this.connectedAccountPurposeBindingRuntime
                ),
            },
        });
        registerAutomationReplyHandoffRpcHandler(this.rpcHandlerManager, {
            machineId: this.machine.id,
            resolveAccountId: async (signal) => await this.getAccountId(signal),
            resolveInstallationId: () =>
                readInstallationIdentityIfExistsSync()?.installationId ?? null,
            resolveAccountEncryptionCurrentness: async (signal) =>
                await fetchAccountEncryptionCurrentness({
                    token: this.token,
                    ...(signal ? { signal } : {}),
                }),
            resolveAccountEncryptionMaterial: async (signal) => {
                const credentials = await readStoredCredentials().catch(() => null);
                signal?.throwIfAborted();
                if (!credentials || credentials.token !== this.token || !credentials.encryption) {
                    return null;
                }
                try {
                    return credentials.encryption.type === 'legacy'
                        ? createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'legacy',
                                secret: credentials.encryption.secret,
                            },
                        })
                        : createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'dataKey',
                                machineKey: credentials.encryption.machineKey,
                            },
                            dataKeyPublicKey: credentials.encryption.publicKey,
                        });
                } catch {
                    return null;
                }
            },
        });
        const composerMediaStageStore = createActiveDaemonComposerMediaStageStore({
            machineId: this.machine.id,
        });
        const fileSystemHandlers = registerFileSystemHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedReadFiles: () => this.transientSessionMediaReadAllowance.readAllowedReadFiles(),
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
            composerMediaStage: {
                executionTarget: {
                    serverId: configuration.activeServerId,
                    machineId: this.machine.id,
                },
                store: composerMediaStageStore,
            },
        });
        this.fileSystemTransferRelayOwner = {
            store: fileSystemHandlers.transferSessionStore,
            lifecycle: createTransferSessionLifecycle({
                store: fileSystemHandlers.transferSessionStore,
                chunkSizeBytes: configuration.filesTransferChunkBytes,
            }),
        };
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceAnchorHandlers(this.rpcHandlerManager, {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(this.rpcHandlerManager, {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerMachineConnectedAccountRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            machineId: this.machine.id,
            getRuntime: () => this.connectedAccountDaemonRuntime,
        });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
        });
    }

    setRPCHandlers({
        spawnSession,
        sessionSpawnV1OutcomeRequired,
        resolveSpawnSessionByNonce,
        stopSession,
        isSessionActive,
        loadLocalSessionMetadata,
        savePreparedTargetLocalMetadata,
        requestShutdown,
        memory,
        daemonServerWorkScheduler,
        voiceInference,
        machineTransferChannel,
        transferRelayV2Channel,
        directPeerTransfer,
        directTransferImport,
        directTransferExport,
    }: MachineRpcHandlers, deps?: Omit<MachineRpcHandlerDeps, 'externalAction'> & Readonly<{
        externalActionIngressOwner?: ExternalActionIngressOwner;
    }>): MachineRpcLifecycleRegistration {
        this.sessionSpawnV1OutcomeRequired = sessionSpawnV1OutcomeRequired === true;
        this.agentCatalogObservation = deps?.agentCatalogObservation ?? null;
        const machineRpcLifecycleRegistration = registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                ...(sessionSpawnV1OutcomeRequired === true
                    ? { sessionSpawnV1OutcomeRequired: true }
                    : {}),
                ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                ...(loadLocalSessionMetadata ? { loadLocalSessionMetadata } : {}),
                ...(savePreparedTargetLocalMetadata ? { savePreparedTargetLocalMetadata } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(daemonServerWorkScheduler ? { daemonServerWorkScheduler } : {}),
                ...(voiceInference ? { voiceInference } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(transferRelayV2Channel ? { transferRelayV2Channel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
                ...(directTransferImport ? { directTransferImport } : {}),
                ...(directTransferExport ? { directTransferExport } : {}),
            },
            deps: {
                ...deps,
                ...(deps?.externalActionIngressOwner
                    ? {
                        externalAction: {
                            ...deps.externalActionIngressOwner,
                            machineId: this.machine.id,
                            resolveAccountId: async (signal) => await this.getAccountId(signal),
                        },
                    }
                    : {}),
                actionOperations: {
                    handlers: this.actionOperationRuntime.handlers,
                    observeExecution: this.actionOperationRuntime.observeExecution,
                },
                sessionHandoffCoordinator: createTrackedSessionHandoffCoordinator({
                    readCredentials: async () => await readStoredCredentials().catch(() => null),
                    callMachine: async (input) => input.machineId === this.machine.id
                        ? await this.rpcHandlerManager.invokeLocal(
                            input.method,
                            input.request,
                            input.signal ? { signal: input.signal } : undefined,
                        )
                        : await callMachineRpc(input),
                }),
                ...(this.lifecycleDependencies.createCapabilitiesApiClient
                    ? {
                        createCapabilitiesApiClient:
                            this.lifecycleDependencies.createCapabilitiesApiClient,
                    }
                    : {}),
                sessionServerStart: {
                    machineId: this.machine.id,
                    token: this.token,
                    readCredentials: async () => await readStoredCredentials().catch(() => null),
                    resolveAccountId: async (signal) => await this.getAccountId(signal),
                    resolveInstallationId: () =>
                        readInstallationIdentityIfExistsSync()?.installationId ?? null,
                    resolveAccountEncryptionCurrentness: async (signal) =>
                        await fetchAccountEncryptionCurrentness({
                            token: this.token,
                            ...(signal ? { signal } : {}),
                        }),
                    machineAdmissionTransport: async (request, options) =>
                        await this.enqueueSessionPendingByMachine(request, options),
                },
                externalSessionStatusDemandChannel: this,
                subscribeSessionArchivedStateChanges:
                    deps?.subscribeSessionArchivedStateChanges
                    ?? ((listener) => this.onUpdate((update) => {
                        const body = update.body;
                        if (
                            body.t !== 'update-session'
                            || body.archivedAt === undefined
                        ) {
                            return false;
                        }
                        void Promise.resolve(listener({
                            sessionId: body.id,
                            archived: body.archivedAt !== null,
                        })).catch((error) => {
                            logger.warn(
                                '[API MACHINE] Session archive-state listener failed',
                                {
                                    sessionId: body.id,
                                    archived: body.archivedAt !== null,
                                    message: error instanceof Error
                                        ? error.message
                                        : String(error),
                                },
                            );
                        });
                        return true;
                    })),
                subscribeSessionDeletedChanges: (listener) =>
                    this.onSessionDeletedChange(listener),
                workingDirectory: deps?.workingDirectory ?? this.machineRpcWorkingDirectory,
                filesystemAccessPolicy: deps?.filesystemAccessPolicy ?? this.filesystemAccessPolicy,
                getAdditionalAllowedWriteDirs: deps?.getAdditionalAllowedWriteDirs ?? (() => this.additionalAllowedWriteDirs),
                transientMediaReadAllowance: deps?.transientMediaReadAllowance ?? this.transientSessionMediaReadAllowance,
                extraTransferRelayV2DownloadOwners: [
                    this.fileSystemTransferRelayOwner,
                    ...(deps?.extraTransferRelayV2DownloadOwners ?? []),
                ],
            },
        });
        this.rpcLifecycleRegistrations.push(machineRpcLifecycleRegistration);
        return machineRpcLifecycleRegistration;
    }

    getPeerMediationMachineRpcHandlerManager(): RpcHandlerInvoker {
        return {
            invokeLocal: async (method, params, options) => await this.rpcHandlerManager.invokeLocal(
                method,
                params,
                options?.signal ? { signal: options.signal } : undefined,
            ),
        };
    }

    registerLocalServicesPreviewRoutes(localServicesPreview: LocalServicePreviewRoutes): void {
        registerDaemonLocalServicePreviewSnapshotHandler(this.rpcHandlerManager, {
            localServicesPreview,
        });
    }

    registerLocalServicesRoutes(localServices: DaemonLocalServicesMachineRpcRoutes): void {
        registerDaemonLocalServicesMachineRpcHandlers(this.rpcHandlerManager, localServices);
    }

    registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void {
        this.connectedAccountDaemonRuntime = runtime;
    }

    registerConnectedAccountPurposeBindingRuntime(runtime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    >): void {
        this.connectedAccountPurposeBindingRuntime = runtime;
    }

    registerBrowserControlRoutes(browserControl: BrowserDaemonControlRoutes): void {
        registerDaemonBrowserControlHandler(this.rpcHandlerManager, {
            browserControl,
        });
    }

    registerBrowserContextRoutes(browserContext: BrowserContextRoutes): void {
        registerDaemonBrowserContextHandler(this.rpcHandlerManager, {
            browserContext,
        });
    }

    registerBrowserDiagnosticsRoutes(browserDiagnostics: BrowserDiagnosticsRoutes): void {
        registerDaemonBrowserDiagnosticsSnapshotHandler(this.rpcHandlerManager, {
            browserDiagnostics,
        });
    }

    registerBrowserRecordingRoutes(browserRecording: BrowserRecordingRoutes): void {
        registerDaemonBrowserRecordingHandlers(this.rpcHandlerManager, {
            browserRecording,
        });
    }

    registerSimulatorPreviewRoutes(simulatorPreview: SimulatorPreviewRoutes): void {
        registerDaemonSimulatorPreviewHandlers(this.rpcHandlerManager, {
            simulatorPreview,
        });
    }

    registerLiveStreamRelayRoutes(relay: DaemonLiveStreamRelayRoutes): void {
        registerDaemonLiveStreamRelayHandlers(this.rpcHandlerManager, {
            relay,
        });
    }

    onUpdate(listener: (update: Update) => boolean | void): () => void {
        this.updateListeners.add(listener);
        return () => {
            this.updateListeners.delete(listener);
        };
    }

    onAccountSettingsVersionHint(listener: (hint: AccountSettingsVersionHintNotification) => void | Promise<void>): () => void {
        this.accountSettingsVersionHintListeners.add(listener);
        return () => {
            this.accountSettingsVersionHintListeners.delete(listener);
        };
    }

    onPendingSessionActivationHint(
        listener: (hint: PendingSessionActivationHintNotification) => void | Promise<void>,
    ): () => void {
        this.pendingSessionActivationHintListeners.add(listener);
        return () => {
            this.pendingSessionActivationHintListeners.delete(listener);
        };
    }

    onSessionDeletedChange(
        listener: (
            change: SessionDeletedChangeNotification,
        ) => void | Promise<void>,
    ): () => void {
        this.sessionDeletedChangeListeners.add(listener);
        return () => {
            this.sessionDeletedChangeListeners.delete(listener);
        };
    }

    getSessionSyncPendingInputServerContractResult():
        SessionSyncPendingInputServerContractResult | null {
        const result = this.sessionSyncPendingInputServerContractResult;
        return (
            result
            && result.sessionConnectionEpoch === this.activeTransportGeneration
            && result.socket === this.socket
            && result.socket.connected === true
        )
            ? result
            : null;
    }

    private async notifyPendingSessionActivationHint(
        hint: PendingSessionActivationHintNotification,
    ): Promise<void> {
        for (const listener of this.pendingSessionActivationHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Pending session activation listener failed; Pending custody retained', {
                    sessionId: hint.sessionId,
                    requestId: hint.requestId,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async notifySessionDeletedChange(
        change: SessionDeletedChangeNotification,
    ): Promise<void> {
        for (const listener of this.sessionDeletedChangeListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onConnectedServicesProjection(
        listener: (notification: ConnectedServicesProjectionNotification) => void | Promise<void>,
    ): () => void {
        if (this.connectedServicesProjectionListener) {
            throw new Error('Connected-services projection reconciliation already has an owner');
        }
        this.connectedServicesProjectionListener = listener;
        return () => {
            if (this.connectedServicesProjectionListener === listener) {
                this.connectedServicesProjectionListener = null;
            }
        };
    }

    private async reconcileConnectedServicesProjection(
        notification: Omit<
            ConnectedServicesProjectionNotification,
            | 'signal'
            | 'connectedServicesV2'
            | 'connectedServiceCredentialRevisionsV1'
        >,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        if (!this.connectedServicesProjectionListener) {
            throw new Error('connected_services_projection_reconciler_unavailable');
        }
        const profile = await fetchAccountProfile({ token: this.token, signal });
        signal.throwIfAborted();
        try {
            await this.connectedServicesProjectionListener({
                ...notification,
                signal,
                connectedServicesV2: profile.connectedServicesV2,
                connectedServiceCredentialRevisionsV1: profile.connectedServiceCredentialRevisionsV1,
            });
        } catch (error) {
            if (!isConnectedServiceGenerationReconciliationNotAcknowledgeableError(error)) throw error;
            logger.debug('[API MACHINE] Connected-services generation reconciliation awaits another domain event', {
                source: notification.source,
            });
        }
        signal.throwIfAborted();
    }

    private async notifyAccountSettingsVersionHint(hint: AccountSettingsVersionHintNotification): Promise<void> {
        for (const listener of this.accountSettingsVersionHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Account settings version hint listener failed; continuing changes catch-up', {
                    settingsVersion: hint.settingsVersion,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    onMachineTransferEnvelope(listener: (payload: MachineTransferReceiveEnvelope) => void): () => void {
        this.machineTransferListeners.add(listener);
        return () => {
            this.machineTransferListeners.delete(listener);
        };
    }

    onTransferRelayV2Envelope(listener: (payload: TransferRelayV2SendEnvelope) => void): () => void {
        this.transferRelayV2Listeners.add(listener);
        return () => {
            this.transferRelayV2Listeners.delete(listener);
        };
    }

    onPeerTcpTunnelRelayEnvelope(listener: (payload: PeerTcpTunnelRelayEnvelope) => void): () => void {
        this.peerTcpTunnelRelayListeners.add(listener);
        return () => {
            this.peerTcpTunnelRelayListeners.delete(listener);
        };
    }

    onMachineLiveStreamRelayEnvelope(listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void): () => void {
        this.machineLiveStreamRelayListeners.add(listener);
        return () => {
            this.machineLiveStreamRelayListeners.delete(listener);
        };
    }

    onExternalSessionStatusDemand(
        listener: (payload: ExternalSessionStatusDemandDaemonMessageV1) => void,
    ): () => void {
        this.externalSessionStatusDemandListeners.add(listener);
        return () => {
            this.externalSessionStatusDemandListeners.delete(listener);
        };
    }

    onConnectionStateChange(listener: (state: ManagedConnectionState) => void): () => void {
        this.connectionStateListeners.add(listener);
        listener(this.currentConnectionState);
        return () => {
            this.connectionStateListeners.delete(listener);
        };
    }

    /**
     * Whether this daemon can currently serve the machine-control RPCs the server dispatches
     * to it: an active transport whose registration reached the readiness publication.
     *
     * This is the only fact that separated a working daemon from the 56-minute pid-26058
     * outage — the process, its heartbeat, its control-server ping and its socket were all
     * healthy while every machine RPC was unreachable. It is read by the heartbeat so
     * `happier daemon status` and `happier doctor` can report it instead of a PID probe.
     */
    isMachineControlRegistrationReady(): boolean {
        return this.socket !== null
            && this.machineControlRunningGeneration === this.activeTransportGeneration;
    }

    sendMachineTransferEnvelope(payload: MachineTransferSendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, payload);
    }

    hasConnectedClientRpcHandler(method: string): boolean {
        const normalized = this.normalizeMachineScopedRpcMethod(method);
        return normalized ? this.connectedClientRpcMethods.has(normalized) : false;
    }

    sendTransferRelayV2Envelope(payload: TransferRelayV2SendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
    }

    sendPeerTcpTunnelRelayEnvelope(payload: PeerTcpTunnelRelayEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
    }

    sendMachineLiveStreamRelayEnvelope(payload: MachineLiveStreamRelayEnvelopeV1): void {
        if (!this.socket) return;
        this.socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, payload);
    }

    emitExternalSessionTranscriptUpdate(payload: ExternalSessionTranscriptInvalidationV1): void {
        if (!this.socket) return;
        this.socket.emit('external-session-transcript-invalidated', payload);
    }

    async executeExternalSessionHistoricalImportCommand(
        command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> {
        if (!this.socket) {
            return {
                v: 1,
                kind: 'error',
                errorCode: 'internal_error',
                message: 'Machine socket is unavailable.',
            };
        }
        const socket = this.socket;
        const timeoutMs = resolveSessionControlSocketAckTimeoutMs();
        return await new Promise<ExternalSessionOperationSocketResponseV1>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('External session historical import command timed out.'));
            }, timeoutMs);
            socket.emit(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, command, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
    }

    /**
     * Reverse (daemon -> connected client/UI) RPC call over the persistent machine socket (W2C-BA-1).
     *
     * The spawned cli daemon runs in a SEPARATE OS process and cannot drive client-owned surfaces
     * (e.g. the desktop Wry WebView) directly. This emits a machine-scoped `rpc-call` for
     * `<machineId>:<method>` exactly the way the client emits forward machine RPC, so the server
     * routes it to whichever connected client socket (the desktop UI) registered the method. Params +
     * result use the Machine's canonical content mode. Fails closed
     * (never throws) when the socket is down, the call times out, or no client is registered, so the
     * caller stays fail-safe.
     */
    async callConnectedClientRpc<TResult = unknown>(
        method: string,
        params: unknown,
        options?: Readonly<{ timeoutMs?: number }>,
    ): Promise<Readonly<{ ok: true; result: TResult }> | Readonly<{ ok: false; error?: string; errorCode?: string }>> {
        const socket = this.socket;
        if (!socket) {
            return { ok: false, errorCode: 'machine_socket_unavailable' };
        }
        await this.requirePlainMachineCompatibility();
        const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
        const encodedParams = this.machineContentCodec.encodeRpc(params);
        const response = await new Promise<SocketRpcCallResponse>((resolve) => {
            let settled = false;
            const settle = (value: SocketRpcCallResponse) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => settle({ ok: false, error: 'RPC call timeout' }), timeoutMs);
            try {
                socket.emit(
                    SOCKET_RPC_EVENTS.CALL,
                    { method: `${this.machine.id}:${method}`, params: encodedParams, timeoutMs },
                    (value: SocketRpcCallResponse) => settle(value),
                );
            } catch (error) {
                settle({ ok: false, error: error instanceof Error ? error.message : 'RPC call failed' });
            }
        });

        if (!response.ok) {
            return {
                ok: false,
                ...(response.error !== undefined ? { error: response.error } : {}),
                ...(response.errorCode !== undefined ? { errorCode: response.errorCode } : {}),
            };
        }
        if (socket.connected === false) {
            return { ok: false, errorCode: 'machine_socket_unavailable' };
        }

        try {
            return {
                ok: true,
                result: this.machineContentCodec.decodeRpc(response.result) as TResult,
            };
        } catch {
            return { ok: false, errorCode: 'machine_rpc_result_decrypt_failed' };
        }
    }

    private dispatchUpdate(update: Update): boolean {
        let handled = false;
        for (const listener of this.updateListeners) {
            try {
                if (listener(update) === true) {
                    handled = true;
                }
            } catch (error) {
                logger.warn('[API MACHINE] Update listener threw (ignored)', {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return handled;
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async captureMachineSessionTerminal(
        sessionId: string,
    ): Promise<MachineSessionTerminalCaptureResponseV1> {
        if (!this.socket) {
            return { v: 1, status: 'rejected', sessionId, reason: 'unsupported' };
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
            payload: { v: 1, sessionId },
        });
        return MachineSessionTerminalCaptureResponseV1Schema.parse(raw);
    }

    async finalizeMachineSessionTerminal(
        target: Readonly<{ sessionId: string; authority: MachineSessionTerminalAuthorityV1 }>,
    ): Promise<MachineSessionTerminalFinalizeResponseV1> {
        if (!this.socket) {
            return {
                v: 1,
                status: 'rejected',
                sessionId: target.sessionId,
                reason: 'unsupported',
            };
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
            payload: {
                v: 1,
                sessionId: target.sessionId,
                authority: target.authority,
            },
        });
        return MachineSessionTerminalFinalizeResponseV1Schema.parse(raw);
    }

    /**
     * Publishes one complete, content-free exact-target capability projection.
     * A successful response is the server-assigned monotonic projection revision.
     */
    async publishOperationProtocolCapabilities(
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const socket = this.socket;
        if (!socket) {
            throw new Error('Machine socket is not connected');
        }
        return await this.publishOperationProtocolCapabilitiesOnSocket(
            socket,
            capabilities,
        );
    }

    async enqueueSessionPendingByMachine(
        request: SessionPendingEnqueueByMachineRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<SessionInputAdmissionResultV1> {
        if (options?.signal?.aborted) {
            return { status: 'rejected', code: 'session_input_cancelled' };
        }
        const socket = this.socket;
        if (!socket) {
            return {
                status: 'rejected',
                code: 'session_input_target_unavailable',
            };
        }
        const payload = SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
        try {
            const raw = await emitSocketWithAck({
                socket,
                event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                payload,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const parsed = SessionPendingEnqueueByMachineResponseV1Schema.safeParse(raw);
            return parsed.success
                ? parsed.data.result
                : {
                    status: 'outcomeUnknown',
                    localId: request.localId,
                    code: 'machine_admission_response_invalid',
                };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { status: 'rejected', code: 'session_input_target_unavailable' };
            }
            const code = error instanceof SocketAckAbortError
                ? 'machine_admission_cancelled_after_emit'
                : error instanceof SocketAckError && error.code === 'socket_ack_timeout'
                    ? 'machine_socket_ack_timeout'
                    : 'machine_socket_disconnected';
            return { status: 'outcomeUnknown', localId: request.localId, code };
        }
    }

    /**
     * Session-owned Automation ingress. The daemon sends only the frozen Run
     * correspondence and opaque plain V2 request to its authenticated server;
     * the server rederives authority and chooses direct/local versus exact
     * cross-machine dispatch. Automation never receives that routing choice.
     */
    async dispatchSessionServerStart(
        request: SessionServerStartIngressRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<SessionServerStartDispatchResultV1> {
        if (options?.signal?.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        const socket = this.socket;
        if (!socket) {
            return { type: 'error', code: 'machine_offline', retryable: true };
        }
        const payload = SessionServerStartIngressRequestV1Schema.safeParse(request);
        if (!payload.success) {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }

        try {
            const raw = await emitSocketWithAck({
                socket,
                event: SESSION_SERVER_START_INGRESS_EVENT_V1,
                payload: payload.data,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const response = SessionServerStartIngressResponseV1Schema.safeParse(raw);
            if (!response.success) {
                // The server may have already submitted the effect, so only the
                // canonical creation key can resolve a malformed acknowledgement.
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            if (response.data.kind === 'result') return response.data.result;

            const local = await this.rpcHandlerManager.invokeLocal(
                SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
                response.data.dispatch,
                options?.signal ? { signal: options.signal } : undefined,
            );
            const result = SessionServerStartDispatchResultV1Schema.safeParse(local);
            return result.success
                ? result.data
                : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { type: 'error', code: 'machine_offline', retryable: true };
            }
            // A socket acknowledgement can be lost after the server receives
            // the ingress. Retrying the same immutable Session creation key is
            // the sole rejoin path; do not fabricate a local fallback.
            if (error instanceof SocketAckAbortError || error instanceof SocketAckError) {
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            return options?.signal?.aborted
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { type: 'error', code: 'spawn_failed', retryable: true };
        }
    }

    private async publishOperationProtocolCapabilitiesOnSocket(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse({
            machineId: this.machine.id,
            capabilities,
        });
        const raw = await emitSocketWithAck({
            socket,
            event: MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
            payload: request,
        });
        const response = MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(raw);
        if (response.result !== 'success') {
            throw new Error(`Machine operation protocol capability update failed: ${response.code}`);
        }
        return response.revision;
    }

    private currentMachineOperationProtocolCapabilities(): MachineOperationProtocolCapabilitiesV1 | null {
        return this.sessionSpawnV1OutcomeRequired
            ? CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1
            : null;
    }

    async updateMachineMetadata(
        handler: (metadata: MachineMetadata | null) => MachineMetadata,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication()) {
            return 'suppressed';
        }
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication()) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.metadata);

            // No-op: don't write if nothing changed.
            if (this.machine.metadata && JSON.stringify(updated) === JSON.stringify(this.machine.metadata)) {
                return 'unchanged';
            }
            await this.requirePlainMachineCompatibility();

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-metadata',
                payload: {
                    machineId: this.machine.id,
                    metadata: this.machineContentCodec.encodeStored(updated),
                    expectedVersion: this.machine.metadataVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.metadata = this.machineContentCodec.decodeStored(answer.metadata) as MachineMetadata;
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = this.machineContentCodec.decodeStored(answer.metadata) as MachineMetadata;
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine metadata update acknowledgement');
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(
        handler: (state: DaemonState | null) => DaemonState,
        options?: ApiMachineDaemonStatePublicationOptions,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
            return 'suppressed';
        }
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.daemonState);
            await this.requirePlainMachineCompatibility();

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-state',
                payload: {
                    machineId: this.machine.id,
                    daemonState: this.machineContentCodec.encodeStored(updated),
                    expectedVersion: this.machine.daemonStateVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.daemonState = this.machineContentCodec.decodeStored(answer.daemonState) as DaemonState;
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = this.machineContentCodec.decodeStored(answer.daemonState) as DaemonState;
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine daemon-state update acknowledgement');
        });
    }

    private getDaemonTerminalSessionMutationOutbox(
        sessionId: string,
        isShuttingDown: (() => boolean) | undefined = this.lifecycleDependencies.isDaemonQuiescing,
    ): DaemonSessionClientDurableMutationOutbox {
        const existing = this.daemonTerminalSessionMutationOutboxes.get(sessionId);
        if (existing) return existing;

        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: this.token,
            sessionId,
            getSocket: () => null,
            requestReconnect: () => undefined,
            ...(isShuttingDown ? { isShuttingDown } : {}),
        });
        this.daemonTerminalSessionMutationOutboxes.set(sessionId, outbox);
        return outbox;
    }

    async enqueueDaemonTerminalExactTurnEnd(mutation: ExactSessionTurnEndMutationV1): Promise<void> {
        await this.getDaemonTerminalSessionMutationOutbox(mutation.sessionId).enqueueExactTurnEnd(mutation);
    }

    async recoverDaemonTerminalSessionMutationJournals(params: Readonly<{
        bindUsageLimitRecoveryJournals: (sessionIds: readonly string[]) => Promise<Readonly<{
            boundSessionIds: readonly string[];
            retainedSessionIds: readonly string[];
        }>>;
        isShuttingDown?: () => boolean;
    }>): Promise<Readonly<{ recoveredSessionIds: readonly string[]; retainedSessionIds: readonly string[] }>> {
        const recoveredSessionIds: string[] = [];
        let retainedSessionIds: readonly string[] = [];
        const isShuttingDown = (): boolean => params.isShuttingDown?.() === true;
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const sessionIds = await discoverDaemonSessionClientDurableMutationJournalSessionIds(
            configuration.activeServerDir,
        );
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const usageBindings = await params.bindUsageLimitRecoveryJournals(sessionIds);
        retainedSessionIds = usageBindings.retainedSessionIds;
        for (const sessionId of sessionIds) {
            if (isShuttingDown()) break;
            const outbox = this.getDaemonTerminalSessionMutationOutbox(sessionId, isShuttingDown);
            if (isShuttingDown()) break;
            await outbox.awaitReady();
            if (isShuttingDown()) break;
            await outbox.flush('startup');
            recoveredSessionIds.push(sessionId);
        }
        return {
            recoveredSessionIds,
            retainedSessionIds,
        };
    }

    connect(params?: {
        takeover?: boolean;
        onConnect?: () => void | Promise<void>;
        onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
        onMachineReplaced?: (event: { machineId: string }) => void;
    }) {
        const serverUrl = resolveServerHttpBaseUrl();
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                classifyTransportErrorToProbeResult: classifyMachineTransportErrorToProbeResult,
                createTransport: () => {
                    const transportGeneration = this.activeTransportGeneration + 1;
                    this.activeTransportGeneration = transportGeneration;
                    const installationIdentity = configuration.installationIdentityFile
                        ? readInstallationIdentityIfExistsSync()
                        : null;
                    const installationProof = installationIdentity
                        ? buildInstallationProofForMachine({
                            identity: installationIdentity,
                            machineId: this.machine.id,
                            token: this.token,
                        })
                        : null;
                    const { socket, transport } = createMachineSocketTransport({
                        serverUrl,
                        token: this.token,
                        machineId: this.machine.id,
                        ...(installationProof
                            ? {
                                installationId: installationProof.installationId,
                                installationPublicKey: installationProof.installationPublicKey,
                                installationProof: installationProof.installationProof,
                            }
                            : null),
                        ...this.ownershipMetadata,
                        takeover: takeoverOnNextConnect,
                        transports: configuration.socketIoTransports,
                        env: process.env,
                    });
                    this.connectedClientRpcMethods.clear();
                    this.socket = socket;
                    this.installSocketEventHandlers(
                        socket,
                        transportGeneration,
                        params,
                    );
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket, transportGeneration);
                    });
                    return transport;
                },
                probeReadiness: createLoopbackReadinessProbe({
                    serverUrl,
                    token: this.token,
                }),
                onStateChange: (state) => {
                    this.currentConnectionState = state;
                    for (const listener of this.connectionStateListeners) {
                        listener(state);
                    }
                },
                onConnected: async () => {
                    logger.debug('[API MACHINE] Connected to server');
                    const isReconnect = this.hasConnectedOnce;
                    this.hasConnectedOnce = true;
                    takeoverOnNextConnect = false;

                    const socket = this.socket;
                    const transportGeneration =
                        this.activeTransportGeneration;
                    const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
                        (method) => !this.rpcHandlerManager.hasHandler(method),
                    );
                    if (socket) {
                        this.rpcHandlerManager.onSocketConnect(socket);
                        // A persisted projection replaces rather than merges, so publishing an
                        // empty one withdraws sessionSpawn until something republishes it.
                        // Publish it only when it is true of this daemon — the exact-target
                        // handlers are absent, or the creation-outcome attestation is missing —
                        // which is the server's fail-closed input. Otherwise leave the server's
                        // projection alone and let the readiness publication below assert the
                        // real capabilities: a daemon that holds the capability must never
                        // advertise itself as capability-less, because every path that would
                        // undo that can fail.
                        if (
                            missingCoreHandlers.length > 0
                            || this.currentMachineOperationProtocolCapabilities() === null
                        ) {
                            await this
                                .publishOperationProtocolCapabilitiesOnSocket(socket, {})
                                .catch(() => {
                                    logger.warn('[API MACHINE] Failed to publish the fail-closed operation protocol capability projection on connect');
                                });
                        }
                        const contractResult =
                            await this
                                .sessionSyncPendingInputServerContractController
                                .resolve({
                                    sessionConnectionEpoch:
                                        transportGeneration,
                                    socket,
                                    machineId: this.machine.id,
                                });
                        if (
                            this.socket === socket
                            && this.activeTransportGeneration
                                === transportGeneration
                            && socket.connected === true
                        ) {
                            this.sessionSyncPendingInputServerContractResult =
                                contractResult;
                        }
                    }

                    if (missingCoreHandlers.length > 0) {
                        logger.warn('[API MACHINE] Core machine-control RPC handlers are not installed', {
                            missingMethods: missingCoreHandlers,
                        });
                    } else if (socket) {
                        // Deliberately not awaited. The deadline below bounds how long this
                        // attempt watches for the server's registration acknowledgements before
                        // reporting them as outstanding; it is not a functional cutoff, because
                        // every later acknowledgement re-enters the same publication. Awaiting
                        // it here would only delay keep-alive and changes sync by the deadline.
                        void (async () => {
                            let registrationResult =
                                await this.publishMachineControlReadinessWhenReady({
                                    socket,
                                    transportGeneration,
                                    timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                });
                            const isCurrentTransport = () => (
                                this.socket === socket
                                && this.activeTransportGeneration === transportGeneration
                                && socket.connected === true
                            );
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();
                                registrationResult =
                                    await this.publishMachineControlReadinessWhenReady({
                                        socket,
                                        transportGeneration,
                                        timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                    });
                            }
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                logger.warn('[API MACHINE] Core machine-control RPC registration did not become ready', {
                                    status: registrationResult.readiness.status,
                                    missingMethods: registrationResult.readiness.missingMethods,
                                });
                            }
                        })().catch((error) => {
                            logger.warn('[API MACHINE] Machine-control readiness publication failed', {
                                message: error instanceof Error ? error.message : String(error),
                            });
                        });
                    }

                    this.startChangesSyncWithRetry({ reason: isReconnect ? 'reconnect' : 'connect' });
                    this.startKeepAlive();

                    if (params?.onConnect) {
                        await Promise.resolve(params.onConnect()).catch(() => {});
                    }
                },
                onDisconnected: async () => {
                    // The transport socket that actually disconnected owns teardown via its
                    // socket-scoped disconnect handler. This avoids stale callbacks from an
                    // older transport clearing a newer active socket.
                },
                onAuthFailed: async (ctx) => {
                    logger.debug('[API MACHINE] Auth failed');
                    if (!this.isCurrentConnectionState(ctx.state)) {
                        return;
                    }
                    this.teardownActiveSocket();
                },
            });
        }

        void this.connectionSupervisor.start().catch((error) => {
            logger.warn('[API MACHINE] Failed to start machine connection supervisor', {
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    private installSocketEventHandlers(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
        params?: {
            takeover?: boolean;
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: (event: { machineId: string }) => void;
        },
    ) {
        socket.on('connect_error', (error: unknown) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const ownershipConflict = readMachineOwnerConflictFromSocketError(error);
            if (!ownershipConflict) {
                const diagnostic = readSocketConnectErrorDiagnostic(error);
                logger.warn('[API MACHINE] Machine socket connect error', diagnostic);
                if (isMachineReplacedSocketError(error)) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.({ machineId: this.machine.id });
                }
                return;
            }
            void this.connectionSupervisor?.stop().catch(() => {});
            params?.onOwnershipConflict?.(ownershipConflict);
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            const isCurrentTransport = () => (
                this.isActiveTransportGeneration(transportGeneration)
                && socket === this.socket
            );
            if (!isCurrentTransport()) {
                return;
            }
            logger.debugLargeJson(
                `[API MACHINE] Received RPC request:`,
                projectIncomingMachineRpcDebugPayload(data),
            );
            try {
                await this.requirePlainMachineCompatibility();
                if (!isCurrentTransport()) {
                    return;
                }
                const response = await this.rpcHandlerManager.handleRequest(data);
                if (!isCurrentTransport()) {
                    return;
                }
                callback(response);
            } catch (error) {
                if (!isCurrentTransport()) {
                    return;
                }
                callback({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Machine RPC is unavailable',
                    errorCode: (
                        error
                        && typeof error === 'object'
                        && typeof (error as { code?: unknown }).code === 'string'
                    )
                        ? (error as { code: string }).code
                        : 'client-upgrade-required',
                    retryable: false,
                });
            }
        });

        socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            if (method) {
                this.connectedClientRpcMethods.add(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.UNREGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            if (method) {
                this.connectedClientRpcMethods.delete(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, (data: MachineTransferReceiveEnvelope) => {
            for (const listener of this.machineTransferListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine transfer listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, (data: TransferRelayV2SendEnvelope) => {
            for (const listener of this.transferRelayV2Listeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Transfer relay v2 listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (data: PeerTcpTunnelRelayEnvelope) => {
            for (const listener of this.peerTcpTunnelRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Peer TCP tunnel relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, (data: MachineLiveStreamRelayEnvelopeV1) => {
            for (const listener of this.machineLiveStreamRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine live-stream relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(
            EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
            (data: ExternalSessionStatusDemandDaemonMessageV1) => {
                if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                    return;
                }
                for (const listener of this.externalSessionStatusDemandListeners) {
                    try {
                        listener(data);
                    } catch (error) {
                        logger.warn('[API MACHINE] External-session status-demand listener threw (ignored)', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            },
        );

        socket.on('update', (data: Update) => {
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = this.machineContentCodec.decodeStored(update.metadata.value) as MachineMetadata;
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = this.machineContentCodec.decodeStored(update.daemonState.value) as DaemonState;
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
                return;
            }

            const handled = this.dispatchUpdate(data);
            if (data.body.t === 'pending-changed') {
                const requestId = typeof data.body.pendingActivationRequestId === 'string'
                    ? data.body.pendingActivationRequestId.trim()
                    : '';
                const sessionId = typeof data.body.sessionId === 'string'
                    ? data.body.sessionId.trim()
                    : data.body.sid.trim();
                if (requestId && sessionId) {
                    void this.notifyPendingSessionActivationHint({
                        sessionId,
                        requestId,
                        pendingVersion: data.body.pendingVersion,
                        source: 'live',
                    });
                }
            }
            if (
                data.body.t === 'account-change'
                || (
                    data.body.t === 'update-account'
                    && 'connectedServices' in data.body
                    && data.body.connectedServices !== undefined
                )
            ) {
                this.startChangesSyncWithRetry({ reason: 'live' });
            }
            if (!handled && process.env.DEBUG) {
                logger.debug(`[API MACHINE] Ignored update type: ${(data.body as any).t}`);
            }
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            if (!this.socket) {
                return;
            }
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    async shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        // Socket reconnects retain this Account scope; process-terminal
        // shutdown is the canonical point that retires its Collection cursor
        // retention and active local observers.
        retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKeyForToken(this.token));
        this.projectionSchedulingClosed = true;
        this.activeTransportGeneration += 1;
        this.teardownActiveSocket();
        this.connectedServicesProjectionRetry.close();
        if (this.connectionSupervisor) {
            await this.connectionSupervisor.stop();
        }
        await this.connectedServicesProjectionRetry.waitForIdle();
        await this.rpcHandlerManager.waitForIdle();
        await this.disposeRpcLifecycleRegistrations();
        await this.fileSystemTransferRelayOwner.store.dispose();
        const daemonTerminalOutboxes = Array.from(this.daemonTerminalSessionMutationOutboxes.values());
        this.daemonTerminalSessionMutationOutboxes.clear();
        await Promise.all(daemonTerminalOutboxes.map(async (outbox) => {
            try {
                await outbox.close();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to close session-end mutation outbox', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    private async disposeRpcLifecycleRegistrations(): Promise<void> {
        const registrations = this.rpcLifecycleRegistrations.splice(0);
        await Promise.all(registrations.map(async (registration) => {
            try {
                await registration.dispose();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to dispose RPC lifecycle registration', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    async awaitPendingRpcRequests(): Promise<void> {
        await this.rpcHandlerManager.waitForIdle();
    }

    getActiveRpcHandlerExecutions(): readonly RpcHandlerActiveExecution[] {
        return this.rpcHandlerManager.getActiveHandlerExecutions();
    }

    /**
     * Resolves one exact Session access fact through the incumbent Account
     * change carrier. The returned cursor is admission evidence only: this
     * method never persists or acknowledges it as consumed feed progress.
     */
    async resolvePluginResourceSessionAccess(params: Readonly<{
        accountId: string;
        sessionId: string;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        accountId: string;
        throughCursor: number;
        status: 'available' | 'unavailable';
    }>> {
        params.signal.throwIfAborted();
        const accountId = await this.getAccountId(params.signal);
        params.signal.throwIfAborted();
        if (!accountId || accountId !== params.accountId) {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const result = await fetchChanges({
            token: this.token,
            after: 0,
            limit: 1,
            sessionAccessSessionId: params.sessionId,
            signal: params.signal,
        });
        params.signal.throwIfAborted();
        if (result.status !== 'ok') {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const probe = result.response.sessionAccessProbe;
        if (!probe || probe.sessionId !== params.sessionId) {
            // Supported older servers omit the additive exact proof. The
            // affected Session-scoped operation fails closed without changing
            // global Account Resources or the ordinary change cursor.
            throw new Error('plugin_resource_session_access_unavailable');
        }
        return Object.freeze({
            accountId,
            throughCursor: probe.throughCursor,
            status: probe.status,
        });
    }

    private async getAccountId(signal?: AbortSignal): Promise<string | null> {
        if (this.accountIdPromise) {
            return await this.accountIdPromise.catch((error) => {
                if (isAuthenticationError(error)) {
                    if (this.connectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            });
        }

        const request = () => fetchChangesAccountId({ token: this.token, ...(signal ? { signal } : {}) });
        const supervisor = this.connectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async refreshMachineFromServer(signal?: AbortSignal): Promise<void> {
        try {
            const serverUrl = resolveServerHttpBaseUrl();
            const request = async () => {
                const response = await axios.get(`${serverUrl}/v1/machines/${this.machine.id}`, {
                    headers: {
                        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15_000,
                    ...(signal ? { signal } : {}),
                    validateStatus: () => true,
                });
                if (isAuthenticationStatus(response.status)) {
                    throw createAuthenticationHttpStatusError(
                        response.status,
                        `Authentication failed while refreshing machine snapshot (${response.status})`,
                    );
                }
                return response;
            };
            const response = this.connectionSupervisor
                ? await runSupervisedRequest({
                    supervisor: this.connectionSupervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                    readStatusCode: (result) => result.status,
                })
                : await request();

            if (response.status !== 200) {
                return;
            }

            const raw = (response.data as any)?.machine;
            if (!raw || typeof raw !== 'object') {
                return;
            }

            const nextMetadata =
                typeof raw.metadata === 'string'
                    ? this.machineContentCodec.decodeStored(raw.metadata) as MachineMetadata
                    : null;
            const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : this.machine.metadataVersion;

            const nextDaemonState =
                typeof raw.daemonState === 'string'
                    ? this.machineContentCodec.decodeStored(raw.daemonState) as DaemonState
                    : null;
            const nextDaemonStateVersion = typeof raw.daemonStateVersion === 'number' ? raw.daemonStateVersion : this.machine.daemonStateVersion;

            if (nextMetadataVersion > this.machine.metadataVersion) {
                this.machine.metadata = nextMetadata;
                this.machine.metadataVersion = nextMetadataVersion;
            }
            if (nextDaemonStateVersion > this.machine.daemonStateVersion) {
                this.machine.daemonState = nextDaemonState;
                this.machine.daemonStateVersion = nextDaemonStateVersion;
            }
        } catch (error) {
            logger.debug('[API MACHINE] Failed to refresh machine snapshot', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    /** The Account-change carrier is the only source of Session access proof. */
    private applyResourceSessionAccessWitness(
        params: Parameters<PluginReloadController['applyResourceSessionAccessWitness']>[0],
    ): void {
        const lifecycle = this.lifecycleDependencies.resourceSessionLifecycle
            ?? pluginReloadController;
        lifecycle.applyResourceSessionAccessWitness(params);
    }

    private async syncChangesOnConnect(
        opts: { reason: 'connect' | 'reconnect' | 'live' },
        signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
        // Startup/reconnect recover the full projection; live wakes classify the changes page first.
        const executionAuthority = opts.reason === 'live'
            ? 'runtime_recovery' as const
            : 'passive_projection' as const;
        signal.throwIfAborted();
        if (opts.reason !== 'live') {
            try {
                await this.reconcileConnectedServicesProjection({
                    source: opts.reason === 'connect' ? 'startup' : 'reconnect',
                    executionAuthority,
                }, signal);
            } catch (error) {
                if (handleRequestAuthenticationFailure({
                    supervisor: this.connectionSupervisor,
                    error,
                    hadAuth: true,
                })) {
                    return;
                }
                throw error;
            }
        }

        const enabled = (() => {
            const raw = process.env.HAPPY_ENABLE_V2_CHANGES;
            if (!raw) return true;
            return ['true', '1', 'yes'].includes(raw.toLowerCase());
        })();
        if (!enabled) {
            return;
        }

        signal.throwIfAborted();
        const accountId = await this.getAccountId(signal);
        signal.throwIfAborted();
        if (!accountId) throw new Error('account_changes_account_id_unavailable');
        const accountScopeKey = resolveAccountSettingsScopeKeyForToken(this.token);

        const CHANGES_PAGE_LIMIT = 200;
        const after = await readAccountChangesCursor(accountId);
        const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT, signal });
        signal.throwIfAborted();

        if (result.status === 'cursor-gone') {
            this.applyResourceSessionAccessWitness({ accountId });
            signal.throwIfAborted();
            await this.refreshMachineFromServer(signal);
            signal.throwIfAborted();
            await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
            signal.throwIfAborted();
            publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                kind: 'reset',
                changeCursor: result.currentCursor,
            });
            await this.reconcileConnectedServicesProjection({ source: 'cursor-gone', executionAuthority }, signal);
            signal.throwIfAborted();
            await writeAccountChangesCursor(accountId, result.currentCursor);
            signal.throwIfAborted();
            return;
        }
        if (result.status !== 'ok') {
            if (handleRequestAuthenticationFailure({
                supervisor: this.connectionSupervisor,
                error: result.error,
                hadAuth: true,
            })) {
                return;
            }

            // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
            // On reconnect, fall back to a snapshot refresh.
            const changesEndpointUnavailable = asRecord(result.error)?.status === 404;
            if (changesEndpointUnavailable) {
                this.applyResourceSessionAccessWitness({ accountId });
                signal.throwIfAborted();
            }
            if (opts.reason === 'reconnect' || opts.reason === 'live') {
                await this.refreshMachineFromServer(signal);
            }
            if (changesEndpointUnavailable) return;

            // A snapshot does not acknowledge a transient changes-feed failure.
            // Let the canonical retry owner retain and retry the current work.
            throw result.error;
        }

        const changes = result.response.changes;
        const nextCursor = result.response.nextCursor;
        this.applyResourceSessionAccessWitness({
            accountId,
            ...(result.response.sessionAccessWitness === undefined
                ? {}
                : { witness: result.response.sessionAccessWitness }),
        });
        signal.throwIfAborted();
        const pluginAccountSettingsInvalidations = readPluginAccountSettingsWatchInvalidations(changes);
        const pluginAccountCollectionInvalidations = readPluginAccountCollectionWatchInvalidations(changes);

        const hasRelevantMachineChange = changes.some(
            (c) => c.kind === 'machine' && c.entityId === this.machine.id,
        );
        const accountSettingsVersions = changes
            .filter((c) => c.kind === 'account' && c.entityId === 'self')
            .map((c) => readAccountSettingsVersionFromHint(c.hint))
            .filter((version): version is number => version !== null);
        const highestAccountSettingsVersion = accountSettingsVersions.length > 0
            ? Math.max(...accountSettingsVersions)
            : null;
        const hasConnectedServicesChange = changes.some((change) => {
            if (change.kind !== 'account' || change.entityId !== 'self') return false;
            const hint = change.hint;
            return hint !== null
                && typeof hint === 'object'
                && !Array.isArray(hint)
                && (hint as { connectedServices?: unknown }).connectedServices === true;
        });
        const pendingActivationHints = changes.flatMap((change): PendingSessionActivationHintNotification[] => {
            if (change.kind !== 'session') return [];
            const hint = asRecord(change.hint);
            if (!hint) return [];
            const requestId = typeof hint.pendingActivationRequestId === 'string'
                ? hint.pendingActivationRequestId.trim()
                : '';
            const sessionId = change.entityId.trim();
            const pendingVersion = hint.pendingVersion;
            if (
                !requestId
                || !sessionId
                || typeof pendingVersion !== 'number'
                || !Number.isSafeInteger(pendingVersion)
                || pendingVersion < 0
            ) return [];
            return [{ sessionId, requestId, pendingVersion, source: 'changes' }];
        });
        const deletedSessionChangeNotifications = changes.flatMap((change) => {
            const deletion = readAuthoritativeSessionDeletionChangeV1(change);
            if (!deletion) return [];
            // A durable Session-deletion fact is delivered only by the
            // authenticated Account whose changes feed produced it. Pin that
            // Account's operation scope onto the notification so cleanup
            // targets exactly the partition owning the deleted Session's
            // operation records, even if the ambient credentials rotate
            // before the listener runs. Fail closed when the delivering
            // Account cannot be established: the cursor stays untouched and
            // the fact replays.
            const accountScope = resolveExternalSessionOperationAccountScope(
                configuration.activeServerDir,
                this.token,
            );
            if (!accountScope) {
                throw new Error('account_changes_account_scope_unavailable');
            }
            return [{ ...deletion, accountScope }];
        });

        if (changes.length >= CHANGES_PAGE_LIMIT || hasRelevantMachineChange) {
            await this.refreshMachineFromServer(signal);
            signal.throwIfAborted();
        }
        if (highestAccountSettingsVersion !== null) {
            await this.notifyAccountSettingsVersionHint({
                settingsVersion: highestAccountSettingsVersion,
                source: 'changes',
            });
        } else if (changes.length >= CHANGES_PAGE_LIMIT) {
            await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'page-limit' });
        }
        if (changes.length >= CHANGES_PAGE_LIMIT) {
            publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
            publishPluginAccountCollectionWatchInvalidation({
                accountScopeKey,
                kind: 'reset',
                changeCursor: nextCursor,
            });
        } else {
            for (const invalidation of pluginAccountSettingsInvalidations) {
                publishPluginAccountSettingsWatchInvalidation(invalidation);
            }
            for (const invalidation of pluginAccountCollectionInvalidations) {
                publishPluginAccountCollectionWatchInvalidation({
                    ...invalidation,
                    accountScopeKey,
                });
            }
        }
        signal.throwIfAborted();

        if (hasConnectedServicesChange || changes.length >= CHANGES_PAGE_LIMIT) {
            await this.reconcileConnectedServicesProjection({
                source: hasConnectedServicesChange ? 'changes' : 'page-limit',
                executionAuthority,
            }, signal);
        }
        for (const activationHint of pendingActivationHints) {
            signal.throwIfAborted();
            await this.notifyPendingSessionActivationHint(activationHint);
        }
        for (const deletion of deletedSessionChangeNotifications) {
            signal.throwIfAborted();
            // Cleanup is part of consuming this durable deletion fact. A
            // listener failure leaves the Account cursor untouched so the
            // incumbent changes retry owner replays the exact same deletion.
            await this.notifySessionDeletedChange(deletion);
        }

        signal.throwIfAborted();
        await writeAccountChangesCursor(accountId, nextCursor);
        signal.throwIfAborted();
    }

    private startChangesSyncWithRetry(opts: { reason: 'connect' | 'reconnect' | 'live' }): void {
        if (this.projectionSchedulingClosed) return;
        this.connectedServicesProjectionRetry.schedule(async (signal) => {
            try {
                await this.syncChangesOnConnect(opts, signal);
            } catch (error) {
                if (!signal.aborted) {
                    logger.warn('[API MACHINE] /v2/changes sync failed; retry scheduled', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
                throw error;
            }
        }, { runImmediately: true });
    }
}
