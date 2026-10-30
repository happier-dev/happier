import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';

export const PLUGIN_COLLECTION_PRESENCE_HTTP_PATH_V1 = '/v1/plugins/data/presence';

const collectionIdentityShape = () => ({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
});

/** Own-Account startup demand only; presence grants no Collection access or writer authority. */
export const PluginCollectionPresenceRequestV1Schema = lazyZodSchema(() => z.strictObject({
  collections: z.array(z.strictObject(collectionIdentityShape())),
}));
export type PluginCollectionPresenceRequestV1 = z.infer<typeof PluginCollectionPresenceRequestV1Schema>;

/** Each distinct requested identity, paired with the same read snapshot's Account change cursor. */
export const PluginCollectionPresenceResultV1Schema = lazyZodSchema(() => z.strictObject({
  collections: z.array(z.strictObject({ ...collectionIdentityShape(), present: z.boolean() })),
  changeCursor: z.number().check(z.int(), z.minimum(0)),
}));
export type PluginCollectionPresenceResultV1 = z.infer<typeof PluginCollectionPresenceResultV1Schema>;
