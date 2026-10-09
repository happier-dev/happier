import { z } from 'zod';
import { AccountStoredContentUpgradeRequiredV1Schema } from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogKeyV1Schema,
    ConnectedAccountCatalogRowReadResponseV1Schema, ConnectedAccountCatalogRowMutationV1Schema,
    ConnectedAccountCatalogRowMutationResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { PresentUserRequiredResponseSchema, requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { inTx } from '@/storage/inTx';
import { mutateConnectedAccountCatalogRow, readConnectedAccountCatalogRowInTx } from './configurationRows';

const params = z.object({ key: asServerProtocolZod(ConnectedAccountCatalogKeyV1Schema) }).strict();
const internal = z.object({ error: z.literal('internal') }).strict();

/** The authenticated Account owns this address; neither Account ids nor private KV keys are client parameters. */
export function registerConnectedAccountConfigurationRowsRoutes(app: Fastify): void {
    const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
    app.get(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
        schema: { params, response: { 200: asServerProtocolZod(ConnectedAccountCatalogRowReadResponseV1Schema), 500: internal } },
    }, async (request, reply) => {
        try { return reply.send(await inTx(tx => readConnectedAccountCatalogRowInTx(tx, { accountId: request.userId, key: request.params.key }))); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
    app.post(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/:key`, { preHandler: app.authenticate, config,
        schema: { params, body: asServerProtocolZod(ConnectedAccountCatalogRowMutationV1Schema), response: {
            200: asServerProtocolZod(ConnectedAccountCatalogRowMutationResponseV1Schema),
            403: PresentUserRequiredResponseSchema, 426: AccountStoredContentUpgradeRequiredV1Schema, 500: internal,
        } },
    }, async (request, reply) => {
        if (request.body.settingsMutation) {
            await requirePresentUser(request, reply);
            if (reply.sent || !await enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest(request, reply)) return;
        }
        try { return reply.send(await mutateConnectedAccountCatalogRow({ accountId: request.userId, key: request.params.key,
            authentication: readTeamOperationAuthenticationFromRequest(request), ...request.body })); }
        catch { return reply.code(500).send({ error: 'internal' }); }
    });
}
