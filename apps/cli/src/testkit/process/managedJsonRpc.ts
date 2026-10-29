import { createStablePluginExecService } from '../../plugins/runtime/invocation/services/exec';

/** Substitute only the executable; retain host admission, binary transport and RPC lifecycle. */
export async function createManagedJsonRpcTestClient(params: Readonly<{
    cwd: string;
    command: string;
    args: readonly string[];
    environment?: Readonly<Record<string, string>>;
    maxFrameBytes?: number;
    requestTimeoutMs?: number;
}>) {
    const executable = { kind: 'systemTool', id: 'fixture.json-rpc' } as const;
    const exec = createStablePluginExecService({
        environment: params.environment ?? {}, allowedEnvKeys: Object.keys(params.environment ?? {}),
        allowedExecutables: [executable], signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        resolveExecutable: async () => ({ command: params.command }),
        resolvePath: async () => params.cwd,
    });
    return await exec.clients.spawn({ kind: 'jsonRpc', framing: 'webSocket',
        maxFrameBytes: params.maxFrameBytes, requestTimeoutMs: params.requestTimeoutMs,
        launch: { executable, args: params.args, cwd: { root: 'workspace', relativePath: '' } },
    });
}

/** A real endpoint connection has no synthetic child or process result. */
export async function connectManagedJsonRpcTestClient(params: Readonly<{
    cwd: string;
    socketPath: string;
    maxFrameBytes?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
}>) {
    const exec = createStablePluginExecService({
        allowedExecutables: [], environment: {}, signal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        resolveExecutable: async () => { throw new Error('Endpoint connections must not launch a process'); },
        resolvePath: async () => params.cwd,
    });
    return await exec.clients.connectJsonRpc({ endpoint: { kind: 'unixWebSocket', socketPath: params.socketPath },
        maxFrameBytes: params.maxFrameBytes, requestTimeoutMs: params.requestTimeoutMs,
    }, params.signal ? { signal: params.signal } : undefined);
}
