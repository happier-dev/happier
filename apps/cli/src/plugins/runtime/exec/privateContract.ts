// CLI-private predecessor execution contract retained only while host-internal callers migrate.
export type ExecAgentCliLaunchInputV1 = Readonly<{
    kind: 'agent-cli';
    agentId: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    unsetEnvKeys?: readonly string[];
    stdin?: string | Uint8Array;
}>;

export type ExecBinaryLaunchInputV1 = Readonly<{
    kind: 'binary';
    executablePath: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    unsetEnvKeys?: readonly string[];
    stdin?: string | Uint8Array;
}>;

export type ExecManagedInstallableLaunchInputV1 = Readonly<{
    kind: 'managed-installable';
    installableId: string;
    executableName?: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    unsetEnvKeys?: readonly string[];
    stdin?: string | Uint8Array;
    sourcePreference?: 'managed-first';
}>;

export type ExecIpcLaunchInputV1 = Readonly<{
    kind: 'ipc';
    endpoint: string;
}>;

export type ExecLaunchInputV1 =
    | ExecAgentCliLaunchInputV1
    | ExecBinaryLaunchInputV1
    | ExecManagedInstallableLaunchInputV1
    | ExecIpcLaunchInputV1;

export type ExecOutputStreamV1 = 'stdout' | 'stderr';

/**
 * Optional sink for raw process output chunks. The host invokes this for every stdout/stderr chunk
 * observed after spawn, in addition to (not instead of) the buffered `ExecRunResultV1` tails. It is
 * a generic tee — the consumer owns any persistence/format/redaction. Used by the managed-server
 * host to tee a supervised server's output to a durable per-server log. Must never throw.
 */
export type ExecOutputTeeV1 = Readonly<{
    onChunk: (stream: ExecOutputStreamV1, chunk: Uint8Array) => void;
}>;

export type ExecRunOptionsV1 = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    outputTee?: ExecOutputTeeV1;
}>;

export type ExecRunResultV1 = Readonly<{
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}>;

export type ExecRuntimeDiagnosticV1 = Readonly<{
    code: string;
    severity: 'info' | 'warning' | 'error';
    messageKey: string;
    detail?: Readonly<Record<string, unknown>>;
}>;

export type ExecProcessHandleV1 = Readonly<{
    pid: number | null;
    exit: Promise<ExecRunResultV1>;
    writeStdin(input: string | Uint8Array): Promise<void>;
    kill(signal?: string): void;
    dispose(): Promise<void>;
}>;

export type ExecClientStatusV1 = 'starting' | 'running' | 'exited' | 'disposed';

export type ExecClientExitListenerV1 = (result: ExecRunResultV1) => void;

export type ExecClientDisposeReasonV1 = Readonly<{
    code?: string;
    message?: string;
}>;

export type ExecStrictLfJsonFramingV1 = Readonly<{ kind: 'strict-lf-json' }>;

// Framing is fixed to a 4-byte big-endian length prefix by the host runtime
// (apps/cli/src/plugins/runtime/exec/framedBytes.ts). No configurable knobs are
// exposed so the public ABI cannot advertise framing modes the host ignores.
export type ExecFramedBytesFramingV1 = Readonly<{
    kind: 'framed-bytes';
}>;

export type ExecLengthPrefixedByteOrderV1 = 'big-endian' | 'little-endian';

export type ExecClientFramingV1 =
    | ExecStrictLfJsonFramingV1
    | ExecFramedBytesFramingV1;

export type ExecClientTransportV1 = Readonly<{
    kind: 'stdio';
    framing: ExecClientFramingV1;
    encoding?: string;
    maxFrameBytes?: number;
}>;

export type ExecLoopbackWebSocketHandshakeResponseV1 = Readonly<{
    byteOrder?: ExecLengthPrefixedByteOrderV1;
    maxFrameBytes?: number;
    timeoutMs?: number;
}>;

export type ExecLoopbackWebSocketHandshakeV1 = Readonly<{
    byteOrder: ExecLengthPrefixedByteOrderV1;
    requestFrames: readonly (Uint8Array | string)[];
    response?: ExecLoopbackWebSocketHandshakeResponseV1;
}>;

export type ExecLoopbackWebSocketConnectV1 = Readonly<{
    timeoutMs?: number;
    retryInitialDelayMs?: number;
    retryMaxDelayMs?: number;
}>;

export type ExecLoopbackWebSocketShutdownV1 = Readonly<{
    kind: 'close-stdin';
    graceMs?: number;
}>;

export type ExecLoopbackWebSocketLimitsV1 = Readonly<{
    maxMessageBytes?: number;
    maxPendingMessages?: number;
    maxBufferedBytes?: number;
}>;

