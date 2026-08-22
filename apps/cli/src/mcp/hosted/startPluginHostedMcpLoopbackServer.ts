import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { assertHostedMcpHandlerSpec, registerHostedMcpHandlers } from './handlers';
import type { PluginHostedMcpServerSpec } from './runtimeTypes';
import type { HostedMcpRuntimeEndpoint } from '../runtimeTypes';

export type PluginHostedMcpLoopbackServer = Readonly<{
    endpoint: Extract<HostedMcpRuntimeEndpoint, Readonly<{ kind: 'loopbackHttp' }>>;
    dispose: () => Promise<void>;
}>;

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function startPluginHostedMcpLoopbackServer(params: Readonly<{
    pluginId: string;
    spec: PluginHostedMcpServerSpec;
}>): Promise<PluginHostedMcpLoopbackServer> {
    assertHostedMcpHandlerSpec(params);
    const requestCleanups = new Set<() => Promise<void>>();
    const server = createServer(async (req, res) => {
        const mcp = new McpServer({
            name: `${params.pluginId}:${params.spec.name}`,
            version: '1.0.0',
        });
        const abortController = new AbortController();
        registerHostedMcpHandlers({
            server: mcp,
            pluginId: params.pluginId,
            spec: params.spec,
            signal: abortController.signal,
        });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;
            abortController.abort();
            requestCleanups.delete(cleanup);
            if (!res.destroyed) {
                res.destroy();
            }
            try {
                await transport.close();
            } finally {
                await Promise.resolve(mcp.close());
            }
        };
        requestCleanups.add(cleanup);
        res.once('close', () => {
            cleanup().catch(() => undefined);
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch {
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
        }
    });

    const port = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            const address = server.address() as AddressInfo;
            resolve(address.port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
    });

    let disposed = false;
    const dispose = async () => {
        if (disposed) {
            return;
        }
        disposed = true;
        await Promise.all([...requestCleanups].map((cleanup) => cleanup()));
        await closeHttpServer(server);
    };

    return Object.freeze({
        endpoint: Object.freeze({
            kind: 'loopbackHttp',
            url: `http://127.0.0.1:${port}`,
            host: '127.0.0.1',
            port,
        }),
        dispose,
    });
}
