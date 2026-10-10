import { z } from 'zod';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRowMutationV1Schema,
  RemoteHostCatalogRowReadResponseV1Schema, RemoteHostCatalogRowMutationResponseV1Schema,
  assertRemoteHostCatalogContentForModeV1, readRemoteHostCatalogRecordV1,
  type RemoteHostCatalogRowMutationV1, type RemoteHostCatalogRowMutationResponseV1,
} from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { SharedSavedSecretCreateInputV1Schema, SharedSavedSecretPromoteInputV1Schema, SavedSecretCatalogReferenceCensusV1Schema,
  type SharedSavedSecretCreateInputV1, type SavedSecretCatalogReferenceCensusV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { listSavedSecretReferenceCatalogRefsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx, type Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { decodeSavedSecretResourceEnvelopes } from '@/app/api/routes/account/registerSavedSecretResourceRoutes';
import { promoteSavedSecretResourceInTx, SavedSecretResourceTransactionAbort,
  type SavedSecretResourceServiceError } from '@/app/account/savedSecrets/savedSecretResourceService';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { readRemoteHostCatalogRowInTx, mutateRemoteHostCatalogRowInTx } from './remoteHostRows';

async function resourcePacketFailureInTx(tx: Tx, accountId: string, mutation: RemoteHostCatalogRowMutationV1,
  error: SavedSecretResourceServiceError): Promise<RemoteHostCatalogRowMutationResponseV1> {
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
  if (error === 'settings_conflict') return { status: 'settings-conflict', revision: fence.account.settingsVersion };
  const row = await readRemoteHostCatalogRowInTx(tx, { accountId });
  if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') return row;
  if (error === 'references_conflict') {
    const revision = row.status === 'absent' ? 'absent' : row.revision;
    return revision !== mutation.expectedRevision ? { status: 'conflict', revision: revision === 'absent' ? -1 : revision }
      : { status: 'references-conflict' };
  }
  return { status: error === 'settings_invalid' ? 'invalid-stored-content' : 'references-invalid', reason: error };
}

async function promoteRemoteHostPacketInTx(tx: Tx, input: Readonly<{
  accountId: string; authentication?: TeamOperationAuthenticationContext;
  mutation: RemoteHostCatalogRowMutationV1; resources: readonly SharedSavedSecretCreateInputV1[];
  referenceCensus?: SavedSecretCatalogReferenceCensusV1;
}>): Promise<RemoteHostCatalogRowMutationResponseV1> {
  const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
  if (fence.status === 'account_not_found') return { status: 'account-not-found' };
  if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent', reason: fence.reason };
  const accountMode = fence.account.currentness.encryptionMode;
  try { assertRemoteHostCatalogContentForModeV1(input.mutation.content, accountMode); }
  catch { return { status: 'account-mode-mismatch' }; }
  const row = await readRemoteHostCatalogRowInTx(tx, input);
  if (row.status !== 'present' && row.status !== 'absent' && row.status !== 'deleted') return row;
  let resourceRefs: string[] = [];
  if (input.mutation.expectedRevision !== 'absent' && row.status === 'present') {
    // An opaque existing catalog requires the client's complete OLD witness.
    // Next references cannot be substituted for that capture.
    if (row.content.t === 'encrypted') {
      if (!input.referenceCensus) return { status: 'references-invalid' };
    } else {
      const record = readRemoteHostCatalogRecordV1(row.content.v);
      if (record.status !== 'ready') return { status: 'invalid-stored-content' };
      resourceRefs = [...new Set(listSavedSecretReferenceCatalogRefsV1({ profileRecords: [], remoteHostRecords: record.hosts })
        .map(reference => reference.secretId))];
    }
  }
  if (input.referenceCensus && (input.referenceCensus.accountMode !== accountMode
    || input.referenceCensus.remoteHosts?.revision !== input.mutation.expectedRevision)) return { status: 'references-conflict' };
  const [first, ...additional] = input.resources;
  if (!first) return { status: 'references-invalid' };
  const parsed = SharedSavedSecretPromoteInputV1Schema.safeParse({ ...first, additionalSavedSecretResources: additional,
    nextSettings: null, profileMutations: [], remoteHostMutation: input.mutation,
    referenceCensus: input.referenceCensus ?? { scope: 'catalogs', accountMode, catalogs: {},
      remoteHosts: { revision: input.mutation.expectedRevision, resourceRefs } } });
  if (!parsed.success) return { status: 'references-invalid' };
  const keyEnvelopes = decodeSavedSecretResourceEnvelopes(parsed.data.keyEnvelopes);
  const resources = (parsed.data.additionalSavedSecretResources ?? []).map(resource => {
    const decoded = decodeSavedSecretResourceEnvelopes(resource.keyEnvelopes);
    return decoded ? { ...resource, keyEnvelopes: decoded } : null;
  });
  if (!keyEnvelopes || resources.some(resource => resource === null)) return { status: 'references-invalid' };
  const result = await promoteSavedSecretResourceInTx(tx, { ...parsed.data, accountId: input.accountId,
    authentication: input.authentication, keyEnvelopes,
    additionalSavedSecretResources: resources.filter((resource): resource is NonNullable<typeof resource> => resource !== null) });
  if (!result.ok) return resourcePacketFailureInTx(tx, input.accountId, input.mutation, result.error);
  if (result.value.remoteHostRevision === undefined) throw new Error('Remote host promotion omitted its committed revision');
  const account = await tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { seq: true } });
  return { status: 'updated', revision: result.value.remoteHostRevision, cursor: account.seq };
}

/** Catalog packets use authenticated identity, not public KV or caller-supplied Accounts. */
export function registerRemoteHostCatalogRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(REMOTE_HOST_ROWS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(RemoteHostCatalogRowReadResponseV1Schema) } },
  }, async (request, reply) => reply.send(await inTx(tx => readRemoteHostCatalogRowInTx(tx, { accountId: request.userId }), { readOnly: true })));
  app.post(REMOTE_HOST_ROWS_ROUTE_V1, { preHandler: [app.authenticate, async (request, reply) => {
    if (request.body.savedSecretResources?.length) return requirePresentUser(request, reply);
  }], config,
    schema: { body: z.object({ mutation: asServerProtocolZod(RemoteHostCatalogRowMutationV1Schema),
      savedSecretResources: z.array(SharedSavedSecretCreateInputV1Schema).optional(),
      referenceCensus: SavedSecretCatalogReferenceCensusV1Schema.optional() }).strict(),
      response: { 200: asServerProtocolZod(RemoteHostCatalogRowMutationResponseV1Schema) } },
  }, async (request, reply) => {
    const authentication = readTeamOperationAuthenticationFromRequest(request);
    try {
      return reply.send(await inTx(tx => request.body.savedSecretResources?.length
        ? promoteRemoteHostPacketInTx(tx, { accountId: request.userId, authentication,
          mutation: request.body.mutation, resources: request.body.savedSecretResources, referenceCensus: request.body.referenceCensus })
        : mutateRemoteHostCatalogRowInTx(tx, { accountId: request.userId, authentication, ...request.body.mutation })));
    } catch (error) {
      // The canonical batch abort must leave the transaction before mapping its result.
      if (!(error instanceof SavedSecretResourceTransactionAbort)) throw error;
      return reply.send(await inTx(tx => resourcePacketFailureInTx(tx, request.userId, request.body.mutation, error.error)));
    }
  });
}
