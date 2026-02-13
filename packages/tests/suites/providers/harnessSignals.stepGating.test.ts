import { describe, expect, test } from 'vitest';

import {
  countTaskCompleteMessages,
  countTaskCompleteTraceEvents,
  resolveTaskCompleteBaselineAtStepStart,
  shouldEnqueueNextStepAfterSatisfaction,
} from '../../src/testkit/providers/harness/harnessSignals';

describe('provider harness step gating', () => {
  test('counts ACP task_complete messages', () => {
    expect(countTaskCompleteMessages([])).toBe(0);
    expect(
      countTaskCompleteMessages([
        { role: 'user', content: { type: 'text', text: 'Then reply DONE.' } },
        { type: 'task_complete', id: 'a' },
        { role: 'assistant', content: { type: 'text', text: 'DONE' } },
        { type: 'task_complete', id: 'b' },
      ]),
    ).toBe(2);
  });

  test('counts ACP task_complete trace events', () => {
    expect(countTaskCompleteTraceEvents([])).toBe(0);
    expect(
      countTaskCompleteTraceEvents([
        { kind: 'tool-call' },
        { kind: 'task_complete' },
        { kind: 'task_complete' },
      ]),
    ).toBe(2);
  });

  test('requires task_complete before enqueuing next step by default (ACP)', () => {
    const decodedMessagesSeen: unknown[] = [{ role: 'user', content: { type: 'text', text: 'step1 prompt' } }];

    expect(
      shouldEnqueueNextStepAfterSatisfaction({
        providerProtocol: 'acp',
        traceEvents: [],
        decodedMessagesSeen,
        taskCompleteCountAtStepSatisfaction: null,
      }),
    ).toBe(false);

    expect(
      shouldEnqueueNextStepAfterSatisfaction({
        providerProtocol: 'acp',
        traceEvents: [],
        decodedMessagesSeen: [...decodedMessagesSeen, { type: 'task_complete', id: 'x' }],
        taskCompleteCountAtStepSatisfaction: 0,
      }),
    ).toBe(true);
  });

  test('accepts task_complete trace events when session messages omit task_complete', () => {
    expect(
      shouldEnqueueNextStepAfterSatisfaction({
        providerProtocol: 'acp',
        traceEvents: [{ kind: 'task_complete' }],
        decodedMessagesSeen: [],
        taskCompleteCountAtStepSatisfaction: 0,
      }),
    ).toBe(true);
  });

  test('captures ACP task_complete baseline at step enqueue', () => {
    expect(
      resolveTaskCompleteBaselineAtStepStart({
        providerProtocol: 'acp',
        traceEvents: [{ kind: 'task_complete' }, { kind: 'tool-call' }],
        decodedMessagesSeen: [{ type: 'task_complete', id: 'm1' }],
      }),
    ).toBe(1);

    expect(
      resolveTaskCompleteBaselineAtStepStart({
        providerProtocol: 'acp',
        allowInFlightSteer: true,
        traceEvents: [{ kind: 'task_complete' }],
        decodedMessagesSeen: [{ type: 'task_complete', id: 'm1' }],
      }),
    ).toBeNull();

    expect(
      resolveTaskCompleteBaselineAtStepStart({
        providerProtocol: 'codex',
        traceEvents: [{ kind: 'task_complete' }],
        decodedMessagesSeen: [{ type: 'task_complete', id: 'm1' }],
      }),
    ).toBeNull();
  });

  test('allows in-flight step enqueue when explicitly enabled', () => {
    expect(
      shouldEnqueueNextStepAfterSatisfaction({
        providerProtocol: 'acp',
        allowInFlightSteer: true,
        traceEvents: [],
        decodedMessagesSeen: [],
        taskCompleteCountAtStepSatisfaction: null,
      }),
    ).toBe(true);
  });

  test('does not gate non-ACP providers on task_complete', () => {
    expect(
      shouldEnqueueNextStepAfterSatisfaction({
        providerProtocol: 'codex',
        traceEvents: [],
        decodedMessagesSeen: [],
        taskCompleteCountAtStepSatisfaction: null,
      }),
    ).toBe(true);
  });
});
