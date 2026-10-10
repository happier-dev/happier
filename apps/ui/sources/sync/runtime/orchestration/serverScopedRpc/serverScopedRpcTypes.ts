import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption, EncryptionGenerationScopeAuthority, EncryptionScopeInput } from '@/sync/encryption/encryption';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { Metadata } from '@happier-dev/session-core/state';

/**
 * How long an unqualified server-scoped RPC operation may stay in flight.
 *
 * This is the ceiling every caller inherits when it does not name its own, so
 * it is also the point past which an unsettled daemon call is stuck rather
 * than slow. Consumers that must decide how long to keep waiting on a daemon
 * round-trip derive their bound from this value instead of restating it.
 */
export const DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS = 30_000;

export type ServerScopedMachineRpcParams<A> = Readonly<{
    machineId: string;
    method: string;
    payload: A;
    /** Original admitted invocation identity, consumed by the existing RPC owner. */
    requestId?: string;
    serverId?: string | null;
    /** When present, scoped credentials must resolve to this exact Account. */
    accountId?: string | null;
    timeoutMs?: number;
    /** Caller cancellation owns the admitted operation; connection setup remains bounded. */
    operationTimeoutMs?: null;
    preferScoped?: boolean;
    /** Account key material requires Machine encryption or the private installed-key sealed carrier. */
    requireEncryptedPayload?: true;
    skipTransferPolicyEvaluation?: boolean;
    authorization?: SocketRpcAuthorizationContext;
    signal?: AbortSignal;
    /** Exact-action issuance hook, invoked immediately before the real socket emit. */
    onIssued?: () => void;
    /** Transport dispatch hook; unlike exact-action issuance, preserves peer routing. */
    onDispatched?: () => void;
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
    /** Present for runtime-produced contexts; optional only for injected test/compatibility adapters. */
    targetAccountId?: string;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
    /** Semantic carrier for a Home with no reachable URL origin (browser Iroh). */
    homeCarrier?: HomeCarrier;
    release?: () => Promise<void>;
    token: string;
    /** Runtime-produced contexts retain the exact credentials already resolved by the scope owner. */
    credentials?: AuthCredentials;
    encryption: ScopedRpcEncryptionContext | null;
}>;

export type ResolvedServerRpcContext = ActiveServerRpcContext | ScopedServerRpcContext;

export type ScopedRpcEncryptionContext = Readonly<{
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    initializeMachines: Encryption['initializeMachines'];
    getMachineEncryption: (machineId: string) => ScopedMachineEncryption | null | undefined;
    captureMachineEncryptionContext: Encryption['captureMachineEncryptionContext'];
    getMachineEncryptionContext: Encryption['getMachineEncryptionContext'];
    removeMachineEncryption: Encryption['removeMachineEncryption'];
}>;

/**
 * The generation methods are declared here, not discovered at runtime: the only producer of this
 * context is the canonical Account encryption owner, which implements them. A consumer that has to
 * know whether the material it captured is still current can therefore just take this context.
 */
export type ScopedRpcSessionEncryptionContext = Readonly<{
    anonID?: string;
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    /**
     * The batch opener, declared for the same reason as the generation methods: the producer is the
     * Account encryption owner, which owns native-worker routing and cooperative opening, so a
     * consumer working a whole page asks for it instead of fanning the singular call out itself.
     */
    decryptEncryptionKeys: (
        values: readonly string[],
        scope?: EncryptionScopeInput,
    ) => Promise<Array<Uint8Array | null>>;
    initializeSessions: (
        keys: Map<string, Uint8Array | null>,
        scope?: EncryptionScopeInput,
    ) => Promise<void>;
    getSessionEncryption: (sessionId: string) => ScopedSessionEncryption | null | undefined;
}> & EncryptionGenerationScopeAuthority;

export type ScopedMachineEncryption = Readonly<{
    encryptRaw: (payload: unknown) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
}>;

export type ScopedSessionEncryption = Readonly<{
    encryptRaw: (payload: unknown) => Promise<string>;
    decryptRaw: (payload: string) => Promise<unknown>;
    encryptMetadata?: (metadata: Metadata) => Promise<string>;
    decryptMetadata?: (version: number, value: string) => Promise<Metadata | null>;
}>;

export type ScopedSocketConnectParams = Readonly<{
    /** Actual verified Socket.IO origin. */
    serverUrl: string;
    /** Exact, profile-proven Home identity for local foreground reach history. */
    homeIdentityId?: string;
    /** Stable Home identity/auth audience and reachability key. */
    reachabilityServerUrl?: string;
    carrier?: 'https' | 'iroh';
    /** Semantic carrier for a Home with no reachable URL origin (browser Iroh). */
    homeCarrier?: HomeCarrier;
    /**
     * Custody of the acquired transport lease behind {@link homeCarrier}.
     *
     * Passing it hands ownership to the socket pool from this call onward, because
     * the pooled socket outlives the caller that created it: a logical client's
     * `disconnect()` only drops its own use, and the pool releases the lease once
     * the socket it carries is actually torn down. The caller must not release it
     * afterwards — including when this call fails, which the pool unwinds itself.
     */
    releaseCarrier?: () => Promise<void>;
    /**
     * Defers carrier custody transfer until the pool knows it must create a
     * physical socket entry. Reusing an existing entry does not invoke this
     * callback, so an authority can safely issue another logical operation
     * without consuming a second carrier release.
     */
    takeCarrierRelease?: () => (() => Promise<void>) | undefined;
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
