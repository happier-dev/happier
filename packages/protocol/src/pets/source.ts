import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const PetPackageSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.looseObject({
      kind: z.literal('builtIn'),
      petId: z.string().check(z.minLength(1), z.maxLength(200)),
    }),
  z.looseObject({
      kind: z.literal('detectedCodexHome'),
      homeKind: z.enum(['user', 'connectedService']),
      homePath: z.string().check(z.minLength(1), z.maxLength(10_000)),
      packagePath: z.string().check(z.minLength(1), z.maxLength(10_000)),
      sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
  z.looseObject({
      kind: z.literal('happierManagedLocal'),
      packagePath: z.string().check(z.minLength(1), z.maxLength(10_000)),
      sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
  z.looseObject({
      kind: z.literal('accountPet'),
      accountPetId: z.string().check(z.minLength(1), z.maxLength(500)),
      sourceKey: z.string().check(z.minLength(1), z.maxLength(500)),
    }),
]));

export type PetPackageSourceV1 = z.infer<typeof PetPackageSourceV1Schema>;

export const PetPackageSelectionV1Schema = lazyZodSchema(() => z.looseObject({
    source: PetPackageSourceV1Schema,
    selectedAtMs: z.number().check(z.int(), z.minimum(0)),
  }));

export type PetPackageSelectionV1 = z.infer<typeof PetPackageSelectionV1Schema>;
