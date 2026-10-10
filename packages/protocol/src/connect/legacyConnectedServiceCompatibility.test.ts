import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    ProviderAccountUsageSnapshotV1Schema,
    parseBuiltInLegacyConnectedServiceCredentialRecordV1,
    parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
    parseBuiltInLegacyProviderAccountUsageSnapshotV1,
    parseQualifiedConnectedAccountCredentialPlaintextV1,
    projectBuiltInLegacyConnectedServiceCredentialRecordV1,
    projectBuiltInLegacyConnectedServiceQuotaSnapshotV1,
    projectBuiltInLegacyProviderAccountUsageSnapshotV1,
    projectQualifiedConnectedAccountCredentialPlaintextV1,
} from '../index.js';

// Required fields copied from server-v0.2.1
// (4913c1e533c872a0712ba1c25b3104fd470aacc2) and the matching current Remote
// credential schema at e67f3751f1ab5dc13e40a583a28f3962111154aa.
const ReleasedCredentialRecordSchema = z.discriminatedUnion('kind', [
    z.object({
        v: z.literal(1),
        serviceId: z.string(),
        profileId: z.string(),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative().nullable(),
        kind: z.literal('oauth'),
        oauth: z.object({
            accessToken: z.string().min(1),
            refreshToken: z.string().min(1),
            idToken: z.string().min(1).nullable(),
            tokenType: z.string().min(1).nullable(),
            scope: z.string().min(1).nullable(),
            providerAccountId: z.string().min(1).nullable(),
            providerEmail: z.string().min(1).nullable(),
            raw: z.unknown().nullable(),
        }),
        token: z.null(),
    }),
    z.object({
        v: z.literal(1),
        serviceId: z.string(),
        profileId: z.string(),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative().nullable(),
        kind: z.literal('token'),
        oauth: z.null(),
        token: z.object({
            token: z.string().min(1),
            providerAccountId: z.string().min(1).nullable(),
            providerEmail: z.string().min(1).nullable(),
            raw: z.unknown().nullable(),
        }),
    }),
]);

// Literal prospective predecessor contract copied from current dirty Remote HEAD
// e67f3751f1ab5dc13e40a583a28f3962111154aa. The relevant protocol source was clean.
const RemoteRecoveryCreditsSchema = z.object({
    kind: z.literal('usage_limit_resets'),
    availableCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative().optional(),
    nextExpiresAtMs: z.number().int().nonnegative().nullable().optional(),
    source: z.enum([
        'provider_api',
        'background_fetch',
        'runtime_event',
        'runtime_probe',
        'in_band_snapshot',
        'in_band_provider_snapshot',
        'manual_refresh',
        'user_probe',
        'cached',
        'unknown',
    ]).optional(),
    confidence: z.enum(['exact', 'derived', 'estimated', 'stale', 'unknown']).optional(),
    credits: z.array(z.object({
        providerCreditId: z.string().trim().min(1).optional(),
        kind: z.enum(['usage_limit_reset', 'rate_limit_reset', 'quota_reset', 'unknown']),
        status: z.enum(['available', 'redeeming', 'redeemed', 'expired', 'unknown']),
        providerResetType: z.string().trim().min(1).optional(),
        appliesToProviderLimitId: z.string().trim().min(1).nullable().optional(),
        title: z.string().trim().min(1).nullable().optional(),
        description: z.string().trim().min(1).nullable().optional(),
        grantedAtMs: z.number().int().nonnegative().nullable().optional(),
        expiresAtMs: z.number().int().nonnegative().nullable().optional(),
        redeemStartedAtMs: z.number().int().nonnegative().nullable().optional(),
        redeemedAtMs: z.number().int().nonnegative().nullable().optional(),
    }).strict()).default([]),
}).strict();

