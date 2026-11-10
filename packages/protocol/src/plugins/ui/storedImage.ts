import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionImageMediaReferenceV1Schema } from '../../sessions/media/imageReferenceV1.js';

/** Native Session-image facts; the Session reader verifies declared scope and file integrity. */
export const StoredImageRefV1Schema = lazyZodSchema(() => z.required(SessionImageMediaReferenceV1Schema, { file: true }));
export type StoredImageRefV1 = z.infer<typeof StoredImageRefV1Schema>;
export const PluginUiReadStoredImageRequestV1Schema = lazyZodSchema(() => z.strictObject({ image: StoredImageRefV1Schema }));
export const PluginUiReadStoredImageResultV1Schema = lazyZodSchema(() => z.strictObject({
  bytesBase64: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().check(z.int(), z.positive()),
  height: z.number().check(z.int(), z.positive()),
}));
export type PluginUiReadStoredImageResultV1 = z.infer<typeof PluginUiReadStoredImageResultV1Schema>;
