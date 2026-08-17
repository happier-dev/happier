import { z } from 'zod';

const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_PROVIDER_IDS = new Set(['constructor', 'prototype']);

const PredecessorVoiceProviderIdSchema = z.union([
    z.string().min(1).max(64)
        .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
        .refine((providerId) => !RESERVED_PROVIDER_IDS.has(providerId), 'Reserved provider identifier'),
    z.string().min(3).max(256).refine((providerId) => {
        const separator = providerId.indexOf('/');
        if (separator <= 0 || separator === providerId.length - 1) return false;
        const pluginId = providerId.slice(0, separator);
        const localId = providerId.slice(separator + 1);
        const pluginSegments = pluginId.split('.');
        return pluginSegments.length >= 2
            && pluginSegments.every((segment) => (
                /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(segment)
                && !RESERVED_RECORD_KEYS.has(segment)
            ))
            && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(localId);
    }, 'External Voice provider ids must be canonical qualified Plugin contribution keys'),
]);

function canonicalRecordKeySchema(maxLength: number) {
    return z.string().min(1).max(maxLength)
        .refine((value) => value === value.trim(), 'Identifier must already be canonical')
        .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identifier must not contain control characters')
        .refine((value) => !RESERVED_RECORD_KEYS.has(value), 'Identifier is reserved');
}

const SavedSecretIdSchema = z.string().min(1).max(256)
    .refine((value) => value === value.trim(), 'Saved-secret id must already be canonical')
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Saved-secret id must not contain control characters');

const PredecessorSavedSecretSlotRecordSchema = z.record(
    canonicalRecordKeySchema(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    SavedSecretIdSchema,
).superRefine((value, context) => {
    if (Object.keys(value).length > 8) {
        context.addIssue({ code: 'custom', message: 'Too many credential-slot bindings' });
    }
});

export const PredecessorVoiceCredentialBindingV1Schema = z.object({
    providerId: PredecessorVoiceProviderIdSchema,
    credentialBindings: z.object({
        account: PredecessorSavedSecretSlotRecordSchema.optional(),
        byMachineId: z.record(
            canonicalRecordKeySchema(256),
            PredecessorSavedSecretSlotRecordSchema,
        ).optional(),
    }).strict().superRefine((value, context) => {
        if (Object.keys(value.byMachineId ?? {}).length > 2_048) {
            context.addIssue({
                code: 'custom',
                path: ['byMachineId'],
                message: 'Too many machine secret-binding branches',
            });
        }
    }),
    approvedRecipientContractDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
}).strict();

export type PredecessorVoiceCredentialBindingV1 = Readonly<
    z.infer<typeof PredecessorVoiceCredentialBindingV1Schema>
>;

export function parsePredecessorVoiceCredentialBindings(
    value: unknown,
): readonly PredecessorVoiceCredentialBindingV1[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as Readonly<Record<string, unknown>>;
    if (!Array.isArray(raw.credentialBindings)) return [];
    return raw.credentialBindings.slice(0, 64).flatMap((candidate) => {
        const parsed = PredecessorVoiceCredentialBindingV1Schema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
    });
}
