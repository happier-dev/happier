import { z } from 'zod';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferMutationV1Schema, ProfileTransferMutationResponseV1Schema, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { mutateProfileTransfer } from '@/app/account/profiles/profileTransferRows';
import { readProfileTransferControlInTx, profileTransferControlReadResponseV1 } from '@/app/account/profiles/profileTransferControl';

/** Authenticated semantic Profile transfer; callers cannot choose an Account or raw KV key. */
export function registerProfileTransferRoutes(app: Fastify): void {
    app.get(PROFILE_TRANSFER_ROUTE_V1, {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') },
        schema: { response: { 200: asServerProtocolZod(ProfileTransferRowReadResponseV1Schema), 500: z.object({ error: z.literal('internal') }).strict() } },
    }, async (request, reply) => {
        const result = await inTx(tx => readProfileTransferControlInTx(tx, { accountId: request.userId }), { readOnly: true });
        return reply.send(profileTransferControlReadResponseV1(result));
    });
    app.post(PROFILE_TRANSFER_ROUTE_V1, {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') },
        schema: { body: asServerProtocolZod(ProfileTransferMutationV1Schema), response: {
            200: asServerProtocolZod(ProfileTransferMutationResponseV1Schema),
            400: z.object({ error: z.literal('invalid-params') }).strict(), 500: z.object({ error: z.literal('internal') }).strict(),
        } },
    }, async (request, reply) => reply.send(await mutateProfileTransfer({ accountId: request.userId, mutation: request.body,
        authentication: readTeamOperationAuthenticationFromRequest(request) })));
}
