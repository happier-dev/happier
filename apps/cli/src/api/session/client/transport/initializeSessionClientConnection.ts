import { Socket } from 'socket.io-client';
import { applyCliActionAutomationUpdateV1, reconnectCliActionAutomationsV1 } from '@/api/actionAutomations';

import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import type { AccountUpdatesSocket, SessionClientTransport } from './sessionClientTransport';
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
        transport: SessionClientTransport;
        sessionId: string;
        localMachineId?: string | null;
        /**
         * Account-wide user-scoped updates. A restricted Session-runtime
         * composition (shared-editor authority) has no Account room to join, so
         * it never opens that socket.
         */
        userScopedAccountUpdates: boolean;
        getMetadataSnapshot: () => unknown;
        setSessionSocket: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
        rpcHandlerManager: {
            onSocketConnect: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
            onSocketDisconnect: () => void;
        };
        handleUserScopedUpdate: (
            data: Update,
            socket: AccountUpdatesSocket,
        ) => void;
        installSessionSocketEventHandlers: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
        classifyTransportErrorToProbeResult: Parameters<typeof createManagedConnectionSupervisor>[0]['classifyTransportErrorToProbeResult'];
        onStateChange: (state: ManagedConnectionState) => void;
        shouldKeepUserSocketConnected: () => boolean;
        kickUserSocketConnect: () => void;
        syncChangesOnConnect: (opts: { reason: 'connect' | 'reconnect' }) => Promise<void>;
        shouldSyncSessionSnapshotOnConnect: () => boolean;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<void>;
        flushDurableSessionMutationsOnReconnect: () => Promise<void>;
        replayLatestSessionPresenceOnReconnect?: () => void;
        reofferAcceptedProviderInputSettlementsAfterConnection?: () => void;
        recoverAppliedPermissionCompletions?: () => Promise<void>;
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
        /** Content-free hint only; the destination reconciler re-observes durable authority. */
        onSessionFollowInvalidated?: () => void;
        onAccountCatalogInvalidated?: (wake: Update) => Promise<void>;
    }>,
): Readonly<{
    userSocket: AccountUpdatesSocket | null;
    sessionConnectionSupervisor: ManagedConnectionSupervisor;
    getServerFeaturesSnapshot: ReturnType<typeof createSessionSyncPendingInputServerContractController>['getServerFeaturesSnapshot'];
}> {
    const userSocket = params.userScopedAccountUpdates
        ? params.transport.createAccountUpdatesSocket?.() ?? null
        : null;
    userSocket?.on('update', (data: Update) => {
        applyCliActionAutomationUpdateV1({ token: params.token, serverHttpBaseUrl: params.transport.serverUrl, body: data.body });
        // AccountChange carries no Session identity. The existing changes-feed
        // owner determines whether this destination's context was invalidated.
        if (data.body?.t === 'account-change') {
            void params.onAccountCatalogInvalidated?.(data).catch(() => {
                logger.debug('[API] Captured Account catalog refresh unavailable');
            });
        }
        params.handleUserScopedUpdate(data, userSocket);
    });
    userSocket?.on('session', () => {});

    let currentTransportSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
    let currentTransportMachineId: string | undefined;
    let publisherReadinessAbortController: AbortController | null = null;
    const serverContractController = createSessionSyncPendingInputServerContractController({
        serverUrl: params.transport.serverUrl,
        token: params.token,
    });
    const invalidateSessionConnection = async (): Promise<void> => {
        publisherReadinessAbortController?.abort();
        publisherReadinessAbortController = null;
        const invalidated = serverContractController.invalidate({
            socket: currentTransportSocket ?? undefined,
        });
        // Retire this transport synchronously. Compatibility invalidation can
        // yield while a new connection publishes and acknowledges its handlers.
        params.rpcHandlerManager.onSocketDisconnect();
        try {
            userSocket?.disconnect();
        } catch {
            // ignore
        }
        await params.setSessionSyncPendingInputServerContractResult?.(
            invalidated ? composeInvalidatedSessionClientConnectionContract(invalidated) : null,
        );
    };
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
            const { socket, transport } = params.transport.createSessionSocketTransport({
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
            serverUrl: params.transport.serverUrl,
            token: params.token,
        }),
        onStateChange: (state) => {
            logger.infoFile('[API] Session socket connection state', {
                phase: state.phase,
                reason: state.reason,
                attempt: state.attempt,
                nextRetryAt: state.nextRetryAt,
                lastErrorMessage: state.lastErrorMessage
                    ? redactBugReportSensitiveText(state.lastErrorMessage)
                    : null,
            });
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
            if (connected.reason === 'reconnect') reconnectCliActionAutomationsV1({ token: params.token,
                serverHttpBaseUrl: params.transport.serverUrl });
            await params.recoverAppliedPermissionCompletions?.().catch(() => {
                logger.infoFile('[API] session_permission_completion_recovery_failed', { operation: 'update-state' });
            });
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
                    signal: connectionPublisherReadiness.signal,
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
            if (!flushedDurableMutations) {
                await params.flushDurableSessionMutationsOnReconnect().catch((error) => {
                    logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            }
            params.onSessionFollowInvalidated?.();
        },
        onDisconnected: async ({ event }) => {
            logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
            await invalidateSessionConnection();
        },
        onAuthFailed: invalidateSessionConnection,
    });

    return {
        userSocket,
        sessionConnectionSupervisor,
        getServerFeaturesSnapshot: serverContractController.getServerFeaturesSnapshot,
    };
}
