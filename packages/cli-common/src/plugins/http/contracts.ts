import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginDiagnosticData } from '../errors.js';
import type { PluginContributionRef, Disposable, PluginCancellationOptions } from '../registration/contracts.js';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type PluginInterceptedRequest = Readonly<{
    url: string;
    method: HttpMethod;
    headers: Readonly<Record<string, string>>;
}>;
export type PluginInterceptorResult =
    | Readonly<{ decision: 'continue'; request: PluginInterceptedRequest }>
    | Readonly<{ decision: 'deny'; code: string }>;

export type PluginFetchCredentialBinding =
    Readonly<{
        kind: 'voiceAccountOperation';
        provider: PluginContributionRef;
        operation: string;
        parameters: Readonly<Record<string, JsonValue>>;
    }>
    | Readonly<{
        /** Host-custodied headers for an invocation's declared purpose. */
        kind: 'connectedAccountPurpose';
        purpose: string;
        origin: string;
        /** Issued method, compared with the actual request before credential injection. */
        method: HttpMethod;
        headerNames: readonly string[];
    }>;

/** A redaction-aware header supplied during a host-vended WebSocket handshake. */
export type PluginWebSocketHeader = Readonly<{
    name: string;
    value: string;
    sensitive?: boolean;
}>;

export type PluginWebSocketMessage =
    | Readonly<{ kind: 'text'; text: string }>
    | Readonly<{ kind: 'binary'; data: Uint8Array }>;

export type PluginWebSocketClose = Readonly<{
    kind: 'remote' | 'local' | 'aborted' | 'generationRetired' | 'hostShutdown' | 'error';
    code?: number;
    reason?: string;
    wasClean: boolean;
    diagnostic?: PluginDiagnosticData;
}>;

export type PluginWebSocketOpenInput = Readonly<{
    url: string;
    protocols?: readonly string[];
    headers?: readonly PluginWebSocketHeader[];
    allowInsecureWs?: boolean;
    connectTimeoutMs?: number;
    maxMessageBytes?: number;
    maxPendingMessages?: number;
    maxPendingBytes?: number;
    maxBufferedSendBytes?: number;
}>;

export interface PluginWebSocketConnection extends Disposable {
    readonly url: string;
    readonly protocol: string;
    readonly closed: Promise<PluginWebSocketClose>;
    send(message: PluginWebSocketMessage, options?: PluginCancellationOptions): Promise<void>;
    receive(options?: PluginCancellationOptions): Promise<PluginWebSocketMessage | Readonly<{
        kind: 'closed';
        close: PluginWebSocketClose;
    }>>;
    close(request?: Readonly<{ code?: number; reason?: string }>): void;
}

export type HttpRequest = Readonly<{
    url: string;
    method?: HttpMethod;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
    credentialBinding?: PluginFetchCredentialBinding;
    redirect: 'error' | 'follow' | 'manual';
    timeoutMs?: number;
    /** Release the response body without reading it when only metadata is needed. */
    responseBody?: 'buffer' | 'discard';
    /** Observe this request's natively validated HTTPS peer; absence remains unknown. */
    observeTlsPeer?: true;
}>;
export type HttpResponse = Readonly<{
    status: number;
    finalUrl: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    /** Metadata from this exact request, never a grant or substitute for endpoint admission. */
    tlsPeer?: Readonly<{
        url: string;
        fingerprint256: string;
        notBefore: number;
        notAfter: number;
    }>;
}>;

/** A bodyless read stream; credentials come from the admitted invocation purpose. */
export type HttpStreamRequest = Readonly<{
    url: string;
    method?: 'GET' | 'HEAD';
    headers?: Readonly<Record<string, string>>;
    redirect: 'error' | 'follow' | 'manual';
    timeoutMs?: number;
    body?: never;
    credentialBinding?: Extract<PluginFetchCredentialBinding, { kind: 'connectedAccountPurpose' }>;
}>;

/** Incremental response bytes, owned by the caller's current read lifetime. */
export type HttpStreamResponse = Readonly<{
    status: number;
    finalUrl: string;
    headers: Readonly<Record<string, string>>;
    chunks: AsyncIterable<Uint8Array>;
    /** Releases the body even when iteration has not started; safe to repeat. */
    dispose(): Promise<void>;
}>;

/** Trusted plugin declaration of the exact request's read-only semantics. */
export type HttpPreparedReadInput = Omit<HttpRequest, 'method' | 'credentialBinding' | 'body'>
    & Readonly<{ body?: Uint8Array }> & (
    | Readonly<{ intent: 'get'; method?: 'GET' }>
    | Readonly<{ intent: 'graphqlQuery'; method: 'POST' }>
);

/** An admitted immutable request, consumable once under its owner's cancellation. */
export interface PreparedHttpRead {
    request(options: { signal: AbortSignal }): Promise<HttpResponse>;
    /** Aborts this read and resolves after the host releases retained custody. */
    dispose(): Promise<void>;
}

export interface HttpService {
    request(input: HttpRequest, options?: { signal?: AbortSignal }): Promise<HttpResponse>;
    /** @realm cli */
    requestStream(input: HttpStreamRequest, options?: { signal?: AbortSignal }): Promise<HttpStreamResponse>;
    /**
     * Admits and snapshots a read without sending HTTP. The handle preserves this
     * invocation's policy and currentness, but uses its request owner's signal.
     * GraphQL query semantics are declared by trusted plugin code, never inferred
     * from arbitrary POST bytes. Credential bindings remain invocation-bound.
     */
    prepareRead(input: HttpPreparedReadInput, options?: { signal?: AbortSignal }): Promise<PreparedHttpRead>;
    openWebSocket(
        input: PluginWebSocketOpenInput,
        options?: PluginCancellationOptions,
    ): Promise<PluginWebSocketConnection>;
}
