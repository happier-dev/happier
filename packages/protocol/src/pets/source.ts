import { z } from 'zod';

export const PetPackageSourceV1Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('builtIn'),
      petId: z.string().min(1).max(200),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('detectedCodexHome'),
      homeKind: z.enum(['user', 'connectedService']),
      homePath: z.string().min(1).max(10_000),
      packagePath: z.string().min(1).max(10_000),
      sourceKey: z.string().min(1).max(500),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('happierManagedLocal'),
      packagePath: z.string().min(1).max(10_000),
      sourceKey: z.string().min(1).max(500),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('accountPet'),
      accountPetId: z.string().min(1).max(500),
      sourceKey: z.string().min(1).max(500),
    })
    .passthrough(),
]);

export type PetPackageSourceV1 = z.infer<typeof PetPackageSourceV1Schema>;

export const PetPackageSelectionV1Schema = z
  .object({
    source: PetPackageSourceV1Schema,
    selectedAtMs: z.number().int().min(0),
  })
  .passthrough();

export type PetPackageSelectionV1 = z.infer<typeof PetPackageSelectionV1Schema>;
