import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { StoredImageRefV1Schema, PluginUiReadStoredImageResultV1Schema } from '../plugins/ui/storedImage.js';

/** Host-stamped caller identity with the same strict native image facts as renderer requests. */
export const DaemonPluginStoredImageReadRequestSchema = lazyZodSchema(() => z.object({
  callerPluginId: z.string().trim().min(1),
  expectedCallerOccurrenceId: z.string().trim().min(1),
  media: StoredImageRefV1Schema,
}).strict());
export type DaemonPluginStoredImageReadRequest = z.infer<typeof DaemonPluginStoredImageReadRequestSchema>;
export const DaemonPluginStoredImageReadResponseSchema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), image: PluginUiReadStoredImageResultV1Schema }).strict(),
  z.object({ ok: z.literal(false), code: z.string().min(1) }).strict(),
]));
export type DaemonPluginStoredImageReadResponse = z.infer<typeof DaemonPluginStoredImageReadResponseSchema>;
