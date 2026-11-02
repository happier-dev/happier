import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { MachineRecipeReferenceV1Schema, MachineRecipePackageObservationV1Schema } from './machineRecipeV1.js';

export const MachineSetupObservationStatusV1Schema = lazyZodSchema(() => z.enum([
    'satisfied', 'drifted', 'unsupported', 'unavailable', 'unverifiable',
]));
export const MachineSetupObservationReasonV1Schema = lazyZodSchema(() => z.enum([
    'required_fact_unavailable', 'needs_admin_to_check', 'package_manager_busy',
    'foreign_effect_conflict', 'private_scope_unenforceable', 'remove_unsupported',
    'plan_changed', 'validation_failed', 'native_effect_failed', 'admin_access_unavailable',
]));
const backend = () => z.string().check(z.regex(/^[a-z][a-zA-Z0-9_.-]*$/));

/** Public native facts are a compact projection, never the private effect-plan facts bag. */
export const MachineSetupPublishedStepObservationV1Schema = lazyZodSchema(() => z.strictObject({
    stepId: z.string().check(z.minLength(1)), status: MachineSetupObservationStatusV1Schema,
    reason: z.optional(MachineSetupObservationReasonV1Schema), backend: z.optional(backend()),
    packages: z.optional(z.array(MachineRecipePackageObservationV1Schema)),
}));

export const MachineSetupObservationV1Schema = lazyZodSchema(() => z.strictObject({
    version: z.literal(1), desiredRevision: z.number().check(z.int(), z.nonnegative()),
    status: z.enum(['checking', 'satisfied', 'drifted', 'unsupported', 'unavailable', 'unverifiable']),
    reason: z.optional(MachineSetupObservationReasonV1Schema),
    recipes: z.array(z.strictObject({
        ref: MachineRecipeReferenceV1Schema, status: MachineSetupObservationStatusV1Schema,
        reason: z.optional(MachineSetupObservationReasonV1Schema),
        steps: z.array(MachineSetupPublishedStepObservationV1Schema),
    })),
    scripts: z.optional(z.array(z.strictObject({
        sourceIndex: z.number().check(z.int(), z.nonnegative()), status: MachineSetupObservationStatusV1Schema,
        reason: z.optional(MachineSetupObservationReasonV1Schema),
    }))),
    updates: z.optional(z.strictObject({
        status: MachineSetupObservationStatusV1Schema, reason: z.optional(MachineSetupObservationReasonV1Schema),
        backend: z.optional(backend()), pendingSecurity: z.optional(z.number().check(z.int(), z.nonnegative())),
        pendingAll: z.optional(z.number().check(z.int(), z.nonnegative())), rebootNeeded: z.optional(z.boolean()),
    })),
}));
export const MachineSetupObservationV1ReadSchema = createStoredReadSchema(MachineSetupObservationV1Schema);
export type MachineSetupObservationV1 = z.infer<typeof MachineSetupObservationV1Schema>;
