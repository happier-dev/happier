import type {
    ErrorRuntimeServiceV1,
    ExecRuntimeServiceV1,
    McpClientHandleV1,
    McpClientSpecV1,
    McpResolveForSessionInputV1,
    McpRuntimeServiceV1,
    McpServerHandleV1,
    McpServerSpecV1,
    ManagedServerRuntimeServiceV1,
    ResolvedMcpServerSpecV1,
} from '@happier-dev/plugin-sdk';

type PluginMcpDisposable = Readonly<{
    dispose: () => void | Promise<void>;
}>;

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
                if (!params.startHostedServer) {
                    throw createUnsupportedMcpTransportError(transport.kind, 'server');
                }
                const hostedHandle = await runWithClassification(() => Promise.resolve(params.startHostedServer?.(spec)).then((handle) => {
                    if (!handle) {
                        throw new Error(`Plugin '${params.pluginId}' hosted MCP server adapter did not return a handle`);
                    }
                    return handle;
                }));
                let disposed = false;
                const handle: McpServerHandleV1 = Object.freeze({
                    id: hostedHandle.id,
                    spec: hostedHandle.spec ?? spec,
                    async dispose() {
                        if (disposed) {
                            return;
                        }
                        disposed = true;
                        await disposeOnce(() => hostedHandle.dispose());
                    },
                });
                return addDisposable(handle);
            }
            if (transport.kind !== 'managed') {
                throw createUnsupportedMcpTransportError(transport.kind, 'server');
            }
            const managedHandle = await runWithClassification(() => params.managedServer.supervise(transport.server));
            let disposed = false;
            const handle: McpServerHandleV1 = Object.freeze({
                id: spec.id,
                spec,
                managedServer: managedHandle,
                async dispose() {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    await disposeOnce(() => managedHandle.dispose());
                },
            });
            return addDisposable(handle);
        },
        async createClient(spec: McpClientSpecV1): Promise<McpClientHandleV1> {
            const transport = spec.transport;
            const signal = readSignal(params, transport.kind === 'managed' ? transport.server.signal : undefined);
            assertNotAborted(signal);
            if (transport.kind === 'stdio') {
                const client = await runWithClassification(() => params.exec.spawnClient(transport.launch, { signal }));
                let disposed = false;
                const handle: McpClientHandleV1 = Object.freeze({
                    id: spec.id,
                    spec,
                    client,
                    request: client.request,
                    notify: client.notify,
                    async dispose() {
                        if (disposed) {
                            return;
                        }
                        disposed = true;
                        await disposeOnce(() => client.dispose());
                    },
                });
                return addDisposable(handle);
            }
            if (transport.kind === 'managed') {
                const managedHandle = await runWithClassification(() => params.managedServer.supervise(transport.server));
                let disposed = false;
                const handle: McpClientHandleV1 = Object.freeze({
                    id: spec.id,
                    spec,
                    managedServer: managedHandle,
                    async dispose() {
                        if (disposed) {
                            return;
                        }
                        disposed = true;
                        await disposeOnce(() => managedHandle.dispose());
                    },
                });
                return addDisposable(handle);
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
