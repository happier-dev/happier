import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
    evaluateRefreshEligibility,
    recordRefreshFailure,
    TRIAGE_REFRESH_BACKOFF_IDLE_V1,
    TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
} from './refreshEligibility.js';

const NOW_MS = 1_700_000_000_000;

function failure(overrides: Partial<TriageSourceFailureV1> = {}): TriageSourceFailureV1 {
    return { class: 'transient', code: 'source-busy', ...overrides };
}

describe('triage refresh pacing', () => {
    it('paces view demand only, and reports the exact next eligible moment', () => {
        const lastReadStartedAtMs = NOW_MS - 1;
        const paced = evaluateRefreshEligibility({
            trigger: 'view',
            nowMs: NOW_MS,
            lastReadStartedAtMs,
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
        });
        expect(paced).toEqual({
            kind: 'blocked',
            reason: 'minimumInterval',
            nextEligibleAtMs: lastReadStartedAtMs + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
        });

        // Manual Refresh is the user asking, so the shared interval never
        // holds it: it is the one trigger that must reach the provider now.
        expect(evaluateRefreshEligibility({
            trigger: 'manual',
            nowMs: NOW_MS,
            lastReadStartedAtMs,
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
        })).toEqual({ kind: 'eligible' });

        expect(evaluateRefreshEligibility({
            trigger: 'view',
            nowMs: lastReadStartedAtMs + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
            lastReadStartedAtMs,
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
        })).toEqual({ kind: 'eligible' });
    });

    it('blocks manual refresh on the latest active provider deadline', () => {
        const sourceStated = evaluateRefreshEligibility({
            trigger: 'manual',
            nowMs: NOW_MS,
            lastReadStartedAtMs: null,
            backoff: {
                retryNotBeforeMs: NOW_MS + 90_000,
                failureBackoffUntilMs: NOW_MS + 5_000,
                consecutivePacingFailures: 1,
            },
        });
        expect(sourceStated).toEqual({
            kind: 'blocked',
            reason: 'sourceRetryDeadline',
            nextEligibleAtMs: NOW_MS + 90_000,
        });

        const ourBackoff = evaluateRefreshEligibility({
            trigger: 'manual',
            nowMs: NOW_MS,
            lastReadStartedAtMs: null,
            backoff: {
                retryNotBeforeMs: NOW_MS + 1_000,
                failureBackoffUntilMs: NOW_MS + 40_000,
                consecutivePacingFailures: 3,
            },
        });
        expect(ourBackoff).toEqual({
            kind: 'blocked',
            reason: 'failureBackoff',
            nextEligibleAtMs: NOW_MS + 40_000,
        });

        expect(evaluateRefreshEligibility({
            trigger: 'manual',
            nowMs: NOW_MS,
            lastReadStartedAtMs: null,
            backoff: {
                retryNotBeforeMs: NOW_MS,
                failureBackoffUntilMs: NOW_MS,
                consecutivePacingFailures: 2,
            },
        })).toEqual({ kind: 'eligible' });
    });

    it('grows the pacing ceiling with consecutive failures and draws the delay inside it', () => {
        const ceilings: number[] = [];
        let backoff = TRIAGE_REFRESH_BACKOFF_IDLE_V1;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            backoff = recordRefreshFailure({
                backoff,
                failure: failure(),
                nowMs: NOW_MS,
                random: () => 1,
            });
            ceilings.push((backoff.failureBackoffUntilMs ?? NOW_MS) - NOW_MS);
        }
        expect(ceilings).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
        expect(backoff.consecutivePacingFailures).toBe(8);

        const jittered = recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure(),
            nowMs: NOW_MS,
            random: () => 0.25,
        });
        expect(jittered.failureBackoffUntilMs).toBe(NOW_MS + 1_250);
    });

    it('keeps a stated retry deadline but never backs off a user-actionable failure', () => {
        const authentication = recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure({ class: 'authentication', code: 'token-expired', retryNotBeforeMs: NOW_MS + 30_000 }),
            nowMs: NOW_MS,
            random: () => 1,
        });
        expect(authentication).toEqual({
            retryNotBeforeMs: NOW_MS + 30_000,
            failureBackoffUntilMs: null,
            consecutivePacingFailures: 0,
        });

        const permission = recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure({ class: 'permission', code: 'forbidden' }),
            nowMs: NOW_MS,
            random: () => 1,
        });
        expect(permission).toEqual(TRIAGE_REFRESH_BACKOFF_IDLE_V1);
    });

    it('bounds a source-stated deadline to the retry horizon, so no provider header can park a manual Refresh', () => {
        const ONE_HOUR_MS = 60 * 60 * 1_000;
        const hostile = recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure({
                class: 'rateLimit',
                code: 'secondary-limit',
                retryNotBeforeMs: NOW_MS + (30 * 24 * ONE_HOUR_MS),
            }),
            nowMs: NOW_MS,
            random: () => 1,
        });
        expect(hostile.retryNotBeforeMs).toBe(NOW_MS + ONE_HOUR_MS);

        // The press this protects. A source-stated deadline is still honoured —
        // `core/CORPUS.md` §4.2 requires surfacing the wait rather than bypassing
        // provider authority — but a skewed, mis-scaled or rewritten header cannot
        // hold the user's own Refresh past the horizon.
        expect(evaluateRefreshEligibility({
            trigger: 'manual',
            nowMs: NOW_MS + ONE_HOUR_MS,
            lastReadStartedAtMs: null,
            backoff: hostile,
        })).toEqual({ kind: 'eligible' });

        // Inside the horizon the provider's own instant is carried exactly, not
        // rounded to the bound: the bound is a ceiling, not a schedule.
        expect(recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure({ class: 'rateLimit', code: 'secondary-limit', retryNotBeforeMs: NOW_MS + 90_000 }),
            nowMs: NOW_MS,
            random: () => 1,
        }).retryNotBeforeMs).toBe(NOW_MS + 90_000);
    });

    it('honours a rate-limit deadline alongside the aggregate ceiling', () => {
        const rateLimited = recordRefreshFailure({
            backoff: TRIAGE_REFRESH_BACKOFF_IDLE_V1,
            failure: failure({ class: 'rateLimit', code: 'secondary-limit', retryNotBeforeMs: NOW_MS + 120_000 }),
            nowMs: NOW_MS,
            random: () => 1,
        });
        expect(rateLimited).toEqual({
            retryNotBeforeMs: NOW_MS + 120_000,
            failureBackoffUntilMs: NOW_MS + 5_000,
            consecutivePacingFailures: 1,
        });
    });
});
