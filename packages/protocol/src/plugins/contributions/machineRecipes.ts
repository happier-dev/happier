import type { z } from 'zod/mini';
import { MachineRecipeV1Schema as canonicalRecipeSchema, type MachineRecipeV1 } from '../../machines/setup/machineRecipeV1.js';

// Keep the public family projection finite; admission uses the same native schema.
export const MachineRecipeV1Schema: z.ZodMiniType<MachineRecipeV1> = canonicalRecipeSchema;
export type { MachineRecipeV1 } from '../../machines/setup/machineRecipeV1.js';
