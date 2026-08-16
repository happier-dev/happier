/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { registerWorkspaceAnchorHandlers } from '@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers';
import { registerWorkspaceFaviconHandlers } from '@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ScmConnectedAccountCredentialResolver } from '@/scm/types';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServices/connectedServicesProjectionRetryScheduler';
import { isConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { RpcHandlerManager, type RpcHandlerRegistrationReadiness } from './rpc/RpcHandlerManager';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    type DirectSessionTranscriptDeltaEphemeral,
    type MachineTransferReceiveEnvelope,
    type MachineTransferSendEnvelope,
    type ConnectedServiceExecutionAuthorityV1,
    type ExactSessionTurnEndMutationV1,
} from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { readAccountChangesCursor, writeAccountChangesCursor } from '@/persistence';
import { createAuthenticationHttpStatusError, isAuthenticationError, isAuthenticationStatus } from './client/httpStatusError';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { emitSocketWithAck, type EmitWithAckSocket } from '@/session/transport/shared/socketAck';
import type { SessionMutationSocket } from './session/mutations/createSessionMutationOutbox';
import {
    createDaemonTerminalSessionMutationJournal,
    createDaemonTerminalSessionMutationOutbox,
    type DaemonTerminalSessionMutationOutbox,
} from './session/mutations/daemonTerminalSessionMutationOutbox';
import { recoverDaemonTerminalSessionMutationJournals } from './session/mutations/daemonTerminalSessionMutationDiscovery';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { authorizeMachineRpcRequest } from './machine/machineRpcAuthorization';
import { projectMachineRpcTransportAcknowledgement } from './machine/projectMachineRpcTransportAcknowledgement';
import { registerMachineRpcHandlers, type MachineRpcHandlerDeps, type MachineRpcHandlers } from './machine/rpcHandlers';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
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
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { fetchAccountProfile } from '@/api/accountProfile';
import type { RpcHandlerActiveExecution } from '@/api/rpc/types';

export type ApiMachineClientDeps = Readonly<{
    connectedAccounts?: ScmConnectedAccountCredentialResolver;
}>;

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

export type ConnectedServicesProjectionChangeSource =
    | 'startup'
    | 'reconnect'
    | 'changes'
    | 'cursor-gone'
    | 'page-limit'
    | 'live';

export type ConnectedServicesProjectionChangeNotification = Readonly<{
    source: ConnectedServicesProjectionChangeSource;
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
    signal: AbortSignal;
    connectedServicesV2: unknown | null;
    connectedServiceCredentialRevisionsV1: unknown | null;
}>;

type RpcLifecycleRegistration = Readonly<{
    dispose: () => Promise<void>;
}>;

const REQUIRED_MACHINE_CONTROL_RPC_METHODS = Object.freeze([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
    RPC_METHODS.STOP_SESSION,
]);
const MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

function readSocketConnectErrorDiagnostic(error: unknown): Record<string, unknown> {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const details: Record<string, unknown> = {
        message: error instanceof Error ? error.message : typeof record?.message === 'string' ? record.message : String(error),
    };

    if (typeof record?.name === 'string' && record.name.trim().length > 0) {
        details.name = record.name;
    }
    if (typeof record?.code === 'string' && record.code.trim().length > 0) {
        details.code = record.code;
    }

    const statusCode = typeof record?.statusCode === 'number'
        ? record.statusCode
        : typeof data?.statusCode === 'number'
            ? data.statusCode
            : null;
    if (statusCode !== null) {
        details.statusCode = statusCode;
    }

    return details;
}

