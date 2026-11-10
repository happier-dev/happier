import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Chromium derives these 32 a–p characters from the extension's public key. */
export const BrowserExtensionIdV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[a-p]{32}$/)));
export type BrowserExtensionIdV1 = z.infer<typeof BrowserExtensionIdV1Schema>;

export const BrowserExtensionWebStoreSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('webStore'), extensionId: BrowserExtensionIdV1Schema,
}));
export type BrowserExtensionWebStoreSourceV1 = z.infer<typeof BrowserExtensionWebStoreSourceV1Schema>;
