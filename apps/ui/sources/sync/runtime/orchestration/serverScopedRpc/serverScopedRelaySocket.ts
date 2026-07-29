import { resolveServerScopedContext } from './resolveServerScopedContext';
import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { storage } from '@/sync/domains/state/storage';

const DEFAULT_SCOPE_PROFILE_ERROR_MESSAGE = 'Active account profile id is unavailable for server-scoped relay socket';

type SendEventFn<TPayload> = (payload: TPayload) => void;
type SubscribeEventFn<TPayload> = (listener: (payload: TPayload) => void) => () => void;
type ScopedTransportConfig<TPayload> = Readonly<{
    send: SendEventFn<TPayload>;
    on: SubscribeEventFn<TPayload>;
}>;
type SocketAwareScopedTransportFactory<TPayload> = (socket: {
    emit: (event: string, payload: TPayload) => void;
    on: (event: string, listener: (payload: TPayload) => void) => void;
    off: (event: string, listener: (payload: TPayload) => void) => void;
    timeout: (ms: number) => {
        emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
    };
}) => {
    send: SendEventFn<TPayload>;
    on: SubscribeEventFn<TPayload>;
    socketId?: string;
};
type ScopedSocketClientLike<TPayload> = {
    emit: (event: string, payload: TPayload) => void;
    on: (event: string, listener: (payload: TPayload) => void) => void;
    off: (event: string, listener: (payload: TPayload) => void) => void;
    timeout: (ms: number) => {
        emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
    };
    getSocketId: () => string;
};

export type ServerScopedRelaySocket<TPayload> = Readonly<{
    scopeUserId: string;
    machineId: string;
    sendEnvelope: (payload: TPayload) => void;
    onEnvelope: (listener: (payload: TPayload) => void) => () => void;
    disconnect: () => void;
    socketId?: string;
    viewerId?: string;
}>;

export function createServerScopedRelaySocket<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
    missingScopeUserProfileErrorMessage?: string;
    createActiveTransport: ScopedTransportConfig<TPayload>;
    createScopedTransport: (socket: {
        emit: (event: string, payload: TPayload) => void;
        on: (event: string, listener: (payload: TPayload) => void) => void;
        off: (event: string, listener: (payload: TPayload) => void) => void;
        timeout: (ms: number) => {
            emitWithAck: (event: string, payload: TPayload) => Promise<unknown>;
        };
    }) => ScopedTransportConfig<TPayload> & Readonly<{
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
        timeoutMs: params.timeoutMs,
        missingScopeUserProfileErrorMessage: params.missingScopeUserProfileErrorMessage,
        activeTransport: params.createActiveTransport,
        scopedTransport: (socket) => params.createScopedTransport(socket),
        getActiveSocketId: params.getActiveSocketId,
        getScopedSocketId: params.getScopedSocketId,
    });
}

export async function resolveServerScopedRelaySocket<TPayload>(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
    missingScopeUserProfileErrorMessage?: string;
    activeTransport: ScopedTransportConfig<TPayload>;
    scopedTransport: ScopedTransportConfig<TPayload> & {
        socketId?: string;
    } | SocketAwareScopedTransportFactory<TPayload>;
    getActiveSocketId?: () => string;
    getScopedSocketId?: (socket: ScopedSocketClientLike<TPayload>) => string;
}>): Promise<ServerScopedRelaySocket<TPayload>> {
    const context = await resolveServerScopedContext({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
    });
    const scopeUserId = readActiveProfileId({
        missingScopeUserProfileErrorMessage: params.missingScopeUserProfileErrorMessage,
    });

    if (context.scope === 'active') {
        return {
            scopeUserId,
            machineId: context.machineId,
            socketId: params.getActiveSocketId?.(),
            sendEnvelope: params.activeTransport.send,
            onEnvelope: params.activeTransport.on,
            disconnect: () => {},
        };
    }

    const socket = await createEphemeralServerSocketClient({
        serverUrl: context.targetServerUrl,
        token: context.token,
        timeoutMs: context.timeoutMs,
    });
    const scopedTransport = typeof params.scopedTransport === 'function'
        ? params.scopedTransport(socket)
        : params.scopedTransport;

    return {
        scopeUserId,
        machineId: context.machineId,
        socketId: params.getScopedSocketId?.(socket) ?? scopedTransport.socketId ?? socket.getSocketId(),
        sendEnvelope: scopedTransport.send,
        onEnvelope: scopedTransport.on,
        disconnect: () => {
            socket.disconnect();
        },
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
