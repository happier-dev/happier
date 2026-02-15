import { describe, expect, it, vi } from 'vitest';

import { OutgoingMessageQueue } from './OutgoingMessageQueue';

describe('OutgoingMessageQueue', () => {
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
});

