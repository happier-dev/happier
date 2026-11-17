import { z } from 'zod/mini';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowReadResponseV1Schema,
  PromptLibraryRowMutationV1Schema, PromptLibraryRowMutationResponseV1Schema, PromptLibraryRowsListResponseV1Schema,
  PromptLibraryRowsInitializationV1Schema, PromptLibraryRowsInitializationResponseV1Schema, parsePromptLibraryPhysicalKeyV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { initializePromptLibraryRowsInTx, listPromptLibraryRowsInTx, mutatePromptLibraryRowInTx, readPromptLibraryRowInTx } from './promptLibraryRows';
import { readReservedAccountScopedKvRowMutationConflict } from '@/app/kv/reservedAccountScopedKvRow';
import { readUserKvMutationConflict } from '@/app/kv/kvMutate';
import { AccountSettingsPublicationConflict } from '@/app/accountSettings/writeAccountSettingsInTx';

const params = z.strictObject({ key: asServerProtocolZod(PromptLibraryCatalogKeyV1Schema) });
const internal = z.strictObject({ error: z.literal('internal') });

/** Authenticated Account identity, never a caller-supplied Account or public KV key. */
export function registerPromptLibraryRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
    schema: { params, response: { 200: asServerProtocolZod(PromptLibraryRowReadResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inReadSnapshot(tx => readPromptLibraryRowInTx(tx, { accountId: request.userId, key: request.params.key }), { transactionClass: 'prompt-library-read' })); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
  app.post(`${PROMPT_LIBRARY_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
    schema: { params, body: asServerProtocolZod(PromptLibraryRowMutationV1Schema),
      response: { 200: asServerProtocolZod(PromptLibraryRowMutationResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => mutatePromptLibraryRowInTx(tx, {
      accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), key: request.params.key, ...request.body,
    }))); }
    catch (error) {
      const conflict = await readReservedAccountScopedKvRowMutationConflict(error);
      if (conflict) return reply.send(conflict);
      if (error instanceof AccountSettingsPublicationConflict) return reply.send(error.result.status === 'version_mismatch'
        ? { status: 'settings-conflict', revision: error.result.currentVersion } : { status: 'invalid-stored-content' });
      return reply.code(500).send({ error: 'internal' });
    }
  });
  app.post(PROMPT_LIBRARY_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { body: asServerProtocolZod(PromptLibraryRowsInitializationV1Schema),
      response: { 200: asServerProtocolZod(PromptLibraryRowsInitializationResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => initializePromptLibraryRowsInTx(tx, {
      accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), ...request.body,
    }))); }
    catch (error) {
      const conflict = await readUserKvMutationConflict(error);
      const key = conflict ? parsePromptLibraryPhysicalKeyV1(conflict.key) : null;
      if (conflict && key) return reply.send({ status: 'conflict', key, revision: conflict.version });
      if (error instanceof AccountSettingsPublicationConflict) return reply.send(error.result.status === 'version_mismatch'
        ? { status: 'settings-conflict', revision: error.result.currentVersion } : { status: 'invalid-stored-content' });
      return reply.code(500).send({ error: 'internal' });
    }
  });
  app.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(PromptLibraryRowsListResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inReadSnapshot(tx => listPromptLibraryRowsInTx(tx, { accountId: request.userId }), { transactionClass: 'prompt-library-list' })); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
}
