import { z } from 'zod';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema,
  ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { mutateProviderConnectionsRowInTx, readProviderConnectionsRowInTx } from './connectionRows';

const internal = z.object({ error: z.literal('internal') }).strict();

/** Account identity comes only from authentication; public KV cannot address this singleton. */
export function registerProviderConnectionsRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(ProviderConnectionsRowReadResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => readProviderConnectionsRowInTx(tx, { accountId: request.userId }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
  app.post(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { body: asServerProtocolZod(ProviderConnectionsRowMutationV1Schema),
      response: { 200: asServerProtocolZod(ProviderConnectionsRowMutationResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => mutateProviderConnectionsRowInTx(tx, {
      accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), ...request.body,
    }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
}
