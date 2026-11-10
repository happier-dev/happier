import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const MachineReplacementReasonSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[a-z][a-z0-9_:-]*$/u)));

export type MachineReplacementReason = z.infer<typeof MachineReplacementReasonSchema>;

export const MachineReplacementFieldsSchema = lazyZodSchema(() => z.object({
    replacesMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    replacementReason: z.optional(MachineReplacementReasonSchema),
}));

export type MachineReplacementFields = z.infer<typeof MachineReplacementFieldsSchema>;

/** Existing registration outcomes; skip diagnostics never carry server prose. */
export const MachineRegistrationReplacementResultSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('applied'),
        replacesMachineId: z.string().check(z.trim(), z.minLength(1)),
    }),
    z.strictObject({
        status: z.literal('alreadyApplied'),
        replacesMachineId: z.string().check(z.trim(), z.minLength(1)),
    }),
    z.strictObject({
        status: z.literal('skipped'),
        replacesMachineId: z.string().check(z.trim(), z.minLength(1)),
        reason: z.enum([
            'old_machine_not_found',
            'replacement_machine_not_found',
            'persistent_machine_required',
            'replacement_same_machine',
            'replacement_machine_revoked',
            'replacement_machine_already_replaced',
            'content_public_key_fingerprint_mismatch',
            'installation_id_mismatch',
            'installation_public_key_mismatch',
        ]),
    }),
]));

export type MachineRegistrationReplacementResult = Readonly<z.infer<typeof MachineRegistrationReplacementResultSchema>>;

export type MachineReplacementRegistrationIntent = Readonly<{
    replacesMachineId: string;
    replacementReason: MachineReplacementReason;
}>;

export function readMachineReplacementRegistrationIntent(
    input: unknown,
): MachineReplacementRegistrationIntent | null {
    const parsed = MachineReplacementFieldsSchema.safeParse(input);
    if (!parsed.success) return null;
    const replacesMachineId = parsed.data.replacesMachineId?.trim();
    const replacementReason = parsed.data.replacementReason?.trim();
    if (!replacesMachineId || !replacementReason) return null;
    return { replacesMachineId, replacementReason };
}
