import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { Query } from './query';

describe('Claude SDK Query (onMessageReceived)', () => {
  it('fires onMessageReceived as soon as a message is read from stdout (even when the iterator is not consumed)', async () => {
    const stdout = new PassThrough();

    const q = new Query(
      null,
      stdout,
      Promise.resolve(),
      undefined,
    ) as any;

    const onMessageReceived = vi.fn();
    q.onMessageReceived = onMessageReceived;

    stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      })}\n`,
    );

    // Allow the readline loop to process the line.
    await Promise.resolve();
    await Promise.resolve();

    expect(onMessageReceived).toHaveBeenCalledTimes(1);
    expect(onMessageReceived.mock.calls[0]?.[0]).toMatchObject({ type: 'assistant' });

    stdout.end();
  });
});

