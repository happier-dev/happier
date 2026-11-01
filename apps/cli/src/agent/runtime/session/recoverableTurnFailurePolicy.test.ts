import { describe, expect, it } from 'vitest';

import {
    resolveRecoverableTurnFailureRetryDecision,
    resolveRecoverableTurnFailureSecondFailure,
} from './recoverableTurnFailurePolicy';

describe('recoverable turn failure retry policy', () => {
    it('leaves retries to the containing lifecycle when no retry-count budget is specified', () => {
        expect(resolveRecoverableTurnFailureRetryDecision({
            attemptCount: 40, maxRetries: null, failedTurnHadMeaningfulActivity: true,
            promptMode: 'activity_aware', originalPrompt: 'original', continuationPrompt: 'continue',
        })).toMatchObject({ action: 'retry', prompt: 'continue' });
    });
    it('trusts provider willRetry by suppressing backend errors without consuming host retry budget', () => {
        const decision = resolveRecoverableTurnFailureRetryDecision({
            attemptCount: 0,
            maxRetries: 1,
            providerWillRetry: true,
            failureRetryAfterMs: 2_500,
            failedTurnHadMeaningfulActivity: false,
            promptMode: 'activity_aware',
            originalPrompt: 'run the task',
            continuationPrompt: 'continue safely',
        });

        expect(decision).toEqual({
            action: 'await_provider_retry',
            retryAfterMs: 2_500,
            suppressBackendError: true,
            consumeRetryBudget: false,
        });
    });

    it('preserves retry-after timing when arming a host-owned retry', () => {
        const decision = resolveRecoverableTurnFailureRetryDecision({
            attemptCount: 0,
            maxRetries: 1,
            providerWillRetry: false,
            failureRetryAfterMs: 7_500,
            failedTurnHadMeaningfulActivity: false,
            promptMode: 'activity_aware',
            originalPrompt: 'run the task',
            continuationPrompt: 'continue safely',
        });

        expect(decision).toEqual({
            action: 'retry',
            prompt: 'run the task',
            promptKind: 'original',
            retryAfterMs: 7_500,
            suppressBackendError: true,
            consumeRetryBudget: true,
        });
    });

    it('uses the configured continuation prompt when activity makes original replay unsafe', () => {
        const decision = resolveRecoverableTurnFailureRetryDecision({
            attemptCount: 0,
            maxRetries: 1,
            providerWillRetry: false,
            failureRetryAfterMs: null,
            failedTurnHadMeaningfulActivity: true,
            promptMode: 'activity_aware',
            originalPrompt: 'run the task',
            continuationPrompt: 'custom continuation from settings',
        });

        expect(decision).toMatchObject({
            action: 'retry',
            prompt: 'custom continuation from settings',
            promptKind: 'continuation',
        });
    });

    it('surfaces the first failure after the retry budget is exhausted', () => {
        const firstFailure = new Error('ORIGINAL_CAPACITY_FAILURE');
        const retryFailure = new Error('RETRY_CAPACITY_FAILURE');

        const decision = resolveRecoverableTurnFailureSecondFailure({
            originalFailure: firstFailure,
            latestFailure: retryFailure,
        });

        expect(decision).toEqual({
            action: 'surface_original_failure',
            failure: firstFailure,
            suppressLatestFailure: true,
        });
    });
});
