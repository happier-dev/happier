import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

/**
 * How long an unqualified server-scoped RPC operation may stay in flight.
 *
 * This is the ceiling every caller inherits when it does not name its own, so
 * it is also the point past which an unsettled daemon call is stuck rather
 * than slow. Consumers that must decide how long to keep waiting on a daemon
 * round-trip derive their bound from this value instead of restating it.
 */
export const DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS = 30_000;

export type SocketRpcResult =
    | { ok: true; result: string }
    | { ok: false; error?: string; errorCode?: string };

export type ServerScopedMachineRpcParams<A> = Readonly<{
    machineId: string;
    method: string;
    payload: A;
    serverId?: string | null;
    timeoutMs?: number;
    preferScoped?: boolean;
    skipTransferPolicyEvaluation?: boolean;
    authorization?: SocketRpcAuthorizationContext;
    signal?: AbortSignal;
    /** Exact-action issuance hook, invoked immediately before the real socket emit. */
    onIssued?: () => void;
}>;

export type ActiveServerRpcContext = Readonly<{
    scope: 'active';
    machineId: string;
    timeoutMs: number;
}>;

export type ScopedServerRpcContext = Readonly<{
    scope: 'scoped';
    machineId: string;
    timeoutMs: number;
    targetServerId: string;
    targetServerUrl: string;
    token: string;
    encryption: ScopedRpcEncryptionContext | null;
}>;

export type ResolvedServerRpcContext = ActiveServerRpcContext | ScopedServerRpcContext;

export type ScopedRpcEncryptionContext = Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeMachines: (keys: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => ScopedMachineEncryption | null | undefined;
}>;

export type ScopedRpcSessionEncryptionContext = Readonly<{
    anonID?: string;
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (keys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => ScopedSessionEncryption | null | undefined;
}>;

export type ScopedMachineEncryption = Readonly<{
    encryptRaw: (payload: unknown) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
}>;

export type ScopedSessionEncryption = Readonly<{
    encryptRaw: (payload: unknown) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
}>;

export type ScopedSocketConnectParams = Readonly<{
    serverUrl: string;
    token: string;
    timeoutMs: number;
}>;

export type ScopedSocketClient = Readonly<{
    emitWithAck?: (event: string, payload: any) => Promise<unknown>;
    timeout: (ms: number) => { emitWithAck: (event: string, payload: any) => Promise<unknown> };
    emit: (event: string, payload: any) => void;
    on: (event: string, listener: (...args: any[]) => void) => void;
    off: (event: string, listener: (...args: any[]) => void) => void;
    /**
     * The socket.io connection id of the underlying ephemeral socket, or '' when not connected.
     * Surfacing it lets per-tab transports (e.g. the live-stream relay viewer) target
     * `io.to(socketId)` instead of falling back to the shared user room. It changes across
     * reconnects, so callers must read it at use time, never cache it.
     */
    getSocketId: () => string;
    disconnect: () => void;
}>;
