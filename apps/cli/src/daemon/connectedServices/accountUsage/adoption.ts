import { z } from 'zod';

import {
    ProviderAccountUsageRecordIdSchema,
    ProviderAccountUsageRecordKeyV1Schema,
} from '@happier-dev/protocol';

const ProviderAccountUsageAdoptionProofV1Schema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('opaque_local_credential_ref_match'),
        localCredentialRef: z.string().trim().min(1),
    }).strict(),
    z.object({
        kind: z.literal('session_subject_match'),
        sessionId: z.string().trim().min(1).nullable().optional(),
    }).strict(),
    z.object({
        kind: z.literal('id_token_account_id'),
        issuer: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
        kind: z.literal('provider_account_id_match'),
    }).strict(),
    z.object({
        kind: z.literal('provider_owned_subject_proof'),
        detail: z.string().trim().min(1).optional(),
    }).strict(),
]);

export const ProviderAccountUsageAdoptionV1Schema = z.object({
    providerId: z.string().trim().min(1),
    fromRecordId: ProviderAccountUsageRecordIdSchema,
    toRecordId: ProviderAccountUsageRecordIdSchema,
    stableRecordKey: ProviderAccountUsageRecordKeyV1Schema,
    proof: ProviderAccountUsageAdoptionProofV1Schema,
    observedAtMs: z.number().int().nonnegative(),
}).strict().superRefine((adoption, ctx) => {
    if (adoption.providerId !== adoption.stableRecordKey.providerId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Adoption providerId must match stable record key providerId',
            path: ['providerId'],
        });
    }
});

export type ProviderAccountUsageAdoptionV1 = z.infer<typeof ProviderAccountUsageAdoptionV1Schema>;
