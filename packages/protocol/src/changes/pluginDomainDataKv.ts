import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginAccountStorageLogicalKeyV1Schema } from '../plugins/data/accountKvValueV1.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

const keys = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  keys: z.array(PluginAccountStorageLogicalKeyV1Schema).check(z.minLength(1), z.maxLength(200),
    z.refine(values => new Set(values).size === values.length, 'Plugin Account KV invalidation keys must be unique.')),
}));
const full = lazyZodSchema(() => z.strictObject({
  pluginDomain: z.literal('dataKv'),
  pluginId: asProtocolZod(PluginIdSchema),
  full: z.literal(true),
}));
export const PluginDomainDataKvChangeHintSchema = lazyZodSchema(() => z.union([keys, full]));
export type PluginDomainDataKvChangeHint = z.infer<typeof PluginDomainDataKvChangeHintSchema>;