const RemoteQuotaSnapshotFixtureSchema = z.object({
    v: z.literal(1),
    serviceId: z.string().min(1),
    profileId: z.string().min(1),
    fetchedAt: z.number().int().nonnegative(),
    staleAfterMs: z.number().int().min(1),
    planLabel: z.string().min(1).nullable(),
    accountLabel: z.string().min(1).nullable(),
    recoveryCredits: RemoteRecoveryCreditsSchema,
    meters: z.array(z.object({
        meterId: z.string().min(1),
        label: z.string().min(1),
        used: z.number().finite().nullable(),
        limit: z.number().finite().nullable(),
        unit: z.enum(['count', 'tokens', 'credits', 'usd', 'requests', 'unknown']),
        utilizationPct: z.number().finite().min(0).max(100).nullable(),
        resetsAt: z.number().int().nonnegative().nullable(),
        status: z.enum(['ok', 'unavailable', 'estimated']),
        details: z.object({}),
    })),
});

const tokenCredential = {
    v: 1,
    serviceId: 'anthropic',
    profileId: 'work',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    expiresAt: null,
    kind: 'token',
    oauth: null,
    token: {
        token: 'sk-ant-test',
        providerAccountId: 'acct_123',
        providerEmail: 'dev@example.com',
        raw: null,
    },
} as const;

const remoteRecoveryCredits = {
    kind: 'usage_limit_resets',
    availableCount: 1,
    totalCount: 2,
    nextExpiresAtMs: 1_700_100_000_000,
    source: 'provider_api',
    confidence: 'exact',
    credits: [{
        providerCreditId: 'credit_123',
        kind: 'rate_limit_reset',
        status: 'available',
        providerResetType: 'five_hour',
        appliesToProviderLimitId: 'five-hour',
        title: null,
        description: 'Reset the five-hour window',
        grantedAtMs: null,
        expiresAtMs: 1_700_100_000_000,
        redeemStartedAtMs: null,
        redeemedAtMs: null,
    }],
} as const;

describe('legacy recovery-credit schema characterization', () => {
    it('normalizes identifiers and independently defaults omitted details', () => {
        const { credits: _credits, ...summary } = remoteRecoveryCredits;
        const input = { ...remoteQuotaSnapshot, recoveryCredits: { ...summary, availableCount: 0 } };
        const first = parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(input);
        expect(first.recoveryCredits?.credits).toEqual([]);
        first.recoveryCredits?.credits.push({ kind: 'unknown', status: 'unknown' });
        expect(parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(input).recoveryCredits?.credits).toEqual([]);
        const trimmed = parseBuiltInLegacyConnectedServiceQuotaSnapshotV1({
            ...remoteQuotaSnapshot,
            recoveryCredits: { ...remoteRecoveryCredits, credits: [{
                ...remoteRecoveryCredits.credits[0], providerCreditId: '  credit_123  ', description: '  detail  ',
            }] },
        });
        expect(trimmed.recoveryCredits?.credits[0]).toMatchObject({ id: 'credit_123', description: 'detail' });
    });

    it('retains closed objects and the aggregate count refinement', () => {
        for (const recoveryCredits of [
            { ...remoteRecoveryCredits, extra: true },
            { ...remoteRecoveryCredits, credits: [{ ...remoteRecoveryCredits.credits[0], extra: true }] },
            { ...remoteRecoveryCredits, totalCount: 0 },
            { ...remoteRecoveryCredits, availableCount: 1.5 },
        ]) {
            let error: unknown;
            try { parseBuiltInLegacyConnectedServiceQuotaSnapshotV1({ ...remoteQuotaSnapshot, recoveryCredits }); }
            catch (caught) { error = caught; }
            expect(error).toMatchObject({ code: 'connected_service_recovery_credits_invalid' });
        }
    });
});

const meter = {
    meterId: 'five-hour',
    label: 'Five hour',
    used: 20,
    limit: 100,
    unit: 'credits',
    utilizationPct: 20,
    resetsAt: 1_700_100_000_000,
    status: 'ok',
    details: {},
} as const;

