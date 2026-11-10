import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** The Account preference keeps an unavailable package reference for later recovery. */
export const PetAccountReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtIn'), petId: z.string().check(z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('accountPet'), accountPetId: z.string().check(z.minLength(1), z.maxLength(256)) }),
]));
export type PetAccountReferenceV1 = z.infer<typeof PetAccountReferenceV1Schema>;

export const PetDeviceOverrideV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('detectedCodexHome'), sourceKey: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('happierManagedLocal'), sourceKey: z.string().check(z.minLength(1)) }),
]));
export type PetDeviceOverrideV1 = z.infer<typeof PetDeviceOverrideV1Schema>;

/** Empty input retains the chooser's navigation contract; selection operands are exclusive. */
export const PetChooseInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({}),
  z.strictObject({ petRef: PetAccountReferenceV1Schema }),
  z.strictObject({ deviceOverride: PetDeviceOverrideV1Schema }),
]));
export type PetChooseInputV1 = z.infer<typeof PetChooseInputV1Schema>;
export const PetChooseResultV1Schema = lazyZodSchema(() => z.strictObject({ status: z.enum(['opened', 'selected']) }));
export type PetChooseResultV1 = z.infer<typeof PetChooseResultV1Schema>;
