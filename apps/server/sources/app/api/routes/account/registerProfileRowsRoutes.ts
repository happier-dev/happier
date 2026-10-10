import { z } from 'zod';
import {
    PROFILE_ROWS_ROUTE_V1, PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1,
    ProfileRowMutationV1Schema, ProfileRowMutationResponseV1Schema, ProfileRowReadResponseV1Schema,
    ProfileRowsListResponseV1Schema, ProfileReferenceGuardReadResponseV1Schema,
    PROFILE_PROVIDER_CONVERSION_ROUTE_V1, ProfileProviderConversionMutationV1Schema, ProfileProviderConversionResponseV1Schema,
    parseProfilePhysicalKey,
    ProfileRowReadRequestV1Schema,
} from '@happier-dev/protocol/profiles/profileRecordV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { listProfileRowsInTx, readProfileReferenceGuardInTx, readProfileRowInTx, mutateProfileRows, convertProfileProviders } from '@/app/account/profiles/profileRows';

const invalidParams = z.object({ error: z.literal('invalid-params') }).strict();

/** Closed Profile semantics share the reserved-row owner, never public arbitrary-key KV. */
export function registerProfileRowsRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.post(PROFILE_PROVIDER_CONVERSION_ROUTE_V1, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProfileProviderConversionMutationV1Schema),
            response: { 200: asServerProtocolZod(ProfileProviderConversionResponseV1Schema) } },
    }, async (request, reply) => reply.send(await convertProfileProviders({ accountId: request.userId, mutation: request.body,
        authentication: readTeamOperationAuthenticationFromRequest(request) })));
    app.get(PROFILE_REFERENCE_GUARD_ROUTE_V1, {
        preHandler: app.authenticate, config,
        schema: { response: { 200: asServerProtocolZod(ProfileReferenceGuardReadResponseV1Schema) } },
    }, async (request, reply) => reply.send(await inTx(tx => readProfileReferenceGuardInTx(tx, { accountId: request.userId }))));
    app.get(PROFILE_ROWS_ROUTE_V1, {
        preHandler: app.authenticate, config,
        schema: { querystring: z.object({ cursor: z.string().refine(value => parseProfilePhysicalKey(value) !== null, 'Invalid Profile cursor').optional(), limit: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
            response: { 200: asServerProtocolZod(ProfileRowsListResponseV1Schema), 400: invalidParams } },
    }, async (request, reply) => reply.send(await inTx(tx => listProfileRowsInTx(tx, { accountId: request.userId,
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
    }))));
    app.post(PROFILE_RECORD_READ_ROUTE_V1, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProfileRowReadRequestV1Schema), response: { 200: asServerProtocolZod(ProfileRowReadResponseV1Schema), 400: invalidParams } },
    }, async (request, reply) => reply.send(await inTx(tx => readProfileRowInTx(tx, { accountId: request.userId, id: request.body.id }))));
    app.post(PROFILE_RECORDS_ROUTE_V1, {
        preHandler: app.authenticate, config,
        schema: { body: asServerProtocolZod(ProfileRowMutationV1Schema),
            response: { 200: asServerProtocolZod(ProfileRowMutationResponseV1Schema), 400: invalidParams } },
    }, async (request, reply) => {
        if (request.body.operation === 'import') return reply.code(400).send({ error: 'invalid-params' });
        const result = await mutateProfileRows({ accountId: request.userId, mutations: [request.body],
            authentication: readTeamOperationAuthenticationFromRequest(request) });
        if (result.status !== 'updated') return reply.send(result);
        const row = result.rows[0];
        if (!row) throw new Error('Profile mutation did not return its row');
        return reply.send({ status: 'updated', revision: row.revision, cursor: result.cursor, referenceGuardRevision: result.referenceGuardRevision });
    });
}
