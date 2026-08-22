/** @moduleRealm daemon */
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { ManagedExecutableRef } from '@happier-dev/protocol';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export const MAX_PLUGIN_FETCH_REDIRECTS = 10;

export type PluginFetchCredentialBinding =
    Readonly<{
        kind: 'voiceAccountOperation';
        provider: PluginContributionRef;
        operation: string;
        parameters: Readonly<Record<string, JsonValue>>;
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

export interface HttpService {
    request(input: Readonly<{
        url: string;
        method?: HttpMethod;
        headers?: Readonly<Record<string, string>>;
        body?: Uint8Array;
        credentialBinding?: PluginFetchCredentialBinding;
        redirect: 'error' | 'follow' | 'manual';
        timeoutMs?: number;
    }>, options?: { signal?: AbortSignal }): Promise<{
        status: number;
        finalUrl: string;
        headers: Readonly<Record<string, string>>;
        body: Uint8Array;
    }>;
    openWebSocket(
        input: PluginWebSocketOpenInput,
        options?: PluginCancellationOptions,
    ): Promise<PluginWebSocketConnection>;
}

export type PluginPath =
    | Readonly<{ root: 'pluginData'; relativePath: string }>
    | Readonly<{ root: 'workspace'; relativePath: string }>
    | Readonly<{ root: 'project'; projectId: string; relativePath: string }>;

export interface FileSystemService {
    readFile(path: PluginPath, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<Uint8Array>;
    writeFile(path: PluginPath, data: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
    stat(path: PluginPath, options?: { signal?: AbortSignal }): Promise<{ kind: 'file' | 'directory'; size: number; modifiedAtMs: number }>;
    list(path: PluginPath, options?: { cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{
        items: readonly Readonly<{ name: string; kind: 'file' | 'directory' }>[];
        nextCursor?: string;
    }>;
    remove(path: PluginPath, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>;
}

export type { ManagedExecutableRef } from '@happier-dev/protocol';
export type PluginExecSpawnRequest = Readonly<{
    executable: ManagedExecutableRef;
    args?: readonly string[];
    cwd?: PluginPath;
    env?: Readonly<Record<string, string>>;
    stdin?: Uint8Array;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
}>;
export type PluginAgentCliReadinessRequest = Readonly<{
    candidates: readonly string[];
    requirement: 'any' | 'all';
    cwd?: string;
    projectId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
}>;
export type PluginAgentCliReadinessResult = Readonly<{
    launchable: readonly Readonly<{ agentId: string }>[];
}>;
export type PluginProcessOutput = Readonly<{ sequence: number; stream: 'stdout' | 'stderr'; data: Uint8Array }>;
export type PluginProcessObservedTermination =
    | Readonly<{ kind: 'exit'; exitCode: number }>
    | Readonly<{ kind: 'signal'; signal: string }>
    | Readonly<{ kind: 'failed'; diagnostic: PluginDiagnosticData }>;
export type PluginProcessTerminationRequest =
    | Readonly<{ kind: 'none' | 'timeout' | 'abort' }>
    | Readonly<{ kind: 'dispose'; reason?: 'caller' | 'generationRetired' | 'hostShutdown' | 'runtimeRecovery' }>;
export type PluginProcessResult = Readonly<{
    termination: Readonly<{ observed: PluginProcessObservedTermination; requestedBy: PluginProcessTerminationRequest }>;
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}>;

export interface PluginProcessHandle extends Disposable {
    write(data: Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    wait(): Promise<PluginProcessResult>;
    onOutput(listener: (chunk: PluginProcessOutput) => void): Disposable;
    dispose(): Promise<void>;
}

export interface PluginJsonRpcClient extends Disposable {
    request(method: string, params?: JsonValue, options?: { signal?: AbortSignal; timeoutMs?: number | null }): Promise<JsonValue>;
    notify(method: string, params?: JsonValue): Promise<void>;
    onNotification(listener: (message: { method: string; params?: JsonValue }) => void | Promise<void>): Disposable;
    onRequest(method: string, listener: (request: { id: string | number; method: string; params?: JsonValue }) => JsonValue | Promise<JsonValue>): Disposable;
}
export interface PluginJsonStreamClient extends Disposable { write(value: JsonValue): Promise<void>; subscribe(listener: (value: JsonValue) => void | Promise<void>): Disposable }
export interface PluginFramedBytesClient extends Disposable { writeFrame(frame: Uint8Array): Promise<void>; subscribe(listener: (frame: Uint8Array) => void | Promise<void>): Disposable }
export interface PluginLoopbackWebSocketJsonClient extends Disposable { send(value: JsonValue): Promise<void>; subscribe(listener: (value: JsonValue) => void | Promise<void>): Disposable }
export type PluginLoopbackWebSocketHeader = Readonly<{
    name: string;
    value: string;
    sensitive?: boolean;
}>;
export type PluginLoopbackWebSocketEndpoint = Readonly<{
    host: '127.0.0.1' | '::1';
    port: number;
    path?: string;
    headers?: readonly PluginLoopbackWebSocketHeader[];
}>;
export type PluginLoopbackWebSocketHandshake = Readonly<{
    framing: 'lengthPrefix';
    byteOrder: 'little-endian' | 'big-endian';
    requestFrames: readonly (Uint8Array | string)[];
    decodeResponse(response: Uint8Array): PluginLoopbackWebSocketEndpoint | Promise<PluginLoopbackWebSocketEndpoint>;
}>;
export type PluginLoopbackWebSocketClientSpec =
    | Readonly<{
        kind: 'loopbackWebSocketJson';
        launch: PluginExecSpawnRequest;
        endpoint: PluginLoopbackWebSocketEndpoint;
        handshake?: never;
        maxFrameBytes: number;
    }>
    | Readonly<{
        kind: 'loopbackWebSocketJson';
        launch: PluginExecSpawnRequest;
        endpoint?: never;
        handshake: PluginLoopbackWebSocketHandshake;
        maxFrameBytes: number;
    }>;
export type PluginProtocolClientSpec =
    | Readonly<{ kind: 'jsonRpc'; launch: PluginExecSpawnRequest; framing: 'jsonLines' | 'contentLength'; maxFrameBytes: number; requestTimeoutMs?: number }>
    | Readonly<{ kind: 'jsonStream'; launch: PluginExecSpawnRequest; maxFrameBytes: number }>
    | Readonly<{ kind: 'framedBytes'; launch: PluginExecSpawnRequest; framing: 'lengthPrefix' | 'contentLength'; maxFrameBytes: number }>
    | PluginLoopbackWebSocketClientSpec;
export type PluginProtocolClientByKind = {
    jsonRpc: PluginJsonRpcClient;
    jsonStream: PluginJsonStreamClient;
    framedBytes: PluginFramedBytesClient;
    loopbackWebSocketJson: PluginLoopbackWebSocketJsonClient;
};
export type PluginProtocolClientKind = keyof PluginProtocolClientByKind;
export type PluginProtocolClientSpecByKind<K extends PluginProtocolClientKind> =
    Extract<PluginProtocolClientSpec, { kind: K }>;
export interface PluginProtocolClientHandle<K extends PluginProtocolClientKind = PluginProtocolClientKind> extends Disposable {
    readonly client: PluginProtocolClientByKind[K];
    readonly process: PluginProcessHandle;
    wait(): Promise<PluginProcessResult>;
    dispose(): Promise<void>;
}
export interface ProtocolClientsService {
    spawn<K extends PluginProtocolClientKind>(spec: PluginProtocolClientSpecByKind<K>, options?: { signal?: AbortSignal }): Promise<PluginProtocolClientHandle<K>>;
}
