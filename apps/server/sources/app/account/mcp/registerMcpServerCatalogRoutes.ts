import { z } from 'zod';
import {
    MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema,
    McpServerCatalogRowMutationV1Schema, McpServerCatalogRowMutationResponseV1Schema,
} from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { mutateMcpServerCatalogRowInTx, readMcpServerCatalogRowInTx } from './serverRows';

const internal = z.object({ error: z.literal('internal') }).strict();

/** Authenticated Account identity, never a caller-supplied Account or arbitrary KV key. */
export function registerMcpServerCatalogRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.get(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(McpServerCatalogRowReadResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => readMcpServerCatalogRowInTx(tx, { accountId: request.userId }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(McpServerCatalogRowMutationV1Schema),
            response: { 200: asServerProtocolZod(McpServerCatalogRowMutationResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => mutateMcpServerCatalogRowInTx(tx, {
            accountId: request.userId, ...request.body, authentication: readTeamOperationAuthenticationFromRequest(request),
        }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
}
