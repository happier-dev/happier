import { Socket } from 'socket.io-client';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
import {
    createSessionSyncPendingInputServerContractController,
    supportsRuntimeActivityV2,
    supportsSessionSyncPendingInputV1,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import {
    composeInvalidatedSessionClientConnectionContract,
    resolveSessionClientConnectionContract,
    type SessionClientConnectionContractResult,
} from './sessionClientConnectionContract';

function normalizeMachineId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export function initializeSessionClientConnection(
    params: Readonly<{
        token: string;
        sessionId: string;
        localMachineId?: string | null;
        getMetadataSnapshot: () => unknown;
        setSessionSocket: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
        rpcHandlerManager: {
            onSocketConnect: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
            onSocketDisconnect: () => void;
        };
        handleUserScopedUpdate: (
            data: Update,
            socket: Socket<ServerToClientEvents, ClientToServerEvents>,
        ) => void;
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
        replayLatestSessionPresenceOnReconnect?: () => void;
        reofferAcceptedProviderInputSettlementsAfterConnection?: () => void;
        markConnected: () => Readonly<{ reason: 'connect' | 'reconnect'; epoch: number }> | 'connect' | 'reconnect';
        setSessionSyncPendingInputServerContractResult?: (
            result: SessionClientConnectionContractResult | null,
        ) => Promise<void> | void;
        prepareSessionSyncPendingInputServerContractResult?: (
            result: SessionClientConnectionContractResult,
        ) => Promise<void> | void;
        waitForRuntimeActivityPublisherReadiness?: (
            signal: AbortSignal,
        ) => Promise<boolean>;
    }>,
): Readonly<{
    userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionConnectionSupervisor: ManagedConnectionSupervisor;
}> {
    const userSocket = createUserScopedSocket({ token: params.token });
    userSocket.on('update', (data: Update) => params.handleUserScopedUpdate(data, userSocket));
    userSocket.on('session', () => {});

    let currentTransportSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
    let currentTransportMachineId: string | undefined;
    let publisherReadinessAbortController: AbortController | null = null;
    const serverContractController = createSessionSyncPendingInputServerContractController({
        serverUrl: resolveServerHttpBaseUrl(),
        token: params.token,
    });
    const sessionConnectionSupervisor = createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        createTransport: () => {
            const machineId = (() => {
                const localMachineId = normalizeMachineId(params.localMachineId);
                if (localMachineId) {
                    return localMachineId;
                }
                const metadata = params.getMetadataSnapshot();
                if (!(metadata && typeof metadata === 'object')) {
                    return undefined;
                }
                return normalizeMachineId((metadata as { machineId?: unknown }).machineId);
            })();
            const { socket, transport } = createSessionSocketTransport({
                token: params.token,
                sessionId: params.sessionId,
                machineId,
            });
            currentTransportSocket = socket;
            currentTransportMachineId = machineId;
            params.setSessionSocket(socket);
            params.installSessionSocketEventHandlers(socket);
            return transport;
        },
        classifyTransportErrorToProbeResult: params.classifyTransportErrorToProbeResult,
        probeReadiness: createLoopbackReadinessProbe({
            serverUrl: resolveServerHttpBaseUrl(),
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
            const markedConnected = params.markConnected();
            const connected = typeof markedConnected === 'string'
                ? { reason: markedConnected, epoch: 0 }
                : markedConnected;
            const probeScope = sessionConnectionSupervisor.captureProbeReportScope?.();
            const contractProbe = {
                sessionConnectionEpoch: connected.epoch,
                socket: currentTransportSocket,
                machineId: currentTransportMachineId,
            };
            publisherReadinessAbortController?.abort();
            const connectionPublisherReadiness = new AbortController();
            publisherReadinessAbortController = connectionPublisherReadiness;
            let flushedDurableMutations = false;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const serverContractResult = await serverContractController.resolve(contractProbe);
                if (
                    serverContractResult.sessionConnectionEpoch !== connected.epoch
                    || serverContractResult.socket !== currentTransportSocket
                    || currentTransportSocket.connected !== true
                ) {
                    return;
                }
                const contractResult = await resolveSessionClientConnectionContract({
                    serverContract: serverContractResult,
                    sessionId: params.sessionId,
                    socket: currentTransportSocket,
                });
                if (
                    contractResult.sessionConnectionEpoch !== connected.epoch
                    || contractResult.socket !== currentTransportSocket
                    || currentTransportSocket.connected !== true
                ) {
                    return;
                }
                await params.prepareSessionSyncPendingInputServerContractResult?.(contractResult);
                if (contractResult.mode === 'auth_failed') {
                    await params.setSessionSyncPendingInputServerContractResult?.(contractResult);
                    sessionConnectionSupervisor.reportProbeResult?.({
                        status: 'auth_failed', statusCode: 401, errorMessage: 'Authentication failed while resolving session compatibility',
                    }, probeScope);
                    return;
                }
                const requiresPublisherReadiness = supportsRuntimeActivityV2(contractResult)
                    && supportsSessionSyncPendingInputV1(contractResult);
                if (requiresPublisherReadiness) {
                    await params.flushDurableSessionMutationsOnReconnect().catch((error) => {
                        logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                            error: serializeAxiosErrorForLog(error),
                        });
                    });
                    flushedDurableMutations = true;
                    const ready = await params.waitForRuntimeActivityPublisherReadiness?.(
                        connectionPublisherReadiness.signal,
                    ) ?? true;
                    if (!ready) return;
                    if (
                        connectionPublisherReadiness.signal.aborted
                        || contractResult.sessionConnectionEpoch !== connected.epoch
                        || contractResult.socket !== currentTransportSocket
                        || currentTransportSocket.connected !== true
                    ) {
                        return;
                    }
                }
                await params.setSessionSyncPendingInputServerContractResult?.(contractResult);
                if (
                    contractResult.runtimeActivity !== 'indeterminate'
                    || contractResult.pendingInput !== 'indeterminate'
                    || contractResult.publisherAuthority !== 'indeterminate'
                ) {
                    break;
                }
                if (attempt === 1) {
                    sessionConnectionSupervisor.reportProbeResult?.({
                        status: 'retry_later',
                        reason: 'probe_failed',
                        errorMessage: 'Session compatibility remained indeterminate after bounded probes',
                    }, probeScope);
                    return;
                }
            }
            if (params.shouldKeepUserSocketConnected()) {
                params.kickUserSocketConnect();
            }
            params.reofferAcceptedProviderInputSettlementsAfterConnection?.();
            params.replayLatestSessionPresenceOnReconnect?.();
            await params.syncChangesOnConnect({ reason: connected.reason }).catch((error) => {
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
            if (!flushedDurableMutations) {
                await params.flushDurableSessionMutationsOnReconnect().catch((error) => {
                    logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            }
        },
        onDisconnected: async ({ event }) => {
            logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
            publisherReadinessAbortController?.abort();
            publisherReadinessAbortController = null;
            const invalidated = serverContractController.invalidate({
                socket: currentTransportSocket ?? undefined,
            });
            await params.setSessionSyncPendingInputServerContractResult?.(
                invalidated ? composeInvalidatedSessionClientConnectionContract(invalidated) : null,
            );
            params.rpcHandlerManager.onSocketDisconnect();
            try {
                userSocket.disconnect();
            } catch {
                // ignore
            }
        },
        onAuthFailed: async () => {
            publisherReadinessAbortController?.abort();
            publisherReadinessAbortController = null;
            const invalidated = serverContractController.invalidate({
                socket: currentTransportSocket ?? undefined,
            });
            await params.setSessionSyncPendingInputServerContractResult?.(
                invalidated ? composeInvalidatedSessionClientConnectionContract(invalidated) : null,
            );
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
