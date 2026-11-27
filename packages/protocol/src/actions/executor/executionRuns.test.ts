import { describe, expect, it } from 'vitest';
import { withExecutionRunStartFailureDetails } from '../../execution/runs/responseSchemas.js';
import { readActionOutputDiagnostic, withActionFailureDiagnostic } from './actionFailureDiagnostic.js';
import { fanoutStarts, readFanoutStartError } from './executionRuns.js';

describe('executionRuns fanout typed failure preservation', () => {
  it('preserves typed failure envelope fields and diagnostics through readFanoutStartError', () => {
    const failureCause = {
      phase: 'review.launch',
      errorClass: 'HttpStatusError',
      errorCode: 'account_disconnected',
      httpStatus: 403,
    } as const;
    const returned = withActionFailureDiagnostic({
      ok: false as const,
      errorCode: 'review_engine_unavailable',
      error: 'Reconnect the reviewer account.',
      requestId: 'req-returned-1',
      failureCause,
      details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
      effectAttempted: false,
    }, { phase: 'review.launch', causeKind: 'access_denied' });

    const projected = readFanoutStartError(returned);
    expect(projected).toEqual({
      errorCode: 'review_engine_unavailable',
      error: 'Reconnect the reviewer account.',
      requestId: 'req-returned-1',
      failureCause,
      effectAttempted: false,
      details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
    });
    expect(readActionOutputDiagnostic(projected)).toMatchObject({
      phase: 'review.launch',
      causeKind: 'access_denied',
    });

    const thrown = Object.assign(new Error('Private transport prose'), {
      ok: false as const,
      errorCode: 'review_narrator_unavailable',
      error: 'Reconnect the narrator account.',
      requestId: 'req-thrown-1',
      failureCause: {
        phase: 'review.narration',
        errorClass: 'HttpStatusError',
        errorCode: 'account_disconnected',
        httpStatus: 403,
      },
      details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
      effectAttempted: false,
    });
    expect(readFanoutStartError(thrown)).toEqual({
      errorCode: 'review_narrator_unavailable',
      error: 'Reconnect the narrator account.',
      requestId: 'req-thrown-1',
      failureCause: {
        phase: 'review.narration',
        errorClass: 'HttpStatusError',
        errorCode: 'account_disconnected',
        httpStatus: 403,
      },
      effectAttempted: false,
      details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
    });
  });

  it('preserves typed failureCause, requestId, details, and effectAttempted across fanoutStarts returned and thrown failures', async () => {
    const returnedCause = {
      phase: 'review.launch',
      errorClass: 'HttpStatusError',
      errorCode: 'account_disconnected',
      httpStatus: 403,
    } as const;
    const thrownCause = {
      phase: 'execution.run.start',
      errorClass: 'HttpStatusError',
      errorCode: 'rate_limited',
      httpStatus: 429,
    } as const;

    const results = await fanoutStarts({
      keys: ['returned-refusal', 'thrown-refusal'],
      startOne: async (key) => {
        if (key === 'returned-refusal') {
          return {
            ok: false,
            errorCode: 'review_engine_unavailable',
            error: 'Reconnect the reviewer account.',
            requestId: 'req-fanout-returned',
            failureCause: returnedCause,
            details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
            effectAttempted: false,
          };
        }
        throw new Error('Wrapper error', {
          cause: {
            ok: false,
            errorCode: 'provider_rate_limited',
            error: 'Provider rate limit reached.',
            requestId: 'req-fanout-thrown',
            failureCause: thrownCause,
            details: withExecutionRunStartFailureDetails({ retryAfterSeconds: 30 }, 'noRunCreated'),
            effectAttempted: false,
          },
        });
      },
    });

    expect(results).toEqual([
      {
        key: 'returned-refusal',
        ok: false,
        errorCode: 'review_engine_unavailable',
        error: 'Reconnect the reviewer account.',
        requestId: 'req-fanout-returned',
        failureCause: returnedCause,
        effectAttempted: false,
        details: withExecutionRunStartFailureDetails({ reason: 'account_disconnected' }, 'noRunCreated'),
      },
      {
        key: 'thrown-refusal',
        ok: false,
        errorCode: 'provider_rate_limited',
        error: 'Provider rate limit reached.',
        requestId: 'req-fanout-thrown',
        failureCause: thrownCause,
        effectAttempted: false,
        details: withExecutionRunStartFailureDetails({ retryAfterSeconds: 30 }, 'noRunCreated'),
      },
    ]);
  });
});
