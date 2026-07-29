/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import type { ConnectedServiceExecutionAuthorityV1 } from '@happier-dev/protocol';
import { fetchAccountProfile } from './accountProfile';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import type { SocketRpcCallResponse } from './types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
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
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServices/connectedServicesProjectionRetryScheduler';
import { isConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import type { RpcHandlerInvoker } from './rpc/types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
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

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import {
    registerMachineRpcHandlers,
    type MachineRpcHandlerDeps,
    type MachineRpcHandlers,
    type MachineRpcLifecycleRegistration,
} from './machine/rpcHandlers';
import {
    registerMachineConnectedAccountRpcHandlers,
} from './machine/rpcHandlers.connectedAccounts';
import { authorizeMachineRpcRequest } from './machine/machineRpcAuthorization';
import { projectMachineRpcTransportAcknowledgement } from './machine/projectMachineRpcTransportAcknowledgement';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
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
import { readCliClientUpgradeRequired } from '@/api/clientCompatibility/cliClientCompatibility';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
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
    MachineSessionTerminalCaptureResponseV1Schema,
    MachineSessionTerminalFinalizeResponseV1Schema,
    type MachineSessionTerminalCaptureResponseV1,
    type MachineSessionTerminalFinalizeResponseV1,
} from '@happier-dev/protocol';

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

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

export type ConnectedServicesProjectionNotification = Readonly<{
    source: AccountSettingsVersionHintSource | 'startup' | 'reconnect' | 'live';
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
    signal: AbortSignal;
    connectedServicesV2: unknown;
    connectedServiceCredentialRevisionsV1: unknown;
}>;

export type ApiMachineClientLifecycleDependencies = Readonly<{
    isDaemonQuiescing?: () => boolean;
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
    if (!readCliClientUpgradeRequired(error)) {
        return null;
    }
    return {
        status: 'auth_failed',
        statusCode: 426,
        errorMessage: 'This Happier daemon must be upgraded before it can sync sessions.',
    };
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
    private activeTransportGeneration = 0;
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
        this.sessionSyncPendingInputServerContractController =
            createSessionSyncPendingInputServerContractController({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            });
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
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
        });

        this.machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        this.filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        registerSessionHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            // G-RC4: thread the live server-features snapshot into the plugin-UI-tier projection so
            // a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the daemon
            // projection (master §3.5 "server disables X → daemon refuses"). Reuses the one fetch
            // source — no fresh probe path is introduced.
            daemonContributionRegistryProjection: {
                resolveServerFeaturesSnapshot: async () => await fetchServerFeaturesSnapshot({
                    serverUrl: configuration.serverUrl,
                    timeoutMs: 1_500,
                }),
            },
        });
        const fileSystemHandlers = registerFileSystemHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedReadFiles: () => this.transientSessionMediaReadAllowance.readAllowedReadFiles(),
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
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
    }: MachineRpcHandlers, deps?: MachineRpcHandlerDeps): MachineRpcLifecycleRegistration {
        const machineRpcLifecycleRegistration = registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
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
            invokeLocal: async (method, params) => await this.rpcHandlerManager.invokeLocal(method, params),
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
            'signal' | 'connectedServicesV2' | 'connectedServiceCredentialRevisionsV1'
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
     * result ride the machine data key — machine RPC is always e2ee (no plaintext mode). Fails closed
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
        const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
        const encryptedParams = encodeBase64(
            encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, params),
        );
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
                    { method: `${this.machine.id}:${method}`, params: encryptedParams, timeoutMs },
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

        const encryptedResult = typeof response.result === 'string' ? response.result.trim() : '';
        if (!encryptedResult) {
            return { ok: true, result: null as TResult };
        }
        try {
            const decrypted = decrypt(
                this.machine.encryptionKey,
                this.machine.encryptionVariant,
                decodeBase64(encryptedResult),
            ) as TResult;
            return { ok: true, result: decrypted };
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
        target: Readonly<{ sessionId: string; committedFenceMs: number }>,
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
                committedFenceMs: target.committedFenceMs,
            },
        });
        return MachineSessionTerminalFinalizeResponseV1Schema.parse(raw);
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

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-metadata',
                payload: {
                    machineId: this.machine.id,
                    metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                    expectedVersion: this.machine.metadataVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
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

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-state',
                payload: {
                    machineId: this.machine.id,
                    daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                    expectedVersion: this.machine.daemonStateVersion,
                },
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
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
                    if (socket) {
                        this.rpcHandlerManager.onSocketConnect(socket);
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

                    void this.updateDaemonState((state) => ({
                        ...state,
                        status: 'running',
                        pid: process.pid,
                        httpPort: this.machine.daemonState?.httpPort,
                        startedAt: Date.now()
                    })).catch((error) => {
                        logger.warn('[API MACHINE] Failed to update daemon state on connect', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });

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
            logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data);
            callback(await this.rpcHandlerManager.handleRequest(data));
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
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
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
                data.body.t === 'update-account'
                && 'connectedServices' in data.body
                && data.body.connectedServices !== undefined
            ) {
                this.startChangesSyncWithRetry({ reason: 'reconnect' });
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
                    ? decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(raw.metadata))
                    : null;
            const nextMetadataVersion = typeof raw.metadataVersion === 'number' ? raw.metadataVersion : this.machine.metadataVersion;

            const nextDaemonState =
                typeof raw.daemonState === 'string'
                    ? decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(raw.daemonState))
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

    private async syncChangesOnConnect(
        opts: { reason: 'connect' | 'reconnect' },
        signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
        const executionAuthority = 'passive_projection' as const;
        signal.throwIfAborted();
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

        const CHANGES_PAGE_LIMIT = 200;
        const after = await readAccountChangesCursor(accountId);
        const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT, signal });
        signal.throwIfAborted();

        if (result.status === 'cursor-gone') {
            await this.refreshMachineFromServer(signal);
            signal.throwIfAborted();
            await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
            signal.throwIfAborted();
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
            if (opts.reason === 'reconnect') {
                await this.refreshMachineFromServer(signal);
            }
            return;
        }

        const changes = result.response.changes;
        const nextCursor = result.response.nextCursor;

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

        signal.throwIfAborted();
        await writeAccountChangesCursor(accountId, nextCursor);
        signal.throwIfAborted();
    }

    private startChangesSyncWithRetry(opts: { reason: 'connect' | 'reconnect' }): void {
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
