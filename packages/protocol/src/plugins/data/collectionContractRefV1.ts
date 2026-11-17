import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { PLUGIN_COLLECTION_SCHEMA_VERSION_MAX } from './collectionLimitsV1.js';

export const PluginCollectionSchemaVersionV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(PLUGIN_COLLECTION_SCHEMA_VERSION_MAX)));
export type PluginCollectionSchemaVersionV1 = z.infer<typeof PluginCollectionSchemaVersionV1Schema>;

export const PluginCollectionContractDigestV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)));
export type PluginCollectionContractDigestV1 = z.infer<typeof PluginCollectionContractDigestV1Schema>;

/** Exact immutable Collection declaration loaded by one daemon or UI artifact. */
export const PluginCollectionContractRefV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  collectionId: asProtocolZod(PluginContributionLocalIdSchema),
  schemaVersion: PluginCollectionSchemaVersionV1Schema,
  contractDigest: PluginCollectionContractDigestV1Schema,
}));
export type PluginCollectionContractRefV1 = z.infer<typeof PluginCollectionContractRefV1Schema>;

export function doesPluginCollectionContractMatchRefV1(contract: PluginCollectionContractRefV1, ref: PluginCollectionContractRefV1): boolean {
  return contract.pluginId === ref.pluginId && contract.collectionId === ref.collectionId
    && contract.schemaVersion === ref.schemaVersion && contract.contractDigest === ref.contractDigest;
}

export function pluginCollectionContractKeyV1(value: Pick<PluginCollectionContractRefV1, 'pluginId' | 'collectionId'>): string {
  return `${value.pluginId}\u0000${value.collectionId}`;
}
