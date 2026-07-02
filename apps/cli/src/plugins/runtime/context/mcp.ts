import type {
    ErrorRuntimeServiceV1,
    ExecRuntimeServiceV1,
    JsonRpcClientV1,
    McpClientHandleV1,
    McpClientSpecV1,
    McpResolveForSessionInputV1,
    McpRuntimeServiceV1,
    McpServerHandleV1,
    McpServerSpecV1,
    ManagedServerRuntimeServiceV1,
    ResolvedMcpServerSpecV1,
} from '@happier-dev/plugin-sdk';
import { assertMcpRuntimeServerRegistrationSafe } from '@/mcp/hosted/safety';

type PluginMcpDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

type AsyncDispose = () => Promise<void>;

export type CreatePluginMcpServiceParams = Readonly<{
    pluginId: string;
    exec: ExecRuntimeServiceV1;
    managedServer: ManagedServerRuntimeServiceV1;
    errors?: ErrorRuntimeServiceV1;
    signal?: AbortSignal;
    addDisposable?: (disposable: PluginMcpDisposable) => unknown;
    startHostedServer?: (spec: McpServerSpecV1) => Promise<McpServerHandleV1> | McpServerHandleV1;
    listSpecs?: () => Promise<readonly McpServerSpecV1[]> | readonly McpServerSpecV1[];
    resolveForSession?: (
        input: McpResolveForSessionInputV1,
    ) => Promise<readonly ResolvedMcpServerSpecV1[]> | readonly ResolvedMcpServerSpecV1[];
}>;

async function disposeOnce(dispose: () => Promise<void>): Promise<void> {
    await dispose();
}

function createAbortError(): Error {
    const error = new Error('Plugin MCP operation was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function createUnsupportedMcpTransportError(kind: string, operation: string): Error {
    return new Error(`Unsupported MCP ${operation} transport '${kind}'`);
}

function readSignal(params: CreatePluginMcpServiceParams, signal: AbortSignal | undefined): AbortSignal | undefined {
    return signal ?? params.signal;
}

function createAbortBoundDispose(
    dispose: AsyncDispose,
    signals: readonly (AbortSignal | undefined)[],
): AsyncDispose {
    let disposed = false;
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    const removeAbortListeners = () => {
        for (const signal of activeSignals) {
            signal.removeEventListener('abort', disposeOnAbort);
        }
    };
    const disposeBoundHandle = async () => {
        if (disposed) {
            return;
        }
        disposed = true;
        removeAbortListeners();
        await dispose();
    };
    const disposeOnAbort = () => {
        void disposeBoundHandle().catch(() => undefined);
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            disposeOnAbort();
        } else {
            signal.addEventListener('abort', disposeOnAbort, { once: true });
        }
    }
    return disposeBoundHandle;
}

function assertMcpClientMethods(
    client: McpClientHandleV1['client'],
    pluginId: string,
    clientId: string,
): asserts client is NonNullable<McpClientHandleV1['client']> & Readonly<{ client: JsonRpcClientV1 }> {
    if (typeof client?.client?.request !== 'function' || typeof client.client.notify !== 'function') {
        throw new Error(`Plugin '${pluginId}' MCP client '${clientId}' does not expose MCP request/notify methods`);
    }
}

export function createPluginMcpService(params: CreatePluginMcpServiceParams): McpRuntimeServiceV1 {
    function addDisposable<T extends PluginMcpDisposable>(handle: T): T {
        params.addDisposable?.(handle);
        return handle;
    }

    async function runWithClassification<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            params.errors?.classify(error);
            throw error;
        }
    }

    const service: McpRuntimeServiceV1 = Object.freeze({
        async startServer(spec: McpServerSpecV1): Promise<McpServerHandleV1> {
            assertNotAborted(params.signal);
            const transport = spec.transport;
            if (transport.kind === 'hosted') {
                assertMcpRuntimeServerRegistrationSafe(spec, { pluginId: params.pluginId });
                if (!params.startHostedServer) {
                    throw createUnsupportedMcpTransportError(transport.kind, 'server');
                }
                const hostedHandle = await runWithClassification(() => Promise.resolve(params.startHostedServer?.(spec)).then((handle) => {
                    if (!handle) {
                        throw new Error(`Plugin '${params.pluginId}' hosted MCP server adapter did not return a handle`);
                    }
                    return handle;
                }));
                const dispose = createAbortBoundDispose(
                    () => disposeOnce(() => hostedHandle.dispose()),
                    [params.signal],
                );
                const handle: McpServerHandleV1 = Object.freeze({
                    id: hostedHandle.id,
                    spec: hostedHandle.spec ?? spec,
                    endpoint: hostedHandle.endpoint,
                    dispose,
                });
                return addDisposable(handle);
            }
            if (transport.kind !== 'managed') {
                throw createUnsupportedMcpTransportError(transport.kind, 'server');
            }
            const managedHandle = await runWithClassification(() => params.managedServer.supervise(transport.server));
            const dispose = createAbortBoundDispose(
                () => disposeOnce(() => managedHandle.dispose()),
                [params.signal, transport.server.signal],
            );
            const handle: McpServerHandleV1 = Object.freeze({
                id: spec.id,
                spec,
                managedServer: managedHandle,
                dispose,
            });
            return addDisposable(handle);
        },
        async createClient(spec: McpClientSpecV1): Promise<McpClientHandleV1> {
            const transport = spec.transport;
            const signal = readSignal(params, transport.kind === 'managed' ? transport.server.signal : undefined);
            assertNotAborted(signal);
            if (transport.kind === 'stdio') {
                const client = await runWithClassification(() => params.exec.spawnClient({
                    launch: transport.launch,
                    transport: {
                        kind: 'stdio',
                        framing: { kind: 'strict-lf-json' },
                        encoding: 'utf8',
                    },
                    protocol: { kind: 'json-rpc-2.0' },
                }, { signal }));
                const dispose = createAbortBoundDispose(
                    () => disposeOnce(() => client.dispose()),
                    [signal],
                );
                try {
                    assertMcpClientMethods(client, params.pluginId, spec.id);
                } catch (error) {
                    await dispose();
                    throw error;
                }
                const handle: McpClientHandleV1 = Object.freeze({
                    id: spec.id,
                    spec,
                    client,
                    request: (message) => {
                        if (typeof (message as { method?: unknown })?.method !== 'string') {
                            throw new Error(`Plugin '${params.pluginId}' MCP client '${spec.id}' request requires a string method`);
                        }
                        return client.client.request(
                            (message as { method: string }).method,
                            (message as { params?: unknown }).params,
                        );
                    },
                    notify: (message) => {
                        if (typeof (message as { method?: unknown })?.method !== 'string') {
                            throw new Error(`Plugin '${params.pluginId}' MCP client '${spec.id}' notification requires a string method`);
                        }
                        return client.client.notify(
                            (message as { method: string }).method,
                            (message as { params?: unknown }).params,
                        );
                    },
                    dispose,
                });
                return addDisposable(handle);
            }
            if (transport.kind === 'managed') {
                throw createUnsupportedMcpTransportError(transport.kind, 'client');
            }
            throw createUnsupportedMcpTransportError(transport.kind, 'client');
        },
        async list(): Promise<readonly McpServerSpecV1[]> {
            return Object.freeze([...(await (params.listSpecs?.() ?? []))]);
        },
        async resolveForSession(
            input: McpResolveForSessionInputV1,
        ): Promise<readonly ResolvedMcpServerSpecV1[]> {
            return Object.freeze([...(await (params.resolveForSession?.(input) ?? []))]);
        },
    });
    return service;
}
