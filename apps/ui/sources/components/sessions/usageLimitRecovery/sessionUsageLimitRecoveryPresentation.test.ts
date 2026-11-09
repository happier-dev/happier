import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { describe, expect, it } from 'vitest';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import {
    buildSessionUsageLimitRecoveryPresentation,
    isSessionUsageLimitRecoveryCheckNowAction,
    isSessionUsageLimitRecoveryCheckingOperationAction,
    readSessionUsageLimitRecoveryFromMetadata,
    type SessionUsageLimitRecoveryTranslate,
} from './sessionUsageLimitRecoveryPresentation';

const translateUsageLimitRecoveryKeyForTest: SessionUsageLimitRecoveryTranslate = (key, ..._params) => key;

const usageLimitIssue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'usage_limit',
    source: 'usage_limit',
    occurredAt: 1_700_000_000_000,
    usageLimit: {
        v: 1,
        resetAtMs: 1_700_000_060_000,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
    },
} as const;

const switchAccountUsageLimitIssue = SessionRuntimeIssueV1Schema.parse({
    ...usageLimitIssue,
    usageLimit: {
        ...usageLimitIssue.usageLimit,
        recoverability: 'switch_account',
        connectedService: {
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'team',
            groupExhausted: false,
        },
    },
});
const switchAccountUsageLimit = (() => {
    if (!switchAccountUsageLimitIssue.usageLimit) {
        throw new Error('expected switch-account usage-limit fixture');
    }
    return switchAccountUsageLimitIssue.usageLimit;
})();
const switchAccountConnectedService = (() => {
    if (!switchAccountUsageLimit.connectedService) {
        throw new Error('expected connected-service usage-limit fixture');
    }
    return switchAccountUsageLimit.connectedService;
})();

const temporaryThrottleIssue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_temporary_throttle',
    source: 'agent_status_error',
    occurredAt: 1_700_000_000_000,
    provider: 'codex',
    temporaryThrottle: {
        v: 1,
        retryAfterMs: 12_000,
        recoverability: 'retry',
    },
} as const;

