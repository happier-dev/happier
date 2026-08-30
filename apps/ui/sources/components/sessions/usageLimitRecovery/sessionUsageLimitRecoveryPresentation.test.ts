import { describe, expect, it, vi } from 'vitest';

import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import {
    buildSessionUsageLimitRecoveryPresentation,
    buildSessionUsageLimitStatusBadgePresentation,
    translateSessionUsageLimitRecovery,
} from './sessionUsageLimitRecoveryPresentation';

function usageIssue(
    provider: string,
    resetAtMs: number | null,
    overrides: Partial<NonNullable<SessionRuntimeIssueV1['usageLimit']>> = {},
): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1,
        provider,
        usageLimit: {
            v: 1,
            resetAtMs,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'wait',
            ...overrides,
        },
    };
}

function temporaryThrottleIssue(provider: string): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_temporary_throttle',
        source: 'provider_status_error',
        occurredAt: 1,
        provider,
        temporaryThrottle: {
            v: 1,
            retryAfterMs: 30_000,
            recoverability: 'retry',
        },
    };
}

describe('sessionUsageLimitRecoveryPresentation', () => {
    it('translates a waiting-for-reset status with its required reset time', () => {
        expect(translateSessionUsageLimitRecovery(
            'session.usageLimitRecovery.statusWaitingResetUntil',
            { time: '17:30' },
        )).toContain('17:30');
    });

    it('builds the same generic recovery actions for normalized usage-limit issues from different providers', () => {
        const translate = vi.fn((key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ));
        const resetAtMs = Date.UTC(2026, 4, 17, 15, 0, 0);

        for (const provider of ['codex', 'claude', 'opencode']) {
            const presentation = buildSessionUsageLimitRecoveryPresentation({
                featureEnabled: true,
                latestTurnStatus: 'failed',
                issue: usageIssue(provider, resetAtMs),
                recovery: null,
                rememberedMode: 'ask',
                checkNowSupported: true,
                translate,
                formatTime: (value) => `time:${value}`,
            });

            expect(presentation?.issueFingerprint).toBe(`usage-limit:${provider}:unknown-turn:1:${resetAtMs}`);
            expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
            expect(presentation?.banner.body).toContain('session.usageLimitRecovery.resetBody');
            expect(presentation?.banner.primaryAction.kind).toBe('enable');
            expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'remember']);
        }
    });

    it('omits manual check-now when the provider does not expose a safe quota probe', () => {
        const params = {
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('opencode', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key: string) => key,
            formatTime: (value: number) => String(value),
            checkNowSupported: false,
        } satisfies Parameters<typeof buildSessionUsageLimitRecoveryPresentation>[0] & {
            checkNowSupported: boolean;
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation(params);

        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
    });

    it('offers an apply-reset action when an available recovery credit exists', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            recoveryCredits: {
                kind: 'usage_limit_resets',
                availableCount: 1,
                totalCount: 1,
                nextExpiresAtMs: 1_701_000_000_000,
                source: 'provider_api',
                confidence: 'exact',
                credits: [{
                    providerCreditId: 'reset-credit-1',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    grantedAtMs: 1_699_000_000_000,
                    expiresAtMs: 1_701_000_000_000,
                    redeemedAtMs: null,
                    title: null,
                    description: null,
                }],
            },
            rememberedMode: 'ask',
            checkNowSupported: true,
            nowMs: 1_700_000_000_000,
            translate: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
            formatTime: (value) => `time:${value}`,
        });

        expect(presentation?.banner.body).toContain('session.usageLimitRecovery.resetCreditExpiresBody');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual([
            'consume_reset_credit',
            'check_now',
            'remember',
        ]);
        expect(presentation?.banner.secondaryActions[0]).toEqual(expect.objectContaining({
            label: 'session.usageLimitRecovery.consumeResetCreditAction',
            testID: 'session-usageLimit-recovery-consumeResetCredit',
        }));
    });

    it('uses a fallback-switch action for switchable exhausted connected-service groups', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    groupExhausted: true,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.switchFallbackNowAction');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'remember']);
    });

    it('keeps fallback switching actionable after automatic group recovery is exhausted', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'exhausted',
            issueFingerprint: 'usage:group-exhausted',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 3,
            maxAttempts: 3,
            lastProbeError: 'all_group_members_exhausted',
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-main', profileId: 'primary' },
        };
        const issue = usageIssue('codex', null, {
            recoverability: 'switch_account',
            connectedService: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                groupExhausted: true,
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage:group-exhausted');
        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'remember']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusExhausted');
    });

    it('prefers fallback switching when exhausted group recovery metadata is newer than the stale runtime issue shape', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'exhausted',
            issueFingerprint: 'usage:group-exhausted-stale-issue',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 3,
            maxAttempts: 3,
            lastProbeError: 'no_eligible_member',
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-main', profileId: 'primary' },
        };
        const issue = usageIssue('codex', null, {
            recoverability: 'switch_account',
            connectedService: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                groupExhausted: false,
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'remember']);
    });

    it('keeps fallback switching actionable when exhausted group recovery advanced to a different member', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'exhausted',
            issueFingerprint: 'usage:group-no-eligible-member-newer-profile',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: 'no_eligible_member',
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-main', profileId: 'backup' },
        };
        const issue = usageIssue('codex', null, {
            recoverability: 'switch_account',
            connectedService: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                groupExhausted: false,
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_fallback_now');
    });

    it('uses a switch-account action for switchable connected-service profile limits', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'claude-subscription',
                    profileId: 'claude-primary',
                    groupId: null,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_account_now');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.switchAccountNowAction');
    });

    it('keeps switch-account recovery available when manual check-now is unsupported', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                    groupExhausted: false,
                },
            }),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: false,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_account_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
    });

    it('uses a retry action for temporary provider throttles', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: temporaryThrottleIssue('codex'),
            recovery: null,
            rememberedMode: 'ask',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: temporaryThrottleIssue('codex'),
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('retry_temporary_throttle');
        expect(presentation?.banner.primaryAction.label).toBe('session.usageLimitRecovery.retryTemporaryThrottleAction');
        expect(badge?.label).toBe('session.usageLimitRecovery.statusTemporaryThrottle');
    });

    it('shows cancel and checking state when a wait-resume intent is active', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'checking',
            issueFingerprint: 'usage:s1',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: null,
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'native' },
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            rememberedMode: 'auto_wait',
            checkNowSupported: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage:s1');
        expect(presentation?.banner.primaryAction.kind).toBe('cancel');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['check_now', 'forget']);
        expect(badge).toEqual(expect.objectContaining({
            key: 'session-usage-limit-recovery',
            label: 'session.usageLimitRecovery.statusChecking',
            tone: 'warning',
        }));
    });

    it('presents a resume action after a manual check reports that the limit is ready', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'ready',
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'ready',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.readyTitle');
        expect(presentation?.banner.body).toBe('session.usageLimitRecovery.readyBody');
        expect(presentation?.banner.primaryAction.kind).toBe('resume_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['remember']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusReady');
    });

    it('surfaces manual recovery check statuses when no durable recovery intent exists yet', () => {
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'waiting',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(badge?.label).toBe('session.usageLimitRecovery.statusWaiting');
    });

    it('surfaces probe rate-limit retry timing when no reset time exists', () => {
        const retryAtMs = 1_700_000_060_000;
        const params = {
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'waiting',
            operationRetryAtMs: retryAtMs,
            translate: (key: string, p?: Readonly<{ time?: string }>) => (p ? `${key}:${p.time}` : key),
            formatTime: (value: number) => `time:${value}`,
        } as const;

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            ...params,
            rememberedMode: 'ask',
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation(params);

        expect(presentation?.banner.body).toBe(`session.usageLimitRecovery.resetBody:time:${retryAtMs}`);
        expect(badge?.label).toBe(`session.usageLimitRecovery.statusWaitingUntil:time:${retryAtMs}`);
    });

    it('does not let probe retry timing imply readiness when the reset already elapsed', () => {
        const retryAtMs = 5_000;
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            operationStatus: 'waiting',
            operationRetryAtMs: retryAtMs,
            nowMs: retryAtMs + 60_000,
            hasInterruptedWorkToResume: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => `time:${value}`,
        });

        expect(presentation?.banner.primaryAction.kind).not.toBe('resume_now');
    });

    it('surfaces waiting recovery state with a reset time', () => {
        const resetAtMs = 1_700_000_000_000;
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage:waiting-reset',
            armedAtMs: 1,
            resetAtMs,
            nextCheckAtMs: resetAtMs,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: null,
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'native' },
        };

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            rememberedMode: 'auto_wait',
            checkNowSupported: true,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => `time:${value}`,
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => `time:${value}`,
        });

        expect(presentation?.banner.body).toBe(`session.usageLimitRecovery.resetBody:time:${resetAtMs}`);
        expect(presentation?.banner.primaryAction.kind).toBe('cancel');
        expect(badge?.label).toBe(`session.usageLimitRecovery.statusWaitingResetUntil:time:${resetAtMs}`);
    });

    it('surfaces account rotation pending for waiting group recovery without a reset time', () => {
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'waiting',
            issueFingerprint: 'usage:rotation-pending',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: 'no_eligible_member',
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'codex-main', profileId: 'primary' },
        };

        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null, {
                recoverability: 'switch_account',
                connectedService: {
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'codex-main',
                },
            }),
            recovery,
            translate: (key, params) => params ? `${key}:time:${params.time}` : key,
            formatTime: (value) => String(value),
        });

        expect(badge?.label).toBe('session.usageLimitRecovery.statusAccountRotationPending');
    });

    it('does not present a resume action after reset elapses when no interrupted work remains to resume', () => {
        const resetAtMs = 1_700_000_000_000;
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            rememberedMode: 'auto_wait',
            checkNowSupported: false,
            hasInterruptedWorkToResume: false,
            nowMs: resetAtMs,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            hasInterruptedWorkToResume: false,
            nowMs: resetAtMs,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.title');
        expect(presentation?.banner.body).toBe(`session.usageLimitRecovery.resetBody:${resetAtMs}`);
        expect(presentation?.banner.primaryAction.kind).not.toBe('resume_now');
        expect(badge?.label).not.toBe('session.usageLimitRecovery.statusReady');
    });

    it('presents a resume action when the provider reset time has already elapsed and interrupted work remains to resume', () => {
        const resetAtMs = 1_700_000_000_000;
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            rememberedMode: 'auto_wait',
            checkNowSupported: false,
            hasInterruptedWorkToResume: true,
            nowMs: resetAtMs,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: usageIssue('claude', resetAtMs),
            recovery: null,
            operationStatus: null,
            hasInterruptedWorkToResume: true,
            nowMs: resetAtMs,
            translate: (key, params) => params ? `${key}:${params.time}` : key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.readyTitle');
        expect(presentation?.banner.body).toBe('session.usageLimitRecovery.readyBody');
        expect(presentation?.banner.primaryAction.kind).toBe('resume_now');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['forget']);
        expect(badge?.label).toBe('session.usageLimitRecovery.statusReady');
    });

    it('does not render when the feature is disabled or the runtime issue is not a usage limit', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: false,
            latestTurnStatus: 'failed',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue: { ...usageIssue('codex', null), source: 'stream_error' },
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('does not render a stale usage-limit issue after a later turn completed', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'completed',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('keeps an inactive stale in-progress usage-limit issue visible when the runtime is not actively working', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue: usageIssue('codex', null),
            recovery: null,
            runtimeWorking: false,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue: usageIssue('codex', null),
            recovery: null,
            runtimeWorking: false,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
        expect(badge?.key).toBe('session-usage-limit-recovery');
    });

    it('keeps a usage-limit issue visible after abort cleanup marks the turn cancelled', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('enable');
        expect(badge?.key).toBe('session-usage-limit-recovery');
    });

    it('keeps a usage-limit issue visible when cancelled cleanup is the only later activity', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'cancelled',
            issue: usageIssue('codex', null),
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.issueFingerprint).toBe('usage-limit:codex:unknown-turn:1:no-reset');
    });

    it('keeps an unproven recovery visible after a local switch resumes the runtime as working', () => {
        const issue = usageIssue('claude', null);

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue,
            recovery: null,
            runtimeWorking: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });
        const badge = buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue,
            recovery: null,
            runtimeWorking: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
        expect(badge?.key).toBe('session-usage-limit-recovery');
    });

    it('keeps an active recovery in action-required (switch_account) state visible while working', () => {
        const issue = usageIssue('codex', null, {
            recoverability: 'switch_account',
            connectedService: {
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'codex-main',
                groupExhausted: false,
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue,
            recovery: null,
            runtimeWorking: true,
            checkNowSupported: false,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        });

        expect(presentation?.banner.primaryAction.kind).toBe('switch_account_now');
    });

    it('hides recovery once the provider produces genuine activity after the issue (proven recovery)', () => {
        const issue = usageIssue('claude', null);

        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            runtimeWorking: true,
            hasActivityAfterRuntimeIssue: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            runtimeWorking: true,
            hasActivityAfterRuntimeIssue: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('hides recovery once the durable recovery intent is cancelled, even while working', () => {
        const issue = usageIssue('codex', null);
        const recovery: SessionUsageLimitRecoveryV1 = {
            v: 1,
            status: 'cancelled',
            issueFingerprint: 'usage:cancelled',
            armedAtMs: 1,
            resetAtMs: null,
            nextCheckAtMs: null,
            attemptCount: 1,
            maxAttempts: 3,
            lastProbeError: null,
            resumePromptMode: 'standard',
            selectedAuth: { kind: 'native' },
        };

        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue,
            recovery,
            runtimeWorking: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'in_progress',
            issue,
            recovery,
            runtimeWorking: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });

    it('does not render a stale usage-limit issue after later meaningful session activity', () => {
        const issue = usageIssue('claude', null);

        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            rememberedMode: 'ask',
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();

        expect(buildSessionUsageLimitStatusBadgePresentation({
            featureEnabled: true,
            latestTurnStatus: 'failed',
            issue,
            recovery: null,
            hasActivityAfterRuntimeIssue: true,
            translate: (key) => key,
            formatTime: (value) => String(value),
        })).toBeNull();
    });
});
