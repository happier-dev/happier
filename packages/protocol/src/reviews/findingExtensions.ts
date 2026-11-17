import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { withStrictJsonInput } from '../json/strictJsonValue.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../plugins/pluginId.js';

/** Plugin-owned evidence is opaque content; it never grants finding authority. */
export const ReviewFindingExtensionsSchema = lazyZodSchema(() => withStrictJsonInput(
  z.record(asProtocolZod(PluginIdSchema), z.json()),
));
export type ReviewFindingExtensions = z.infer<typeof ReviewFindingExtensionsSchema>;
