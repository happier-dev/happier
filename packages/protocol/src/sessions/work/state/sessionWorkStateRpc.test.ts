import { describe, expect, it } from 'vitest';

import * as sessionWorkStateRpc from './sessionWorkStateRpc.js';
import {
    ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
    DaemonSessionSkillCatalogListRequestV1Schema,
    DaemonSessionVendorPluginCatalogListRequestV1Schema,
    DaemonSessionGoalClearRequestV1Schema,
    DaemonSessionGoalSetRequestV1Schema,
    SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema,
    SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema,
    SessionGoalSetRequestV1Schema,
    SessionPendingQueueMaterializeNextRequestV1Schema,
    SessionPendingQueueMaterializeNextResponseV1Schema,
    SessionSkillCatalogListResponseV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    SessionWorkStateGetResponseV1Schema,
} from './sessionWorkStateRpc.js';
import { RPC_METHODS, SESSION_RPC_METHODS } from '../../../rpc/index.js';

describe('session work-state RPC contracts', () => {
    it('defines session-scoped RPC method ids', () => {
        expect(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET).toBe('session.workState.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_GET).toBe('session.goal.get');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_SET).toBe('session.goal.set');
        expect(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR).toBe('session.goal.clear');
        expect(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE).toBe('session.review.startInline');
        expect(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS).toBe(
            'session.connectedServiceAuth.invalidateTransports',
        );
        expect((SESSION_RPC_METHODS as Record<string, string>).SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION).toBe(
            'session.connectedServiceAuth.applyGeneration',
        );
        expect((SESSION_RPC_METHODS as Record<string, string>).SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY).toBe(
            'session.connectedServiceAuth.readRuntimeIdentity',
        );
        expect(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT).toBe(
            'session.pendingQueue.materializeNext',
        );
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_GET).toBe('daemon.sessionGoal.get');
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_SET).toBe('daemon.sessionGoal.set');
        expect(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR).toBe('daemon.sessionGoal.clear');
        expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST).toBe(
            'daemon.sessionVendorPluginCatalog.list',
        );
        expect((RPC_METHODS as Record<string, string>).DAEMON_SESSION_SKILL_CATALOG_LIST).toBe(
            'daemon.sessionSkillCatalog.list',
        );
        expect((RPC_METHODS as Record<string, string>).DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME).toBe(
            'daemon.connectedServiceQuota.recoveryCredit.consume',
        );
        expect(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST).toBe('session.vendorPluginCatalog.list');
        expect(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST).toBe('session.skillCatalog.list');
    });

    it('parses work-state and vendor plugin catalog response shapes', () => {
        expect(SessionWorkStateGetResponseV1Schema.parse({ workState: null })).toEqual({ workState: null });
        expect(SessionGoalSetRequestV1Schema.parse({ objective: 'Ship goals', status: 'active', tokenBudget: null })).toEqual({
            objective: 'Ship goals',
            status: 'active',
            tokenBudget: null,
        });
        expect(SessionGoalSetRequestV1Schema.parse({ status: 'paused' })).toEqual({
            status: 'paused',
        });
        expect(SessionGoalSetRequestV1Schema.parse({ tokenBudget: 50_000 })).toEqual({
            tokenBudget: 50_000,
        });
        expect(() => SessionGoalSetRequestV1Schema.parse({})).toThrow();
        expect(DaemonSessionGoalSetRequestV1Schema.parse({ sessionId: 's1', status: 'paused' })).toEqual({
            sessionId: 's1',
            status: 'paused',
        });
        expect(() => DaemonSessionGoalSetRequestV1Schema.parse({ status: 'paused' })).toThrow();
        expect(DaemonSessionGoalClearRequestV1Schema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
        expect(DaemonSessionVendorPluginCatalogListRequestV1Schema.parse({ sessionId: 's1', cwd: '/repo' })).toEqual({
            sessionId: 's1',
            cwd: '/repo',
        });
        expect(DaemonSessionSkillCatalogListRequestV1Schema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
        expect(() => DaemonSessionVendorPluginCatalogListRequestV1Schema.parse({ cwd: '/repo' })).toThrow();
        expect(SessionVendorPluginCatalogListResponseV1Schema.parse({
            vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail', enabled: true }],
        }).vendorPlugins[0]?.vendorPluginRef).toBe('plugin://gmail@openai-curated');
        expect(SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema.parse({})).toEqual({});
        expect(SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema.parse({ ok: true })).toEqual({ ok: true });
        expect(ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.parse({
            serviceId: ' openai-codex ',
            profileId: ' work ',
            idempotencyKey: ' consume:s1:credit-1 ',
            providerCreditId: ' credit-1 ',
        })).toEqual({
            serviceId: 'openai-codex',
            profileId: 'work',
            idempotencyKey: 'consume:s1:credit-1',
            providerCreditId: 'credit-1',
        });
        expect(ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.safeParse({
            serviceId: 'openai-codex',
            profileId: 'work',
        }).success).toBe(false);
        expect((sessionWorkStateRpc as Record<string, unknown>).ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema).toEqual(
            expect.objectContaining({ parse: expect.any(Function) }),
        );
        expect(ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse({
            ok: true,
            snapshot: null,
            receipt: {
                idempotencyKey: 'consume:s1:credit-1',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
        })).toEqual({
            ok: true,
            snapshot: null,
            receipt: {
                idempotencyKey: 'consume:s1:credit-1',
                providerCreditId: 'credit-1',
                status: 'consumed',
            },
        });
        expect(ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse({
            ok: false,
            error: 'unavailable',
            errorCode: 'connected_service_quota_recovery_credit_unavailable',
            receipt: {
                idempotencyKey: 'consume:s1:credit-1',
                providerCreditId: 'credit-1',
                status: 'unknown_after_timeout',
            },
        })).toEqual({
            ok: false,
            error: 'unavailable',
            errorCode: 'connected_service_quota_recovery_credit_unavailable',
            receipt: {
                idempotencyKey: 'consume:s1:credit-1',
                providerCreditId: 'credit-1',
                status: 'unknown_after_timeout',
            },
        });
        expect(SessionPendingQueueMaterializeNextRequestV1Schema.parse({})).toEqual({});
        expect(SessionPendingQueueMaterializeNextRequestV1Schema.parse({
            reconcileWhenEmpty: 'force',
        })).toEqual({
            reconcileWhenEmpty: 'force',
        });
        expect(SessionPendingQueueMaterializeNextRequestV1Schema.parse({
            reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_runtime_idle',
        })).toEqual({
            reconcileWhenEmpty: 'force',
            deliveryTiming: 'after_runtime_idle',
        });
        expect(() => SessionPendingQueueMaterializeNextRequestV1Schema.parse({
            reconcileWhenEmpty: 'never',
        })).toThrow();
        expect(() => SessionPendingQueueMaterializeNextRequestV1Schema.parse({
            deliveryTiming: 'after_everything',
        })).toThrow();
        expect(SessionPendingQueueMaterializeNextResponseV1Schema.parse({
            type: 'materialized',
            localId: 'pending-local',
            seq: null,
            content: { t: 'encrypted', c: 'ciphertext' },
        })).toEqual({
            type: 'materialized',
            localId: 'pending-local',
            seq: null,
            content: { t: 'encrypted', c: 'ciphertext' },
        });
        expect(SessionPendingQueueMaterializeNextResponseV1Schema.parse({
            type: 'deferred',
            reason: 'runtime_activity_active',
        })).toEqual({
            type: 'deferred',
            reason: 'runtime_activity_active',
        });
    });

    it('parses generic connected-service auth generation apply and runtime identity contracts', () => {
        const exports = sessionWorkStateRpc as Record<string, {
            parse?: (value: unknown) => unknown;
            safeParse?: (value: unknown) => { success: boolean };
        } | undefined>;
        const applyRequestSchema = exports.SessionConnectedServiceAuthApplyGenerationRequestV1Schema;
        const applyResponseSchema = exports.SessionConnectedServiceAuthApplyGenerationResponseV1Schema;
        const readIdentityRequestSchema = exports.SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema;
        const readIdentityResponseSchema = exports.SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema;

        expect(typeof applyRequestSchema?.parse).toBe('function');
        expect(typeof applyResponseSchema?.parse).toBe('function');
        expect(typeof readIdentityRequestSchema?.parse).toBe('function');
        expect(typeof readIdentityResponseSchema?.parse).toBe('function');

        expect(applyRequestSchema?.parse?.({
            serviceId: ' openai-codex ',
            reason: 'usage_limit',
            requireDirectLiveHotApply: true,
            expected: {
                profileId: ' work ',
                groupId: ' happier ',
                generation: ' 42 ',
            },
            authGeneration: {
                kind: 'oauth',
                providerAccountId: 'acct_1',
            },
        })).toEqual({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            requireDirectLiveHotApply: true,
            expected: {
                profileId: 'work',
                groupId: 'happier',
                generation: '42',
            },
            authGeneration: {
                kind: 'oauth',
                providerAccountId: 'acct_1',
            },
        });
        expect(applyRequestSchema?.safeParse?.({
            serviceId: 'openai-codex',
            reason: 'usage_limit',
            authGeneration: {},
        }).success).toBe(false);
        expect(applyResponseSchema?.parse?.({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'acct_1',
            recovery: { status: 'resumed' },
        })).toEqual({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            activeAccountId: 'acct_1',
            recovery: { status: 'resumed' },
        });
        expect(applyResponseSchema?.safeParse?.({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            verification: {
                proofStrength: 'exact',
                source: 'applied_credential',
            },
        }).success).toBe(false);
        expect(applyResponseSchema?.safeParse?.({
            ok: true,
            appliedVia: 'direct_live_hot_auth',
            verification: {
                proofStrength: 'exact',
                providerAccountId: 'acct_1',
                source: 'applied_credential',
            },
        }).success).toBe(true);

        expect(readIdentityRequestSchema?.parse?.({
            serviceId: ' openai-codex ',
            reason: 'same_provider_account_exhausted',
            requireExactProof: true,
            expected: { generation: 7 },
        })).toEqual({
            serviceId: 'openai-codex',
            reason: 'same_provider_account_exhausted',
            requireExactProof: true,
            expected: { generation: 7 },
        });
        expect(readIdentityResponseSchema?.parse?.({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_1',
                accountLabel: 'Work',
                source: 'runtime_applied_generation',
            },
            runtime: {
                safeToProbe: true,
                safeToApply: false,
                inProviderTurn: true,
                profileId: 'work',
                groupId: 'happier',
                generation: 7,
            },
        })).toEqual({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
                providerAccountId: 'acct_1',
                accountLabel: 'Work',
                source: 'runtime_applied_generation',
            },
            runtime: {
                safeToProbe: true,
                safeToApply: false,
                inProviderTurn: true,
                profileId: 'work',
                groupId: 'happier',
                generation: 7,
            },
        });
        expect(readIdentityResponseSchema?.safeParse?.({
            ok: true,
            serviceId: 'openai-codex',
            identity: {
                strategy: 'provider_account_id',
                proofStrength: 'exact',
            },
        }).success).toBe(false);
        expect(readIdentityResponseSchema?.safeParse?.({
            ok: true,
            serviceId: 'claude-subscription',
            identity: {
                strategy: 'shared_group_auth_surface',
                proofStrength: 'exact',
            },
        }).success).toBe(false);
        expect(readIdentityResponseSchema?.safeParse?.({
            ok: true,
            serviceId: 'claude-subscription',
            identity: {
                strategy: 'shared_group_auth_surface',
                proofStrength: 'exact',
                sharedAuthSurfaceId: 'team',
            },
        }).success).toBe(true);
        expect(readIdentityResponseSchema?.safeParse?.({
            ok: true,
            serviceId: 'claude-subscription',
            identity: {
                strategy: 'none',
                proofStrength: 'exact',
            },
        }).success).toBe(false);
    });

    it('parses final catalog list wrappers while preserving legacy list aliases', () => {
        const vendorCatalog = SessionVendorPluginCatalogListResponseV1Schema.parse({
            catalog: {
                v: 1,
                backendId: 'codex',
                agentId: 'codex-agent',
                updatedAt: 100,
                items: [
                    {
                        v: 1,
                        backendId: 'codex',
                        agentId: 'codex-agent',
                        vendorPluginRef: 'plugin://gmail@openai-curated',
                        displayName: 'Gmail',
                        installed: true,
                        enabled: true,
                    },
                    {
                        v: 1,
                        backendId: 'codex',
                        vendorPluginRef: 'plugin://hidden@openai-curated',
                        displayName: 'Hidden',
                        installed: true,
                        enabled: true,
                        mentionable: false,
                    },
                ],
            },
        });

        expect(vendorCatalog.catalog?.items[0]).toMatchObject({
            backendId: 'codex',
            agentId: 'codex-agent',
            mentionable: true,
            vendorPluginRef: 'plugin://gmail@openai-curated',
        });
        expect(vendorCatalog.vendorPlugins).toEqual(vendorCatalog.catalog?.items);
        expect(vendorCatalog.catalog?.items[1]?.mentionable).toBe(false);

        const legacyVendorCatalog = SessionVendorPluginCatalogListResponseV1Schema.parse({
            vendorPlugins: [
                {
                    vendorPluginRef: 'plugin://legacy@openai-curated',
                    name: 'legacy',
                    enabled: true,
                },
            ],
        });
        expect(legacyVendorCatalog.vendorPlugins[0]).toMatchObject({
            vendorPluginRef: 'plugin://legacy@openai-curated',
            name: 'legacy',
        });

        const skillCatalog = SessionSkillCatalogListResponseV1Schema.parse({
            catalog: {
                v: 1,
                backendId: 'codex',
                agentId: 'codex-agent',
                updatedAt: 200,
                items: [
                    {
                        v: 1,
                        id: 'codex:review',
                        origin: 'vendor',
                        name: 'review',
                        backendId: 'codex',
                        agentId: 'codex-agent',
                        path: '/skills/review/SKILL.md',
                        projectionRef: 'codex-native:review',
                    },
                ],
            },
        });

        expect(skillCatalog.catalog?.items[0]).toMatchObject({
            id: 'codex:review',
            origin: 'vendor',
            backendId: 'codex',
            agentId: 'codex-agent',
            projectionRef: 'codex-native:review',
        });
        expect(skillCatalog.skills).toEqual(skillCatalog.catalog?.items);

        const legacySkillCatalog = SessionSkillCatalogListResponseV1Schema.parse({
            skills: [
                {
                    name: 'debugger',
                    origin: 'codex_native',
                    path: '/skills/debugger/SKILL.md',
                },
                {
                    name: 'team-style',
                    origin: 'happier_projected',
                    projectionKind: 'projected-root',
                },
            ],
        });

        expect(legacySkillCatalog.skills[0]).toMatchObject({
            origin: 'vendor',
            backendId: 'codex',
            path: '/skills/debugger/SKILL.md',
        });
        expect(legacySkillCatalog.skills[1]).toMatchObject({
            origin: 'happier',
            projectionRef: 'projected-root',
        });
    });

    it('exports shared usage-limit request and response schemas with rememberPreference compatibility', () => {
        const exports = sessionWorkStateRpc as Record<string, unknown>;

        expect(typeof (exports.SessionUsageLimitWaitResumeEnableRequestV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');
        expect(typeof (exports.SessionUsageLimitWaitResumeCancelRequestV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');
        expect(typeof (exports.SessionUsageLimitCheckNowRequestV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');
        expect(typeof (exports.SessionUsageLimitWaitResumeEnableResponseV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');
        expect(typeof (exports.SessionUsageLimitWaitResumeCancelResponseV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');
        expect(typeof (exports.SessionUsageLimitCheckNowResponseV1Schema as { safeParse?: unknown } | undefined)?.safeParse).toBe('function');

        const enableRequestSchema = exports.SessionUsageLimitWaitResumeEnableRequestV1Schema as {
            parse: (value: unknown) => unknown;
            safeParse: (value: unknown) => { success: boolean };
        };
        const cancelRequestSchema = exports.SessionUsageLimitWaitResumeCancelRequestV1Schema as { parse: (value: unknown) => unknown };
        const checkNowRequestSchema = exports.SessionUsageLimitCheckNowRequestV1Schema as {
            parse: (value: unknown) => unknown;
            safeParse: (value: unknown) => { success: boolean };
        };
        const consumeResetCreditRequestSchema = exports.SessionUsageLimitConsumeResetCreditRequestV1Schema as {
            parse: (value: unknown) => unknown;
            safeParse: (value: unknown) => { success: boolean };
        };
        const operationResponseSchema = exports.SessionUsageLimitWaitResumeEnableResponseV1Schema as { parse: (value: unknown) => unknown };

        expect(enableRequestSchema.parse({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            rememberPreference: true,
            resumePromptMode: 'off',
        })).toEqual({
            sessionId: 's1',
            issueFingerprint: 'usage-limit:s1:123',
            rememberPreference: true,
            resumePromptMode: 'off',
        });
        expect(enableRequestSchema.safeParse({
            sessionId: 's1',
            resumePromptMode: 'invalid',
        }).success).toBe(false);
        expect(cancelRequestSchema.parse({ sessionId: 's1', issueFingerprint: null })).toEqual({
            sessionId: 's1',
            issueFingerprint: null,
        });
        expect(checkNowRequestSchema.parse({ sessionId: 's1', provider: ' codex ', resumePromptMode: 'off' })).toEqual({
            sessionId: 's1',
            agentId: 'codex',
            resumePromptMode: 'off',
        });
        expect(checkNowRequestSchema.parse({
            sessionId: 's1',
            provider: ' codex ',
            operation: 'switch_account_now',
        })).toEqual({
            sessionId: 's1',
            agentId: 'codex',
            operation: 'switch_account_now',
        });
        expect(checkNowRequestSchema.safeParse({
            sessionId: 's1',
            provider: ' codex ',
            operation: 'consume_reset_credit',
        }).success).toBe(false);
        expect(consumeResetCreditRequestSchema.parse({
            sessionId: 's1',
            provider: ' codex ',
            issueFingerprint: ' usage-limit:codex:turn-1 ',
            resumePromptMode: 'custom',
        })).toEqual({
            sessionId: 's1',
            agentId: 'codex',
            issueFingerprint: 'usage-limit:codex:turn-1',
            resumePromptMode: 'custom',
        });
        expect(checkNowRequestSchema.safeParse({
            sessionId: 's1',
            operation: 'invalid',
        }).success).toBe(false);
        expect(checkNowRequestSchema.safeParse({
            sessionId: 's1',
            resumePromptMode: 'invalid',
        }).success).toBe(false);
        expect(operationResponseSchema.parse({ ok: true, status: 'waiting', sessionId: 's1' })).toEqual({
            ok: true,
            status: 'waiting',
            sessionId: 's1',
        });
        expect(operationResponseSchema.parse({
            ok: false,
            error: 'feature_disabled',
            errorCode: 'feature_disabled',
            sessionId: 's1',
        })).toEqual({
            ok: false,
            status: 'unsupported',
            errorCode: 'feature_disabled',
            sessionId: 's1',
        });
        expect(operationResponseSchema.parse({
            ok: true,
            status: 'unrecognized-daemon-result',
            sessionId: 's1',
        })).toEqual({
            ok: false,
            status: 'unsupported',
            errorCode: 'unsupported_session_usage_limit_recovery_operation_result_status',
            sessionId: 's1',
            diagnostics: { status: 'unrecognized-daemon-result' },
        });
        expect(operationResponseSchema.parse({ ok: true })).toEqual({
            ok: false,
            status: 'malformed_response',
            errorCode: 'malformed_session_usage_limit_recovery_operation_result',
        });
    });
});
