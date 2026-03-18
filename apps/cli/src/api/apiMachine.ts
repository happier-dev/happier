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
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { backoff } from '@/utils/time';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { MachineTransferReceiveEnvelope, MachineTransferSendEnvelope } from '@happier-dev/protocol';
import { fetchChanges } from './changes';
import { readLastChangesCursor, writeLastChangesCursor } from '@/persistence';
import { resolveLoopbackHttpUrl } from './client/loopbackUrl';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { registerMachineRpcHandlers, type MachineRpcHandlerDeps, type MachineRpcHandlers } from './machine/rpcHandlers';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private changesSyncInFlight: Promise<void> | null = null;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
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

    private handleTransportSocketDisconnect(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>): void {
        logger.debug('[API MACHINE] Disconnected from server');
        if (this.socket !== socket) {
            return;
        }
        this.teardownActiveSocket();
    }

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        const machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        let additionalAllowedReadDirs: string[] = [];
        let additionalAllowedWriteDirs: string[] = [];
        registerSessionHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            setAdditionalAllowedReadDirs: (dirs) => {
                additionalAllowedReadDirs = dirs;
            },
            setAdditionalAllowedWriteDirs: (dirs) => {
                additionalAllowedWriteDirs = dirs;
            },
        });
        registerFileSystemHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory, {
            getAdditionalAllowedReadDirs: () => additionalAllowedReadDirs,
            getAdditionalAllowedWriteDirs: () => additionalAllowedWriteDirs,
        });
        registerMachineFileBrowserHandlers({ rpcHandlerManager: this.rpcHandlerManager });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, machineRpcWorkingDirectory);
    }

    setRPCHandlers({
        spawnSession,
        stopSession,
        isSessionActive,
        requestShutdown,
        memory,
        machineTransferChannel,
        directPeerTransfer,
    }: MachineRpcHandlers, deps?: MachineRpcHandlerDeps) {
        registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
            },
            deps,
        });
    }

    onUpdate(listener: (update: Update) => boolean | void): () => void {
        this.updateListeners.add(listener);
        return () => {
            this.updateListeners.delete(listener);
        };
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

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
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

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
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

    emitSessionEnd(payload: { sid: string; time: number; exit?: any }) {
        // May be called before connect() finishes; best-effort only.
        if (!this.socket) {
            return;
        }
        this.socket.emit('session-end', payload);
    }

    connect(params?: { onConnect?: () => void | Promise<void> }) {
        const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                createTransport: () => {
                    const { socket, transport } = createMachineSocketTransport({
                        serverUrl,
                        token: this.token,
                        machineId: this.machine.id,
                        transports: configuration.socketIoTransports,
                        env: process.env,
                    });
                    this.socket = socket;
                    this.installSocketEventHandlers(socket);
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket);
                    });
                    return transport;
                },
                probeReadiness: createLoopbackReadinessProbe({
                    serverUrl: configuration.apiServerUrl,
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

                    if (this.socket) {
                        this.rpcHandlerManager.onSocketConnect(this.socket);
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

                    void this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' });
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

    private installSocketEventHandlers(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>) {
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
        this.stopKeepAlive();
        this.socket = null;
        if (this.connectionSupervisor) {
            await this.connectionSupervisor.stop();
        }
    }

    async awaitPendingRpcRequests(): Promise<void> {
        await this.rpcHandlerManager.waitForIdle();
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            return await this.accountIdPromise.catch(() => null);
        }

        const p = (async () => {
            const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
            const response = await axios.get(`${serverUrl}/v1/account/profile`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15_000,
            });
            const id = (response?.data as any)?.id;
            if (typeof id !== 'string' || id.length === 0) {
                throw new Error('Invalid /v1/account/profile response');
            }
            return id;
        })();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch {
            this.accountIdPromise = null;
            return null;
        }
    }

    private async refreshMachineFromServer(): Promise<void> {
        try {
            const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
            const response = await axios.get(`${serverUrl}/v1/machines/${this.machine.id}`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15_000,
                validateStatus: () => true,
            });

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
            logger.debug('[API MACHINE] Failed to refresh machine snapshot', { error });
        }
    }

    private async syncChangesOnConnect(opts: { reason: 'connect' | 'reconnect' }): Promise<void> {
        const enabled = (() => {
            const raw = process.env.HAPPY_ENABLE_V2_CHANGES;
            if (!raw) return true;
            return ['true', '1', 'yes'].includes(raw.toLowerCase());
        })();
        if (!enabled) {
            return;
        }

        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
        }

        const p = (async () => {
            const accountId = await this.getAccountId();
            if (!accountId) return;

            const CHANGES_PAGE_LIMIT = 200;
            const after = await readLastChangesCursor(accountId);
            const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT });

            if (result.status === 'cursor-gone') {
                await writeLastChangesCursor(accountId, result.currentCursor);
                await this.refreshMachineFromServer();
                return;
            }
            if (result.status !== 'ok') {
                // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
                // On reconnect, fall back to a snapshot refresh.
                if (opts.reason === 'reconnect') {
                    await this.refreshMachineFromServer();
                }
                return;
            }

            const changes = result.response.changes;
            const nextCursor = result.response.nextCursor;

            const hasRelevantMachineChange = changes.some(
                (c) => c.kind === 'machine' && c.entityId === this.machine.id,
            );

            if (changes.length >= CHANGES_PAGE_LIMIT || hasRelevantMachineChange) {
                await this.refreshMachineFromServer();
            }

            await writeLastChangesCursor(accountId, nextCursor);
        })();

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            this.changesSyncInFlight = null;
        }
    }
}