export type ExecLoopbackWebSocketTransportV1 = Readonly<{
    kind: 'spawned-loopback-websocket';
    handshake: ExecLoopbackWebSocketHandshakeV1;
    connect?: ExecLoopbackWebSocketConnectV1;
    shutdown?: ExecLoopbackWebSocketShutdownV1;
    limits?: ExecLoopbackWebSocketLimitsV1;
}>;

export type ExecClientAnyTransportV1 =
    | ExecClientTransportV1
    | ExecLoopbackWebSocketTransportV1;

export type ExecJsonRpcClientProtocolV1 = Readonly<{ kind: 'json-rpc-2.0' }>;

export type ExecJsonStreamClientProtocolV1 = Readonly<{
    kind: 'json-stream';
    recordSchema?: unknown;
}>;

export type ExecFramedBytesClientProtocolV1 = Readonly<{
    kind: 'framed-bytes';
    frameSchema?: unknown;
}>;

export type ExecLoopbackWebSocketEndpointV1 = Readonly<{
    url?: string;
    protocol?: string;
    host?: string;
    port?: number;
    path?: string;
} & Record<string, unknown>>;

export type ExecLoopbackWebSocketHeaderV1 = Readonly<{
    name: string;
    value: string;
    sensitive?: boolean;
}>;

export type ExecLoopbackWebSocketEndpointCodecV1<
    TEndpoint extends ExecLoopbackWebSocketEndpointV1 = ExecLoopbackWebSocketEndpointV1,
> = Readonly<{
    decodeHandshakeResponse(response: Uint8Array): TEndpoint | Promise<TEndpoint>;
    buildHeaders?: (endpoint: TEndpoint) => readonly ExecLoopbackWebSocketHeaderV1[];
}>;

export type ExecLoopbackWebSocketJsonProtocolV1<
    TEndpoint extends ExecLoopbackWebSocketEndpointV1 = ExecLoopbackWebSocketEndpointV1,
> = Readonly<{
    kind: 'json-websocket';
    endpoint: ExecLoopbackWebSocketEndpointCodecV1<TEndpoint>;
}>;

export type ExecClientProtocolV1 =
    | ExecJsonRpcClientProtocolV1
    | ExecJsonStreamClientProtocolV1
    | ExecFramedBytesClientProtocolV1
    | ExecLoopbackWebSocketJsonProtocolV1;

export type ExecClientLifecycleV1 = Readonly<{
    requestTimeoutMs?: number;
    maxStderrBytes?: number;
    diagnostics?: ExecClientDiagnosticsV1;
}>;

export type ExecClientDiagnosticSanitizerV1 = Readonly<{
    redactedValues?: readonly string[];
    sensitiveKeys?: readonly string[];
    maxStringBytes?: number;
    maxArrayItems?: number;
    maxObjectKeys?: number;
    maxDepth?: number;
}>;

export type ExecClientRpcLogV1 = Readonly<{
    kind: 'file';
    path: string;
    maxBytes?: number;
    rotateCount?: number;
}>;

export type ExecClientDiagnosticsV1 = Readonly<{
    rpcLog?: ExecClientRpcLogV1;
    sanitizer?: ExecClientDiagnosticSanitizerV1;
}>;

export type JsonRpcRequestOptionsV1 = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
}>;

export type JsonRpcRequestHandlerContextV1 = Readonly<{
    method: string;
    requestId?: string;
    signal?: AbortSignal;
}>;

export type JsonRpcRequestHandlerV1<TParams = unknown, TResult = unknown> = (
    params: TParams,
    context: JsonRpcRequestHandlerContextV1,
) => Promise<TResult> | TResult;

export type JsonRpcNotificationHandlerV1<TParams = unknown> = (
    params: TParams,
    context: Readonly<{ method: string }>,
) => Promise<void> | void;

export type JsonRpcMessageHookDecisionV1 =
    | 'pass'
    | 'suppress'
    | Readonly<{
        kind: 'replace';
        message: unknown;
    }>;

export type JsonRpcMessageHookV1 = (
    message: unknown,
    context: Readonly<{ phase: 'incoming' | 'outgoing' }>,
) => JsonRpcMessageHookDecisionV1 | Promise<JsonRpcMessageHookDecisionV1>;

export type JsonRpcClientV1 = Readonly<{
    request<TParams = unknown, TResult = unknown>(
        method: string,
        params?: TParams,
        options?: JsonRpcRequestOptionsV1,
    ): Promise<TResult>;
    notify<TParams = unknown>(method: string, params?: TParams): Promise<void>;
    registerRequestHandler<TParams = unknown, TResult = unknown>(
        method: string,
        handler: JsonRpcRequestHandlerV1<TParams, TResult>,
    ): () => void;
    registerNotificationHandler<TParams = unknown>(
        method: string,
        handler: JsonRpcNotificationHandlerV1<TParams>,
    ): () => void;
}>;

