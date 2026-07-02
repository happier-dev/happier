import { z } from 'zod';

export const BrowserProfileStorageModeV1Schema = z.enum(['ephemeral', 'session', 'user', 'plugin']);
export type BrowserProfileStorageModeV1 = z.infer<typeof BrowserProfileStorageModeV1Schema>;

export const BrowserProfileOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('user'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('plugin'), id: z.string().trim().min(1).max(256) }).strict(),
]);
export type BrowserProfileOwnerV1 = z.infer<typeof BrowserProfileOwnerV1Schema>;

export const BrowserProfileV1Schema = z
  .object({
    profileId: z.string().trim().min(1).max(256),
    storageMode: BrowserProfileStorageModeV1Schema,
    owner: BrowserProfileOwnerV1Schema,
    cleanupOnSessionClose: z.boolean().default(true),
  })
  .strict();
export type BrowserProfileV1 = z.infer<typeof BrowserProfileV1Schema>;
