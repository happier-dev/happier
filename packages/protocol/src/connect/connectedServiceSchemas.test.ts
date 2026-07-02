import { describe, expect, it } from 'vitest';

import {
    ConnectedServiceIdSchema,
    ConnectedServiceAuthGroupCreateRequestV1Schema,
    ConnectedServiceAuthGroupActiveProfileRequestV1Schema,
    ConnectedServiceAuthGroupErrorResponseV1Schema,
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceAuthGroupMemberCreateRequestV1Schema,
    ConnectedServiceAuthGroupMemberDeleteRequestV1Schema,
    ConnectedServiceAuthGroupMemberPatchRequestV1Schema,
    ConnectedServiceAuthGroupMemberStateV1Schema,
    ConnectedServiceAuthGroupPatchRequestV1Schema,
    ConnectedServiceAuthGroupPolicyPatchV1Schema,
    ConnectedServiceAuthGroupPolicyV1Schema,
    ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema,
    ConnectedServiceAuthGroupV1Schema,
    ConnectedServiceBindingSelectionV1Schema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceCredentialHealthV1Schema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    SessionConnectedServiceAuthSwitchRpcParamsSchema,
    SealedConnectedServiceCredentialV1Schema,
} from './connectedServiceSchemas.js';

describe('connectedServiceSchemas', () => {
    it('parses connected service ids', () => {
        expect(ConnectedServiceIdSchema.parse('openai-codex')).toBe('openai-codex');
        expect(ConnectedServiceIdSchema.parse('openai')).toBe('openai');
        expect(ConnectedServiceIdSchema.parse('anthropic')).toBe('anthropic');
        expect(ConnectedServiceIdSchema.parse('claude-subscription')).toBe('claude-subscription');
        expect(ConnectedServiceIdSchema.parse('gemini')).toBe('gemini');
        expect(ConnectedServiceIdSchema.parse('github')).toBe('github');
        expect(ConnectedServiceIdSchema.parse('bitbucket')).toBe('bitbucket');
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
            token: {
                token: 'setup-token',
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
        });
        expect(rec.kind).toBe('token');
        expect(rec.serviceId).toBe('github');
        expect(rec.expiresAt).toBeNull();
        expect('oauth' in rec).toBe(false);
    });

    it('parses a Bitbucket API token record with email or username metadata', () => {
        const now = Date.now();
        const rec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'bitbucket',
            profileId: 'work',
            kind: 'token',
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            token: {
                token: 'bb-api-token',
                providerAccountId: 'dev@example.com',
                providerEmail: 'dev@example.com',
                raw: null,
            },
        });
        expect(rec.kind).toBe('token');
        expect(rec.serviceId).toBe('bitbucket');
        expect(rec.token.providerEmail).toBe('dev@example.com');
        expect('oauth' in rec).toBe(false);
    });

    it('parses sealed credential payloads', () => {
        const sealed = SealedConnectedServiceCredentialV1Schema.parse({
            format: 'account_scoped_v1',
            ciphertext: 'base64ciphertext',
        });
        expect(sealed.format).toBe('account_scoped_v1');
    });

    it('parses credential health state for persisted reconnect decisions', () => {
        const health = ConnectedServiceCredentialHealthV1Schema.parse({
            v: 1,
            status: 'needs_reauth',
            reconnectRequired: true,
            lastRefreshAttemptAt: 10,
            lastRefreshFailureAt: 11,
            lastRefreshFailureKind: 'invalid_grant',
            providerHttpStatus: 401,
            providerErrorCode: 'invalid_grant',
        });

        expect(health.status).toBe('needs_reauth');
        expect(health.reconnectRequired).toBe(true);
    });

    it('rejects credential health provider error codes that are too large for persisted metadata', () => {
        expect(ConnectedServiceCredentialHealthV1Schema.safeParse({
            v: 1,
            status: 'refresh_failed_retryable',
            reconnectRequired: false,
            providerErrorCode: 'x'.repeat(129),
        }).success).toBe(false);
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

    it('parses additive quota meter source and remaining semantics', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 60_000,
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
                        providerLimitId: 'weekly_tokens',
                        limitCategory: 'usage_limit',
                    },
                },
            ],
        });

        expect(parsed.source).toBe('in_band_provider_snapshot');
        expect(parsed.confidence).toBe('exact');
        expect(parsed.evidence).toEqual({
            providerLimitId: 'weekly_tokens',
            observedAtMs: now - 100,
        });
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
                providerLimitId: 'weekly_tokens',
                limitCategory: 'usage_limit',
            }),
        }));
    });

  it('rejects unsafe quota evidence headers', () => {
    const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
            fetchedAt: Date.now(),
            staleAfterMs: 60_000,
            planLabel: null,
            accountLabel: null,
            evidence: {
                headers: {
                    authorization: 'Bearer secret',
                },
            },
            meters: [],
        });

    expect(result.success).toBe(false);
  });

  it('rejects auth-like quota evidence header aliases', () => {
    const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: Date.now(),
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

    it('parses a legacy token record that still carries explicit oauth: null', () => {
        // Migration regression: prior shipped clients persisted token records with
        // `oauth: null`. The schema flipped to `oauth: z.null().optional()`; both
        // shapes must continue to parse so existing on-disk records keep working.
        const now = Date.now();
        const legacyRec = ConnectedServiceCredentialRecordV1Schema.parse({
            v: 1,
            serviceId: 'github',
            profileId: 'default',
            kind: 'token',
            createdAt: now,
            updatedAt: now,
            expiresAt: null,
            oauth: null,
            token: {
                token: 'github_pat_legacy',
                providerAccountId: null,
                providerEmail: null,
                raw: null,
            },
        });
        expect(legacyRec.kind).toBe('token');
        expect(legacyRec.serviceId).toBe('github');
    });

    it('rejects whitespace-only token credentials at the schema boundary', () => {
        const now = Date.now();
        expect(
            ConnectedServiceCredentialRecordV1Schema.safeParse({
                v: 1,
                serviceId: 'github',
                profileId: 'default',
                kind: 'token',
                createdAt: now,
                updatedAt: now,
                expiresAt: null,
                token: {
                    token: '   ',
                    providerAccountId: null,
                    providerEmail: null,
                    raw: null,
                },
            }).success,
        ).toBe(false);
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
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('codex-main').success).toBe(true);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('groups').success).toBe(true);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('__groups').success).toBe(false);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('bad/group').success).toBe(false);
        expect(ConnectedServiceAuthGroupIdSchema.safeParse('bad:group').success).toBe(false);
    });

    it('parses default account group fallback policy', () => {
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1 })).toEqual({
            v: 1,
            strategy: 'priority',
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
            recoveryPromptMode: 'standard',
            resumePromptMode: 'standard',
            effectiveMeterStrategy: 'most_constrained',
            memberRuntimeStatePersistence: 'server_state_json',
        });
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ v: 1, strategy: 'round_robin' }).success).toBe(false);
    });

    it('parses disabled account group recovery resume prompts', () => {
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({
            v: 1,
            resumePromptMode: 'off',
        }).resumePromptMode).toBe('off');

        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.parse({
            resumePromptMode: 'off',
        })).toEqual({
            resumePromptMode: 'off',
        });
    });

    it('parses custom account group recovery resume prompts', () => {
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({
            v: 1,
            resumePromptMode: 'custom',
        }).resumePromptMode).toBe('custom');

        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.parse({
            resumePromptMode: 'custom',
        })).toEqual({
            resumePromptMode: 'custom',
        });
    });

    it('parses persisted member runtime state by limit category', () => {
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
            credentialHealthStatus: 'needs_reauth',
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
            credentialHealthStatus: 'needs_reauth',
        });
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            quotaExhaustedUntilMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            planUnavailableUntilMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            validationBlockedUntilMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            providerResetsAtMs: -1,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberStateV1Schema.safeParse({
            credentialHealthStatus: 'not_a_health_status',
        }).success).toBe(false);
    });

    it('parses account group route payloads without credentials', () => {
        const policy = ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, autoSwitch: true });
        const group = ConnectedServiceAuthGroupV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'codex-main',
            displayName: 'Codex main',
            policy,
            activeProfileId: 'work',
            generation: 2,
            state: { status: 'ready', lastSwitchAt: 123 },
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
                    state: { cooldownUntilMs: null },
                    createdAt: 1,
                    updatedAt: 2,
                },
            ],
        });

        expect(group.members[0]?.profileId).toBe('work');
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
        })).toEqual({
            displayName: null,
            policy: { softSwitchRemainingPercent: 9 },
            activeProfileId: 'personal',
            expectedGeneration: 2,
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
    });

    it('parses runtime state patches with generation checks', () => {
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({
            expectedGeneration: 2,
            state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
            memberStates: [{
                profileId: 'backup',
                state: { rateLimitedUntilMs: 1234, lastFailureCode: 'rate_limit' },
            }],
        })).toEqual({
            expectedGeneration: 2,
            state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
            memberStates: [{
                profileId: 'backup',
                state: { rateLimitedUntilMs: 1234, lastFailureCode: 'rate_limit' },
            }],
        });
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({
            state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
        })).toEqual({
            state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
            memberStates: [],
        });
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.parse({
            memberStates: [{
                profileId: 'backup',
                state: { rateLimitedUntilMs: 1234 },
            }],
        })).toEqual({
            memberStates: [{
                profileId: 'backup',
                state: { rateLimitedUntilMs: 1234 },
            }],
        });
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.safeParse({
            expectedGeneration: -1,
        }).success).toBe(false);
    });

    it('parses typed auth-group route error responses', () => {
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_generation_conflict',
            generation: 4,
        })).toEqual({
            error: 'connect_group_generation_conflict',
            generation: 4,
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_profile_runtime_cooldown',
            resetAtMs: 1_800_000_000_000,
        })).toEqual({
            error: 'connect_group_profile_runtime_cooldown',
            resetAtMs: 1_800_000_000_000,
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse({
            error: 'not_a_connect_group_error',
        }).success).toBe(false);
    });

    it('parses profile and group connected-service session bindings', () => {
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
                    profileId: 'work',
                },
            },
        });

        expect(parsed.bindingsByServiceId['openai-codex']?.selection).toBe('group');
        expect(ConnectedServiceBindingSelectionV1Schema.parse({
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
        })).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'codex-main',
        });

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
            rematerializeServiceId: 'anthropic',
            expectedGroupGenerationByServiceId: { anthropic: 4 },
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
            rematerializeServiceId: 'anthropic',
            expectedGroupGenerationByServiceId: { anthropic: 4 },
            accountSettingsVersionHint: 42,
        });
    });

    it('parses active-profile compare-and-set generation requests with explicit cooldown override', () => {
        expect(ConnectedServiceAuthGroupActiveProfileRequestV1Schema.parse({
            profileId: 'backup',
            expectedGeneration: 3,
        })).toEqual({
            profileId: 'backup',
            expectedGeneration: 3,
        });
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
        expect(ConnectedServiceAuthGroupActiveProfileRequestV1Schema.safeParse({
            profileId: 'backup',
            expectedGeneration: 3,
            overrideRuntimeCooldown: 'yes',
        }).success).toBe(false);
    });

    it('requires compare-and-set generation for member mutations', () => {
        expect(ConnectedServiceAuthGroupMemberCreateRequestV1Schema.parse({
            profileId: 'backup',
            priority: 10,
            enabled: true,
            expectedGeneration: 3,
        })).toEqual({
            profileId: 'backup',
            priority: 10,
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
            priority: 20,
            expectedGeneration: 4,
        })).toEqual({
            priority: 20,
            expectedGeneration: 4,
        });
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.safeParse({
            enabled: false,
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberPatchRequestV1Schema.safeParse({
            enabled: false,
            expectedGeneration: -1,
        }).success).toBe(false);

        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.parse({
            expectedGeneration: '5',
        })).toEqual({
            expectedGeneration: 5,
        });
        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.safeParse({}).success).toBe(false);
        expect(ConnectedServiceAuthGroupMemberDeleteRequestV1Schema.safeParse({
            expectedGeneration: -1,
        }).success).toBe(false);
    });
});
