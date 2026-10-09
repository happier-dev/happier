import { resolveServerScopedContext } from './resolveServerScopedContext';
import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from './createScopedSocketConnectParams';
import { storage } from '@/sync/domains/state/storage';
import { parseToken } from '@/utils/auth/parseToken';
import type { ScopedServerRpcContext } from './serverScopedRpcTypes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { StaleServerGenerationError } from '@/sync/http/client';
import { fireAndForget } from '@/utils/system/fireAndForget';

const DEFAULT_SCOPE_PROFILE_ERROR_MESSAGE = 'Active account profile id is unavailable for server-scoped relay socket';

type SendEventFn<TPayload> = (payload: TPayload) => void;
type SubscribeEventFn<TPayload> = (listener: (payload: TPayload) => void) => () => void;
type ScopedTransportConfig<TPayload> = Readonly<{
    send: SendEventFn<TPayload>;
    on: SubscribeEventFn<TPayload>;
    dispose?: () => void;
}>;
type SocketAwareScopedTransportFactory<TPayload> = (socket: {
    emit: (event: string, payload: unknown) => void;
    on: (event: string, listener: (payload: TPayload) => void) => void;
    off: (event: string, listener: (payload: TPayload) => void) => void;
    timeout: (ms: number) => {
        emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
    };
}, context: ScopedServerRpcContext) => ScopedTransportConfig<TPayload> & {
    send: SendEventFn<TPayload>;
    on: SubscribeEventFn<TPayload>;
    socketId?: string;
};
type ScopedSocketClientLike<TPayload> = {
    emit: (event: string, payload: unknown) => void;
    on: (event: string, listener: (payload: TPayload) => void) => void;
    off: (event: string, listener: (payload: TPayload) => void) => void;
    timeout: (ms: number) => {
        emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
    };
    getSocketId: () => string;
    disconnect: () => void;
};

export type ServerScopedRelaySocket<TPayload> = Readonly<{
    scopeUserId: string;
    machineId: string;
    sendEnvelope: (payload: TPayload) => void;
    onEnvelope: (listener: (payload: TPayload) => void) => () => void;
    disconnect: () => Promise<void>;
    socketId?: string;
    viewerId?: string;
}>;

export function createServerScopedRelaySocket<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Borrow the source's admitted authority; never resolve another Account here. */
    accountLifetime?: ServerAccountScopeLifetime | null;
    timeoutMs?: number;
    missingScopeUserProfileErrorMessage?: string;
    createActiveTransport: ScopedTransportConfig<TPayload>;
    createScopedTransport: (socket: {
        emit: (event: string, payload: unknown) => void;
        on: (event: string, listener: (payload: TPayload) => void) => void;
        off: (event: string, listener: (payload: TPayload) => void) => void;
        timeout: (ms: number) => {
            emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
        };
    }, context: ScopedServerRpcContext) => ScopedTransportConfig<TPayload> & Readonly<{
        socketId?: string;
    }>;
    getActiveSocketId?: () => string;
    getScopedSocketId?: (socket: {
        emit: (event: string, payload: TPayload) => void;
        on: (event: string, listener: (payload: TPayload) => void) => void;
        off: (event: string, listener: (payload: TPayload) => void) => void;
        timeout: (ms: number) => {
            emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
        };
    }) => string;
}>): Promise<ServerScopedRelaySocket<TPayload>> {
    return resolveServerScopedRelaySocket({
        machineId: params.machineId,
        serverId: params.serverId,
        accountLifetime: params.accountLifetime,
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: params.missingScopeUserProfileErrorMessage,
        activeTransport: params.createActiveTransport,
        scopedTransport: (socket, context) => params.createScopedTransport(socket, context),
        getActiveSocketId: params.getActiveSocketId,
        getScopedSocketId: params.getScopedSocketId,
    });
}

