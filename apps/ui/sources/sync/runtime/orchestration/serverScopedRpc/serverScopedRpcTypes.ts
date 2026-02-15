import type { Socket } from 'socket.io-client';

export type SocketRpcResult =
    | { ok: true; result: string }
    | { ok: false; error?: string; errorCode?: string };

export type ServerScopedMachineRpcParams<A> = Readonly<{
    machineId: string;
    method: string;
    payload: A;
    serverId?: string | null;
    timeoutMs?: number;
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
    initializeMachines: (keys: Map<string, Uint8Array | null>) => Promise<void>;
    getMachineEncryption: (machineId: string) => ScopedMachineEncryption | null | undefined;
}>;

export type ScopedRpcSessionEncryptionContext = Readonly<{
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

export type ScopedSocketClient = Socket;
