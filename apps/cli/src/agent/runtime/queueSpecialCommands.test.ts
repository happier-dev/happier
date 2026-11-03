import { describe, expect, it } from 'vitest';

import { MessageQueue2 } from './modeMessageQueue';
import { createManualCompactionQueue, pushMessageToQueueWithSpecialCommands } from './queueSpecialCommands';

describe('pushMessageToQueueWithSpecialCommands', () => {
  it('keeps compact and its instructions separate from neighboring input', async () => {
    const queue = new MessageQueue2<string>((mode) => mode);
    queue.push('before', 'default');
    pushMessageToQueueWithSpecialCommands({ queue, message: '/compact retain the decision', text: '/compact retain the decision', mode: 'default' });
    queue.push('after', 'default');
    const messages: string[] = [];
    while (queue.size()) messages.push((await queue.waitForMessagesAndGetAsString())!.message);
    expect(messages).toEqual(['before', '/compact retain the decision', 'after']);
  });
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

describe('manual compaction admission', () => {
  it('dedupes queued and running work and permits retry after terminal settlement or queue removal', async () => {
    const queue = new MessageQueue2<string>((mode) => mode);
    const control = createManualCompactionQueue({ queue, readText: (text: string) => text, isAvailable: () => true });
    expect(control.enqueue('/compact notes', 'default')).toEqual({ status: 'admitted' });
    expect(control.enqueue('/compact other notes', 'default')).toEqual({ status: 'already_pending' });
    await queue.waitForMessagesAndGetAsString();
    control.setRunning(true);
    expect(control.enqueue('/compact', 'default')).toEqual({ status: 'already_pending' });
    control.setRunning(false);
    expect(control.enqueue('/compact', 'default')).toEqual({ status: 'admitted' });
    queue.discardMatching(() => true);
    expect(control.enqueue('/compact retry', 'default')).toEqual({ status: 'admitted' });
    expect(queue.size()).toBe(1);
  });

  it('does not queue unavailable manual control', () => {
    const queue = new MessageQueue2<string>((mode) => mode);
    const control = createManualCompactionQueue({ queue, readText: (text: string) => text, isAvailable: () => false });
    expect(control.enqueue('/compact', 'default')).toEqual({ status: 'unsupported' });
    expect(queue.size()).toBe(0);
  });
});
