import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type { ManagedExecutableRef } from '@happier-dev/protocol';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export const MAX_PLUGIN_FETCH_REDIRECTS = 10;
export const MAX_PLUGIN_FETCH_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_FETCH_HEADER_BYTES = 64 * 1024;

export type PluginFetchCredentialBinding =
    Readonly<{
        kind: 'voiceAccountOperation';
        provider: PluginContributionRef;
        operation: string;
        parameters: Readonly<Record<string, JsonValue>>;
    }>;

export interface PluginFetchService {
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
}

export type PluginPath =
    | Readonly<{ root: 'pluginData'; relativePath: string }>
    | Readonly<{ root: 'workspace'; relativePath: string }>
    | Readonly<{ root: 'project'; projectId: string; relativePath: string }>;

export interface PluginFileSystemService {
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
export interface PluginAgentCliReadinessService {
    checkReadiness(request: PluginAgentCliReadinessRequest): Promise<PluginAgentCliReadinessResult>;
}
export type PluginSystemToolResolveRequest = Readonly<{
    toolId: string;
    purpose: string;
    cwd?: string;
    preferredPath?: string | null;
    signal?: AbortSignal;
}>;
export type PluginSystemToolDiagnostic = Readonly<{
    code: string;
    detail?: Readonly<Record<string, string | number>>;
}>;
export type PluginResolvedSystemTool = Readonly<{
    executable: ManagedExecutableRef;
    executablePath: string;
    diagnostics?: readonly PluginSystemToolDiagnostic[];
}>;
export interface PluginSystemToolsService {
    resolve(request: PluginSystemToolResolveRequest): Promise<PluginResolvedSystemTool>;
}
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
    readonly pid: number | null;
    write(data: Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    wait(): Promise<PluginProcessResult>;
    onOutput(listener: (chunk: PluginProcessOutput) => void): Disposable;
    dispose(): Promise<void>;
}

export interface PluginJsonRpcClient extends Disposable {
    request(method: string, params?: JsonValue, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<JsonValue>;
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
export interface PluginProtocolClientsService {
    spawn<K extends PluginProtocolClientKind>(spec: PluginProtocolClientSpecByKind<K>, options?: { signal?: AbortSignal }): Promise<PluginProtocolClientHandle<K>>;
}
export interface PluginExecService {
    readonly agentCli: PluginAgentCliReadinessService;
    readonly systemTools: PluginSystemToolsService;
    run(request: PluginExecSpawnRequest & { timeoutMs?: number }, options?: { signal?: AbortSignal }): Promise<PluginProcessResult>;
    spawn(request: PluginExecSpawnRequest, options?: { signal?: AbortSignal }): Promise<PluginProcessHandle>;
    readonly clients: PluginProtocolClientsService;
}

export type ManagedDependencyStatus =
    | Readonly<{ state: 'missing'; id: string; supported: true }>
    | Readonly<{ state: 'ready'; id: string; version: string; sourceId: string; executable?: ManagedExecutableRef }>
    | Readonly<{ state: 'updateAvailable'; id: string; version: string; availableVersion: string; sourceId: string; executable?: ManagedExecutableRef }>
    | Readonly<{ state: 'unsupported' | 'failed'; id: string; code: string }>;
export type ManagedDependencyReady = Extract<ManagedDependencyStatus, { state: 'ready' }>;
export type ManagedServerCredential =
    | Readonly<{ environment: { name: string; value: string }; httpHeader?: { name: string; value: string } }>
    | Readonly<{ environment?: never; httpHeader: { name: string; value: string } }>;
export type ManagedServerMode =
    | Readonly<{ kind: 'managedSpawn'; host?: string; port?: number; baseUrl?: string; portArgument?: string; portEnvironmentKey?: string; baseUrlEnvironmentKey?: string; credential?: ManagedServerCredential }>
    | Readonly<{ kind: 'externalAttach'; baseUrl: string; credential?: ManagedServerCredential }>;
export type ManagedServerHealthCheck =
    | Readonly<{ kind: 'http'; target?: { kind: 'serverPath'; path: string } | { kind: 'url'; url: string }; headers?: Readonly<Record<string, string>>; timeoutMs?: number }>
    | Readonly<{ kind: 'command'; executable: ManagedExecutableRef; args?: readonly string[]; timeoutMs?: number }>;
type ManagedServerSpecBase = Readonly<{
    id: string;
    healthCheck?: ManagedServerHealthCheck;
    watchdog?: Readonly<{ intervalMs: number; missedIntervals: number }>;
    startupTimeoutMs?: number;
}>;
export type ManagedServerSpec = ManagedServerSpecBase & (
    | Readonly<{ mode: Extract<ManagedServerMode, { kind: 'managedSpawn' }>; launch: PluginExecSpawnRequest; durableLog?: { enabled: boolean; keepCount?: number } }>
    | Readonly<{ mode: Extract<ManagedServerMode, { kind: 'externalAttach' }>; launch?: never; durableLog?: never }>
);
export type ManagedServerSnapshot = Readonly<{
    id: string;
    instanceId: string;
    state: 'starting' | 'healthy' | 'unhealthy' | 'stopped';
    mode: ManagedServerMode['kind'];
    baseUrl: string | null;
    port: number | null;
    pid: number | null;
    startedAtMs: number | null;
    lastHealthyAtMs: number | null;
    code?: string;
}>;
export interface ManagedServerHandle extends Disposable {
    snapshot(): ManagedServerSnapshot;
    waitUntilHealthy(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ManagedServerSnapshot>;
    stop(options?: { signal?: AbortSignal }): Promise<ManagedServerStopResult>;
    dispose(): Promise<void>;
}
export type ManagedServerStopResult = Readonly<{ status: 'stopped' | 'detached' }>;
export interface PluginManagedDependenciesService {
    status(id: string, options?: { signal?: AbortSignal }): Promise<ManagedDependencyStatus>;
    ensure(id: string, options?: { signal?: AbortSignal }): Promise<ManagedDependencyReady>;
    update(id: string, options?: { signal?: AbortSignal }): Promise<ManagedDependencyReady>;
    remove(id: string, options?: { signal?: AbortSignal }): Promise<void>;
}
export interface PluginManagedServersService {
    supervise(spec: ManagedServerSpec, options?: { signal?: AbortSignal }): Promise<ManagedServerHandle>;
}
export interface PluginManagedService {
    readonly dependencies: PluginManagedDependenciesService;
    readonly servers: PluginManagedServersService;
}
