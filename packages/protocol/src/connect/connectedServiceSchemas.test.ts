import { describe, expect, it } from 'vitest';

import * as schemas from './connectedServiceSchemas.js';
import * as protocol from '../index.js';

const {
    ConnectedServiceAuthGroupErrorResponseV1Schema,
    ConnectedServiceIdSchema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceCredentialHealthV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    ConnectedServiceUsageSourceV1Schema,
    SealedConnectedServiceCredentialV1Schema,
} = schemas;

function expectSchema(name: string): any {
    const schema = (schemas as Record<string, any>)[name];
    expect(typeof schema?.safeParse).toBe('function');
    return schema;
}

describe('connectedServiceSchemas', () => {
    it('exports the canonical credential mutation contract from the package barrel', () => {
        for (const name of [
            'ConnectedServiceCredentialRevisionV1Schema',
            'ConnectedServiceCredentialMutationGuardV1Schema',
            'ConnectedServiceCredentialMutationSuccessV1Schema',
            'ConnectedServiceCredentialCompatibleMutationSuccessV1Schema',
            'ConnectedServiceCredentialMutationSupersededV1Schema',
            'ConnectedServiceCredentialMutationResponseV1Schema',
            'ConnectedServiceCredentialCompatibleMutationResponseV1Schema',
        ]) {
            expect(typeof (protocol as Record<string, unknown>)[name]).toBe('object');
        }
    });

    it('defines one strict credential revision and mutation fence contract', () => {
        const revisionSchema = expectSchema('ConnectedServiceCredentialRevisionV1Schema');
        const mutationGuardSchema = expectSchema('ConnectedServiceCredentialMutationGuardV1Schema');
        const mutationSuccessSchema = expectSchema('ConnectedServiceCredentialMutationSuccessV1Schema');
        const compatibleMutationSuccessSchema = expectSchema('ConnectedServiceCredentialCompatibleMutationSuccessV1Schema');
        const mutationSupersededSchema = expectSchema('ConnectedServiceCredentialMutationSupersededV1Schema');
        const mutationResponseSchema = expectSchema('ConnectedServiceCredentialMutationResponseV1Schema');

        expect(revisionSchema.parse('csr_0123456789ABCDEFGHJKMNPQRS')).toBe('csr_0123456789ABCDEFGHJKMNPQRS');
        expect(revisionSchema.safeParse(' ').success).toBe(false);
        expect(mutationGuardSchema.parse({
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            refreshLeaseOwnerId: 'machine:daemon:attempt',
        })).toEqual({
            expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
            refreshLeaseOwnerId: 'machine:daemon:attempt',
        });
        expect(mutationGuardSchema.parse({ expectedCredentialRevision: null })).toEqual({
            expectedCredentialRevision: null,
        });
        expect(mutationGuardSchema.safeParse({ refreshLeaseOwnerId: 'owner-without-revision' }).success).toBe(false);
        expect(mutationGuardSchema.safeParse({
            expectedCredentialRevision: null,
            refreshLeaseOwnerId: 'owner-without-existing-credential',
        }).success).toBe(false);
        expect(mutationResponseSchema.parse({
            success: true,
            credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        })).toEqual({
            success: true,
            credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        });
        expect(mutationSuccessSchema.safeParse({ success: true }).success).toBe(false);
        expect(compatibleMutationSuccessSchema.parse({ success: true })).toEqual({ success: true });
        expect(mutationSuccessSchema.safeParse({ success: true, credentialRevision: 'bad' }).success).toBe(false);
        expect(mutationSupersededSchema.safeParse({
            error: 'connect_credential_mutation_superseded',
            reason: 'unknown',
            credentialRevision: null,
        }).success).toBe(false);
        expect(mutationResponseSchema.parse({
            error: 'connect_credential_mutation_superseded',
            reason: 'refresh_lease_lost',
            credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
        })).toEqual({
            error: 'connect_credential_mutation_superseded',
            reason: 'refresh_lease_lost',
            credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
        });
    });

    it('parses connected service ids', () => {
        expect(ConnectedServiceIdSchema.parse('openai-codex')).toBe('openai-codex');
        expect(ConnectedServiceIdSchema.parse('openai')).toBe('openai');
        expect(ConnectedServiceIdSchema.parse('anthropic')).toBe('anthropic');
        expect(ConnectedServiceIdSchema.parse('claude-subscription')).toBe('claude-subscription');
        expect(ConnectedServiceIdSchema.parse('gemini')).toBe('gemini');
        expect(ConnectedServiceIdSchema.parse('antigravity')).toBe('antigravity');
        expect(ConnectedServiceIdSchema.parse('github')).toBe('github');
    });

    it('parses an oauth credential record', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            kind: 'oauth',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 3600_000,
            oauth: {
                accessToken: 'at',
                refreshToken: 'rt',
                idToken: 'id',
                scope: 'openid',
                tokenType: 'Bearer',
                providerAccountId: 'acct_1',
                providerEmail: 'user@example.com',
                raw: null,
            },
            token: null,
        });
        expect(rec.kind).toBe('oauth');
        expect(rec.serviceId).toBe('openai-codex');
    });

    it('parses a token credential record', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'github',
            profileId: 'default',
            kind: 'token',
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: null,
            token: {
                token: 'setup-token',
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
        });
        expect(rec.kind).toBe('token');
        expect(rec.serviceId).toBe('github');
    });

    it.each(['oauth', 'token'] as const)('preserves omitted raw metadata in %s credential records', (kind) => {
        const payload = kind === 'oauth'
            ? { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null }
            : { token: 'setup-token', providerAccountId: null, providerEmail: null };
        const record = {
            v: 1, serviceId: 'github', profileId: 'default', kind,
            createdAt: 1, updatedAt: 1, expiresAt: null,
            oauth: kind === 'oauth' ? payload : null,
            token: kind === 'token' ? payload : null,
        };
        expect(ConnectedServiceCredentialRecordV1Schema.parse(record)).toEqual(record);
        for (const raw of [null, { providerMetadata: 'retained' }]) {
            const withRaw = { ...record, [kind]: { ...payload, raw } };
            expect(ConnectedServiceCredentialRecordV1Schema.parse(withRaw)).toEqual(withRaw);
        }
    });

    it('parses sealed credential payloads', () => {
        const sealed = SealedConnectedServiceCredentialV1Schema.parse({
            format: 'account_scoped_v1',
            ciphertext: 'base64ciphertext',
        });
        expect(sealed.format).toBe('account_scoped_v1');
    });

    it('parses normalized credential health without raw provider secrets', () => {
        const now = Date.now();
        const health = ConnectedServiceCredentialHealthV1Schema.parse({
            v: 1,
            status: 'needs_reauth',
            reconnectRequired: true,
            lastRefreshAttemptAt: now - 2_000,
            lastRefreshFailureAt: now - 1_000,
            lastRefreshFailureKind: 'invalid_grant',
            providerHttpStatus: 400,
            providerErrorCode: 'invalid_grant',
        });

        expect(health.reconnectRequired).toBe(true);
        expect(health.lastRefreshFailureKind).toBe('invalid_grant');

        expect(ConnectedServiceCredentialHealthV1Schema.safeParse({
            v: 1,
            status: 'needs_reauth',
            reconnectRequired: true,
            rawBody: '{"refresh_token":"secret"}',
        }).success).toBe(false);
    });

    it('classifies retryable credential health as usable but not reconnect-required', () => {
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('connected')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('refreshing')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('refresh_failed_retryable')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('needs_reauth')).toBe(false);

        expect(schemas.isConnectedServiceCredentialHealthStatusReconnectRequired('needs_reauth')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusReconnectRequired('refresh_failed_retryable')).toBe(false);
    });

    it('parses connected service quota snapshots', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: 'pro',
            accountLabel: 'work@example.com',
            meters: [
                {
                    meterId: 'requests',
                    label: 'Requests',
                    used: 10,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: 10,
                    resetsAt: now + 60_000,
                    status: 'ok',
                    details: {},
                },
            ],
        });
        expect(parsed.meters).toHaveLength(1);
        expect(parsed.meters[0]?.meterId).toBe('requests');
    });

    it('requires explicit connected-service source context for provider-account quota projections', () => {
        expect(ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        });

        expect(ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'group_member',
            groupId: 'team',
            groupGeneration: 7,
        });

        expect(ConnectedServiceUsageSourceV1Schema.safeParse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'group_member',
        }).success).toBe(false);
        expect(ConnectedServiceUsageSourceV1Schema.safeParse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
            groupId: 'team',
            groupGeneration: 7,
        }).success).toBe(false);
    });

    it('parses additive quota meter source and remaining semantics', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            providerId: 'codex',
            activeAccountId: 'acct-work',
            fetchedAt: now,
            fetchedAtMs: now,
            staleAfterMs: 60_000,
            staleAtMs: now + 60_000,
            planLabel: 'team',
            accountLabel: 'work@example.com',
            source: 'in_band_provider_snapshot',
            confidence: 'exact',
            evidence: {
                providerLimitId: 'weekly_tokens',
                observedAtMs: now - 100,
            },
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 82,
                    limit: 100,
                    usedPct: 82,
                    remaining: 18,
                    remainingPct: 18,
                    resetAtMs: now + 60_000,
                    resetSource: 'provider',
                    providerLimitId: 'weekly_tokens',
                    modelId: 'gpt-5',
                    isExhausted: false,
                    isSoftLimited: true,
                    isCapacityLimited: false,
                    unit: 'credits',
                    utilizationPct: 82,
                    resetsAt: now + 60_000,
                    status: 'ok',
                    source: 'in_band_provider_snapshot',
                    scope: 'weekly',
                    limitScope: 'account',
                    confidence: 'exact',
                    details: {
                        code: 'near_limit',
                        rawScope: 'account:weekly',
                        modelDisplayName: 'GPT 5',
                    },
                },
            ],
        });

        expect(parsed.source).toBe('in_band_provider_snapshot');
        expect(parsed.providerId).toBe('codex');
        expect(parsed.activeAccountId).toBe('acct-work');
        expect(parsed.fetchedAtMs).toBe(now);
        expect(parsed.staleAtMs).toBe(now + 60_000);
        expect(parsed.confidence).toBe('exact');
        expect(parsed.evidence).toEqual({
            providerLimitId: 'weekly_tokens',
            observedAtMs: now - 100,
        });
        expect(parsed.meters[0]?.details?.limitCategory).toBeUndefined();
        expect(parsed.meters[0]).toEqual(expect.objectContaining({
            remaining: 18,
            remainingPct: 18,
            usedPct: 82,
            resetAtMs: now + 60_000,
            resetSource: 'provider',
            providerLimitId: 'weekly_tokens',
            modelId: 'gpt-5',
            isExhausted: false,
            isSoftLimited: true,
            isCapacityLimited: false,
            source: 'in_band_provider_snapshot',
            scope: 'weekly',
            limitScope: 'account',
            confidence: 'exact',
            details: expect.objectContaining({
                code: 'near_limit',
                rawScope: 'account:weekly',
                modelDisplayName: 'GPT 5',
            }),
        }));
    });

    it('parses generalized quota recovery reset credits on quota snapshots', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: 'pro',
            accountLabel: 'work@example.com',
            meters: [],
            recoveryCredits: {
                kind: 'usage_limit_resets',
                availableCount: 1,
                totalCount: 1,
                nextExpiresAtMs: now + 30 * 24 * 60 * 60_000,
                source: 'provider_api',
                confidence: 'exact',
                credits: [
                    {
                        providerCreditId: 'reset-credit-1',
                        kind: 'rate_limit_reset',
                        status: 'available',
                        providerResetType: 'codex_rate_limits',
                        title: 'One free rate limit reset',
                        description: 'Granted by the provider',
                        grantedAtMs: now - 1_000,
                        expiresAtMs: now + 30 * 24 * 60 * 60_000,
                        redeemStartedAtMs: null,
                        redeemedAtMs: null,
                    },
                ],
            },
        });

        expect(parsed.recoveryCredits).toEqual(expect.objectContaining({
            kind: 'usage_limit_resets',
            availableCount: 1,
            totalCount: 1,
            nextExpiresAtMs: now + 30 * 24 * 60 * 60_000,
            source: 'provider_api',
            confidence: 'exact',
        }));
        expect(parsed.recoveryCredits?.credits[0]).toEqual(expect.objectContaining({
            providerCreditId: 'reset-credit-1',
            kind: 'rate_limit_reset',
            status: 'available',
            providerResetType: 'codex_rate_limits',
        }));
    });

    it('normalizes legacy connected-service limit categories to canonical public names', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    used: 100,
                    limit: 100,
                    unit: 'requests',
                    utilizationPct: 100,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'quota' },
                },
                {
                    meterId: 'auth',
                    label: 'Auth',
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct: 100,
                    resetsAt: null,
                    status: 'ok',
                    details: { limitCategory: 'auth' },
                },
            ],
        });

        expect(parsed.meters.map((meter) => meter.details?.limitCategory)).toEqual([
            'usage_limit',
            'auth_invalid',
        ]);
    });

    it('accepts the typed runtime-fallback-unsupported auth-group error code', () => {
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_runtime_fallback_unsupported',
        })).toEqual({
            error: 'connect_group_runtime_fallback_unsupported',
        });
    });

    it('rejects unsafe raw quota evidence payloads', () => {
        const now = Date.now();
        const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            evidence: {
                providerLimitId: 'weekly_tokens',
                observedAtMs: now,
                rawBody: '{"access_token":"secret"}',
                headers: {
                    authorization: 'Bearer secret',
                },
            },
            meters: [],
        });

        expect(result.success).toBe(false);
    });

    it('rejects auth-like quota evidence header aliases', () => {
        const now = Date.now();
        const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            evidence: {
                headers: {
                    'x-authorization': 'Bearer secret',
                },
            },
            meters: [],
        });

        expect(result.success).toBe(false);
    });

    it('strips unsupported meter detail evidence payloads from additive quota meters', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: null,
                limit: null,
                unit: 'tokens',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                details: {
                    evidence: '{"access_token":"secret"}',
                },
            }],
        });

        expect(parsed.meters[0]?.details).toEqual({});
    });

    it('accepts additive quota snapshot and meter fields without preserving unknown raw payloads', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            rawBody: '{"access_token":"secret"}',
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: null,
                limit: null,
                unit: 'tokens',
                utilizationPct: null,
                resetsAt: null,
                status: 'ok',
                rawHeaders: {
                    authorization: 'Bearer secret',
                },
                details: {},
            }],
        });

        expect((parsed as Record<string, unknown>).rawBody).toBeUndefined();
        expect((parsed.meters[0] as Record<string, unknown>).rawHeaders).toBeUndefined();
    });

    it('rejects invalid profile ids', () => {
        const now = Date.now();
        expect(() => {
            ConnectedServiceCredentialRecordV1Schema.parse({
                v: 1,
                serviceId: 'openai-codex',
                profileId: 'work/bad',
                kind: 'oauth',
                createdAt: now,
                updatedAt: now,
                expiresAt: now + 3600_000,
                oauth: {
                    accessToken: 'at',
                    refreshToken: 'rt',
                    idToken: 'id',
                    scope: 'openid',
                    tokenType: 'Bearer',
                    providerAccountId: 'acct_1',
                    providerEmail: 'user@example.com',
                    raw: null,
                },
                token: null,
            });
        }).toThrow();
    });

    it('accepts profile ids that contain ":"', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work:us',
            kind: 'oauth',
            createdAt: now,
            updatedAt: now,
            expiresAt: now + 3600_000,
            oauth: {
                accessToken: 'at',
                refreshToken: 'rt',
                idToken: 'id',
                scope: 'openid',
                tokenType: 'Bearer',
                providerAccountId: 'acct_1',
                providerEmail: 'user@example.com',
                raw: null,
            },
            token: null,
        });
        expect(rec.profileId).toBe('work:us');
    });

    it('parses account group ids as path-safe ids distinct from profile ids', () => {
        const ConnectedServiceAuthGroupIdSchema = expectSchema('ConnectedServiceAuthGroupIdSchema');
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('codex-main').success).toBe(true);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('groups').success).toBe(true);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('__groups').success).toBe(false);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('bad/group').success).toBe(false);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('bad:group').success).toBe(false);
    });

    it('preserves an explicit quota-reset opt-in without adding it to older policies or patches', () => {
        for (const name of ['ConnectedServiceAuthGroupPolicyV1Schema', 'ConnectedServiceAuthGroupPolicyPatchV1Schema']) {
            const schema = expectSchema(name);
            expect(schema.parse({})).not.toHaveProperty('autoUseQuotaResetsWhenExhausted');
            expect(schema.parse({})).not.toHaveProperty('autoDisablePlanInvalidAccounts');
            expect(schema.parse({ autoUseQuotaResetsWhenExhausted: true })).toMatchObject({ autoUseQuotaResetsWhenExhausted: true });
            expect(schema.parse({ autoUseQuotaResetsWhenExhausted: false })).toMatchObject({ autoUseQuotaResetsWhenExhausted: false });
            expect(schema.safeParse({ autoUseQuotaResetsWhenExhausted: 'true' }).success).toBe(false);
            expect(schema.parse({ autoDisablePlanInvalidAccounts: true })).toMatchObject({ autoDisablePlanInvalidAccounts: true });
            expect(schema.safeParse({ autoDisablePlanInvalidAccounts: 'true' }).success).toBe(false);
        }
    });

    it('accepts only canonical optional quota-limit selections', () => {
        for (const name of ['ConnectedServiceAuthGroupPolicyV1Schema', 'ConnectedServiceAuthGroupPolicyPatchV1Schema']) {
            const schema = expectSchema(name);
            expect(schema.parse({})).not.toHaveProperty('quotaLimitSelection');
            expect(schema.parse({ quotaLimitSelection: { mode: 'all', providerLimitIds: [] } })).toMatchObject({
                quotaLimitSelection: { mode: 'all', providerLimitIds: [] },
            });
            expect(schema.parse({ quotaLimitSelection: { mode: 'selected', providerLimitIds: ['spark', 'standard'] } })).toMatchObject({
                quotaLimitSelection: { mode: 'selected', providerLimitIds: ['spark', 'standard'] },
            });
            expect(schema.safeParse({ quotaLimitSelection: { mode: 'all', providerLimitIds: ['spark'] } }).success).toBe(false);
            expect(schema.safeParse({ quotaLimitSelection: { mode: 'selected', providerLimitIds: [] } }).success).toBe(false);
            expect(schema.safeParse({ quotaLimitSelection: { mode: 'selected', providerLimitIds: [' spark ', 'spark'] } }).success).toBe(false);
        }
    });

    it('appends CORS-safe auth-group reader capabilities without replacing existing query parameters', () => {
        const appendReaderCapabilities = (schemas as Record<string, unknown>)
            .appendConnectedServiceAuthGroupReaderCapabilities;
        expect(typeof appendReaderCapabilities).toBe('function');
        expect((appendReaderCapabilities as (path: string) => string)('/v3/connect/openai-codex/groups')).toBe(
            '/v3/connect/openai-codex/groups?happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1',
        );
        expect((appendReaderCapabilities as (path: string) => string)(
            '/v3/connect/openai-codex/groups/main/members/work?expectedGeneration=4',
        )).toBe(
            '/v3/connect/openai-codex/groups/main/members/work?expectedGeneration=4&happierAutoDisablePlanInvalidAccounts=1&happierPoolQuotaLimitSelection=1&happierPoolExpiryFirst=1',
        );
    });

    it('parses the default connected-service account group policy', () => {
        const ConnectedServiceAuthGroupPolicyV1Schema = expectSchema('ConnectedServiceAuthGroupPolicyV1Schema');
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1 })).toEqual({
            v: 1,
            strategy: 'expiry_first',
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            preTurnProbeMode: 'when_stale',
            preTurnProbeOrder: 'current_first_then_candidates',
            recoveryMode: 'switch_or_wait',
            resumePromptMode: 'standard',
        });
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({
            v: 1,
            resumePromptMode: 'off',
        }).resumePromptMode).toBe('off');
        expect(expectSchema('ConnectedServiceAuthGroupPolicyPatchV1Schema').parse({
            resumePromptMode: 'off',
        }).resumePromptMode).toBe('off');
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ v: 1, strategy: 'round_robin' }).success).toBe(false);
        // Existing pools that persisted an explicit `priority` strategy must NOT be silently migrated.
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'priority' }).strategy).toBe('priority');
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'least_limited' }).strategy).toBe('least_limited');
        // Removed no-op fields are dropped, not carried, on the parsed policy.
        const parsedPolicy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1 });
        expect(parsedPolicy).not.toHaveProperty('recoveryPromptMode');
        expect(parsedPolicy).not.toHaveProperty('effectiveMeterStrategy');
        expect(parsedPolicy).not.toHaveProperty('memberRuntimeStatePersistence');
        // Auth groups did not exist in the supported 0.2.1 predecessor. Removed unreleased knobs
        // are caller errors, not a compatibility shape.
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({
            v: 1,
            strategy: 'manual',
            softSwitchRemainingPercent: 42,
            recoveryPromptMode: 'standard',
            effectiveMeterStrategy: 'weekly',
            memberRuntimeStatePersistence: 'server_state_json',
        }).success).toBe(false);
        // Genuine typos are still rejected (strict is preserved for non-legacy unknown keys).
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ v: 1, bogusKey: true }).success).toBe(false);
        expect(expectSchema('ConnectedServiceAuthGroupPolicyPatchV1Schema').safeParse({
            strategy: 'least_limited',
            recoveryPromptMode: 'standard',
            effectiveMeterStrategy: 'weekly',
            memberRuntimeStatePersistence: 'server_state_json',
        }).success).toBe(false);
    });

    it('parses persisted member runtime state by limit category', () => {
        const ConnectedServiceAuthGroupMemberStateV1Schema = expectSchema('ConnectedServiceAuthGroupMemberStateV1Schema');
        const parsed = ConnectedServiceAuthGroupMemberStateV1Schema.parse({
            quotaExhaustedUntilMs: 10,
            rateLimitedUntilMs: 20,
            capacityLimitedUntilMs: 30,
            authInvalidUntilMs: 40,
            planUnavailableUntilMs: 45,
            validationBlockedUntilMs: 46,
            lastFailureKind: 'usage_limit',
            lastFailureCode: 'usage_limit_reached',
            lastObservedPlanType: 'team',
            lastObservedAtMs: 50,
            providerResetsAtMs: 60,
            credentialHealthStatus: 'connected',
        });

        expect(parsed).toEqual({
            quotaExhaustedUntilMs: 10,
            rateLimitedUntilMs: 20,
            capacityLimitedUntilMs: 30,
            authInvalidUntilMs: 40,
            planUnavailableUntilMs: 45,
            validationBlockedUntilMs: 46,
            lastFailureKind: 'usage_limit',
            lastFailureCode: 'usage_limit_reached',
            lastObservedPlanType: 'team',
            lastObservedAtMs: 50,
            providerResetsAtMs: 60,
            credentialHealthStatus: 'connected',
        });
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            quotaExhaustedUntilMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            providerResetsAtMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            credentialHealthStatus: 'invalid',
        }).success).toBe(false);
    });

    it('parses connected-service account group route payloads without secrets', () => {
        const ConnectedServiceAuthGroupCreateRequestV1Schema = expectSchema('ConnectedServiceAuthGroupCreateRequestV1Schema');
        const ConnectedServiceAuthGroupErrorResponseV1Schema = expectSchema('ConnectedServiceAuthGroupErrorResponseV1Schema');
        const ConnectedServiceAuthGroupPatchRequestV1Schema = expectSchema('ConnectedServiceAuthGroupPatchRequestV1Schema');
        const ConnectedServiceAuthGroupPolicyV1Schema = expectSchema('ConnectedServiceAuthGroupPolicyV1Schema');
        const ConnectedServiceAuthGroupRouteParamsV1Schema = expectSchema('ConnectedServiceAuthGroupRouteParamsV1Schema');
        const ConnectedServiceAuthGroupV1Schema = expectSchema('ConnectedServiceAuthGroupV1Schema');
        const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, autoSwitch: true });
        const group = ConnectedServiceAuthGroupV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            displayName: 'Codex main',
            policy,
            activeProfileId: 'work',
            generation: 2,
            runtimeStateRevision: 3,
            state: {
                status: 'ready',
                lastSwitchAt: 123,
            },
            createdAt: 1,
            updatedAt: 2,
            members: [
                {
                    v: 1,
                    serviceId: 'openai-codex',
                    groupId: 'codex-main',
                    profileId: 'work',
                    priority: 10,
                    enabled: true,
                    state: {
                        cooldownUntilMs: null,
                        exhaustedUntilMs: null,
                    },
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        });

        expect(group.members[0]?.profileId).toBe('work');
        expect(group.runtimeStateRevision).toBe(3);
        const groupWithoutRuntimeStateRevision = { ...group } as Record<string, unknown>;
        delete groupWithoutRuntimeStateRevision.runtimeStateRevision;
        expect(ConnectedServiceAuthGroupV1Schema.safeParse(groupWithoutRuntimeStateRevision).success).toBe(false);
        expect((group as Record<string, unknown>).credential).toBeUndefined();
        expect(ConnectedServiceAuthGroupCreateRequestV1Schema.parse({
            groupId: 'codex-main',
            displayName: 'Codex main',
            policy: { autoSwitch: true },
            members: [{ profileId: 'work', priority: 10 }],
            activeProfileId: 'work',
        }).members[0]?.enabled).toBe(true);
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.parse({
            displayName: null,
            policy: { softSwitchRemainingPercent: 9 },
            activeProfileId: 'personal',
            expectedGeneration: 2,
            overrideRuntimeCooldown: true,
        })).toEqual({
            displayName: null,
            policy: { softSwitchRemainingPercent: 9 },
            activeProfileId: 'personal',
            expectedGeneration: 2,
            overrideRuntimeCooldown: true,
        });
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.safeParse({
            policy: { autoSwitch: false },
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.parse({
            policy: { autoSwitch: false },
            expectedGeneration: 3,
        })).toEqual({
            policy: { autoSwitch: false },
            expectedGeneration: 3,
        });
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.parse({
            displayName: 'Codex fallback',
        })).toEqual({
            displayName: 'Codex fallback',
        });
        expect(ConnectedServiceAuthGroupRouteParamsV1Schema.parse({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
        })).toEqual({
            serviceId: 'openai-codex',
            groupId: 'codex-main',
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_profile_runtime_cooldown',
            resetAtMs: 123,
        })).toEqual({
            error: 'connect_group_profile_runtime_cooldown',
            resetAtMs: 123,
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_generation_conflict',
            generation: 2,
        })).toEqual({
            error: 'connect_group_generation_conflict',
            generation: 2,
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_member_profile_not_found',
        })).toEqual({
            error: 'connect_group_member_profile_not_found',
        });
    });

    it('parses profile and group connected-service session bindings', () => {
        const ConnectedServiceBindingSelectionV1Schema = expectSchema('ConnectedServiceBindingSelectionV1Schema');
        const ConnectedServiceBindingsV1Schema = expectSchema('ConnectedServiceBindingsV1Schema');
        const SessionConnectedServiceAuthSwitchRpcParamsSchema = expectSchema('SessionConnectedServiceAuthSwitchRpcParamsSchema');
        expect(ConnectedServiceBindingSelectionV1Schema.parse({
            source: 'connected',
            profileId: 'work',
        })).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        });

        const parsed = ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                },
                github: {
                    source: 'native',
                },
            },
        });

        expect(parsed.bindingsByServiceId['openai-codex']?.selection).toBe('group');
        expect(parsed.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
        });
        expect(ConnectedServiceBindingSelectionV1Schema.safeParse({
            source: 'connected',
            selection: 'group',
            profileId: 'work',
        }).success).toBe(false);

        expect(SessionConnectedServiceAuthSwitchRpcParamsSchema.parse({
            sessionId: '  sess_1  ',
            agentId: '  claude  ',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            expectedGroupGenerationByServiceId: { anthropic: 4 },
            rematerializeServiceId: 'anthropic',
            accountSettingsVersionHint: 42,
        })).toEqual({
            sessionId: 'sess_1',
            agentId: 'claude',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            expectedGroupGenerationByServiceId: { anthropic: 4 },
            rematerializeServiceId: 'anthropic',
            accountSettingsVersionHint: 42,
        });
    });

    it('rejects malformed account group policy values', () => {
        const ConnectedServiceAuthGroupPolicyV1Schema = expectSchema('ConnectedServiceAuthGroupPolicyV1Schema');
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({
            v: 1,
            cooldownMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({
            v: 1,
            switchOn: {
                usageLimit: true,
            },
        }).success).toBe(false);
    });

    it('requires expected generation for active profile updates', () => {
        const ConnectedServiceAuthGroupActiveProfileRequestV1Schema = expectSchema('ConnectedServiceAuthGroupActiveProfileRequestV1Schema');

        expect(ConnectedServiceAuthGroupActiveProfileRequestV1Schema.parse({
            profileId: 'backup',
            expectedGeneration: 3,
            overrideRuntimeCooldown: true,
        })).toEqual({
            profileId: 'backup',
            expectedGeneration: 3,
            overrideRuntimeCooldown: true,
        });
        expect(ConnectedServiceAuthGroupActiveProfileRequestV1Schema.safeParse({
            profileId: 'backup',
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupActiveProfileRequestV1Schema.safeParse({
            profileId: 'backup',
            expectedGeneration: -1,
        }).success).toBe(false);
    });

    it('requires expected generation for member create, member patch, and member delete requests', () => {
        const ConnectedServiceAuthGroupMemberCreateRequestV1Schema = expectSchema('ConnectedServiceAuthGroupMemberCreateRequestV1Schema');
        const ConnectedServiceAuthGroupMemberPatchRequestV1Schema = expectSchema('ConnectedServiceAuthGroupMemberPatchRequestV1Schema');
        const ConnectedServiceAuthGroupMemberDeleteRequestV1Schema = expectSchema('ConnectedServiceAuthGroupMemberDeleteRequestV1Schema');

        expect(ConnectedServiceAuthGroupMemberCreateRequestV1Schema.parse({
            profileId: 'backup',
            priority: 25,
            expectedGeneration: 3,
        })).toEqual({
            profileId: 'backup',
            priority: 25,
            enabled: true,
            expectedGeneration: 3,
        });
        expect(ConnectedServiceAuthGroupMemberCreateRequestV1Schema.safeParse({
            profileId: 'backup',
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberCreateRequestV1Schema.safeParse({
            profileId: 'backup',
            expectedGeneration: -1,
        }).success).toBe(false);

        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.parse({
            enabled: false,
            expectedGeneration: 4,
        })).toEqual({
            enabled: false,
            expectedGeneration: 4,
        });
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.parse({
            enabled: false,
            state: { autoDisabledReason: 'model_not_entitled' },
            expectedGeneration: 4,
            expectedRuntimeStateRevision: 2,
        })).toEqual({
            enabled: false,
            state: { autoDisabledReason: 'model_not_entitled' },
            expectedGeneration: 4,
            expectedRuntimeStateRevision: 2,
        });
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.safeParse({
            state: { autoDisabledReason: 'model_not_entitled' },
            expectedGeneration: 4,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.safeParse({
            enabled: false,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.safeParse({
            enabled: false,
            expectedGeneration: -1,
        }).success).toBe(false);

        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.parse({
            expectedGeneration: 5,
        })).toEqual({
            expectedGeneration: 5,
        });
        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.parse({
            expectedGeneration: '6',
        })).toEqual({
            expectedGeneration: 6,
        });
        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.safeParse({}).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.safeParse({
            expectedGeneration: -1,
        }).success).toBe(false);
    });

    it('requires expected generation for generation-sensitive group patch but keeps runtime-state generation-neutral', () => {
        const ConnectedServiceAuthGroupPatchRequestV1Schema = expectSchema('ConnectedServiceAuthGroupPatchRequestV1Schema');
        const ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema = expectSchema('ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema');

        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.parse({
            displayName: 'Primary group',
        })).toEqual({
            displayName: 'Primary group',
        });
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.parse({
            activeProfileId: 'backup',
            expectedGeneration: 4,
        })).toEqual({
            activeProfileId: 'backup',
            expectedGeneration: 4,
        });
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.safeParse({
            activeProfileId: 'backup',
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPatchRequestV1Schema.safeParse({
            activeProfileId: null,
        }).success).toBe(false);

        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({
            expectedGeneration: 4,
            expectedRuntimeStateRevision: 9,
            state: {
                v: 1,
                groupSwitchInProgress: false,
            },
        })).toEqual({
            expectedGeneration: 4,
            expectedRuntimeStateRevision: 9,
            state: {
                v: 1,
                groupSwitchInProgress: false,
            },
            memberStates: [],
        });
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({})).toEqual({
            memberStates: [],
        });
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.safeParse({
            state: {
                v: 1,
                groupSwitchInProgress: false,
            },
        }).success).toBe(true);
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({
            memberStates: [
                {
                    profileId: 'work',
                    state: { v: 1 },
                },
            ],
        })).toEqual({
            memberStates: [
                {
                    profileId: 'work',
                    state: { v: 1 },
                },
            ],
        });
    });
});
