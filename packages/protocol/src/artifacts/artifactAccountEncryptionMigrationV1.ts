import { z } from 'zod';
import { PluginUiReleaseSlotV1Schema } from '../plugins/availability/v1.js';
import { PackageAssetArchiveDescriptorV1Schema } from '../plugins/availability/packageAssetV1.js';

/** Account-transition inventory V1: authority and content envelopes are closed. */
export const ArtifactAccountEncryptionMigrationOwnershipV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ordinary') }).strict(),
  z.object({ kind: z.literal('pluginUi'), pluginId: z.string().min(1), slot: PluginUiReleaseSlotV1Schema }).strict(),
  z.object({ kind: z.literal('packageAsset'), pluginId: z.string().min(1), descriptor: PackageAssetArchiveDescriptorV1Schema }).strict(),
]);
export type ArtifactAccountEncryptionMigrationOwnershipV1 = z.infer<typeof ArtifactAccountEncryptionMigrationOwnershipV1Schema>;

export const ArtifactAccountEncryptionMigrationRowV1Schema = z.object({
  id: z.string().min(1), ownership: ArtifactAccountEncryptionMigrationOwnershipV1Schema,
  header: z.string().min(1), headerVersion: z.number().int().nonnegative(),
  body: z.string().min(1), bodyVersion: z.number().int().nonnegative(), dataEncryptionKey: z.string().min(1),
  provenance: z.string().min(1).nullable().optional(),
  provenanceDataEncryptionKey: z.string().min(1).nullable().optional(),
  revisions: z.array(z.object({ bodyVersion: z.number().int().nonnegative(), body: z.string().min(1),
    provenance: z.string().min(1).nullable().optional() }).strict()),
}).strict();
export const ArtifactAccountEncryptionMigrationInventoryV1Schema = z.object({
  ownerAccountId: z.string().min(1), encryptionMode: z.enum(['plain', 'e2ee']),
  items: z.array(ArtifactAccountEncryptionMigrationRowV1Schema), nextCursor: z.string().min(1).nullable(),
}).strict();
export type ArtifactAccountEncryptionMigrationInventoryV1 = z.infer<typeof ArtifactAccountEncryptionMigrationInventoryV1Schema>;
