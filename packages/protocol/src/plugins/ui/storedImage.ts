import { z } from 'zod';
import { SessionImageMediaReferenceV1Schema } from '../../sessions/media/imageReferenceV1.js';

/** Native Session-image facts; the Session reader verifies declared scope and file integrity. */
export const StoredImageRefV1Schema = SessionImageMediaReferenceV1Schema.required({ file: true });
export type StoredImageRefV1 = z.infer<typeof StoredImageRefV1Schema>;
export const PluginUiReadStoredImageRequestV1Schema = z.object({ image: StoredImageRefV1Schema }).strict();
export const PluginUiReadStoredImageResultV1Schema = z.object({
  bytesBase64: z.string(),
  mimeType: z.literal('image/png'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();
export type PluginUiReadStoredImageResultV1 = z.infer<typeof PluginUiReadStoredImageResultV1Schema>;
