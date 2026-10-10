import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { PLUGIN_COLLECTION_SCHEMA_VERSION_MAX } from './collectionLimitsV1.js';

export const PluginCollectionSchemaVersionV1Schema = lazyZodSchema(() => z.number().int()
  .min(1)
  .max(PLUGIN_COLLECTION_SCHEMA_VERSION_MAX));
export type PluginCollectionSchemaVersionV1 = z.infer<typeof PluginCollectionSchemaVersionV1Schema>;

export const PluginCollectionContractDigestV1Schema = lazyZodSchema(() => z.string().regex(/^[A-Za-z0-9_-]{43}$/));
export type PluginCollectionContractDigestV1 = z.infer<typeof PluginCollectionContractDigestV1Schema>;

/** Exact immutable Collection declaration loaded by one daemon or UI artifact. */
export const PluginCollectionContractRefV1Schema = lazyZodSchema(() => z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
}).strict());
export type PluginCollectionContractRefV1 = z.infer<typeof PluginCollectionContractRefV1Schema>;