export type ExecStreamWriteOptionsV1 = Readonly<{
    signal?: AbortSignal;
}>;

export type JsonStreamRecordListenerV1 = (record: unknown) => void | Promise<void>;

export type JsonStreamWriteOutcomeV1 =
    | Readonly<{ kind: 'written' }>
    | Readonly<{ kind: 'rejected_before_write'; error: Error }>
    | Readonly<{ kind: 'write_may_have_occurred'; error: Error }>;

export type JsonStreamClientV1 = Readonly<{
    readonly closed: Promise<void>;
    // Records are pushed to subscribers from subscription time onward; the host does not buffer
    // records that arrive before the first subscriber attaches. Subscribe before the launched
    // process can emit (i.e. immediately after spawnClient resolves) to avoid missing records.
    subscribe(listener: JsonStreamRecordListenerV1): () => void;
    writeRecord(record: unknown, options?: ExecStreamWriteOptionsV1): Promise<JsonStreamWriteOutcomeV1>;
}>;

export type FramedBytesListenerV1 = (frame: Uint8Array) => void | Promise<void>;

export type FramedBytesClientV1 = Readonly<{
    readonly closed: Promise<void>;
    subscribe(listener: FramedBytesListenerV1): () => void;
    writeFrame(frame: Uint8Array, options?: ExecStreamWriteOptionsV1): Promise<void>;
}>;

export type LoopbackWebSocketJsonMessageListenerV1 = (message: unknown) => void | Promise<void>;

export type LoopbackWebSocketJsonClientV1 = Readonly<{
    readonly closed: Promise<void>;
    subscribe(listener: LoopbackWebSocketJsonMessageListenerV1): () => void;
    sendJson(message: unknown, options?: ExecStreamWriteOptionsV1): Promise<void>;
}>;

export type ExecProtocolClientV1 =
    | JsonRpcClientV1
    | JsonStreamClientV1
    | FramedBytesClientV1
    | LoopbackWebSocketJsonClientV1;

export type ExecClientHandlersV1 = Readonly<{
    jsonRpc?: Readonly<{
        requests?: Readonly<Record<string, JsonRpcRequestHandlerV1>>;
        notifications?: Readonly<Record<string, JsonRpcNotificationHandlerV1>>;
    }>;
}>;

export type ExecClientHooksV1 = Readonly<{
    jsonRpc?: Readonly<{
        onMessage?: JsonRpcMessageHookV1;
    }>;
}>;

export type ExecJsonRpcClientSpecV1 = Readonly<{
    launch: ExecLaunchInputV1;
    transport: ExecClientTransportV1;
    protocol: ExecJsonRpcClientProtocolV1;
    handlers?: ExecClientHandlersV1;
    hooks?: ExecClientHooksV1;
    lifecycle?: ExecClientLifecycleV1;
}>;

export type ExecJsonStreamClientSpecV1 = Readonly<{
    launch: ExecLaunchInputV1;
    transport: ExecClientTransportV1;
    protocol: ExecJsonStreamClientProtocolV1;
    handlers?: ExecClientHandlersV1;
    hooks?: ExecClientHooksV1;
    lifecycle?: ExecClientLifecycleV1;
}>;

export type ExecFramedBytesClientSpecV1 = Readonly<{
    launch: ExecLaunchInputV1;
    transport: ExecClientTransportV1;
    protocol: ExecFramedBytesClientProtocolV1;
    handlers?: ExecClientHandlersV1;
    hooks?: ExecClientHooksV1;
    lifecycle?: ExecClientLifecycleV1;
}>;

export type ExecLoopbackWebSocketJsonClientSpecV1<
    TEndpoint extends ExecLoopbackWebSocketEndpointV1 = ExecLoopbackWebSocketEndpointV1,
> = Readonly<{
    launch: ExecLaunchInputV1;
    transport: ExecLoopbackWebSocketTransportV1;
    protocol: ExecLoopbackWebSocketJsonProtocolV1<TEndpoint>;
    handlers?: ExecClientHandlersV1;
    hooks?: ExecClientHooksV1;
    lifecycle?: ExecClientLifecycleV1;
}>;

export type ExecClientSpecV1 =
    | ExecJsonRpcClientSpecV1
    | ExecJsonStreamClientSpecV1
    | ExecFramedBytesClientSpecV1
    | ExecLoopbackWebSocketJsonClientSpecV1;

export type ExecClientHandleV1<TClient = JsonRpcClientV1> = Readonly<{
    client: TClient;
    process: ExecProcessHandleV1;
    readonly status: ExecClientStatusV1;
    onExit(listener: ExecClientExitListenerV1): () => void;
    dispose(reason?: ExecClientDisposeReasonV1): Promise<void>;
}>;

export type SystemToolSourceV1 = 'system' | 'user_config' | 'managed';

