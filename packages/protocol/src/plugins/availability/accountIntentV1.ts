import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginCollectionContractRefV1Schema, pluginCollectionContractKeyV1 } from '../data/collectionContractRefV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';
import { PluginReleaseVersionV1Schema } from './releaseRefV1.js';

/** Account intent is data-only; Action schemas must not load declaration projection. */
export const PluginAccountPluginIntentV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  desiredVersion: z.nullable(PluginReleaseVersionV1Schema),
  enabled: z.boolean(),
  offlineUiHosting: z.enum(['disabled', 'enabled']),
  writableCollections: z.array(PluginCollectionContractRefV1Schema),
  revision: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
}).check(z.superRefine((value, context) => {
  const keys = new Set<string>();
  value.writableCollections.forEach((contract, index) => {
    if (contract.pluginId !== value.pluginId) {
      context.addIssue({
        code: 'custom',
        path: ['writableCollections', index, 'pluginId'],
        message: 'Intent writable collections must belong to the selected plugin.',
      });
    }
    const key = pluginCollectionContractKeyV1(contract);
    if (keys.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['writableCollections', index],
        message: 'Intent writable collections must be unique by plugin and collection.',
      });
    }
    keys.add(key);
  });
})));
export type PluginAccountPluginIntentV1 = z.infer<typeof PluginAccountPluginIntentV1Schema>;
