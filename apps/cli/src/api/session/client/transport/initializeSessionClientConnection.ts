import { Socket } from 'socket.io-client';

import { configuration } from '@/configuration';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createSessionSocketTransport } from '../../connection/createSessionSocketTransport';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { createUserScopedSocket } from '../../sockets';
import type { ClientToServerEvents, ServerToClientEvents, Update } from '../../../types';
import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '../../../client/serializeAxiosErrorForLog';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';

export function initializeSessionClientConnection(
    params: Readonly<{
        token: string;
        sessionId: string;
        getMetadataSnapshot: () => unknown;
        setSessionSocket: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
        rpcHandlerManager: {
            onSocketConnect: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
            onSocketDisconnect: () => void;
        };
        handleUserScopedUpdate: (data: Update) => void;
        installSessionSocketEventHandlers: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
        classifyTransportErrorToProbeResult: Parameters<typeof createManagedConnectionSupervisor>[0]['classifyTransportErrorToProbeResult'];
        onStateChange: (state: ManagedConnectionState) => void;
        shouldKeepUserSocketConnected: () => boolean;
        kickUserSocketConnect: () => void;
        syncChangesOnConnect: (opts: { reason: 'connect' | 'reconnect' }) => Promise<void>;
        shouldSyncSessionSnapshotOnConnect: () => boolean;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<void>;
        flushQueuedSessionMessagesOnReconnect: () => Promise<void>;
        flushDurableSessionMutationsOnReconnect: () => Promise<void>;
        markConnected: () => 'connect' | 'reconnect';
    }>,
): Readonly<{
    userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionConnectionSupervisor: ManagedConnectionSupervisor;
}> {
    const userSocket = createUserScopedSocket({ token: params.token });
    userSocket.on('update', (data: Update) => params.handleUserScopedUpdate(data));
    userSocket.on('session', () => {});

    let currentTransportSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
    const sessionConnectionSupervisor = createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        createTransport: () => {
            const machineId = (() => {
                const metadata = params.getMetadataSnapshot();
                if (!(metadata && typeof metadata === 'object')) {
                    return undefined;
                }
                const rawMachineId = (metadata as { machineId?: unknown }).machineId;
                if (typeof rawMachineId !== 'string') {
                    return undefined;
                }
                const trimmedMachineId = rawMachineId.trim();
                return trimmedMachineId.length > 0 ? trimmedMachineId : undefined;
            })();
            const { socket, transport } = createSessionSocketTransport({
                token: params.token,
                sessionId: params.sessionId,
                machineId,
            });
            currentTransportSocket = socket;
            params.setSessionSocket(socket);
            params.installSessionSocketEventHandlers(socket);
            return transport;
        },
        classifyTransportErrorToProbeResult: params.classifyTransportErrorToProbeResult,
        probeReadiness: createLoopbackReadinessProbe({
            serverUrl: configuration.apiServerUrl,
            token: params.token,
        }),
        onStateChange: (state) => {
            params.onStateChange(state);
        },
        onConnected: async () => {
            logger.debug('Socket connected successfully');
            connectionState.recover();
            if (!currentTransportSocket) {
                return;
            }
            params.rpcHandlerManager.onSocketConnect(currentTransportSocket);
            const connectReason = params.markConnected();
            if (params.shouldKeepUserSocketConnected()) {
                params.kickUserSocketConnect();
            }
            await params.syncChangesOnConnect({ reason: connectReason }).catch((error) => {
                logger.debug('[API] Session changes sync on connect failed (non-fatal)', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            if (params.shouldSyncSessionSnapshotOnConnect()) {
                void params.syncSessionSnapshotFromServer({ reason: 'connect' });
            }
            await params.flushQueuedSessionMessagesOnReconnect().catch((error) => {
                logger.debug('[API] Failed to replay queued session messages on reconnect', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            await params.flushDurableSessionMutationsOnReconnect().catch((error) => {
                logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        },
        onDisconnected: async ({ event }) => {
            logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
            params.rpcHandlerManager.onSocketDisconnect();
            try {
                userSocket.disconnect();
            } catch {
                // ignore
            }
        },
        onAuthFailed: async () => {
            params.rpcHandlerManager.onSocketDisconnect();
            try {
                userSocket.disconnect();
            } catch {
                // ignore
            }
        },
    });

    return {
        userSocket,
        sessionConnectionSupervisor,
    };
}
