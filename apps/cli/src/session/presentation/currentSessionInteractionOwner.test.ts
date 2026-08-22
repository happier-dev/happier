import { describe, expect, it, vi } from 'vitest';

import {
  MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS,
  type InteractionTransientRequestV1,
  type InteractionTransientResultV1,
} from '@happier-dev/protocol';

import {
  CURRENT_SESSION_INTERACTION_DEADLINE_MS,
  createCurrentSessionInteractionOwner,
} from './currentSessionInteractionOwner';

const requester = Object.freeze({
  pluginId: 'acme.widgets',
  contributionId: 'run',
  generationId: 'generation-1',
  invocationId: 'invocation-1',
});

function approvalResult(
  request: InteractionTransientRequestV1,
): InteractionTransientResultV1 {
  return {
    requestId: request.requestId,
    kind: 'approval',
    status: 'approved',
    persistence: 'once',
  };
}

type InteractionRequestInput = Parameters<
  ReturnType<typeof createCurrentSessionInteractionOwner>['request']
>[0];
type InteractionPresenterResult = (
  request: InteractionTransientRequestV1,
) => InteractionTransientResultV1;

describe('current Session transient interaction owner', () => {
  it('stamps custody facts and settles the first valid presenter result', async () => {
    let presented!: InteractionTransientRequestV1;
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      now: () => 10,
      createRequestId: () => 'request-1',
      present: async (request) => {
        presented = request;
        return approvalResult(request);
      },
    });

    await expect(owner.request({
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
    }, { requester })).resolves.toEqual({
      requestId: 'request-1',
      kind: 'approval',
      status: 'approved',
      persistence: 'once',
    });
    expect(presented).toMatchObject({
      requestId: 'request-1',
      scope: { kind: 'session', sessionId: 'session-1' },
      requester,
      createdAtMs: 10,
      expiresAtMs: 1_010,
    });
  });

  it('distinguishes requester abort, Session end, and generation retirement', async () => {
    const cases: ReadonlyArray<Readonly<{
      expected: InteractionTransientResultV1['status'];
      run(requesterAbort: AbortController, sessionAbort: AbortController): void;
      isCurrent(): boolean;
    }>> = [
      {
        expected: 'requesterAborted',
        run: (requesterAbort: AbortController) => requesterAbort.abort(),
        isCurrent: () => true,
      },
      {
        expected: 'sessionEnded',
        run: (_requesterAbort: AbortController, sessionAbort: AbortController) => sessionAbort.abort(),
        isCurrent: () => true,
      },
      {
        expected: 'generationRetired',
        run: (_requesterAbort: AbortController, sessionAbort: AbortController) => sessionAbort.abort(),
        isCurrent: () => false,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const requesterAbort = new AbortController();
      const sessionAbort = new AbortController();
      const owner = createCurrentSessionInteractionOwner({
        sessionId: 'session-1',
        sessionSignal: sessionAbort.signal,
        isGenerationCurrent: testCase.isCurrent,
        deadlineMs: 1_000,
        createRequestId: () => `request-${index}`,
        present: async (_request, options) => await new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('presenter aborted')), { once: true });
        }),
      });
      const pending = owner.request({
        kind: 'confirmation',
        title: 'Continue?',
        message: 'Continue?',
      }, { requester, signal: requesterAbort.signal });
      testCase.run(requesterAbort, sessionAbort);
      await expect(pending).resolves.toMatchObject({
        kind: 'confirmation',
        status: testCase.expected,
      });
    }
  });

  it('rejects a late answer after the first terminal event as not current', async () => {
    let resolvePresenter!: (result: InteractionTransientResultV1) => void;
    let request!: InteractionTransientRequestV1;
    const requesterAbort = new AbortController();
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      createRequestId: () => 'request-late',
      present: async (nextRequest) => {
        request = nextRequest;
        return await new Promise<InteractionTransientResultV1>((resolve) => {
          resolvePresenter = resolve;
        });
      },
    });
    const pending = owner.request({
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue?',
    }, { requester, signal: requesterAbort.signal });
    await vi.waitFor(() => expect(request).toBeDefined());
    requesterAbort.abort();
    await expect(pending).resolves.toMatchObject({ status: 'requesterAborted' });

    expect(owner.settle({
      requestId: request.requestId,
      kind: 'confirmation',
      status: 'approved',
    })).toEqual({ status: 'notCurrent', requestId: request.requestId });
    resolvePresenter({
      requestId: request.requestId,
      kind: 'confirmation',
      status: 'approved',
    });
    expect(owner.current()).toEqual([]);
  });

  it('fences an in-flight presenter result when its generation retires', async () => {
    let current = true;
    let resolvePresenter!: (result: InteractionTransientResultV1) => void;
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => current,
      deadlineMs: 1_000,
      createRequestId: () => 'request-retired-race',
      present: async (_request) => await new Promise<InteractionTransientResultV1>((resolve) => {
        resolvePresenter = resolve;
      }),
    });
    const pending = owner.request({
      kind: 'confirmation',
      message: 'Continue?',
    }, { requester });

    await vi.waitFor(() => {
      expect(owner.current()).toHaveLength(1);
      expect(resolvePresenter).toBeTypeOf('function');
    });
    current = false;
    resolvePresenter({
      requestId: 'request-retired-race',
      kind: 'confirmation',
      status: 'approved',
    });

    await expect(pending).resolves.toEqual({
      requestId: 'request-retired-race',
      kind: 'confirmation',
      status: 'generationRetired',
    });
    expect(owner.current()).toEqual([]);
  });

  it('can terminate all live requests with host restart without retaining them', async () => {
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      createRequestId: () => 'request-restart',
      present: async (_request, options) => await new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('presenter aborted')), { once: true });
      }),
    });
    const pending = owner.request({
      kind: 'questions',
      questions: [{ id: 'reason', prompt: 'Why?', type: 'text' }],
    }, { requester });
    await vi.waitFor(() => expect(owner.current()).toHaveLength(1));
    owner.terminateAll('hostRestarted');
    await expect(pending).resolves.toMatchObject({ status: 'hostRestarted' });
    expect(owner.current()).toEqual([]);
  });

  it('settles a synchronous presenter failure as unavailable', async () => {
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      createRequestId: () => 'request-unavailable',
      present: () => {
        throw new Error('presenter unavailable');
      },
    });

    await expect(owner.request({
      kind: 'confirmation',
      message: 'Continue?',
    }, { requester })).resolves.toEqual({
      requestId: 'request-unavailable',
      kind: 'confirmation',
      status: 'unavailable',
    });
    expect(owner.current()).toEqual([]);
  });

  it('preserves exact answered, declined, and user-cancelled presenter outcomes', async () => {
    const cases: ReadonlyArray<Readonly<{
      input: InteractionRequestInput;
      result: InteractionPresenterResult;
      expectedStatus: InteractionTransientResultV1['status'];
    }>> = [
      {
        input: {
          kind: 'questions' as const,
          questions: [{ id: 'reason', prompt: 'Why?', type: 'text' as const, required: true }],
        },
        result: (request: InteractionTransientRequestV1): InteractionTransientResultV1 => ({
          requestId: request.requestId,
          kind: 'questions',
          status: 'answered',
          answers: { reason: { kind: 'text', value: 'Because' } },
        }),
        expectedStatus: 'answered',
      },
      {
        input: {
          kind: 'approval' as const,
          title: 'Run Bash?',
          subject: { kind: 'tool' as const, name: 'Bash', input: { command: 'pwd' } },
        },
        result: (request: InteractionTransientRequestV1): InteractionTransientResultV1 => ({
          requestId: request.requestId,
          kind: 'approval',
          status: 'declined',
        }),
        expectedStatus: 'declined',
      },
      {
        input: { kind: 'confirmation' as const, message: 'Continue?' },
        result: (request: InteractionTransientRequestV1): InteractionTransientResultV1 => ({
          requestId: request.requestId,
          kind: 'confirmation',
          status: 'userCancelled',
        }),
        expectedStatus: 'userCancelled',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const owner = createCurrentSessionInteractionOwner({
        sessionId: 'session-1',
        sessionSignal: new AbortController().signal,
        isGenerationCurrent: () => true,
        deadlineMs: 1_000,
        createRequestId: () => `request-presenter-${index}`,
        present: async (request) => testCase.result(request),
      });

      await expect(owner.request(testCase.input, { requester })).resolves.toMatchObject({
        requestId: `request-presenter-${index}`,
        status: testCase.expectedStatus,
      });
    }
  });

  it('turns malformed presenter settlements into unavailable and clears their custody', async () => {
    const owner = createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs: 1_000,
      createRequestId: () => 'request-malformed',
      present: async () => await new Promise<InteractionTransientResultV1>(() => {}),
    });

    const pending = owner.request({
      kind: 'confirmation',
      message: 'Continue?',
    }, { requester });
    await vi.waitFor(() => expect(owner.current()).toHaveLength(1));
    expect(owner.settle({
      requestId: 'request-malformed',
      kind: 'confirmation',
      status: 'forged',
    })).toMatchObject({ status: 'settled' });
    await expect(pending).resolves.toEqual({
      requestId: 'request-malformed',
      kind: 'confirmation',
      status: 'unavailable',
    });
    expect(owner.current()).toEqual([]);
  });

  it('times out through the canonical owner and rejects a racing late answer', async () => {
    vi.useFakeTimers();
    try {
      let request!: InteractionTransientRequestV1;
      const owner = createCurrentSessionInteractionOwner({
        sessionId: 'session-1',
        sessionSignal: new AbortController().signal,
        isGenerationCurrent: () => true,
        deadlineMs: 10,
        createRequestId: () => 'request-timeout',
        present: async (nextRequest, options) => {
          request = nextRequest;
          return await new Promise<InteractionTransientResultV1>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('presenter aborted')), { once: true });
          });
        },
      });
      const pending = owner.request({
        kind: 'confirmation',
        message: 'Continue?',
      }, { requester });

      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({
        requestId: 'request-timeout',
        kind: 'confirmation',
        status: 'timedOut',
      });
      expect(owner.settle({
        requestId: request.requestId,
        kind: 'confirmation',
        status: 'approved',
      })).toEqual({ status: 'notCurrent', requestId: 'request-timeout' });
      expect(owner.current()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms no host deadline for the interactive Session arm and settles on every lifecycle event', async () => {
    const lifecycle: ReadonlyArray<Readonly<{
      expected: InteractionTransientResultV1['status'];
      isCurrent(): boolean;
      run(input: Readonly<{
        requesterAbort: AbortController;
        sessionAbort: AbortController;
        answer: () => void;
        retire: () => void;
      }>): void;
    }>> = [
      { expected: 'userCancelled', isCurrent: () => true, run: ({ answer }) => answer() },
      { expected: 'requesterAborted', isCurrent: () => true, run: ({ requesterAbort }) => requesterAbort.abort() },
      { expected: 'sessionEnded', isCurrent: () => true, run: ({ sessionAbort }) => sessionAbort.abort() },
      {
        expected: 'generationRetired',
        isCurrent: () => true,
        run: ({ retire, answer }) => {
          retire();
          answer();
        },
      },
    ];

    for (const [index, testCase] of lifecycle.entries()) {
      vi.useFakeTimers();
      try {
        const requesterAbort = new AbortController();
        const sessionAbort = new AbortController();
        let current = true;
        let presented!: InteractionTransientRequestV1;
        let answerPresenter!: (result: InteractionTransientResultV1) => void;
        const owner = createCurrentSessionInteractionOwner({
          sessionId: 'session-1',
          sessionSignal: sessionAbort.signal,
          isGenerationCurrent: () => current && testCase.isCurrent(),
          deadlineMs: CURRENT_SESSION_INTERACTION_DEADLINE_MS,
          createRequestId: () => `request-no-deadline-${index}`,
          present: async (request) => {
            presented = request;
            return await new Promise<InteractionTransientResultV1>((resolve) => {
              answerPresenter = resolve;
            });
          },
        });

        const pending = owner.request({
          kind: 'confirmation',
          message: 'Continue?',
        }, { requester, signal: requesterAbort.signal });
        await vi.advanceTimersByTimeAsync(0);
        expect(owner.current()).toHaveLength(1);
        expect(presented).not.toHaveProperty('expiresAtMs');
        expect(vi.getTimerCount()).toBe(0);

        await vi.advanceTimersByTimeAsync(MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS);
        expect(owner.current()).toHaveLength(1);

        testCase.run({
          requesterAbort,
          sessionAbort,
          answer: () => answerPresenter({
            requestId: `request-no-deadline-${index}`,
            kind: 'confirmation',
            status: 'userCancelled',
          }),
          retire: () => { current = false; },
        });
        await expect(pending).resolves.toMatchObject({
          requestId: `request-no-deadline-${index}`,
          status: testCase.expected,
        });
        expect(owner.current()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('rejects timer values Node cannot represent without choosing a fallback deadline', () => {
    const create = (deadlineMs: number) => () => createCurrentSessionInteractionOwner({
      sessionId: 'session-1',
      sessionSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      deadlineMs,
      present: async (request) => approvalResult(request),
    });

    expect(create(MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS)).not.toThrow();
    for (const deadlineMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TRANSIENT_INTERACTION_TIMER_DELAY_MS + 1,
    ]) {
      expect(create(deadlineMs)).toThrow(/deadline/i);
    }
  });
});