export async function resolveServerScopedRelaySocket<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    timeoutMs?: number;
    missingScopeUserProfileErrorMessage?: string;
    activeTransport: ScopedTransportConfig<TPayload>;
    scopedTransport: ScopedTransportConfig<TPayload> & {
        socketId?: string;
    } | SocketAwareScopedTransportFactory<TPayload>;
    getActiveSocketId?: () => string;
    getScopedSocketId?: (socket: ScopedSocketClientLike<TPayload>) => string;
}>): Promise<ServerScopedRelaySocket<TPayload>> {
    const accountLifetime = params.accountLifetime;
    const isSourceCurrent = () => accountLifetime === undefined || (accountLifetime !== null
        && accountLifetime.isCurrent() && selectActiveServerAccountScopeForServer(
            accountLifetime.scope, params.serverId ?? accountLifetime.scope.serverId,
        ) !== null);
    if (!isSourceCurrent()) throw new StaleServerGenerationError();
    const context = await resolveServerScopedContext({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
    });
    if (context.scope === 'active') {
        if (!isSourceCurrent()) throw new StaleServerGenerationError();
        const scopeUserId = readActiveProfileId({
            missingScopeUserProfileErrorMessage: params.missingScopeUserProfileErrorMessage,
        });
        if (accountLifetime && scopeUserId !== accountLifetime.scope.accountId) throw new StaleServerGenerationError();
        return retainSourceAccountRelay({
            scopeUserId,
            machineId: context.machineId,
            socketId: params.getActiveSocketId?.(),
            sendEnvelope: params.activeTransport.send,
            onEnvelope: params.activeTransport.on,
            disconnect: async () => {},
        }, accountLifetime);
    }

    let socket: ScopedSocketClientLike<TPayload> | null = null;
    let retainedByReturnedSocket = false;
    let carrierCustodyTransferred = false;
    let redundantCarrierReleased = false;
    // The socket is pooled and can outlive this client, so a newly-created pool
    // entry takes carrier custody and releases it only at physical teardown. A
    // reused entry does not take this context's redundant release, which remains
    // ours to release below.
    try {
        const scopeUserId = context.targetAccountId ?? parseToken(context.token);
        if (!isSourceCurrent() || (accountLifetime && scopeUserId !== accountLifetime.scope.accountId)) {
            throw new StaleServerGenerationError();
        }
        socket = await createEphemeralServerSocketClient(
            createScopedSocketConnectParams(context, () => {
                carrierCustodyTransferred = true;
                return context.release;
            }),
        );
        if (!carrierCustodyTransferred) {
            await context.release?.();
            redundantCarrierReleased = true;
        }
        if (!isSourceCurrent()) throw new StaleServerGenerationError();
        const scopedTransport = typeof params.scopedTransport === 'function'
            ? params.scopedTransport(socket, context)
            : params.scopedTransport;

        const resolvedSocket: ServerScopedRelaySocket<TPayload> = {
            scopeUserId,
            machineId: context.machineId,
            socketId: params.getScopedSocketId?.(socket) ?? scopedTransport.socketId ?? socket.getSocketId(),
            sendEnvelope: scopedTransport.send,
            onEnvelope: scopedTransport.on,
            disconnect: async () => {
                scopedTransport.dispose?.();
                socket?.disconnect();
            },
        };
        retainedByReturnedSocket = true;
        return retainSourceAccountRelay(resolvedSocket, accountLifetime);
    } finally {
        if (!retainedByReturnedSocket) {
            socket?.disconnect();
        }
        if (!carrierCustodyTransferred && !redundantCarrierReleased) {
            await context.release?.();
        }
    }
}

/** Retire this logical reader, not the Account connection, Machine or pooled socket. */
function retainSourceAccountRelay<TPayload>(socket: ServerScopedRelaySocket<TPayload>, accountLifetime?: ServerAccountScopeLifetime | null): ServerScopedRelaySocket<TPayload> {
    if (!accountLifetime) return socket;
    const subscriptions = new Set<() => void>();
    let retired = false;
    let closing: Promise<void> | null = null;
    let retirement: ReturnType<ServerAccountScopeLifetime['onRetire']> | null = null;
    const isCurrent = () => !retired && accountLifetime.isCurrent();
    const disconnect = (): Promise<void> => {
        if (closing) return closing;
        retired = true;
        closing = (async () => {
            retirement?.dispose();
            for (const unsubscribe of subscriptions) unsubscribe();
            await socket.disconnect();
        })();
        return closing;
    };
    retirement = accountLifetime.onRetire(() => {
        fireAndForget(disconnect(), { tag: 'source-account-relay-retire' });
    });
    return {
        ...socket,
        sendEnvelope: payload => { if (isCurrent()) socket.sendEnvelope(payload); },
        onEnvelope: listener => {
            if (!isCurrent()) return () => {};
            const unsubscribe = socket.onEnvelope(payload => { if (isCurrent()) listener(payload); });
            const release = () => {
                if (!subscriptions.delete(release)) return;
                unsubscribe();
            };
            subscriptions.add(release);
            return release;
        },
        disconnect,
    };
}

function readActiveProfileId(
    params: Readonly<{ missingScopeUserProfileErrorMessage?: string }>,
): string {
    const profileId = String(storage.getState().profile?.id ?? '').trim();
    if (!profileId) {
        throw new Error(
            params.missingScopeUserProfileErrorMessage ?? DEFAULT_SCOPE_PROFILE_ERROR_MESSAGE,
        );
    }
    return profileId;
}
