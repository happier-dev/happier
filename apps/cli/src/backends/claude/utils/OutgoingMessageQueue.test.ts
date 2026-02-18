import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutgoingMessageQueue } from './OutgoingMessageQueue';

describe('OutgoingMessageQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes optional meta through to the send function', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new OutgoingMessageQueue((message: any, meta?: Record<string, unknown>) => send(message, meta));

    queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'x' } }, { meta: { importedFrom: 'test' } });

    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'assistant' }),
      expect.objectContaining({ importedFrom: 'test' }),
    );
  });

  it('does not send messages behind an unreleased delayed head item (head-of-line blocking)', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new OutgoingMessageQueue((message: any) => send(message));

    queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'first' } }, { delay: 250 });
    queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'second' } });

    // Let the 0ms process timer run; it should stop at the unreleased head item.
    await vi.runOnlyPendingTimersAsync();
    expect(send).toHaveBeenCalledTimes(0);

    // After delay elapses, the head item releases and both items flush in order.
    await vi.advanceTimersByTimeAsync(250);
    await vi.runOnlyPendingTimersAsync();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]?.message?.content).toBe('first');
    expect(send.mock.calls[1]?.[0]?.message?.content).toBe('second');
  });

  it('can release delayed messages early by toolCallId', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const queue = new OutgoingMessageQueue((message: any) => send(message));

    queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'delayed' } }, { delay: 10_000, toolCallIds: ['t1'] });
    queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'after' } });

    await vi.runOnlyPendingTimersAsync();
    expect(send).toHaveBeenCalledTimes(0);

    await queue.releaseToolCall('t1');
    await vi.runOnlyPendingTimersAsync();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]?.message?.content).toBe('delayed');
    expect(send.mock.calls[1]?.[0]?.message?.content).toBe('after');
  });

  it('does not surface send errors as unhandled promise rejections', async () => {
    vi.useFakeTimers();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const send = vi.fn<(message: any) => void>(() => {
        throw new Error('boom');
      });
      const queue = new OutgoingMessageQueue((message: any) => send(message));

      queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'first' } });
      queue.enqueue({ type: 'assistant', message: { role: 'assistant', content: 'second' } });

      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
