import { describe, expect, it } from 'vitest';

import { MessageQueue2 } from './modeMessageQueue';
import { pushMessageToQueueWithSpecialCommands } from './queueSpecialCommands';

describe('pushMessageToQueueWithSpecialCommands', () => {
  it('clears earlier input and isolates the clear command from later input', async () => {
    const queue = new MessageQueue2<string>((mode) => mode);
    queue.push('discard me', 'default');

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: '/clear',
      text: '/clear',
      mode: 'default',
    });
    queue.push('keep me', 'default');

    await expect(queue.waitForMessagesAndGetAsString()).resolves.toMatchObject({ message: '/clear', mode: 'default' });
    await expect(queue.waitForMessagesAndGetAsString()).resolves.toMatchObject({ message: 'keep me', mode: 'default' });
    expect(queue.size()).toBe(0);
  });

  it.each([false, true])('preserves neighboring input for ordinary text with isolate=%s', async (isolate) => {
    const queue = new MessageQueue2<string>((mode) => mode);
    queue.push('before', 'default');

    pushMessageToQueueWithSpecialCommands({
      queue,
      message: 'hello',
      text: 'hello',
      mode: 'default',
      isolate,
    });
    queue.push('after', 'default');

    const messages: string[] = [];
    while (queue.size() > 0) {
      const batch = await queue.waitForMessagesAndGetAsString();
      expect(batch?.mode).toBe('default');
      if (batch) messages.push(batch.message);
    }
    expect(messages).toEqual(isolate ? ['before', 'hello', 'after'] : ['before\nhello\nafter']);
  });
});