const remoteQuotaSnapshot = {
    v: 1,
    serviceId: 'openai-codex',
    profileId: 'work',
    fetchedAt: 1_700_000_000_000,
    staleAfterMs: 300_000,
    planLabel: null,
    accountLabel: null,
    recoveryCredits: remoteRecoveryCredits,
    meters: [meter],
} as const;

const remoteProviderUsageSnapshot = {
    v: 1,
    recordId: 'paug_v1_D2ZqLYLAeVljfsjZqAF45dBhrB9Dkihcs1x1QuJJZxE',
    recordKey: {
        providerId: 'codex',
        accountSubjectId: 'acct_123',
        subjectKind: 'account',
        quotaScope: 'account',
    },
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'acct_123' },
    observedAtMs: 1_700_000_000_000,
    fetchedAtMs: 1_700_000_000_000,
    staleAfterMs: 300_000,
    source: 'providerHttp',
    confidence: 'confirmed',
    state: 'loaded_data',
    recoveryCredits: remoteRecoveryCredits,
    meters: [meter],
} as const;

describe('built-in legacy Connected Services compatibility', () => {
    it('keeps AGY current writes qualified when the generated mapping admits storage migration only', () => {
        const payload = { v: 1 as const, values: {
            accessToken: 'selected-access', refreshToken: 'selected-refresh', projectId: 'selected-project',
        } };
        expect(projectQualifiedConnectedAccountCredentialPlaintextV1({
            ref: { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected-account' },
            authenticationModeId: 'oauth-personal', payload, now: 1000,
        })).toEqual(payload);
    });

    it('migrates a persisted 0.2 Antigravity OAuth record with its selected project into qualified credentials', () => {
        // Prospective predecessor: current 0.2 buildConnectedServiceCredentialRecord and
        // ConnectedServiceCredentialRecordV1Schema at HEAD 37a6541, with dirty AGY support.
        const plaintext = {
            v: 1, serviceId: 'antigravity', profileId: 'selected-account',
            createdAt: 1000, updatedAt: 2000, expiresAt: 3601000, kind: 'oauth', token: null,
            oauth: {
                accessToken: 'selected-access', refreshToken: 'selected-refresh', idToken: null,
                scope: 'cloud-platform aicode', tokenType: 'Bearer',
                providerAccountId: 'selected-google-account', providerEmail: 'selected@example.test',
                raw: { project_id: ' selected-project ', client_id: 'must-not-migrate', unrelated: true },
            },
        };
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
            ref: { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected-account' },
            authenticationModeId: 'oauth-personal', plaintext,
        })).toEqual({
            v: 1,
            values: {
                accessToken: 'selected-access', refreshToken: 'selected-refresh',
                scopes: 'cloud-platform aicode', tokenType: 'Bearer', expiresAtMs: '3601000',
                providerAccountId: 'selected-google-account', providerEmail: 'selected@example.test',
                projectId: 'selected-project',
            },
        });
        // Stored ingress does not grant a scalar public credential or peer identity.
        expect(ConnectedServiceCredentialRecordV1Schema.safeParse(plaintext).success).toBe(false);
        expect(() => parseBuiltInLegacyConnectedServiceCredentialRecordV1(plaintext))
            .toThrow('connected_service_credential_invalid');
        const ref = { service: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' }, accountId: 'selected-account' };
        for (const invalid of [
            { ...plaintext, createdAt: -1 },
            { ...plaintext, oauth: { ...plaintext.oauth, refreshToken: '' } },
            { ...plaintext, oauth: { ...plaintext.oauth, accessToken: 1 } },
            { ...plaintext, token: { token: 'unexpected' } },
            { ...plaintext, serviceId: 'unregistered-storage-id' },
            { ...plaintext, oauth: { ...plaintext.oauth, raw: { happierQualifiedConnectedAccountCredentialV1: {
                v: 1, authenticationModeId: 'oauth-personal', payload: { v: 1, values: { accessToken: 1 } },
            } } } },
        ]) {
            expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
                ref, authenticationModeId: 'oauth-personal', plaintext: invalid,
            })).toThrow('connected_service_credential_invalid');
        }
        for (const mismatch of [
            { ...plaintext, serviceId: 'gemini' },
            { ...plaintext, profileId: 'different-account' },
            { ...plaintext, oauth: { ...plaintext.oauth, raw: { happierQualifiedConnectedAccountCredentialV1: {
                v: 1, authenticationModeId: 'wrong-mode', payload: { v: 1, values: {
                    accessToken: 'selected-access', refreshToken: 'selected-refresh',
                } },
            } } } },
        ]) {
            expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
                ref, authenticationModeId: 'oauth-personal', plaintext: mismatch,
            })).toThrow('connected_account_credential_legacy_assertion_mismatch');
        }
        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
            ref, authenticationModeId: 'wrong-mode', plaintext,
        })).toThrow('connected_account_credential_legacy_assertion_mismatch');
    });

    it('drops additive persisted credential fields while keeping known fields and write admission strict', () => {
        const ref = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' };
        const payload = { v: 1 as const, values: { setupToken: 'setup-token' } };
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'setup-token',
            plaintext: { ...payload, future: true } })).toEqual(payload);
        const record = ConnectedServiceCredentialRecordV1Schema.parse(projectQualifiedConnectedAccountCredentialPlaintextV1({
            ref, authenticationModeId: 'setup-token', payload, now: 1,
        }));
        if (record.kind !== 'token') throw new Error('Expected token record');
        const plaintext = { ...record, future: true, token: { ...record.token, future: true, raw: {
            happierQualifiedConnectedAccountCredentialV1: { v: 1, authenticationModeId: 'setup-token', future: true,
                payload: { ...payload, future: true } },
        } } };
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'setup-token', plaintext })).toEqual(payload);
        const extendedPayload = { ...payload, future: true };
        expect(() => projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'setup-token',
            payload: extendedPayload, now: 1 })).toThrow();
        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'setup-token',
            plaintext: { ...payload, values: { setupToken: 1 } } })).toThrow('connected_service_credential_invalid');
        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'setup-token',
            plaintext: { ...plaintext, token: { ...plaintext.token, raw: {
                happierQualifiedConnectedAccountCredentialV1: { v: 1, authenticationModeId: 'setup-token', payload: { v: 1, values: { setupToken: 1 } } },
            } } } })).toThrow('connected_service_credential_invalid');
    });
    it('retains predecessor Claude OAuth plan facts when reading historical credentials', () => {
        // Native credential metadata produced by ../0.2 at ba32a228cdb99b4f6edb50d699234261a970b56b.
        const ref = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' };
        const plaintext = {
            v: 1, serviceId: 'claude-subscription', profileId: 'work', createdAt: 1, updatedAt: 1, expiresAt: null,
            kind: 'oauth', token: null,
            oauth: {
                accessToken: 'access', refreshToken: 'refresh', idToken: null, tokenType: null, scope: null,
                providerAccountId: null, providerEmail: 'person@example.test',
                raw: { claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'max_20x' } },
            },
        };
        const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'oauth', plaintext });
        expect(payload.values).toMatchObject({ subscriptionType: 'max', rateLimitTier: 'max_20x' });
        const currentPayload = { ...payload, values: { ...payload.values, lastRefreshAtMs: '2' } };
        const projected = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'oauth', payload: currentPayload, now: 2 });
        expect(projected).toMatchObject({ oauth: { raw: { claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'max_20x' } } } });
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: 'oauth', plaintext: projected })).toEqual(currentPayload);
    });
    it.each([
        {
            serviceId: 'openai-codex',
            ref: {
                service: {
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                },
                accountId: 'codex-work',
            },
            authenticationModeId: 'oauth',
            values: {
                accessToken: 'codex-access',
                refreshToken: 'codex-refresh',
                idToken: 'codex-id',
                expiresAtMs: '1700100000000',
                providerAccountId: 'codex-provider-account',
                lastRefreshAtMs: '1700000000000',
            },
        },
        {
            serviceId: 'openai',
            ref: {
                service: {
                    pluginId: 'happier.voice.openai',
                    localId: 'openai',
                },
                accountId: 'openai-work',
            },
            authenticationModeId: 'api-key',
            values: { apiKey: 'openai-api-key' },
        },
        {
            serviceId: 'anthropic',
            ref: {
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                },
                accountId: 'anthropic-work',
            },
            authenticationModeId: 'api-key',
            values: { token: 'anthropic-api-key' },
        },
        {
            serviceId: 'claude-subscription',
            ref: {
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude-subscription',
                },
                accountId: 'claude-setup',
            },
            authenticationModeId: 'setup-token',
            values: { setupToken: 'claude-setup-token' },
        },
        {
            serviceId: 'claude-subscription',
            ref: {
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude-subscription',
                },
                accountId: 'claude-oauth',
            },
            authenticationModeId: 'oauth',
            values: {
                accessToken: 'claude-access',
                refreshToken: 'claude-refresh',
                providerAccountId: 'claude-provider-account',
                providerEmail: 'claude@example.test',
                scopes: '["user:inference","user:profile"]',
                expiresAtMs: '1700200000000',
            },
        },
        {
            serviceId: 'gemini',
            ref: {
                service: {
                    pluginId: 'happier.agent.gemini',
                    localId: 'gemini-account',
                },
                accountId: 'gemini-work',
            },
            authenticationModeId: 'api-key',
            values: { apiKey: 'gemini-api-key' },
        },
        {
            serviceId: 'github',
            ref: {
                service: {
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                },
                accountId: 'github-work',
            },
            authenticationModeId: 'fine-grained-pat',
            values: { token: 'github-token' },
        },
        {
            serviceId: 'bitbucket',
            ref: {
                service: {
                    pluginId: 'happier.scm.forge.bitbucket',
                    localId: 'bitbucket-account',
                },
                accountId: 'bitbucket-work',
            },
            authenticationModeId: 'manual',
            values: {
                identity: 'person@example.test',
                token: 'bitbucket-token',
            },
        },
    ] as const)(
        'losslessly round-trips the mapped $serviceId/$authenticationModeId mode through the exact legacy root',
        ({ ref, authenticationModeId, values }) => {
            const payload = { v: 1 as const, values };
            const normalizedValues: Readonly<Record<string, string>> = values;
            const metadata = {
                providerIdentity: {
                    accountId: normalizedValues.providerAccountId
                        ?? normalizedValues.identity
                        ?? null,
                    email: normalizedValues.providerEmail ?? null,
                },
                scopes: ['read', 'write'],
            } as const;
            const plaintext =
                projectQualifiedConnectedAccountCredentialPlaintextV1({
                    ref,
                    authenticationModeId,
                    payload,
                    metadata,
                    now: 1_700_000_000_000,
                });

            expect(ConnectedServiceCredentialRecordV1Schema.parse(plaintext))
                .toMatchObject({
                    serviceId: expect.any(String),
                    profileId: ref.accountId,
                });
            expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
                ref,
                authenticationModeId,
                plaintext,
                metadata,
            })).toEqual(payload);
        },
    );

    it('keeps a novel or unrepresentable mode in the qualified plaintext shape', () => {
        const payload = {
            v: 1 as const,
            values: { serviceAccountJson: '{"type":"service_account"}' },
        };
        expect(projectQualifiedConnectedAccountCredentialPlaintextV1({
            ref: {
                service: {
                    pluginId: 'happier.agent.gemini',
                    localId: 'gemini-account',
                },
                accountId: 'gemini-service-account',
            },
            authenticationModeId: 'service-account',
            payload,
            now: 1_700_000_000_000,
        })).toEqual(payload);
        expect(projectQualifiedConnectedAccountCredentialPlaintextV1({
            ref: {
                service: {
                    pluginId: 'example.external',
                    localId: 'novel',
                },
                accountId: 'novel-work',
            },
            authenticationModeId: 'token',
            payload: { v: 1, values: { token: 'novel-token' } },
            now: 1_700_000_000_000,
        })).toEqual({
            v: 1,
            values: { token: 'novel-token' },
        });
    });

    it('rejects embedded legacy service, profile, mode, and visible-secret mismatches', () => {
        const ref = {
            service: {
                pluginId: 'happier.agent.claude',
                localId: 'claude-subscription',
            },
            accountId: 'work',
        } as const;
        const plaintext =
            projectQualifiedConnectedAccountCredentialPlaintextV1({
                ref,
                authenticationModeId: 'setup-token',
                payload: {
                    v: 1,
                    values: { setupToken: 'setup-token' },
                },
                metadata: { scopes: [] },
                now: 1_700_000_000_000,
            });
        const record =
            ConnectedServiceCredentialRecordV1Schema.parse(plaintext);

        for (const mismatched of [
            {
                ...record,
                serviceId: 'anthropic',
            },
            {
                ...record,
                profileId: 'other',
            },
            {
                ...record,
                token: {
                    ...record.token,
                    token: 'different-visible-token',
                },
            },
        ]) {
            expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
                ref,
                authenticationModeId: 'setup-token',
                plaintext: mismatched,
                metadata: { scopes: [] },
            })).toThrow('connected_account_credential_legacy_assertion_mismatch');
        }
        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
            ref,
            authenticationModeId: 'oauth',
            plaintext,
            metadata: { scopes: [] },
        })).toThrow('connected_account_credential_legacy_assertion_mismatch');
    });

    it('rejects legacy OAuth visible fields that diverge from qualified assertions', () => {
        const ref = {
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            accountId: 'work',
        } as const;
        const metadata = { scopes: ['read', 'write'] } as const;
        const record = ConnectedServiceCredentialRecordV1Schema.parse(
            projectQualifiedConnectedAccountCredentialPlaintextV1({
                ref,
                authenticationModeId: 'oauth',
                payload: {
                    v: 1,
                    values: {
                        accessToken: 'access',
                        refreshToken: 'refresh',
                    },
                },
                metadata,
                now: 1_700_000_000_000,
            }),
        );
        if (record.kind !== 'oauth') {
            throw new Error('Expected OAuth compatibility record');
        }

        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
            ref,
            authenticationModeId: 'oauth',
            plaintext: {
                ...record,
                oauth: {
                    ...record.oauth,
                    scope: 'admin',
                },
            },
            metadata,
        })).toThrow('connected_account_credential_legacy_assertion_mismatch');
        expect(() => parseQualifiedConnectedAccountCredentialPlaintextV1({
            ref,
            authenticationModeId: 'oauth',
            plaintext: {
                ...record,
                oauth: {
                    ...record.oauth,
                    tokenType: 'Bearer',
                },
            },
            metadata,
        })).toThrow('connected_account_credential_legacy_assertion_mismatch');
    });

    it('accepts and re-emits the released token credential with required oauth:null', () => {
        expect(ReleasedCredentialRecordSchema.parse(tokenCredential)).toEqual(tokenCredential);

        const canonical = parseBuiltInLegacyConnectedServiceCredentialRecordV1(tokenCredential);
        expect(projectBuiltInLegacyConnectedServiceCredentialRecordV1(canonical)).toEqual(tokenCredential);
        expect(ReleasedCredentialRecordSchema.parse(
            projectBuiltInLegacyConnectedServiceCredentialRecordV1(canonical),
        )).toEqual(tokenCredential);
    });

    it('translates the current Remote rich quota recovery credits without losing fields', () => {
        expect(RemoteRecoveryCreditsSchema.parse(remoteRecoveryCredits)).toEqual(remoteRecoveryCredits);
        expect(RemoteQuotaSnapshotFixtureSchema.parse(remoteQuotaSnapshot))
            .toEqual(remoteQuotaSnapshot);

        const canonical = parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(remoteQuotaSnapshot);
        expect(ConnectedServiceQuotaSnapshotV1Schema.parse(canonical).recoveryCredits).toEqual({
            availableCount: 1,
            totalCount: 2,
            nextExpiresAtMs: 1_700_100_000_000,
            source: 'provider_api',
            confidence: 'exact',
            credits: [{
                id: 'credit_123',
                kind: 'rate_limit_reset',
                status: 'available',
                providerResetType: 'five_hour',
                appliesToProviderLimitId: 'five-hour',
                title: null,
                description: 'Reset the five-hour window',
                grantedAtMs: null,
                expiresAtMs: 1_700_100_000_000,
                redeemStartedAtMs: null,
                redeemedAtMs: null,
            }],
        });
        expect(projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(canonical)).toEqual(remoteQuotaSnapshot);
    });

    it('translates the current Remote rich provider-account usage in both directions', () => {
        const canonical = parseBuiltInLegacyProviderAccountUsageSnapshotV1(remoteProviderUsageSnapshot);
        expect(ProviderAccountUsageSnapshotV1Schema.parse(canonical).recoveryCredits?.credits[0]?.id)
            .toBe('credit_123');
        expect(projectBuiltInLegacyProviderAccountUsageSnapshotV1(canonical))
            .toEqual(remoteProviderUsageSnapshot);
    });

    it('round-trips recovery detail without fabricating a missing provider credit id', () => {
        const predecessor = {
            ...remoteQuotaSnapshot,
            recoveryCredits: {
                ...remoteRecoveryCredits,
                credits: [{
                    ...remoteRecoveryCredits.credits[0],
                    providerCreditId: undefined,
                }],
            },
        };
        expect(() => RemoteQuotaSnapshotFixtureSchema.parse(predecessor))
            .not.toThrow();

        const canonical =
            parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(predecessor);
        expect(canonical.recoveryCredits).toMatchObject({
            availableCount: 1,
            totalCount: 2,
            credits: [{
                kind: 'rate_limit_reset',
                status: 'available',
                providerResetType: 'five_hour',
                expiresAtMs: 1_700_100_000_000,
            }],
        });
        expect(canonical.recoveryCredits?.credits[0]).not.toHaveProperty('id');
        expect(projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(canonical))
            .toEqual(predecessor);
    });

    it('preserves Remote-valid unbounded recovery identifiers and display detail', () => {
        const longId = `credit-${'i'.repeat(300)}`;
        const longTitle = `Title ${'t'.repeat(300)}`;
        const longDescription = `Description ${'d'.repeat(1_200)}`;
        const predecessor = {
            ...remoteQuotaSnapshot,
            recoveryCredits: {
                ...remoteRecoveryCredits,
                credits: [{
                    ...remoteRecoveryCredits.credits[0],
                    providerCreditId: longId,
                    title: longTitle,
                    description: longDescription,
                }],
            },
        };

        const canonical =
            parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(predecessor);
        expect(canonical.recoveryCredits?.credits[0]).toMatchObject({
            id: longId,
            title: longTitle,
            description: longDescription,
        });
        expect(projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(canonical))
            .toEqual(predecessor);
    });

    it('degrades canonical unavailable detail to the predecessor non-redeemable unknown status', () => {
        const canonical = ConnectedServiceQuotaSnapshotV1Schema.parse({
            ...remoteQuotaSnapshot,
            planLabel: null,
            accountLabel: null,
            recoveryCredits: {
                availableCount: 0,
                credits: [{
                    id: 'credit_unavailable',
                    kind: 'usage_limit_reset',
                    status: 'unavailable',
                }],
            },
        });

        expect(projectBuiltInLegacyConnectedServiceQuotaSnapshotV1(canonical))
            .toMatchObject({
                recoveryCredits: {
                    kind: 'usage_limit_resets',
                    credits: [{
                        providerCreditId: 'credit_unavailable',
                        status: 'unknown',
                    }],
                },
            });
    });
});
