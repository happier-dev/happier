import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const MachineReplacementReasonSchema = lazyZodSchema(() => z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_:-]*$/u));

export type MachineReplacementReason = z.infer<typeof MachineReplacementReasonSchema>;

export const MachineReplacementFieldsSchema = lazyZodSchema(() => z.object({
    replacesMachineId: z.string().trim().min(1).optional(),
    replacementReason: MachineReplacementReasonSchema.optional(),
}));

export type MachineReplacementFields = z.infer<typeof MachineReplacementFieldsSchema>;

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
