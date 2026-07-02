import { describe, expect, it, vi } from 'vitest';

import type { SessionContinuationRecoveryV1 } from '@happier-dev/protocol';

import {
  createConnectedServiceRecoverySupersessionCleaner,
  shouldSuppressContinuationRecoveryForSupersession,
} from './continuationRecoverySupersession';

function buildRecoveryState(): SessionContinuationRecoveryV1 {
  return {
    v: 1,
    attemptsById: {
      'attempt-pending': {
        v: 1,
        attemptId: 'attempt-pending',
        status: 'pending_provider_context',
        failureAtMs: 1_000,
        updatedAtMs: 1_000,
        resumePromptMode: 'standard',
      },
      'attempt-awaiting': {
        v: 1,
        attemptId: 'attempt-awaiting',
        status: 'awaiting_provider_activity',
        failureAtMs: 1_000,
        updatedAtMs: 1_500,
        resumePromptMode: 'standard',
        sentAtMs: 1_500,
      },
      'attempt-terminal': {
        v: 1,
        attemptId: 'attempt-terminal',
        status: 'provider_activity_observed',
        failureAtMs: 500,
        updatedAtMs: 800,
        resumePromptMode: 'standard',
      },
    },
  };
}

function createHarness() {
  let state: SessionContinuationRecoveryV1 = buildRecoveryState();
  const removeReportOutboxItemsForSession = vi.fn(async () => {});
  const cleaner = createConnectedServiceRecoverySupersessionCleaner({
    nowMs: () => 2_000,
    providerActivityTimeoutMs: 60_000,
    store: {
      read: () => state,
      write: (_sessionId, next) => {
        state = next as SessionContinuationRecoveryV1;
      },
    },
    removeReportOutboxItemsForSession,
  });
  return {
    cleaner,
    removeReportOutboxItemsForSession,
    readAttemptStatus: (attemptId: string) => state.attemptsById[attemptId]?.status,
  };
}

describe('shouldSuppressContinuationRecoveryForSupersession', () => {
  it('suppresses on user-visible terminal turn lifecycle events', () => {
    expect(shouldSuppressContinuationRecoveryForSupersession({
      kind: 'turn_lifecycle',
      event: 'turn_cancelled',
    })).toBe(true);
    expect(shouldSuppressContinuationRecoveryForSupersession({
      kind: 'turn_lifecycle',
      event: 'assistant_message_end',
    })).toBe(true);
  });

  it('does not suppress on non-terminal turn lifecycle events', () => {
    expect(shouldSuppressContinuationRecoveryForSupersession({
      kind: 'turn_lifecycle',
      event: 'task_started',
    })).toBe(false);
    expect(shouldSuppressContinuationRecoveryForSupersession({
      kind: 'turn_lifecycle',
      event: 'prompt_or_steer',
    })).toBe(false);
  });

  it('suppresses on manual session supersession', () => {
    expect(shouldSuppressContinuationRecoveryForSupersession({
      kind: 'manual_session_supersession',
      reason: 'stop',
    })).toBe(true);
  });
});

describe('createConnectedServiceRecoverySupersessionCleaner', () => {
  it('supersedes non-terminal continuation attempts when a turn completes normally', async () => {
    const harness = createHarness();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'assistant_message_end' },
    });

    expect(harness.readAttemptStatus('attempt-pending')).toBe('suppressed_newer_user_input');
    expect(harness.readAttemptStatus('attempt-awaiting')).toBe('suppressed_newer_user_input');
    expect(harness.readAttemptStatus('attempt-terminal')).toBe('provider_activity_observed');
  });

  it('supersedes non-terminal continuation attempts on turn cancellation', async () => {
    const harness = createHarness();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'turn_cancelled' },
    });

    expect(harness.readAttemptStatus('attempt-pending')).toBe('suppressed_newer_user_input');
    expect(harness.readAttemptStatus('attempt-awaiting')).toBe('suppressed_newer_user_input');
  });

  it('leaves continuation attempts pending on non-terminal turn lifecycle events', async () => {
    const harness = createHarness();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'task_started' },
    });
    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'prompt_or_steer' },
    });

    expect(harness.readAttemptStatus('attempt-pending')).toBe('pending_provider_context');
    expect(harness.readAttemptStatus('attempt-awaiting')).toBe('awaiting_provider_activity');
  });

  it('clears the runtime-auth report outbox on cancellation, newer input, or manual supersession', async () => {
    const harness = createHarness();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'assistant_message_end' },
    });
    expect(harness.removeReportOutboxItemsForSession).not.toHaveBeenCalled();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'turn_cancelled' },
    });
    expect(harness.removeReportOutboxItemsForSession).toHaveBeenCalledTimes(1);

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'turn_lifecycle', event: 'prompt_or_steer' },
    });
    expect(harness.removeReportOutboxItemsForSession).toHaveBeenCalledTimes(2);

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'manual_session_supersession', reason: 'stop' },
    });
    expect(harness.removeReportOutboxItemsForSession).toHaveBeenCalledTimes(3);
  });

  it('supersedes non-terminal continuation attempts on manual supersession', async () => {
    const harness = createHarness();

    await harness.cleaner({
      sessionId: 'session-1',
      event: { kind: 'manual_session_supersession', reason: 'switch' },
    });

    expect(harness.readAttemptStatus('attempt-pending')).toBe('suppressed_newer_user_input');
    expect(harness.readAttemptStatus('attempt-awaiting')).toBe('suppressed_newer_user_input');
  });
});
