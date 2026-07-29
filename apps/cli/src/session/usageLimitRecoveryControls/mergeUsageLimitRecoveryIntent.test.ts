import { describe, expect, it } from 'vitest';

import {
    hasSameUsageLimitRecoveryIdentity,
    mergeUsageLimitRecoveryIntent,
    mergeUsageLimitRecoverySchedule,
} from './mergeUsageLimitRecoveryIntent';

function intent(overrides: Record<string, unknown> = {}) {
    return {
        v: 1 as const,
        status: 'waiting' as const,
        resumePromptMode: 'standard' as const,
        issueFingerprint: 'issue-a',
        armedAtMs: 100,
        resetAtMs: 1_000,
        nextCheckAtMs: 500,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' as const },
        ...overrides,
    };
}

describe('mergeUsageLimitRecoveryIntent', () => {
    it('is commutative and idempotent across the complete same-attempt status lattice', () => {
        const statuses = ['armed', 'checking', 'waiting', 'paused', 'exhausted', 'cancelled'] as const;
        for (const leftStatus of statuses) {
            const left = intent({ status: leftStatus, attemptCount: 2 });
            expect(mergeUsageLimitRecoveryIntent(left, left)).toEqual(left);
            for (const rightStatus of statuses) {
                const right = intent({ status: rightStatus, attemptCount: 2 });
                expect(mergeUsageLimitRecoveryIntent(left, right))
                    .toEqual(mergeUsageLimitRecoveryIntent(right, left));
            }
        }
    });

    it('accepts the current controller checking-to-waiting transition and converges in either arrival order', () => {
        const checking = intent({ status: 'checking', attemptCount: 1 });
        const waiting = intent({ status: 'waiting', attemptCount: 1, lastProbeError: 'probe_unavailable' });

        expect(mergeUsageLimitRecoveryIntent(checking, waiting)).toMatchObject({
            status: 'waiting',
            lastProbeError: 'probe_unavailable',
        });
        expect(mergeUsageLimitRecoveryIntent(waiting, checking))
            .toEqual(mergeUsageLimitRecoveryIntent(checking, waiting));
    });
    it.each(['armed', 'waiting', 'checking'] as const)(
        'never revives a paused same-attempt intent with stale %s state',
        (status) => {
            const paused = intent({ status: 'paused', attemptCount: 2, nextCheckAtMs: null });
            const stale = intent({ status, attemptCount: 2, nextCheckAtMs: 2_000 });

            expect(mergeUsageLimitRecoveryIntent(paused, stale)).toMatchObject({ status: 'paused' });
            expect(mergeUsageLimitRecoveryIntent(stale, paused))
                .toEqual(mergeUsageLimitRecoveryIntent(paused, stale));
        },
    );
    it('lets a newer checking attempt supersede an older waiting attempt', () => {
        const oldWaiting = intent({ status: 'waiting', attemptCount: 1, nextCheckAtMs: 1_000 });
        const newChecking = intent({ status: 'checking', attemptCount: 2, nextCheckAtMs: 1_000 });

        expect(mergeUsageLimitRecoveryIntent(oldWaiting, newChecking)).toMatchObject({
            status: 'checking',
            attemptCount: 2,
        });
        expect(mergeUsageLimitRecoveryIntent(newChecking, oldWaiting))
            .toEqual(mergeUsageLimitRecoveryIntent(oldWaiting, newChecking));
    });
    it('never regresses a terminal intent for the same recovery attempt', () => {
        const exhausted = intent({ status: 'exhausted', attemptCount: 3, lastProbeError: 'max_attempts' });
        const staleChecking = intent({ status: 'checking', attemptCount: 2, nextCheckAtMs: 2_000 });

        expect(mergeUsageLimitRecoveryIntent(exhausted, staleChecking)).toMatchObject({
            status: 'exhausted',
            attemptCount: 3,
            lastProbeError: 'max_attempts',
        });
        expect(mergeUsageLimitRecoveryIntent(staleChecking, exhausted))
            .toEqual(mergeUsageLimitRecoveryIntent(exhausted, staleChecking));
    });

    it('lets a genuinely newer issue supersede an older terminal intent', () => {
        const oldTerminal = intent({ status: 'cancelled', armedAtMs: 100 });
        const newIssue = intent({ issueFingerprint: 'issue-b', armedAtMs: 200, status: 'waiting' });

        expect(mergeUsageLimitRecoveryIntent(oldTerminal, newIssue)).toMatchObject({
            issueFingerprint: 'issue-b',
            status: 'waiting',
        });
    });

    it('lets a fresh explicit attempt for the same issue supersede an older terminal epoch', () => {
        const oldTerminal = intent({ status: 'cancelled', armedAtMs: 100 });
        const freshAttempt = intent({ status: 'waiting', armedAtMs: 200, attemptCount: 0 });

        expect(mergeUsageLimitRecoveryIntent(oldTerminal, freshAttempt)).toMatchObject({
            status: 'waiting',
            armedAtMs: 200,
            attemptCount: 0,
        });
    });

    it('retains current when distinct controllers write equal epochs', () => {
        const left = intent({ issueFingerprint: 'issue-a', armedAtMs: 100 });
        const right = intent({ issueFingerprint: 'issue-b', armedAtMs: 100 });

        expect(mergeUsageLimitRecoveryIntent(left, right)).toEqual(left);
        expect(mergeUsageLimitRecoveryIntent(right, left)).toEqual(right);
    });

    it('converges independently of three-writer CAS order while retaining the largest counter', () => {
        const checking = intent({ status: 'checking', attemptCount: 1 });
        const exhausted = intent({ status: 'exhausted', attemptCount: 0 });
        const cancelled = intent({ status: 'cancelled', attemptCount: 0 });

        const checkingThenExhaustedThenCancelled = mergeUsageLimitRecoveryIntent(
            mergeUsageLimitRecoveryIntent(checking, exhausted),
            cancelled,
        );
        const checkingThenCancelledThenExhausted = mergeUsageLimitRecoveryIntent(
            mergeUsageLimitRecoveryIntent(checking, cancelled),
            exhausted,
        );

        expect(checkingThenExhaustedThenCancelled).toEqual(checkingThenCancelledThenExhausted);
        expect(checkingThenExhaustedThenCancelled).toMatchObject({
            status: 'cancelled',
            attemptCount: 1,
        });
    });

    it.each([
        { left: 3, right: 5, expected: 3 },
        { left: 0, right: 5, expected: 5 },
        { left: 3, right: 0, expected: 3 },
    ])('retains the stricter execution cap for $left and $right', ({ left, right, expected }) => {
        const a = intent({ status: 'exhausted', attemptCount: 3, maxAttempts: left });
        const b = intent({ status: 'waiting', attemptCount: 3, maxAttempts: right });
        expect(mergeUsageLimitRecoveryIntent(a, b)?.maxAttempts).toBe(expected);
        expect(mergeUsageLimitRecoveryIntent(a, b)).toEqual(mergeUsageLimitRecoveryIntent(b, a));
    });

    it('requires the exact runtime-auth attempt id when either recovery carries one', () => {
        const legacy = intent();
        const runtimeA = intent({ runtimeAuthRecoveryAttemptId: 'runtime-a' });
        const runtimeB = intent({ runtimeAuthRecoveryAttemptId: 'runtime-b' });

        expect(hasSameUsageLimitRecoveryIdentity(runtimeA, runtimeA)).toBe(true);
        expect(hasSameUsageLimitRecoveryIdentity(runtimeA, runtimeB)).toBe(false);
        expect(hasSameUsageLimitRecoveryIdentity(runtimeA, legacy)).toBe(false);
        expect(hasSameUsageLimitRecoveryIdentity(legacy, runtimeA)).toBe(false);
        expect(hasSameUsageLimitRecoveryIdentity(legacy, legacy)).toBe(true);
    });

    it('fails closed to current for equal-epoch distinct runtime attempts but accepts same-attempt progress', () => {
        const runtimeB = intent({ runtimeAuthRecoveryAttemptId: 'runtime-b' });
        const delayedRuntimeA = intent({
            runtimeAuthRecoveryAttemptId: 'runtime-a',
            attemptCount: 2,
            nextCheckAtMs: 700,
            maxAttempts: 2,
        });
        const progressedRuntimeB = intent({
            runtimeAuthRecoveryAttemptId: 'runtime-b',
            attemptCount: 2,
            nextCheckAtMs: 700,
            maxAttempts: 2,
        });

        expect(mergeUsageLimitRecoverySchedule(runtimeB, delayedRuntimeA)).toEqual(runtimeB);
        expect(mergeUsageLimitRecoveryIntent(runtimeB, {
            ...delayedRuntimeA,
            status: 'cancelled',
        })).toEqual(runtimeB);
        expect(mergeUsageLimitRecoveryIntent(runtimeB, intent({
            status: 'cancelled',
            attemptCount: 2,
        }))).toEqual(runtimeB);
        expect(mergeUsageLimitRecoverySchedule(runtimeB, progressedRuntimeB)).toMatchObject({
            runtimeAuthRecoveryAttemptId: 'runtime-b',
            attemptCount: 2,
            nextCheckAtMs: 700,
            maxAttempts: 2,
        });
    });

    it('lets a distinct runtime attempt supersede only at a strictly higher epoch and retains legacy tuple identity', () => {
        const runtimeB = intent({ runtimeAuthRecoveryAttemptId: 'runtime-b' });
        const newerRuntimeA = intent({ runtimeAuthRecoveryAttemptId: 'runtime-a', armedAtMs: 101 });
        const legacyCurrent = intent();
        const legacyProgress = intent({ attemptCount: 1, nextCheckAtMs: 700 });

        expect(mergeUsageLimitRecoverySchedule(runtimeB, newerRuntimeA)).toEqual(newerRuntimeA);
        expect(mergeUsageLimitRecoverySchedule(legacyCurrent, legacyProgress)).toMatchObject({
            attemptCount: 1,
            nextCheckAtMs: 700,
        });
    });
});
