import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isCredentialFreeRepositoryLocator } from '../scm/repositoryClone.js';

const text = z.string().check(z.trim(), z.minLength(1));

export const RegistryStarterV1Schema = lazyZodSchema(() => z.strictObject({
  repository: z.string().check(z.url(), z.refine(value => /^https:\/\//i.test(value) && isCredentialFreeRepositoryLocator(value), 'Starter repositories require credential-free HTTPS')),
  title: text,
  description: text,
  tags: z.array(text).check(z.minLength(1)),
  previewImage: z.optional(z.string().check(z.url())),
  buildGoal: text,
}));
export type RegistryStarterV1 = z.infer<typeof RegistryStarterV1Schema>;

export const RegistryStarterCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: text,
  starter: RegistryStarterV1Schema,
}));
export type RegistryStarterCatalogEntryV1 = z.infer<typeof RegistryStarterCatalogEntryV1Schema>;

export const RegistryStarterCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1),
  starters: z.array(RegistryStarterCatalogEntryV1Schema),
}));
export type RegistryStarterCatalogV1 = z.infer<typeof RegistryStarterCatalogV1Schema>;
