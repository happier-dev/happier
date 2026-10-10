import { z } from 'zod';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowReadResponseV1Schema,
  PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema, PromptLibraryRowsListResponseV1Schema,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { inTx } from '@/storage/inTx';
import { listPromptLibraryRowsInTx, mutatePromptLibraryRowInTx, readPromptLibraryRowInTx } from './promptLibraryRows';

const params = z.object({ key: asServerProtocolZod(PromptLibraryCatalogKeyV1Schema) }).strict();
const internal = z.object({ error: z.literal('internal') }).strict();

/** Authenticated Account identity, never a caller-supplied Account or public KV key. */
export function registerPromptLibraryRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
    schema: { params, response: { 200: asServerProtocolZod(PromptLibraryRowReadResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => readPromptLibraryRowInTx(tx, { accountId: request.userId, key: request.params.key }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
  app.post(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
    schema: { params, body: asServerProtocolZod(PromptLibraryRowMutationV1Schema),
      response: { 200: asServerProtocolZod(PromptLibraryRowMutationResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => mutatePromptLibraryRowInTx(tx, {
      accountId: request.userId, key: request.params.key, ...request.body,
    }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
  app.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(PromptLibraryRowsListResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => listPromptLibraryRowsInTx(tx, { accountId: request.userId }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
}
