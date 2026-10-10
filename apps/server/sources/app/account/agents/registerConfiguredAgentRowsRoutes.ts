import { z } from 'zod';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema, AcpCatalogRowMutationV1Schema,
    AcpCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { readConfiguredAgentCatalogRowInTx, mutateConfiguredAgentCatalogRow } from './configuredAgentRows';

const internal = z.object({ error: z.literal('internal') }).strict();

export function registerConfiguredAgentRowsRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.get(ACP_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(AcpCatalogRowReadResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => readConfiguredAgentCatalogRowInTx(tx, { accountId: request.userId }), { readOnly: true })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(ACP_CATALOG_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(AcpCatalogRowMutationV1Schema),
            response: { 200: asServerProtocolZod(AcpCatalogRowMutationResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await mutateConfiguredAgentCatalogRow({ accountId: request.userId, ...request.body,
            authentication: readTeamOperationAuthenticationFromRequest(request) })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
}
