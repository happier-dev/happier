import { describe, expect, it } from 'vitest';

import {
  resolveRecoverableTurnFailureRetryDecision,
  resolveRecoverableTurnFailureSecondFailure,
} from './recoverableTurnFailurePolicy.js';

describe('recoverable turn failure policy', () => {
  it('trusts provider-owned retry without consuming host retry budget', () => {
    expect(resolveRecoverableTurnFailureRetryDecision({
      attemptCount: 0,
      maxRetries: 1,
      providerWillRetry: true,
      failureRetryAfterMs: 2_500,
      failedTurnHadMeaningfulActivity: false,
      promptMode: 'activity_aware',
      originalPrompt: 'run the task',
      continuationPrompt: 'continue safely',
    })).toEqual({
      action: 'await_provider_retry',
      retryAfterMs: 2_500,
      suppressBackendError: true,
      consumeRetryBudget: false,
    });
  });

  it('uses configured continuation prompt when activity makes original replay unsafe', () => {
    expect(resolveRecoverableTurnFailureRetryDecision({
      attemptCount: 0,
      maxRetries: 1,
      providerWillRetry: false,
      failureRetryAfterMs: null,
      failedTurnHadMeaningfulActivity: true,
      promptMode: 'activity_aware',
      originalPrompt: 'run the task',
      continuationPrompt: 'custom continuation from settings',
    })).toMatchObject({
      action: 'retry',
      prompt: 'custom continuation from settings',
      promptKind: 'continuation',
    });
  });

  it('surfaces the original failure when a host retry fails too', () => {
    const originalFailure = new Error('ORIGINAL_CAPACITY_FAILURE');
    const retryFailure = new Error('RETRY_CAPACITY_FAILURE');

    expect(resolveRecoverableTurnFailureSecondFailure({
      originalFailure,
      latestFailure: retryFailure,
    })).toEqual({
      action: 'surface_original_failure',
      failure: originalFailure,
      suppressLatestFailure: true,
    });
  });
});
