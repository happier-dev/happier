import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PluginHostedMcpServerSpec } from './runtimeTypes';
import type { HostedMcpRuntimeEndpoint } from '../runtimeTypes';
import { createLocalMcpBearer } from '../runtime/localMcpBearer';
import { registerTranscriptSecret } from '@/api/session/client/transport/transcriptSecretRedaction';
import { createStatelessMcpRequestHandler } from '../runtime/statelessMcpRequestHandler';

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
    toolNameSource?: 'mcpServer';
}>): Promise<PluginHostedMcpLoopbackServer> {
    const [{ McpServer }, { assertHostedMcpHandlerSpec, registerHostedMcpHandlers }] = await Promise.all([
        import('@modelcontextprotocol/sdk/server/mcp.js'),
        import('./handlers'),
    ]);
    assertHostedMcpHandlerSpec(params);
    // Any local process or OS user can reach 127.0.0.1; only the Agent's private bridge config
    // (runner-written MCP client launch material) holds this bearer. Loopback has no peer proof,
    // so the transcript writer redacts it while it is live.
    const bearer = createLocalMcpBearer();
    const unregisterTranscriptSecret = registerTranscriptSecret(bearer.token);
    const authorization = bearer.authorization;
    const requests = createStatelessMcpRequestHandler({
        createServer(signal) {
            const mcp = new McpServer({ name: `${params.pluginId}:${params.spec.name}`, version: '1.0.0' });
            registerHostedMcpHandlers({ server: mcp, pluginId: params.pluginId, spec: params.spec,
                toolNameSource: params.toolNameSource, signal });
            return mcp;
        },
    });
    const server = createServer(async (req, res) => {
        if (!bearer.authenticate(req.headers.authorization)) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        await requests.handleRequest(req, res);
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
    }).catch((error: unknown) => {
        unregisterTranscriptSecret();
        bearer.retire();
        throw error;
    });

    let disposed = false;
    const dispose = async () => {
        if (disposed) {
            return;
        }
        disposed = true;
        unregisterTranscriptSecret();
        bearer.retire();
        await requests.dispose();
        await closeHttpServer(server);
    };

    return Object.freeze({
        endpoint: Object.freeze({
            kind: 'loopbackHttp',
            url: `http://127.0.0.1:${port}`,
            host: '127.0.0.1',
            port,
            headers: Object.freeze({ authorization }),
        }),
        dispose,
    });
}
