import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { StoredImageRefV1Schema, PluginUiReadStoredImageResultV1Schema } from '../plugins/ui/storedImage.js';

/** Host-stamped caller identity with the same strict native image facts as renderer requests. */
export const DaemonPluginStoredImageReadRequestSchema = lazyZodSchema(() => z.strictObject({
  callerPluginId: z.string().check(z.trim(), z.minLength(1)),
  expectedCallerOccurrenceId: z.string().check(z.trim(), z.minLength(1)),
  media: StoredImageRefV1Schema,
}));
export type DaemonPluginStoredImageReadRequest = z.infer<typeof DaemonPluginStoredImageReadRequestSchema>;
export const DaemonPluginStoredImageReadResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), image: PluginUiReadStoredImageResultV1Schema }),
  z.strictObject({ ok: z.literal(false), code: z.string().check(z.minLength(1)) }),
]));
export type DaemonPluginStoredImageReadResponse = z.infer<typeof DaemonPluginStoredImageReadResponseSchema>;