describe('sessionUsageLimitRecoveryPresentation', () => {
    it('hides cancellation only for its exact current issue', () => {
        const issue = SessionRuntimeIssueV1Schema.parse({
            ...usageLimitIssue, agentId: 'claude', agentTurnId: 'turn-b', occurredAt: 2_000,
            usageLimit: { ...usageLimitIssue.usageLimit, resetAtMs: 5_000 },
        });
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({ sessionUsageLimitRecoveryV1: {
            v: 1, status: 'cancelled', issueFingerprint: 'usage-limit:claude:turn-b:2000:5000',
            runtimeAuthRecoveryAttemptId: 'current-attempt', armedAtMs: 2_000,
            resetAtMs: 5_000, nextCheckAtMs: null, attemptCount: 1, maxAttempts: 3,
            lastProbeError: null, selectedAuth: { kind: 'native' },
        } });
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true, lastRuntimeIssue: issue, latestTurnStatus: 'failed', recoveryState,
            settings: { v: 1, mode: 'ask' }, translate: translateUsageLimitRecoveryKeyForTest,
        })).toBeNull();
    });

    it.each(['cancelled', 'waiting'] as const)('keeps a fresh issue independent of an older %s recovery', (status) => {
        const issue = SessionRuntimeIssueV1Schema.parse({
            ...usageLimitIssue, agentId: 'claude', agentTurnId: 'turn-b', occurredAt: 2_000,
            usageLimit: { ...usageLimitIssue.usageLimit, resetAtMs: 5_000 },
        });
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({ sessionUsageLimitRecoveryV1: {
            v: 1, status, issueFingerprint: 'usage-limit:claude:turn-a:100:500',
            runtimeAuthRecoveryAttemptId: 'old-attempt', armedAtMs: 100,
            resetAtMs: 500, nextCheckAtMs: null, attemptCount: 1, maxAttempts: 3,
            lastProbeError: null, selectedAuth: { kind: 'native' },
        } });
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true, lastRuntimeIssue: issue, latestTurnStatus: 'failed', recoveryState,
            hasInterruptedWorkToResume: true, nowMs: 3_000, checkNowSupported: true,
            settings: { v: 1, mode: 'ask' }, translate: translateUsageLimitRecoveryKeyForTest,
        });
        expect(presentation?.issueFingerprint).toBe('usage-limit:claude:turn-b:2000:5000');
        expect(presentation?.armedAtMs).toBe(2_000);
        expect(presentation).not.toHaveProperty('runtimeAuthRecoveryAttemptId');
        expect(presentation?.banner.mode).toBe('enable');
    });

    it('projects overload retry timing and controls without quota actions, including while awaiting the provider', () => {
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({ sessionUsageLimitRecoveryV1: {
            v: 1, status: 'waiting', issueFingerprint: 'temporary-throttle:s1:1', armedAtMs: temporaryThrottleIssue.occurredAt,
            nextCheckAtMs: temporaryThrottleIssue.occurredAt + 12_000, attemptCount: 2, maxAttempts: 5,
            resetAtMs: null, lastProbeError: null, selectedAuth: { kind: 'native' },
        } });
        expect(recoveryState).not.toBeNull();
        const input = {
            featureEnabled: true, lastRuntimeIssue: temporaryThrottleIssue, recoveryState,
            checkNowSupported: true, settings: { v: 1, mode: 'auto_wait' },
            translate: translateUsageLimitRecoveryKeyForTest,
        } as const;
        const scheduled = buildSessionUsageLimitRecoveryPresentation(input);
        expect(buildSessionUsageLimitRecoveryPresentation({ ...input, operationStatus: 'checking' })?.banner.temporaryThrottle?.nextCheckAtMs)
            .toBe(temporaryThrottleIssue.occurredAt + 12_000);
        expect(scheduled?.banner.mode).toBe('cancel');
        expect(scheduled?.banner.secondaryActions.map((action) => action.kind)).toEqual(['retry_temporary_throttle']);
        expect(scheduled?.banner.temporaryThrottle).toEqual({ nextCheckAtMs: temporaryThrottleIssue.occurredAt + 12_000, attemptCount: 2 });
        const awaiting = buildSessionUsageLimitRecoveryPresentation({ ...input, latestTurnStatus: 'in_progress',
            recoveryState: recoveryState ? { ...recoveryState, status: 'waiting', nextCheckAtMs: null } : null });
        expect(awaiting?.banner.temporaryThrottle?.nextCheckAtMs).toBeNull();
        expect(awaiting?.banner.secondaryActions).toEqual([]);
        expect(awaiting?.banner.mode).toBe('cancel');
        expect(buildSessionUsageLimitRecoveryPresentation({ ...input, hasActivityAfterRuntimeIssue: true,
            recoveryState: recoveryState ? { ...recoveryState, status: 'cancelled', nextCheckAtMs: null } : null,
        })?.banner.mode).toBe('retry_temporary_throttle');
        const offline = buildSessionUsageLimitRecoveryPresentation({ ...input, machineReachable: false });
        expect(offline?.banner.temporaryThrottle?.nextCheckAtMs).toBeNull();
        expect(offline?.banner.actionsDisabled).toBe(true);
        expect(buildSessionUsageLimitRecoveryPresentation({ ...input, latestTurnStatus: 'completed' })).toBeNull();
    });

    it.each(['armed', 'waiting', 'checking', 'paused', 'exhausted', 'cancelled'] as const)(
        'reads protocol recovery intent status %s from metadata',
        (status) => {
            expect(readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status,
                    issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: 1_700_000_070_000,
                    attemptCount: 1,
                    maxAttempts: 5,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native' },
                },
            })?.status).toBe(status);
        },
    );

    it.each(['failed', 'resumed'] as const)(
        'ignores legacy local recovery status %s from metadata',
        (status) => {
            expect(readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status,
                    issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: 1_700_000_070_000,
                    attemptCount: 1,
                    maxAttempts: 5,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native' },
                },
            })).toBeNull();
        },
    );

    it('ignores recovery metadata without the selected auth protocol shape', () => {
        expect(readSessionUsageLimitRecoveryFromMetadata({
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                armedAtMs: 1,
                resetAtMs: 1_700_000_060_000,
                nextCheckAtMs: 1_700_000_070_000,
                attemptCount: 1,
                maxAttempts: 5,
                lastProbeError: null,
            },
        })).toBeNull();
    });

    it.each(['armed', 'paused'] as const)(
        'uses cancel affordance for active protocol recovery status %s',
        (status) => {
            const recoveryState = readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status,
                    issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: 1_700_000_070_000,
                    attemptCount: 1,
                    maxAttempts: 5,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native' },
                },
            });

            const presentation = buildSessionUsageLimitRecoveryPresentation({
                featureEnabled: true,
                lastRuntimeIssue: usageLimitIssue,
                latestTurnStatus: 'failed',
                recoveryState,
                settings: { v: 1, mode: 'auto_wait' },
                translate: translateUsageLimitRecoveryKeyForTest,
            });

            expect(presentation?.banner.actionTestID).toBe('session-usageLimit-recovery-cancel');
            expect(presentation?.statusBadge.tone).toBe('active');
        },
    );

    it('returns a generic recovery banner and status badge for usage-limit runtime issues', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            testID: 'session-usageLimit-recovery',
            actionTestID: 'session-usageLimit-recovery-enable',
            title: 'session.usageLimitRecovery.banner.title',
        }));
        expect(presentation?.statusBadge).toEqual(expect.objectContaining({
            key: 'usage-limit-recovery',
            testID: 'session-usageLimit-status-badge',
            tone: 'warning',
        }));
    });

    it('switches the primary action to cancel while the recovery intent is waiting', () => {
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                armedAtMs: 1,
                resetAtMs: 1_700_000_060_000,
                nextCheckAtMs: 1_700_000_070_000,
                attemptCount: 1,
                maxAttempts: 5,
                lastProbeError: null,
                selectedAuth: { kind: 'native' },
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState,
            settings: { v: 1, mode: 'auto_wait' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.actionTestID).toBe('session-usageLimit-recovery-cancel');
        expect(presentation?.statusBadge.tone).toBe('active');
    });

    it('labels reset-backed waiting recovery as waiting for quota reset', () => {
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                armedAtMs: 1,
                resetAtMs: 1_700_000_060_000,
                nextCheckAtMs: 1_700_000_070_000,
                attemptCount: 1,
                maxAttempts: 5,
                lastProbeError: null,
                selectedAuth: { kind: 'native' },
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState,
            settings: { v: 1, mode: 'auto_wait' },
            translate: translateUsageLimitRecoveryKeyForTest,
            nowMs: 1_700_000_000_000,
        });

        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.waitingForQuotaReset');
    });

    it('labels group waiting recovery without reset time as account rotation pending', () => {
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({
            sessionUsageLimitRecoveryV1: {
                v: 1,
                status: 'waiting',
                issueFingerprint: buildUsageLimitIssueFingerprint({ ...switchAccountUsageLimitIssue, usageLimit: { ...switchAccountUsageLimit, resetAtMs: null } }),
                armedAtMs: 1,
                resetAtMs: null,
                nextCheckAtMs: 1_700_000_070_000,
                attemptCount: 1,
                maxAttempts: 5,
                lastProbeError: null,
                selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'team', profileId: null },
            },
        });

        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: {
                ...switchAccountUsageLimitIssue,
                usageLimit: {
                    ...switchAccountUsageLimit,
                    resetAtMs: null,
                },
            },
            latestTurnStatus: 'failed',
            recoveryState,
            settings: { v: 1, mode: 'auto_wait' },
            translate: translateUsageLimitRecoveryKeyForTest,
            nowMs: 1_700_000_000_000,
        });

        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.accountRotationPending');
    });

    it('adds check-now and remember controls beside the primary recovery action', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'check_now',
                testID: 'session-usageLimit-recovery-checkNow',
            }),
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('adds a reset-credit control when recovery credits are available', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'exhausted',
                    issueFingerprint: buildUsageLimitIssueFingerprint(usageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: null,
                    attemptCount: 1,
                    maxAttempts: 1,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native' },
                    recoveryCredits: {
                        availableCount: 1,
                        credits: [{
                            id: 'reset-credit-1',
                            kind: 'usage_limit_reset',
                            status: 'available',
                            expiresAtMs: 1_700_000_120_000,
                        }],
                    },
                },
            }),
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            nowMs: 1_700_000_060_000,
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'consume_reset_credit',
                label: 'session.usageLimitRecovery.actions.consumeResetCredit',
                testID: 'session-usageLimit-recovery-consumeResetCredit',
            }),
            expect.objectContaining({
                kind: 'check_now',
                testID: 'session-usageLimit-recovery-checkNow',
            }),
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('ignores expired reset-credit details when no available summary count remains', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            recoveryCredits: {
                availableCount: 0,
                credits: [{
                    id: 'reset-credit-1',
                    kind: 'usage_limit_reset',
                    status: 'available',
                    expiresAtMs: 1_700_000_010_000,
                }],
            },
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            nowMs: 1_700_000_060_000,
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'check_now',
                testID: 'session-usageLimit-recovery-checkNow',
            }),
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('uses a switch-account primary action for account-switchable limits', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: switchAccountUsageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-switchAccountNow',
            actionLabel: 'session.usageLimitRecovery.actions.switchAccountNow',
            mode: 'switch_account_now',
        }));
        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('prefers fallback switching when exhausted group recovery metadata is newer than stale issue connected-service state', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: switchAccountUsageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'exhausted',
                    issueFingerprint: buildUsageLimitIssueFingerprint(switchAccountUsageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: null,
                    attemptCount: 3,
                    maxAttempts: 3,
                    lastProbeError: 'no_eligible_member',
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        profileId: 'primary',
                    },
                },
            }),
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-switchFallbackNow',
            actionLabel: 'session.usageLimitRecovery.actions.switchFallbackNow',
            mode: 'switch_fallback_now',
        }));
    });

    it('keeps fallback switching actionable when exhausted group recovery advanced to a different member', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: switchAccountUsageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: readSessionUsageLimitRecoveryFromMetadata({
                sessionUsageLimitRecoveryV1: {
                    v: 1,
                    status: 'exhausted',
                    issueFingerprint: buildUsageLimitIssueFingerprint(switchAccountUsageLimitIssue),
                    armedAtMs: 1,
                    resetAtMs: 1_700_000_060_000,
                    nextCheckAtMs: null,
                    attemptCount: 3,
                    maxAttempts: 3,
                    lastProbeError: 'all_group_members_exhausted',
                    selectedAuth: {
                        kind: 'group',
                        serviceId: 'openai-codex',
                        groupId: 'team',
                        profileId: 'backup',
                    },
                },
            }),
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner?.mode).toBe('switch_fallback_now');
    });

    it('keeps switch-account recovery available when manual check-now is unsupported', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: switchAccountUsageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: false,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-switchAccountNow',
            actionLabel: 'session.usageLimitRecovery.actions.switchAccountNow',
            mode: 'switch_account_now',
        }));
        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('uses a fallback-switch primary action when the active group is exhausted', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: {
                ...switchAccountUsageLimitIssue,
                usageLimit: {
                    ...switchAccountUsageLimit,
                    connectedService: {
                        ...switchAccountConnectedService,
                        groupExhausted: true,
                    },
                },
            },
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-switchFallbackNow',
            actionLabel: 'session.usageLimitRecovery.actions.switchFallbackNow',
            mode: 'switch_fallback_now',
        }));
        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('uses a temporary-throttle retry primary action for retryable throttles', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: temporaryThrottleIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-retryTemporaryThrottle',
            actionLabel: 'session.usageLimitRecovery.actions.retryTemporaryThrottle',
            mode: 'retry_temporary_throttle',
        }));
        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.overloadTitle');
        expect(presentation?.banner.secondaryActions).toEqual([]);
    });

    it('classifies typed recovery actions as check-now operations for shell reconciliation', () => {
        expect(isSessionUsageLimitRecoveryCheckNowAction('switch_fallback_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckNowAction('switch_account_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckNowAction('retry_temporary_throttle')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckNowAction('consume_reset_credit')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckNowAction('check_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckNowAction('enable')).toBe(false);
    });

    it('classifies centralized recovery actions as checking operations while their RPC is pending', () => {
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('resume_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('check_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('consume_reset_credit')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('switch_account_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('switch_fallback_now')).toBe(true);
        expect(isSessionUsageLimitRecoveryCheckingOperationAction('retry_temporary_throttle')).toBe(true);
    });

    it('omits manual check-now when the provider does not expose a safe quota probe', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: false,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
    });

    it('switches to resume now after check-now reports the limit is ready', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            operationStatus: 'ready',
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-resumeNow',
            title: 'session.usageLimitRecovery.banner.readyTitle',
            body: 'session.usageLimitRecovery.banner.readyBody',
            mode: 'resume_now',
        }));
        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'remember',
                testID: 'session-usageLimit-recovery-remember',
            }),
        ]);
        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.resumeReady');
    });

    it.each(['resume_now', 'check_now', 'switch_account_now', 'retry_temporary_throttle'] as const)(
        'surfaces a checking presentation while %s is pending',
        () => {
            const presentation = buildSessionUsageLimitRecoveryPresentation({
                featureEnabled: true,
                lastRuntimeIssue: usageLimitIssue,
                latestTurnStatus: 'failed',
                recoveryState: null,
                operationStatus: 'checking',
                checkNowSupported: true,
                settings: { v: 1, mode: 'ask' },
                translate: translateUsageLimitRecoveryKeyForTest,
            });

            expect(presentation?.waiting).toBe(true);
            expect(presentation?.statusBadge).toEqual(expect.objectContaining({
                label: 'session.usageLimitRecovery.status.checking',
                tone: 'active',
            }));
        },
    );

    it('does not switch to resume now when reset elapsed but no interrupted work remains', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            hasInterruptedWorkToResume: false,
            settings: { v: 1, mode: 'auto_wait' },
            nowMs: 1_700_000_060_000,
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-enable',
            title: 'session.usageLimitRecovery.banner.title',
            body: 'session.usageLimitRecovery.banner.body',
            mode: 'enable',
        }));
        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.ready');
    });

    it('switches to resume now when the provider reset time has already elapsed and interrupted work remains', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            checkNowSupported: true,
            hasInterruptedWorkToResume: true,
            settings: { v: 1, mode: 'auto_wait' },
            nowMs: 1_700_000_060_000,
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner).toEqual(expect.objectContaining({
            actionTestID: 'session-usageLimit-recovery-resumeNow',
            title: 'session.usageLimitRecovery.banner.readyTitle',
            body: 'session.usageLimitRecovery.banner.readyBody',
            mode: 'resume_now',
        }));
        expect(presentation?.banner.secondaryActions).toEqual([
            expect.objectContaining({
                kind: 'forget',
                testID: 'session-usageLimit-recovery-forget',
            }),
        ]);
        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.resumeReady');
    });

    it('does not show recovery affordances when the feature is unavailable', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: false,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            recoveryState: null,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        })).toBeNull();
    });

    it('does not show stale recovery affordances after a later turn completed', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'completed',
            recoveryState: null,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        })).toBeNull();
    });

    it.each(['in_progress', 'cancelled'] as const)('keeps unproven recovery visible when the latest lifecycle is %s', (latestTurnStatus) => {
        // Honesty: runtimeWorking (a live thinking signal after a local switch) is NOT
        // provider-outcome proof, so an unproven recovery must stay visible until real activity.
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus,
            runtimeWorking: true,
            recoveryState: null,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        })).not.toBeNull();
    });

    it('hides recovery only after a later in-progress turn produces meaningful activity', () => {
        expect(buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true, lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'in_progress', hasActivityAfterRuntimeIssue: true,
            recoveryState: null, settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        })).toBeNull();
    });

    it('presents the daemon’s automatic usage-limit retry as the current state, not an opt-in wait', () => {
        // The daemon arms a same-Session retry for a non-account usage limit and projects it under
        // its temporary-throttle fingerprint (`projectTemporaryThrottleRecoveryMetadata`).
        const issue = SessionRuntimeIssueV1Schema.parse({
            ...usageLimitIssue, agentId: 'codex',
            usageLimit: { ...usageLimitIssue.usageLimit, resetAtMs: null, quotaScope: 'unknown' },
        });
        const nextCheckAtMs = issue.occurredAt + 3_600_000;
        const recoveryState = readSessionUsageLimitRecoveryFromMetadata({ sessionUsageLimitRecoveryV1: {
            v: 1, status: 'waiting',
            issueFingerprint: 'temporary-throttle:temporary-retry:usage_limit:openai-codex:no-group:profile-1',
            armedAtMs: issue.occurredAt, resetAtMs: null, nextCheckAtMs, attemptCount: 0, maxAttempts: 0,
            lastProbeError: null, selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'profile-1' },
        } });
        expect(recoveryState).not.toBeNull();
        const params: unknown[] = [];
        const translate: SessionUsageLimitRecoveryTranslate = (key, ...rest) => {
            params.push(...rest);
            return key;
        };
        const input = {
            featureEnabled: true, lastRuntimeIssue: issue, latestTurnStatus: 'failed', recoveryState,
            checkNowSupported: true, settings: { v: 1, mode: 'ask' }, translate,
        } as const;
        const presentation = buildSessionUsageLimitRecoveryPresentation(input);

        // Its identity is the daemon's recovery, so Stop retrying and Retry now reach that recovery.
        expect(presentation?.issueFingerprint).toBe(recoveryState?.issueFingerprint);
        expect(presentation?.waiting).toBe(true);
        expect(presentation?.banner.title).toBe('session.usageLimitRecovery.banner.title');
        expect(presentation?.banner.body).toBe('session.usageLimitRecovery.banner.retryAt');
        expect(params).toContainEqual({ time: expect.any(String) });
        expect(presentation?.banner.mode).toBe('cancel');
        expect(presentation?.banner.secondaryActions.map((action) => action.kind)).toEqual(['retry_temporary_throttle']);
        // A usage limit is not an overload: no seconds countdown titled "Model overloaded".
        expect(presentation?.banner.temporaryThrottle).toBeUndefined();
        expect(presentation?.statusBadge.label).toBe('session.usageLimitRecovery.status.waiting');

        const offline = buildSessionUsageLimitRecoveryPresentation({ ...input, machineReachable: false });
        expect(offline?.banner.body).toBe('session.usageLimitRecovery.overloadOffline');
        expect(offline?.banner.actionsDisabled).toBe(true);
        // A stopped daemon retry leaves the person's ordinary opt-in recovery.
        expect(buildSessionUsageLimitRecoveryPresentation({ ...input,
            recoveryState: recoveryState ? { ...recoveryState, status: 'cancelled', nextCheckAtMs: null } : null,
        })?.banner.mode).toBe('enable');
    });

    it('keeps the current failed recovery visible when the provider emits its terminal limit notice', () => {
        const presentation = buildSessionUsageLimitRecoveryPresentation({
            featureEnabled: true,
            lastRuntimeIssue: usageLimitIssue,
            latestTurnStatus: 'failed',
            hasActivityAfterRuntimeIssue: true,
            recoveryState: null,
            settings: { v: 1, mode: 'ask' },
            translate: translateUsageLimitRecoveryKeyForTest,
        });

        expect(presentation?.banner.testID).toBe('session-usageLimit-recovery');
        expect(presentation?.statusBadge.testID).toBe('session-usageLimit-status-badge');
    });
});
