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
    BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    PersistedConnectedServiceBindingsV1Schema,
    ConnectedServiceCredentialHealthV1Schema,
    ConnectedServiceCredentialCompatibleMutationSuccessV1Schema,
    ConnectedServiceCredentialMutationGuardV1Schema,
    ConnectedServiceCredentialMutationResponseV1Schema,
    ConnectedServiceCredentialMutationSuccessV1Schema,
    ConnectedServiceCredentialMutationSupersededV1Schema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceCredentialRevisionV1Schema,
    readConnectedServiceCredentialRevisionBoundaryV1,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    ConnectedServiceUsageSourceV1Schema,
    SessionConnectedServiceAuthSwitchRpcParamsSchema,
    SealedConnectedServiceCredentialV1Schema,
} from './connectedServiceSchemas.js';

describe('connectedServiceSchemas', () => {
    it('defines one strict credential revision and mutation fence contract', () => {
        expect(ConnectedServiceCredentialRevisionV1Schema.parse('csr_0123456789ABCDEFGHJKMNPQRS')).toBe(
            'csr_0123456789ABCDEFGHJKMNPQRS',
        );
        expect(ConnectedServiceCredentialMutationGuardV1Schema.safeParse({
            refreshLeaseOwnerId: 'owner-without-revision',
        }).success).toBe(false);
        expect(ConnectedServiceCredentialMutationGuardV1Schema.parse({
            expectedCredentialRevision: null,
        })).toEqual({ expectedCredentialRevision: null });
        expect(ConnectedServiceCredentialMutationGuardV1Schema.safeParse({
            expectedCredentialRevision: null,
            refreshLeaseOwnerId: 'owner-cannot-use-absence',
        }).success).toBe(false);
        expect(ConnectedServiceCredentialMutationResponseV1Schema.parse({
            error: 'connect_credential_mutation_superseded',
            reason: 'revision_mismatch',
            credentialRevision: null,
        })).toEqual({
            error: 'connect_credential_mutation_superseded',
            reason: 'revision_mismatch',
            credentialRevision: null,
        });
        expect(ConnectedServiceCredentialMutationSuccessV1Schema.safeParse({
            success: true,
            credentialRevision: 'bad',
        }).success).toBe(false);
        expect(ConnectedServiceCredentialMutationSupersededV1Schema.safeParse({
            error: 'connect_credential_mutation_superseded',
            reason: 'unknown',
            credentialRevision: null,
        }).success).toBe(false);
    });

    it('normalizes exact server-v0.2.1 credential responses as explicitly unfenced', () => {
        const legacy = ConnectedServiceCredentialCompatibleMutationSuccessV1Schema.parse({
            success: true,
        });
        expect(readConnectedServiceCredentialRevisionBoundaryV1(legacy)).toEqual({
            revisionSemantics: 'legacy_unfenced',
            credentialRevision: null,
        });

        const revisioned = ConnectedServiceCredentialCompatibleMutationSuccessV1Schema.parse({
            success: true,
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        });
        expect(readConnectedServiceCredentialRevisionBoundaryV1(revisioned)).toEqual({
            revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        });

        expect(readConnectedServiceCredentialRevisionBoundaryV1({
            credentialRevision: 'malformed',
        })).toBeNull();
    });

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

    it('classifies retryable credential health as usable but not reconnect-required', async () => {
        const schemas = await import('./connectedServiceSchemas.js');

        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('connected')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('refreshing')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('refresh_failed_retryable')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusUsable('needs_reauth')).toBe(false);
        expect(schemas.isConnectedServiceCredentialHealthStatusReconnectRequired('needs_reauth')).toBe(true);
        expect(schemas.isConnectedServiceCredentialHealthStatusReconnectRequired('refresh_failed_retryable')).toBe(false);
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

    it('requires explicit connected-service source context for provider-account quota projections', () => {
        expect(ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
        })).toEqual({
            serviceId: 'happier.agent.codex/openai-codex',
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
            serviceId: 'happier.agent.codex/openai-codex',
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

        expect(ConnectedServiceUsageSourceV1Schema.parse({
            serviceId: 'com.acme.agent/novel-service',
            profileId: 'external-work',
            bindingKind: 'profile',
        })).toEqual({
            serviceId: 'com.acme.agent/novel-service',
            profileId: 'external-work',
            bindingKind: 'profile',
        });

        expect(ConnectedServiceUsageSourceV1Schema.safeParse({
            serviceId: 'openai-codex',
            profileId: 'work',
            bindingKind: 'profile',
            groupId: 'team',
            groupGeneration: 7,
        }).success).toBe(false);
    });

    it('accepts sanitized quota recovery credits on quota snapshots', () => {
        const now = Date.now();
        const parsed = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1,
            serviceId: 'openai-codex',
            profileId: 'work',
            fetchedAt: now,
            staleAfterMs: 300_000,
            planLabel: 'pro',
            accountLabel: 'user@example.com',
            recoveryCredits: {
                availableCount: 1,
                credits: [{
                    id: 'reset-credit-1',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    grantedAtMs: now - 1_000,
                    expiresAtMs: now + 86_400_000,
                    title: 'Codex rate limit reset',
                    description: 'Reset your Codex rate limits.',
                }],
            },
            meters: [{
                meterId: 'weekly',
                label: 'Weekly',
                used: null,
                limit: null,
                unit: 'unknown',
                utilizationPct: 82,
                resetsAt: now + 60_000,
                status: 'ok',
                details: {},
            }],
        });

        expect(parsed.recoveryCredits).toEqual({
            availableCount: 1,
            credits: [expect.objectContaining({
                id: 'reset-credit-1',
                kind: 'usage_limit_reset',
                status: 'available',
                expiresAtMs: now + 86_400_000,
            })],
        });
        expect(ConnectedServiceQuotaRecoveryCreditsV1Schema.safeParse(parsed.recoveryCredits).success).toBe(true);
    });

    it('rejects provider-private recovery credit profile fields at the protocol boundary', () => {
        const result = ConnectedServiceQuotaRecoveryCreditsV1Schema.safeParse({
            availableCount: 1,
            credits: [{
                id: 'reset-credit-1',
                kind: 'usage_limit_reset',
                status: 'available',
                profileImageUrl: 'https://example.com/avatar.png',
            }],
        });

        expect(result.success).toBe(false);
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

  it('rejects quota evidence header values that can leak tokens', () => {
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
          'x-provider-debug': 'sk-abcdefghijklmnopqrstuvwxyz',
        },
      },
      meters: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects quota evidence code text that can leak raw credential material', () => {
    const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: Date.now(),
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: null,
      evidence: {
        code: 'authorization: bearer sk-secret-token-value-1234567890',
      },
      meters: [],
    });

    expect(result.success).toBe(false);
  });

  it('rejects quota evidence message text that can leak raw credential material', () => {
    const result = ConnectedServiceQuotaSnapshotV1Schema.safeParse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      fetchedAt: Date.now(),
      staleAfterMs: 60_000,
      planLabel: null,
      accountLabel: null,
      evidence: {
        message: 'provider failed with authorization: bearer sk-secret-token-value-1234567890',
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
            strategy: 'least_limited',
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
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ v: 1, strategy: 'round_robin' }).success).toBe(false);
        // Existing pools that persisted an explicit `priority` strategy must NOT be silently migrated.
        expect(ConnectedServiceAuthGroupPolicyV1Schema.parse({ v: 1, strategy: 'priority' }).strategy).toBe('priority');
    });

    it('rejects removed legacy no-op policy keys as unknown current-contract input', () => {
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({
            v: 1,
            strategy: 'manual',
            softSwitchRemainingPercent: 42,
            recoveryPromptMode: 'standard',
            effectiveMeterStrategy: 'weekly',
            memberRuntimeStatePersistence: 'server_state_json',
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPolicyV1Schema.safeParse({ v: 1, bogusKey: true }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.safeParse({
            strategy: 'least_limited',
            recoveryPromptMode: 'standard',
            effectiveMeterStrategy: 'weekly',
            memberRuntimeStatePersistence: 'server_state_json',
        }).success).toBe(false);
        expect(ConnectedServiceAuthGroupPolicyPatchV1Schema.safeParse({ bogusKey: true }).success).toBe(false);
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
            runtimeStateRevision: 0,
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
        expect(ConnectedServiceAuthGroupV1Schema.safeParse({
            ...group,
            runtimeStateRevision: undefined,
        }).success).toBe(false);
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
            expectedRuntimeStateRevision: 3,
            state: { status: 'exhausted', lastSwitchReason: 'usage_limit' },
            memberStates: [{
                profileId: 'backup',
                state: { rateLimitedUntilMs: 1234, lastFailureCode: 'rate_limit' },
            }],
        })).toEqual({
            expectedGeneration: 2,
            expectedRuntimeStateRevision: 3,
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
        expect(ConnectedServiceAuthGroupRuntimeStatePatchRequestV1Schema.safeParse({
            expectedRuntimeStateRevision: -1,
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
            error: 'connect_group_incarnation_conflict',
        })).toEqual({
            error: 'connect_group_incarnation_conflict',
        });
        expect(ConnectedServiceAuthGroupErrorResponseV1Schema.parse({
            error: 'connect_group_runtime_state_revision_conflict',
            runtimeStateRevision: 7,
        })).toEqual({
            error: 'connect_group_runtime_state_revision_conflict',
            runtimeStateRevision: 7,
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

    it('keys current session bindings by exact qualified Connected Account service identity', () => {
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
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'codex-main',
                    profileId: 'work',
                },
            },
        });

        expect(parsed.bindingsByServiceId['happier.agent.codex/openai-codex']?.selection).toBe('group');
        expect(ConnectedServiceBindingsV1Schema.safeParse({
            v: 1,
            bindingsByServiceId: {
                'novel-service': { source: 'native' },
            },
        }).success).toBe(false);
        expect(ConnectedServiceBindingsV1Schema.parse({
            v: 1,
            bindingsByServiceId: {
                'com.acme.agent/novel-service': { source: 'native' },
            },
        }).bindingsByServiceId).toHaveProperty('com.acme.agent/novel-service');
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
                    'happier.agent.claude/anthropic': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            rematerializeServiceId: 'happier.agent.claude/anthropic',
            expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 4 },
            accountSettingsVersionHint: 42,
        })).toEqual({
            sessionId: 'sess_1',
            agentId: 'claude',
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'happier.agent.claude/anthropic': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            rematerializeServiceId: 'happier.agent.claude/anthropic',
            expectedGroupGenerationByServiceId: { 'happier.agent.claude/anthropic': 4 },
            accountSettingsVersionHint: 42,
        });
    });

    it('normalizes released bundled short service ids only at the named legacy ingress', () => {
        const normalized = BuiltInLegacyConnectedServiceBindingsV1IngressSchema.parse({
            v: 1,
            bindingsByServiceId: {
                'openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });

        expect(normalized).toEqual({
            v: 1,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                },
            },
        });
        expect(BuiltInLegacyConnectedServiceBindingsV1IngressSchema.safeParse({
            v: 1,
            bindingsByServiceId: {
                'novel-service': { source: 'native' },
            },
        }).success).toBe(false);
    });

    it('reads the bundled scalar id for a qualified service only through the generated mapping and fails closed for novel services', () => {
        expect(readBuiltInLegacyConnectedServiceIdForQualifiedService({
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        })).toBe('openai-codex');
        expect(readBuiltInLegacyConnectedServiceIdForQualifiedService({
            pluginId: 'happier.agent.claude',
            localId: 'claude-subscription',
        })).toBe('claude-subscription');
        expect(readBuiltInLegacyConnectedServiceIdForQualifiedService({
            pluginId: 'happier.voice.openai',
            localId: 'openai',
        })).toBe('openai');
        // A qualified identity without a generated legacy member has no scalar
        // representation — including a foreign plugin reusing a bundled local id.
        expect(readBuiltInLegacyConnectedServiceIdForQualifiedService({
            pluginId: 'acme.review',
            localId: 'reviewer-service',
        })).toBeNull();
        expect(readBuiltInLegacyConnectedServiceIdForQualifiedService({
            pluginId: 'acme.review',
            localId: 'openai-codex',
        })).toBeNull();
    });

    it('keeps mixed-version binding reads permissive while persisted writes reject unknown fields', () => {
        const mixedVersionBinding = {
            v: 1,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'work',
                    futureField: 'supported-by-a-newer-reader',
                },
            },
        };

        expect(ConnectedServiceBindingsV1Schema.safeParse(mixedVersionBinding).success).toBe(true);
        expect(PersistedConnectedServiceBindingsV1Schema.safeParse(mixedVersionBinding).success).toBe(false);
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
