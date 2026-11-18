/** @moduleRealm daemon */
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type { AgentNativeLaunchQualifier } from '../exec.js';

export type {
    HttpMethod,
    PluginFetchCredentialBinding,
    PluginWebSocketHeader,
    PluginWebSocketMessage,
    PluginWebSocketClose,
    PluginWebSocketOpenInput,
    PluginWebSocketConnection,
    HttpRequest,
    HttpResponse,
    HttpStreamRequest,
    HttpStreamResponse,
    HttpPreparedReadInput,
    PreparedHttpRead,
    HttpService,
} from '@happier-dev/cli-common/plugins/http/contracts';

export type PluginPath =
    | Readonly<{ root: 'pluginData'; relativePath: string }>
    | Readonly<{ root: 'workspace'; relativePath: string }>
    | Readonly<{ root: 'project'; projectId: string; relativePath: string }>;

export interface FileSystemService {
    /** Create or reopen a durable directory under this plugin's existing data
     * root; relativePath can select configuration-specific storage.
     * The absolute native path can be passed to Exec.
     * Releasing an invocation does not remove its contents. */
    getPluginDataDirectory(input?: Readonly<{ relativePath?: string; signal?: AbortSignal }>): Promise<string>;
    /** Observe only metadata of a declared read-only Machine path. The ready
     * snapshot includes changes during attachment. Cancellation or disposal
     * invalidates reads; disposal awaits native watcher cleanup. The host retains
     * watcher ownership, and this grants no file content or writes. */
    observeMachinePath(input: Readonly<{ absolutePath: string }>,
        emit: (event: Readonly<{ kind: 'changed'; identity: string | null; size: number | null }>
            | Readonly<{ kind: 'unavailable'; code: string; retryable: boolean }>) => void,
        options?: PluginCancellationOptions,
    ): Promise<Disposable & Readonly<{
        identity: string | null;
        size: number | null;
        read(): Promise<Readonly<{ identity: string; size: number }> | null>;
    }>>;
    /**
     * Publish acquired bytes from an admitted file-writing Action with operation metadata.
     * The host returns an accepted receipt to the Action caller before destination delivery;
     * this method remains pending until the incumbent receiver completes or fails, then
     * returns the final result to the handler. Accepted is not proof that bytes were saved.
     * The native transfer owns cancellation and effect-outcome reporting; the operation
     * still waits for any later handler work, whose failure is not erased by delivery.
     */
    prepareDownload(input: Readonly<{ name: string; bytes: Uint8Array;
        destination: import('../protocol/fileDownload.js').FileDownloadDestinationV1 }>,
        options?: { signal?: AbortSignal }): Promise<import('../protocol/fileDownload.js').FileDownloadResultV1>;
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
declare const deploymentExecEnvAttachmentV1: unique symbol;

/** Opaque host-only values. Phase/operational custody is single-use; backup
 * custody lends to commands until the admitted job disposes it or is cancelled. */
export interface DeploymentExecEnvAttachmentV1 extends Disposable {
    readonly [deploymentExecEnvAttachmentV1]: true;
}

/** Selects admitted phase inputs, one operational binding or one backup config group without returning values. */
export interface DeploymentExecEnvPortV1 {
    prepare(input: Readonly<{
        source: import('./deployments.js').DeploymentSourceMaterializationV1;
        phase: 'build' | 'runtime';
        bindingIdentity?: never;
        backupDestination?: never;
    }> | Readonly<{
        /** Opaque identity from deployment-protocol's environmentSecretBindingIdentityV1. */
        bindingIdentity: string;
        source?: never;
        phase?: never;
        backupDestination?: never;
    }> | Readonly<{
        /** Roles come from the host-admitted current destination. Reuse this
         * handle within one admitted backup/restore job; dispose it in its finally. */
        backupDestination: Readonly<{ configKey: 'destination' }>;
        bindingIdentity?: never;
        source?: never;
        phase?: never;
    }>, options?: PluginCancellationOptions): Promise<DeploymentExecEnvAttachmentV1>;
}

export type PluginExecSpawnRequest = Readonly<{
    executable: ManagedExecutableRef;
    args?: readonly string[];
    /** Transient absolute files required by this launch. A native identity switch
     * requires them in its selected material; host-private paths fail before spawn. */
    requiredFiles?: readonly string[];
    /** Process-only selected absolute cwd, or an existing admitted filesystem root. */
    cwd?: PluginPath | string;
    env?: Readonly<Record<string, string>>;
    /** Single-use phase/operational custody, or a backup job's per-command loan;
     * never a plugin-readable map. */
    deploymentEnv?: DeploymentExecEnvAttachmentV1;
    stdin?: Uint8Array;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
}>;
export type PluginAgentCliReadinessRequest = Readonly<{
    /** Read the installed CLI version through the host's canonical probe when requested. */
    includeVersion?: boolean;
    candidates: readonly string[];
    requirement: 'any' | 'all';
    cwd?: string;
    projectId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
}>;
export type PluginAgentCliReadinessResult = Readonly<{
    launchable: readonly Readonly<{ agentId: string; version?: string }>[];
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
    /** Root exit or spawn failure; inherited pipes may still be open. */
    waitForExit(): Promise<PluginProcessResult['termination']>;
    /** Complete captured output, after stdout and stderr close. */
    wait(): Promise<PluginProcessResult>;
    onOutput(listener: (chunk: PluginProcessOutput) => void): Disposable;
    dispose(): Promise<void>;
}

export interface PluginJsonRpcClient extends Disposable {
    request(method: string, params?: JsonValue, options?: { signal?: AbortSignal; timeoutMs?: number | null }): Promise<JsonValue>;
    notify(method: string, params?: JsonValue): Promise<void>;
    /** Observes a parsed native notification synchronously before ordered callback dispatch.
     * Observation only: callbacks must not transform the frame or perform asynchronous work. */
    onNotificationReceived(listener: (message: Readonly<{ method: string; params?: JsonValue; receivedAtMs: number }>) => void): Disposable;
    onNotification(listener: (message: { method: string; params?: JsonValue }) => void | Promise<void>): Disposable;
    onRequest(method: string, listener: (request: { id: string | number; method: string; params?: JsonValue }) => JsonValue | Promise<JsonValue>): Disposable;
}
export interface PluginJsonStreamClient extends Disposable {
    write(value: JsonValue): Promise<void>;
    subscribe(listener: (value: JsonValue) => void | Promise<void>): Disposable;
    /**
     * Only for a spawn that declared `adoptsHeldAgentTurns`: what this client
     * attached to, from the Session holder's stored state (`none`: a fresh
     * Agent; `idle`: an adopted Agent with no turn running; `turn`: an adopted
     * Agent still answering the previous runner's turn; `unknown`: the declared
     * shape tracks no turns).
     */
    readonly heldAgentTurn?: Promise<'none' | 'idle' | 'turn' | 'unknown'>;
}
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
    | Readonly<{
        kind: 'jsonRpc';
        launch: PluginExecSpawnRequest;
        framing: 'jsonLines' | 'contentLength' | 'webSocket';
        /** An explicit caller-owned frame budget; omitted means no payload-size cap. */
        maxFrameBytes?: number;
        requestTimeoutMs?: number;
        cancellationMethod?: string;
        /**
         * The runtime surfaces Agent output that arrives without a turn it started
         * (an Agent adopted after its runner crashed) as a provider-started turn
         * once its session is open. Only then may the host keep the Agent running
         * across a runner crash for the respawned runner to adopt.
         */
        adoptsHeldAgentTurns?: true;
    }>
    | Readonly<{
        kind: 'jsonStream';
        launch: PluginExecSpawnRequest;
        maxFrameBytes: number;
        /**
         * As for `jsonRpc`: the runtime surfaces an adopted Agent's in-flight turn
         * as a provider-started turn. The value names the stream's request shape,
         * so the host can keep the Agent's request ids apart across runners:
         * - `streamJsonControl`: `control_request`/`control_response` by `request_id`
         *   (Claude Code stream-json);
         * - `commandResponse`: `{type, id}` commands answered by `{type: 'response', id}`;
         *   records whose type ends in `_response` answer the Agent's own requests.
         */
        adoptsHeldAgentTurns?: 'streamJsonControl' | 'commandResponse';
    }>
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
/** A connection to an already-owned native Unix endpoint; it never starts its server. */
export type PluginJsonRpcConnectionSpec = Readonly<{
    endpoint: Readonly<{ kind: 'unixWebSocket'; socketPath: string }>;
    maxFrameBytes?: number;
    requestTimeoutMs?: number;
    cancellationMethod?: string;
}>;
export interface PluginJsonRpcConnection extends Disposable {
    readonly client: PluginJsonRpcClient;
    readonly closed: Promise<void>;
    dispose(): Promise<void>;
}
export interface ProtocolClientsService {
    connectJsonRpc(spec: PluginJsonRpcConnectionSpec, options?: { signal?: AbortSignal }): Promise<PluginJsonRpcConnection>;
    spawn<K extends PluginProtocolClientKind>(spec: PluginProtocolClientSpecByKind<K>, options?: { signal?: AbortSignal; nativeLaunch?: AgentNativeLaunchQualifier }): Promise<PluginProtocolClientHandle<K>>;
}
