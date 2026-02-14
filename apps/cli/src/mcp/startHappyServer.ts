import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { logger } from "@/ui/logger";
import type { ApiSessionClient } from "@/api/session/sessionClient";
import { createHappierMcpServer, HAPPIER_MCP_TOOL_NAMES } from "@/mcp/createHappierMcpServer";

export type HappyMcpSessionClient = Pick<ApiSessionClient, 'sessionId' | 'rpcHandlerManager' | 'sendClaudeSessionMessage'>;

export async function startHappyServer(client: HappyMcpSessionClient) {
    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        // Build a fresh MCP server + transport per request.
        //
        // We intentionally run in stateless mode (no session IDs) because some
        // clients re-send initialize and do not keep MCP session headers.
        // In newer MCP SDK versions, stateless transports are single-use; reusing
        // one transport across requests can surface as client-side "Error POSTing to endpoint".
        const { mcp } = createHappierMcpServer(client);

        const transport = new StreamableHTTPServerTransport({
            // NOTE: Returning session id here will result in claude
            // sdk spawn to fail with `Invalid Request: Server already initialized`
            sessionIdGenerator: undefined,
        });

        let cleanedUp = false;
        const cleanup = async () => {
            if (cleanedUp) {
                return;
            }
            cleanedUp = true;

            try {
                await transport.close();
            } catch (error) {
                logger.debug('[happierMCP] Error closing transport:', error);
            }

            try {
                await Promise.resolve(mcp.close());
            } catch (error) {
                logger.debug('[happierMCP] Error closing server:', error);
            }
        };

        res.once('close', () => {
            cleanup().catch((error) => {
                logger.debug('[happierMCP] Error during request cleanup:', error);
            });
        });

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug('[happierMCP] Error handling request:', error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            await cleanup();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames: [...HAPPIER_MCP_TOOL_NAMES],
        stop: () => {
            logger.debug('[happierMCP] Stopping server');
            server.close();
        }
    }
}
