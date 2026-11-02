import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { BrowserExtensionWebStoreSourceV1Schema } from '../browser/profile/extensionsV1.js';

/** Catalogs reference Web Store packages; direct unpacked imports belong to browser Actions. */
export const RegistryBrowserExtensionV1Schema = BrowserExtensionWebStoreSourceV1Schema;
export type RegistryBrowserExtensionV1 = z.infer<typeof RegistryBrowserExtensionV1Schema>;
export const RegistryBrowserExtensionCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: z.string().check(z.minLength(1)), title: z.string().check(z.minLength(1)), description: z.optional(z.string()),
  extension: RegistryBrowserExtensionV1Schema,
}));
export type RegistryBrowserExtensionCatalogEntryV1 = z.infer<typeof RegistryBrowserExtensionCatalogEntryV1Schema>;
