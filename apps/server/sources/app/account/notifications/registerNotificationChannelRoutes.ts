import { z } from 'zod';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema,
  NotificationChannelCatalogMutationV1Schema, NotificationChannelCatalogMutationResponseV1Schema,
} from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { Fastify } from '@/app/api/types';
import { asServerProtocolZod } from '@/app/api/utils/protocolComposableZodAdapter';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { AccountStoredContentUpgradeRequiredV1Schema } from '@happier-dev/protocol';
import { PresentUserRequiredResponseSchema, requirePresentUser } from '@/app/api/utils/requirePresentUser';
import { enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { isServerFeatureEnabledForRequest } from '@/app/features/catalog/serverFeatureGate';
import { readRequestHomeEnv } from '@/app/home/settings/requestHomeEnv';
import { inTx } from '@/storage/inTx';
import { readTeamOperationAuthenticationFromRequest } from '@/app/teams/actorContext';
import { mutateNotificationChannelCatalog, readNotificationChannelCatalogInTx } from './channelRows';

const internal = z.object({ error: z.literal('internal') }).strict();

export function registerNotificationChannelRoutes(app: Fastify): void {
  const config = { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'account.settings') };
  app.get(NOTIFICATION_CHANNELS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { response: { 200: asServerProtocolZod(NotificationChannelCatalogReadResponseV1Schema), 500: internal } },
  }, async (request, reply) => {
    try { return reply.send(await inTx(tx => readNotificationChannelCatalogInTx(tx, { accountId: request.userId }))); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
  app.post(NOTIFICATION_CHANNELS_ROUTE_V1, { preHandler: app.authenticate, config,
    schema: { body: asServerProtocolZod(NotificationChannelCatalogMutationV1Schema),
      response: { 200: asServerProtocolZod(NotificationChannelCatalogMutationResponseV1Schema),
        403: PresentUserRequiredResponseSchema, 426: AccountStoredContentUpgradeRequiredV1Schema, 500: internal } },
  }, async (request, reply) => {
    let settingsMutation = request.body.settingsMutation;
    if (settingsMutation) {
      await requirePresentUser(request, reply);
      if (reply.sent || !await enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest(request, reply)) return;
      const requestHomeEnv = await readRequestHomeEnv(request);
      if (!isServerFeatureEnabledForRequest('sessions.following', requestHomeEnv)) {
        const { remoteAlertPolicy: _suppressedPolicy, ...admitted } = settingsMutation;
        settingsMutation = admitted;
      }
    }
    try { return reply.send(await mutateNotificationChannelCatalog({ accountId: request.userId,
      authentication: readTeamOperationAuthenticationFromRequest(request), ...request.body, settingsMutation })); }
    catch { return reply.code(500).send({ error: 'internal' }); }
  });
}
