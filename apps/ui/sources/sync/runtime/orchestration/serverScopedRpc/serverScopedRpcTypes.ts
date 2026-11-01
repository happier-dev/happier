import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

export const DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS = 30_000;

export type SocketRpcResult<T = string> =
    | { ok: true; result: T }
    | { ok: false; error?: string; errorCode?: string };

export type ServerScopedMachineRpcParams<A> = Readonly<{
    machineId: string;
    method: string;
    payload: A;
    serverId?: string | null;
    /** When present, scoped credentials must belong to this initiating account. */
    accountId?: string | null;
    timeoutMs?: number;
    preferScoped?: boolean;
    authorization?: SocketRpcAuthorizationContext;
    /** Called immediately before a fully prepared transport emission. */
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
    encryption: ScopedRpcEncryptionContext;
}>;

export type ResolvedServerRpcContext = ActiveServerRpcContext | ScopedServerRpcContext;

export type ScopedRpcEncryptionContext = Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeMachines: (keys: Map<string, Uint8Array | null>, options?: Readonly<{ plainMachineIds?: ReadonlySet<string> }>) => Promise<void>;
    getMachineEncryption: (machineId: string) => ScopedMachineEncryption | null | undefined;
}>;

export type ScopedRpcSessionEncryptionContext = Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeSessions: (keys: Map<string, Uint8Array | null>) => Promise<void>;
    getSessionEncryption: (sessionId: string) => ScopedSessionEncryption | null | undefined;
}>;

export type ScopedMachineEncryption = Readonly<{
    encodeRpcPayload: (payload: unknown) => Promise<unknown>;
    decodeRpcResult: (payload: unknown) => Promise<unknown>;
}>;

export type ScopedSessionEncryption = Readonly<{
    encryptRaw: (payload: unknown) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
}>;

export type ScopedSocketConnectParams = Readonly<{
    serverUrl: string;
    token: string;
    timeoutMs: number;
    /** One-shot OS task connection, independent of foreground pooling/pause. */
    networkMode?: 'background-task';
    /** Owns a one-shot background socket through connection and RPC preparation. */
    signal?: AbortSignal;
}>;

export type ScopedSocketClient = Readonly<{
    timeout: (ms: number) => { emitWithAck: (event: string, payload: any) => Promise<unknown> };
    emitWithAck: (event: string, payload: any) => Promise<unknown>;
    emit: (event: string, payload: any) => void;
    disconnect: () => void;
}>;
