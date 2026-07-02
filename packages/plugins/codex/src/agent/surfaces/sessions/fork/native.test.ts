import { describe, expect, it, vi } from 'vitest';

import { forkCodexNativeAppServerConversation } from './native.js';

describe('forkCodexNativeAppServerConversation', () => {
  it('prefers thread/fork and reads nested thread ids from the response payload', async () => {
    const request = vi.fn(async () => ({ thread: { id: ' forked-thread ' } }));

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: ' parent-thread ',
    })).resolves.toEqual({ providerSessionId: 'forked-thread' });

    expect(request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    });
  });

  it('falls back to conversation/fork when thread/fork fails', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/fork') throw new Error('unsupported');
      return { thread_id: 'forked-thread' };
    });

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
    })).resolves.toEqual({ providerSessionId: 'forked-thread' });

    expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    });
  });

  it('returns null when neither native fork method yields a thread id', async () => {
    const events: string[] = [];
    const request = vi.fn(async () => ({ ok: true }));

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
      onEvent: (event) => {
        events.push(event.type);
      },
    })).resolves.toBeNull();

    expect(events).toEqual([
      'methodAttempt',
      'methodReturnedNoThreadId',
      'methodAttempt',
      'methodReturnedNoThreadId',
      'methodsExhausted',
    ]);
  });
});
