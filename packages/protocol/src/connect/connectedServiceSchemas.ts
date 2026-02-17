import { z } from 'zod';

export const ConnectedServiceIdSchema = z.enum([
    'openai-codex',
    'anthropic',
    'gemini',
]);

export type ConnectedServiceId = z.infer<typeof ConnectedServiceIdSchema>;

export const ConnectedServiceCredentialFormatSchema = z.enum(['account_scoped_v1']);
export type ConnectedServiceCredentialFormat = z.infer<typeof ConnectedServiceCredentialFormatSchema>;

export const ConnectedServiceCredentialKindSchema = z.enum(['oauth', 'token']);
export type ConnectedServiceCredentialKind = z.infer<typeof ConnectedServiceCredentialKindSchema>;

export const ConnectedServiceProfileIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/, 'Invalid profile id');

export type ConnectedServiceProfileId = z.infer<typeof ConnectedServiceProfileIdSchema>;

const OauthCredentialPayloadSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    idToken: z.string().min(1).nullable(),
    scope: z.string().min(1).nullable(),
    tokenType: z.string().min(1).nullable(),
    providerAccountId: z.string().min(1).nullable(),
    providerEmail: z.string().min(1).nullable(),
    raw: z.unknown().nullable(),
});

const TokenCredentialPayloadSchema = z.object({
    token: z.string().min(1),
    providerAccountId: z.string().min(1).nullable(),
    providerEmail: z.string().min(1).nullable(),
    raw: z.unknown().nullable(),
});

const ConnectedServiceCredentialBaseSchema = z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
});

export const ConnectedServiceCredentialRecordV1Schema = z.discriminatedUnion('kind', [
    ConnectedServiceCredentialBaseSchema.extend({
        kind: z.literal('oauth'),
        oauth: OauthCredentialPayloadSchema,
        token: z.null(),
    }),
    ConnectedServiceCredentialBaseSchema.extend({
        kind: z.literal('token'),
        oauth: z.null(),
        token: TokenCredentialPayloadSchema,
    }),
]);

export type ConnectedServiceCredentialRecordV1 = z.infer<typeof ConnectedServiceCredentialRecordV1Schema>;

export const SealedConnectedServiceCredentialV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});

export type SealedConnectedServiceCredentialV1 = z.infer<typeof SealedConnectedServiceCredentialV1Schema>;

export const ConnectedServiceQuotaUnitV1Schema = z.enum([
    'count',
    'tokens',
    'credits',
    'usd',
    'requests',
    'unknown',
]);

export type ConnectedServiceQuotaUnitV1 = z.infer<typeof ConnectedServiceQuotaUnitV1Schema>;

export const ConnectedServiceQuotaMeterV1Schema = z.object({
    meterId: z.string().min(1),
    label: z.string().min(1),
    used: z.number().finite().nullable(),
    limit: z.number().finite().nullable(),
    unit: ConnectedServiceQuotaUnitV1Schema,
    utilizationPct: z.number().finite().min(0).max(100).nullable(),
    resetsAt: z.number().int().nonnegative().nullable(),
    status: z.enum(['ok', 'unavailable', 'estimated']),
    details: z
        .object({
            note: z.string().min(1).nullable().optional(),
        })
        .optional()
        .default({}),
});

export type ConnectedServiceQuotaMeterV1 = z.infer<typeof ConnectedServiceQuotaMeterV1Schema>;

export const ConnectedServiceQuotaSnapshotV1Schema = z.object({
    v: z.literal(1),
    serviceId: ConnectedServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema,
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().min(1),
    planLabel: z.string().min(1).nullable(),
    accountLabel: z.string().min(1).nullable(),
    meters: z.array(ConnectedServiceQuotaMeterV1Schema),
});

export type ConnectedServiceQuotaSnapshotV1 = z.infer<typeof ConnectedServiceQuotaSnapshotV1Schema>;

export const SealedConnectedServiceQuotaSnapshotV1Schema = z.object({
    format: ConnectedServiceCredentialFormatSchema,
    ciphertext: z.string().min(1),
});

export type SealedConnectedServiceQuotaSnapshotV1 = z.infer<typeof SealedConnectedServiceQuotaSnapshotV1Schema>;
