import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginManifestV2LoadSchema } from '../manifest/load.js';
import {
  PluginMachineMaterializationSnapshotV1Schema,
  PluginMachineMaterializationV1Schema,
  PluginReleaseFactsV1Schema,
  type PluginReleaseFactsV1,
  type PluginMachineMaterializationV1,
  type PluginMachineMaterializationSnapshotV1,
} from './v1.js';

function replaceReadFields<T>(schema: z.ZodMiniType<T>, fields: Readonly<Record<string, z.core.$ZodType>>): z.ZodMiniType<T> {
  const definition = (schema as unknown as z.core.$ZodTypes)._zod.def;
  if (definition.type !== 'object') throw new TypeError('Availability read projection requires an object schema.');
  const readDefinition = { ...definition, shape: { ...definition.shape, ...fields } };
  return z.core.clone(schema, readDefinition);
}

/** Read-only variants preserve the canonical output; new publication stays strict. */
export const PluginReleaseFactsV1LoadSchema: z.ZodMiniType<PluginReleaseFactsV1> = lazyZodSchema(() => (
  replaceReadFields(PluginReleaseFactsV1Schema, {
    normalizedManifest: PluginManifestV2LoadSchema,
  })
));

export const PluginMachineMaterializationV1LoadSchema: z.ZodMiniType<PluginMachineMaterializationV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationV1Schema, {
    declaredManifest: z.optional(PluginManifestV2LoadSchema),
  })
));

export const PluginMachineMaterializationSnapshotV1LoadSchema: z.ZodMiniType<PluginMachineMaterializationSnapshotV1> = lazyZodSchema(() => (
  replaceReadFields(PluginMachineMaterializationSnapshotV1Schema, {
    materializations: z.readonly(z.array(PluginMachineMaterializationV1LoadSchema)),
  })
));
