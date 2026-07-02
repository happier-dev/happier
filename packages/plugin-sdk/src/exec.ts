export type ExecAgentCliLaunchInputV1 = Readonly<{
    kind: 'agent-cli';
    agentId: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string | Uint8Array;
}>;

export type ExecBinaryLaunchInputV1 = Readonly<{
    kind: 'binary';
    executablePath: string;
    args?: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string | Uint8Array;
}>;

export type ExecIpcLaunchInputV1 = Readonly<{
    kind: 'ipc';
    endpoint: string;
}>;

export type ExecLaunchInputV1 =
    | ExecAgentCliLaunchInputV1
    | ExecBinaryLaunchInputV1
    | ExecIpcLaunchInputV1;

export type ExecRunOptionsV1 = Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
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

export type ExecClientFramingV1 =
    | ExecStrictLfJsonFramingV1
    | ExecFramedBytesFramingV1;

export type ExecClientTransportV1 = Readonly<{
    kind: 'stdio';
    framing: ExecClientFramingV1;
    encoding?: string;
    maxFrameBytes?: number;
}>;

export type ExecJsonRpcClientProtocolV1 = Readonly<{ kind: 'json-rpc-2.0' }>;

export type ExecJsonStreamClientProtocolV1 = Readonly<{
    kind: 'json-stream';
    recordSchema?: unknown;
}>;

export type ExecFramedBytesClientProtocolV1 = Readonly<{
    kind: 'framed-bytes';
    frameSchema?: unknown;
}>;

export type ExecClientProtocolV1 =
    | ExecJsonRpcClientProtocolV1
    | ExecJsonStreamClientProtocolV1
    | ExecFramedBytesClientProtocolV1;

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

export type JsonStreamClientV1 = Readonly<{
    readonly closed: Promise<void>;
    // Records are pushed to subscribers from subscription time onward; the host does not buffer
    // records that arrive before the first subscriber attaches. Subscribe before the launched
    // process can emit (i.e. immediately after spawnClient resolves) to avoid missing records.
    subscribe(listener: JsonStreamRecordListenerV1): () => void;
    writeRecord(record: unknown, options?: ExecStreamWriteOptionsV1): Promise<void>;
}>;

export type FramedBytesListenerV1 = (frame: Uint8Array) => void | Promise<void>;

export type FramedBytesClientV1 = Readonly<{
    readonly closed: Promise<void>;
    subscribe(listener: FramedBytesListenerV1): () => void;
    writeFrame(frame: Uint8Array, options?: ExecStreamWriteOptionsV1): Promise<void>;
}>;

export type ExecProtocolClientV1 =
    | JsonRpcClientV1
    | JsonStreamClientV1
    | FramedBytesClientV1;

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

export type ExecClientSpecV1 =
    | ExecJsonRpcClientSpecV1
    | ExecJsonStreamClientSpecV1
    | ExecFramedBytesClientSpecV1;

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
    spawnClient(spec: ExecClientSpecV1, options?: ExecRunOptionsV1): Promise<ExecClientHandleV1<ExecProtocolClientV1>>;
}