export type SystemToolResolveRequestV1 = Readonly<{
    toolId: string;
    purpose: string;
    cwd?: string;
    preferredPath?: string | null;
    preferredCommand?: string | null;
    signal?: AbortSignal;
}>;

export type SystemToolDiagnosticV1 = ExecRuntimeDiagnosticV1;

export type SystemToolLaunchGrantV1 = Readonly<{
    grantId: string;
    toolId: string;
    displayName: string;
    source: SystemToolSourceV1;
    executablePath: string;
    launch: ExecBinaryLaunchInputV1;
    allowedArguments?: readonly string[];
    diagnostics?: readonly SystemToolDiagnosticV1[];
    expiresAt?: number | null;
}>;

export interface ExecSystemToolServiceV1 {
    resolve(request: SystemToolResolveRequestV1): Promise<SystemToolLaunchGrantV1>;
}

export interface ExecRuntimeServiceV1 {
    readonly systemTools: ExecSystemToolServiceV1;
    run(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecRunResultV1>;
    spawn(input: ExecLaunchInputV1, options?: ExecRunOptionsV1): Promise<ExecProcessHandleV1>;
    spawnClient(spec: ExecJsonRpcClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<JsonRpcClientV1>>;
    spawnClient(spec: ExecJsonStreamClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<JsonStreamClientV1>>;
    spawnClient(spec: ExecFramedBytesClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<FramedBytesClientV1>>;
    spawnClient(spec: ExecLoopbackWebSocketJsonClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<LoopbackWebSocketJsonClientV1>>;
    spawnClient(spec: ExecClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<ExecProtocolClientV1>>;
}

// Host-private shapes retained by the daemon local-service bridge after the
// public legacy SDK barrel was removed. The bridge protocol is the wire owner;
// these types keep its in-process callers aligned without republishing it.
export type LocalServiceLaunchV1 =
    | Readonly<{
        kind: 'agent-cli';
        agentId: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
    }>
    | Readonly<{
        kind: 'binary';
        executablePath: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
    }>
    | Readonly<{
        kind: 'managed-installable';
        installableId: string;
        executableName?: string;
        args?: readonly string[];
        cwd?: string;
        env?: Readonly<Record<string, string>>;
        unsetEnvKeys?: readonly string[];
        stdin?: string | Uint8Array;
        sourcePreference?: 'managed-first' | 'system-first';
    }>
    | Readonly<{ kind: 'ipc'; endpoint: string }>;

export type LocalServiceDeclarationV1 = Readonly<{
    id: string;
    launch: LocalServiceLaunchV1;
    launchMode:
        | Readonly<{ kind: 'detectAfterLaunch'; minimumConfidence?: 'high' | 'medium' | 'low' }>
        | Readonly<{
            kind: 'assignAndInject';
            portPolicy:
                | Readonly<{ kind: 'fixed'; port: number; onCollision?: 'fail' | 'fallback' }>
                | Readonly<{ kind: 'allocated'; preferredPort?: number; onCollision?: 'fail' | 'fallback' }>
                | Readonly<{ kind: 'inherited'; envName: string }>;
            environment?: Readonly<{ inject?: readonly string[] }>;
        }>
        | Readonly<{
            kind: 'externalRegistered';
            inventoryId: string;
            minimumConfidence?: 'high' | 'medium' | 'low';
        }>;
    hostPolicy: Readonly<{ kind: 'loopback'; host?: string }>;
    name:
        | Readonly<{ strategy: 'derived'; base: string }>
        | Readonly<{ strategy: 'fixed'; name: string }>;
    healthCheck:
        | Readonly<{ kind: 'none' }>
        | Readonly<{ kind: 'http'; path?: string; timeoutMs?: number }>
        | Readonly<{ kind: 'command'; launch: LocalServiceLaunchV1; timeoutMs?: number }>;
    restart: Readonly<{ kind: 'never' }>;
    cleanup: Readonly<{ staleAfterMs: number }>;
}>;

export type LocalServiceRuntimeSnapshotV1 = Readonly<{
    id: string;
    phase: 'starting' | 'detecting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
    inventoryId?: string;
    port?: number;
    url?: string;
    diagnostics: readonly Readonly<{
        code: string;
        message?: string;
        severity?: 'info' | 'warning' | 'error';
    }>[];
}>;

export type FetchRuntimeHeadersV1 = Readonly<Record<string, string>>;

export type FetchRuntimeRequestV1 = Readonly<{
    url: string;
    method?: string;
    headers?: FetchRuntimeHeadersV1;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type FetchRuntimeResponseV1 = Readonly<{
    ok: boolean;
    status: number;
    statusText?: string;
    headers: FetchRuntimeHeadersV1;
    body?: unknown;
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type FetchRuntimeServiceV1 = (
    request: FetchRuntimeRequestV1,
) => Promise<FetchRuntimeResponseV1>;
