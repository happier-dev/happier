import { z } from 'zod/mini';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowReadResponseV1Schema,
  ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { isTransactionStorageError } from '@/storage/transactionErrors';
import { mutateProviderConnectionsRowInTx, providerConnectionsHaveCrossAccountSecretReferences, readProviderConnectionsRowInTx } from './connectionRows';
import { readReservedAccountScopedKvRowMutationConflict } from '@/app/kv/reservedAccountScopedKvRow';
import { AccountSettingsPublicationConflict } from '@/app/accountSettings/writeAccountSettingsInTx';

const internal = z.strictObject({ error: z.literal('internal') });

/** Account identity comes only from authentication; public KV cannot address this singleton. */
export function registerProviderConnectionsRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(ProviderConnectionsRowReadResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inReadSnapshot(tx => readProviderConnectionsRowInTx(tx, { accountId: request.userId }),
      { transactionClass: 'provider-catalog-read' })); }
    catch (error) {
      if (isTransactionStorageError(error)) throw error;
      return reply.code(500).send({ error: 'internal' });
    }
  });
  app.post(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { body: asServerProtocolZod(ProviderConnectionsRowMutationV1Schema),
      response: { 200: asServerProtocolZod(ProviderConnectionsRowMutationResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try {
      const crossAccountSecrets = await providerConnectionsHaveCrossAccountSecretReferences(request.userId, request.body.referencedSavedSecretIds);
      return reply.send(await inTx(tx => mutateProviderConnectionsRowInTx(tx, {
        accountId: request.userId, authentication: readTeamOperationAuthenticationFromRequest(request), ...request.body,
      }, { ownSecretReferencesOnly: !crossAccountSecrets }), {
        // Own Secret writers publish behind this same Account fence before commit.
        // Foreign owners/grants require SSI; the fenced validator refuses ownership
        // changes since preflight rather than admitting a new cross-Account predicate.
        ...(crossAccountSecrets ? { isolationLevel: 'Serializable' as const } : {}),
        transactionClass: 'provider-catalog-write',
      }));
    }
    catch (error) {
      const conflict = await readReservedAccountScopedKvRowMutationConflict(error);
      if (conflict) return reply.send(conflict);
      if (error instanceof AccountSettingsPublicationConflict) return reply.send(error.result.status === 'version_mismatch'
        ? { status: 'settings-conflict', revision: error.result.currentVersion } : { status: 'invalid-stored-content' });
      if (isTransactionStorageError(error)) throw error;
      return reply.code(500).send({ error: 'internal' });
    }
  });
}