function isMachineReplacedSocketError(error: unknown, diagnostic: Record<string, unknown>): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = data?.error ?? record?.message;
    return diagnostic.statusCode === 410 && errorCode === 'machine-replaced';
}

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private readonly connectedServicesProjectionRetry = createConnectedServicesProjectionRetryScheduler();
    private projectionSchedulingClosed = false;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private accountSettingsVersionHintListeners = new Set<(hint: AccountSettingsVersionHintNotification) => void | Promise<void>>();
    private pendingSessionActivationHintListeners = new Set<(
        hint: PendingSessionActivationHintNotification,
    ) => void | Promise<void>>();
    private connectedServicesProjectionChangeListeners = new Set<(
        notification: ConnectedServicesProjectionChangeNotification,
    ) => void | Promise<void>>();
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private daemonTerminalSessionMutationOutboxes = new Map<string, DaemonTerminalSessionMutationOutbox>();
    private readonly rpcLifecycleRegistrations: RpcLifecycleRegistration[] = [];
    private readonly machineRpcWorkingDirectory: string;
    private readonly filesystemAccessPolicy: FilesystemAccessPolicy;
    private readonly ownershipMetadata: Readonly<{
        runtimeId?: string;
        cliVersion?: string;
        publicReleaseChannel?: string;
        startupSource?: string;
        serviceManaged?: boolean;
        serviceLabel?: string;
    }>;
    private activeTransportGeneration = 0;
    private machineControlRunningGeneration: number | null = null;
    private machineControlReadinessPublication: Readonly<{
        generation: number;
        promise: Promise<boolean>;
    }> | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private teardownActiveSocket(): void {
        if (!this.socket) {
            return;
        }
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

    private async publishMachineControlRunningWhenReady(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
        timeoutMs: number;
    }>): Promise<Readonly<{
        ready: boolean;
        readiness: RpcHandlerRegistrationReadiness;
    }>> {
        const { socket, transportGeneration, timeoutMs } = params;
        const unregisteredCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
            (method) => !this.rpcHandlerManager.hasHandler(method),
        );
        if (unregisteredCoreHandlers.length > 0) {
            return {
                ready: false,
                readiness: { status: 'disconnected', missingMethods: unregisteredCoreHandlers },
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

        const promise = this.updateDaemonState((state) => ({
            ...state,
            status: 'running',
            pid: process.pid,
            httpPort: this.machine.daemonState?.httpPort,
            startedAt: Date.now(),
        })).then(() => {
            if (
                this.socket === socket
                && this.activeTransportGeneration === transportGeneration
                && socket.connected === true
            ) {
                this.machineControlRunningGeneration = transportGeneration;
            }
            return true;
        }).catch((error) => {
            logger.warn('[API MACHINE] Failed to update daemon state after machine-control readiness', {
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
        deps?: ApiMachineClientDeps,
    ) {
        this.ownershipMetadata = ownershipMetadata ?? {};
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data),
            onRegistrationError: (error) => {
                const probe = classifyMachineTransportErrorToProbeResult(error);
                if (probe) {
                    this.connectionSupervisor?.reportProbeResult?.(probe);
                }
            },
            onRegistrationAcknowledged: () => {
                const socket = this.socket;
                if (!socket) {
                    return;
                }
                void this.publishMachineControlRunningWhenReady({
                    socket,
                    transportGeneration: this.activeTransportGeneration,
                    timeoutMs: 0,
                });
            },
            authorizeRequest: authorizeMachineRpcRequest,
            projectTransportAcknowledgement: projectMachineRpcTransportAcknowledgement,
        });

        const machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        const filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        this.machineRpcWorkingDirectory = machineRpcWorkingDirectory;
        this.filesystemAccessPolicy = filesystemAccessPolicy;
        let additionalAllowedReadDirs: string[] = [];
        let additionalAllowedWriteDirs: string[] = [];
        this.rpcLifecycleRegistrations.push(registerSessionHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            setAdditionalAllowedReadDirs: (dirs) => {
                additionalAllowedReadDirs = dirs;
            },
            setAdditionalAllowedWriteDirs: (dirs) => {
                additionalAllowedWriteDirs = dirs;
            },
        }));
        this.rpcLifecycleRegistrations.push(registerFileSystemHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => additionalAllowedReadDirs,
            getAdditionalAllowedWriteDirs: () => additionalAllowedWriteDirs,
        }));
        registerWorkspaceAnchorHandlers(this.rpcHandlerManager, {
            defaultDirectory: machineRpcWorkingDirectory,
            accessPolicy: filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(this.rpcHandlerManager, {
            defaultDirectory: machineRpcWorkingDirectory,
            accessPolicy: filesystemAccessPolicy,
        });
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            accessPolicy: filesystemAccessPolicy,
        });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            accessPolicy: filesystemAccessPolicy,
            connectedAccounts: deps?.connectedAccounts,
        });
    }

    setRPCHandlers({
        spawnSession,
        spawnSessionForHandoff,
        resolveSpawnSessionByNonce,
        stopSession,
        isSessionActive,
        loadLocalSessionMetadata,
        requestShutdown,
        memory,
        daemonServerWorkScheduler,
        machineTransferChannel,
        directPeerTransfer,
    }: MachineRpcHandlers, deps?: MachineRpcHandlerDeps) {
        const machineRpcLifecycleRegistration = registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                ...(spawnSessionForHandoff ? { spawnSessionForHandoff } : {}),
                ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                ...(loadLocalSessionMetadata ? { loadLocalSessionMetadata } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(daemonServerWorkScheduler ? { daemonServerWorkScheduler } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
            },
            deps: {
                ...deps,
                machineRpcWorkingDirectory: this.machineRpcWorkingDirectory,
                filesystemAccessPolicy: this.filesystemAccessPolicy,
                emitDirectSessionTranscriptUpdate:
                    deps?.emitDirectSessionTranscriptUpdate
                    ?? ((payload) => this.emitDirectSessionTranscriptUpdate(payload)),
            },
        });
        this.rpcLifecycleRegistrations.push(machineRpcLifecycleRegistration);
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

    onConnectedServicesProjectionChange(listener: (
        notification: ConnectedServicesProjectionChangeNotification,
    ) => void | Promise<void>): () => void {
        this.connectedServicesProjectionChangeListeners.add(listener);
        return () => {
            this.connectedServicesProjectionChangeListeners.delete(listener);
        };
    }

    private async notifyConnectedServicesProjectionChange(
        notification: ConnectedServicesProjectionChangeNotification,
    ): Promise<void> {
        notification.signal.throwIfAborted();
        const resolvedNotification = notification.connectedServicesV2 !== null
            && notification.connectedServiceCredentialRevisionsV1 !== null
            ? notification
            : await (async (): Promise<ConnectedServicesProjectionChangeNotification> => {
                const profile = await fetchAccountProfile({ token: this.token, signal: notification.signal });
                notification.signal.throwIfAborted();
                return {
                    ...notification,
                    connectedServicesV2: profile.connectedServicesV2,
                    connectedServiceCredentialRevisionsV1: profile.connectedServiceCredentialRevisionsV1,
                };
            })();
        for (const listener of this.connectedServicesProjectionChangeListeners) {
            try {
                await Promise.resolve(listener(resolvedNotification));
            } catch (error) {
                if (!isConnectedServiceGenerationReconciliationNotAcknowledgeableError(error)) {
                    throw error;
                }
                logger.debug('[API MACHINE] Connected-services generation reconciliation awaits another domain event', {
                    source: notification.source,
                });
            }
            notification.signal.throwIfAborted();
        }
    }

    onMachineTransferEnvelope(listener: (payload: MachineTransferReceiveEnvelope) => void): () => void {
        this.machineTransferListeners.add(listener);
        return () => {
            this.machineTransferListeners.delete(listener);
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

    emitDirectSessionTranscriptUpdate(payload: DirectSessionTranscriptDeltaEphemeral): void {
        if (!this.socket) return;
        this.socket.emit('direct-session-transcript-delta', payload);
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
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const updated = handler(this.machine.metadata);

            // No-op: don't write if nothing changed.
            if (this.machine.metadata && JSON.stringify(updated) === JSON.stringify(this.machine.metadata)) {
                return;
            }

            const answer = await emitSocketWithAck<any>({
                socket: this.socket as any,
                event: 'machine-update-metadata',
                payload: {
                    machineId: this.machine.id,
                    metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                    expectedVersion: this.machine.metadataVersion
                },
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
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
                    expectedVersion: this.machine.daemonStateVersion
                },
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    private createSessionEndMutationSocket(): SessionMutationSocket {
        return {
            connected: this.socket?.connected === true,
            emit: () => {},
            emitWithAck: async () => {
                throw new Error('Machine session-end mutation outbox does not support ack-based events');
            },
        };
    }

    private getDaemonTerminalSessionMutationOutbox(sessionId: string): DaemonTerminalSessionMutationOutbox {
        const existing = this.daemonTerminalSessionMutationOutboxes.get(sessionId);
        if (existing) return existing;

        const outbox = createDaemonTerminalSessionMutationOutbox({
            token: this.token,
            sessionId,
            getSocket: () => this.createSessionEndMutationSocket(),
            requestReconnect: () => {},
        });
        this.daemonTerminalSessionMutationOutboxes.set(sessionId, outbox);
        return outbox;
    }

    async enqueueDaemonTerminalExactTurnEnd(mutation: ExactSessionTurnEndMutationV1): Promise<void> {
        await this.getDaemonTerminalSessionMutationOutbox(mutation.sessionId).enqueueExactTurnEnd(mutation);
    }

    async recoverDaemonTerminalSessionMutationJournals(): Promise<void> {
        const recoveredHandles = new Map<string, DaemonTerminalSessionMutationOutbox>();
        try {
            await recoverDaemonTerminalSessionMutationJournals({
                activeServerDir: configuration.activeServerDir,
                openHandle: (request) => {
                    const existing = this.daemonTerminalSessionMutationOutboxes.get(request.sessionId);
                    if (existing) return existing;
                    const alreadyRecovered = recoveredHandles.get(request.sessionId);
                    if (alreadyRecovered) return alreadyRecovered;
                    const handle = createDaemonTerminalSessionMutationJournal({
                        token: this.token,
                        sessionId: request.sessionId,
                        paths: request.paths,
                        getSocket: () => this.createSessionEndMutationSocket(),
                        requestReconnect: () => {},
                    });
                    recoveredHandles.set(request.sessionId, handle);
                    this.daemonTerminalSessionMutationOutboxes.set(request.sessionId, handle);
                    return handle;
                },
            });
        } catch (error) {
            for (const [sessionId, handle] of recoveredHandles) {
                if (this.daemonTerminalSessionMutationOutboxes.get(sessionId) === handle) {
                    this.daemonTerminalSessionMutationOutboxes.delete(sessionId);
                }
            }
            throw error;
        }
    }

    connect(params?: {
        takeover?: boolean;
        onConnect?: () => void | Promise<void>;
        onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
        onMachineReplaced?: () => void;
    }) {
        logger.debug(`[API MACHINE] Connecting to ${resolveServerHttpBaseUrl()}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                classifyTransportErrorToProbeResult: classifyMachineTransportErrorToProbeResult,
                createTransport: () => {
                    const serverUrl = resolveServerHttpBaseUrl();
                    const transportGeneration = this.activeTransportGeneration + 1;
                    this.activeTransportGeneration = transportGeneration;
                    const installationIdentity = readInstallationIdentityIfExistsSync();
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
                    this.socket = socket;
                    this.installSocketEventHandlers(socket, transportGeneration, params);
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket, transportGeneration);
                    });
                    return transport;
                },
                probeReadiness: async () => await createLoopbackReadinessProbe({
                    serverUrl: resolveServerHttpBaseUrl(),
                    token: this.token,
                })(),
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
                    const transportGeneration = this.activeTransportGeneration;
                    let controlReady = false;
                    if (socket) {
                        this.rpcHandlerManager.onSocketConnect(socket);
                        const unregisteredCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
                            (method) => !this.rpcHandlerManager.hasHandler(method),
                        );
                        if (unregisteredCoreHandlers.length > 0) {
                            logger.warn('[API MACHINE] Required machine-control handlers are not installed; daemon remains offline', {
                                missingMethods: unregisteredCoreHandlers,
                            });
                        } else {
                            const registrationResult = await this.publishMachineControlRunningWhenReady({
                                socket,
                                transportGeneration,
                                timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                            });
                            controlReady = registrationResult.ready;
                            if (registrationResult.readiness.status !== 'ready') {
                                logger.warn('[API MACHINE] Machine-control registration did not become ready; daemon remains offline', {
                                    status: registrationResult.readiness.status,
                                    missingMethods: registrationResult.readiness.missingMethods,
                                });
                            }
                        }
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
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: () => void;
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
                if (isMachineReplacedSocketError(error, diagnostic)) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.();
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

            if (data.body.t === 'update-account' && 'connectedServicesV2' in data.body) {
                this.startChangesSyncWithRetry({ reason: 'live' });
            }

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

            const handled = this.dispatchUpdate(data);
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
        const outboxes = Array.from(this.daemonTerminalSessionMutationOutboxes.values());
        this.daemonTerminalSessionMutationOutboxes.clear();
        await Promise.all(outboxes.map(async (outbox) => {
            try {
                await outbox.close();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to close daemon terminal mutation outbox', {
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
        opts: { reason: 'connect' | 'reconnect' | 'live' },
        signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
        // A live account update is a committed runtime/user action. Preserve that authority so
        // every live group-bound runtime consumes the generation. Startup and reconnect catch-up
        // stay passive and cannot manufacture a restart, continuation, or provider input.
        const executionAuthority = opts.reason === 'live'
            ? 'runtime_recovery' as const
            : 'passive_projection' as const;
        signal.throwIfAborted();
        try {
            await this.notifyConnectedServicesProjectionChange({
                source: opts.reason === 'connect'
                    ? 'startup'
                    : opts.reason === 'live'
                        ? 'live'
                        : 'reconnect',
                executionAuthority,
                signal,
                connectedServicesV2: null,
                connectedServiceCredentialRevisionsV1: null,
            });
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

        await (async () => {
            signal.throwIfAborted();
            const accountId = await this.getAccountId(signal);
            signal.throwIfAborted();
            if (!accountId) throw new Error('account_changes_account_id_unavailable');

            const CHANGES_PAGE_LIMIT = 200;
            const after = await readAccountChangesCursor(accountId);
            const result = await fetchChanges({
                token: this.token,
                after,
                limit: CHANGES_PAGE_LIMIT,
                clientKind: 'daemon',
                signal,
            });
            signal.throwIfAborted();

            if (result.status === 'cursor-gone') {
                await this.refreshMachineFromServer(signal);
                signal.throwIfAborted();
                await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
                signal.throwIfAborted();
                await this.notifyConnectedServicesProjectionChange({
                    source: 'cursor-gone',
                    executionAuthority,
                    signal,
                    connectedServicesV2: null,
                    connectedServiceCredentialRevisionsV1: null,
                });
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
                if (opts.reason === 'reconnect' || opts.reason === 'live') {
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
                const hint = asRecord(change.hint);
                return hint?.connectedServices === true;
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
                await this.notifyConnectedServicesProjectionChange({
                    source: hasConnectedServicesChange ? 'changes' : 'page-limit',
                    executionAuthority,
                    signal,
                    connectedServicesV2: null,
                    connectedServiceCredentialRevisionsV1: null,
                });
            }
            for (const activationHint of pendingActivationHints) {
                signal.throwIfAborted();
                await this.notifyPendingSessionActivationHint(activationHint);
            }

            signal.throwIfAborted();
            await writeAccountChangesCursor(accountId, nextCursor);
            signal.throwIfAborted();
        })();
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
