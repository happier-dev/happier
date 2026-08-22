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
    }, { timeoutMs: null });
  });

  it('reports a missing parent thread as a failure before any fork dispatch', async () => {
    const request = vi.fn();

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: '  ',
    })).rejects.toMatchObject({
      name: 'CodexAppServerNativeForkFailure',
      outcome: 'failed_before_dispatch',
    });

    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to conversation/fork only when thread/fork is definitively unsupported', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/fork') {
        throw Object.assign(new Error('Method not found'), {
          name: 'JsonRpcApplicationError',
          code: -32601,
          method,
        });
      }
      return { thread_id: 'forked-thread' };
    });

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
    })).resolves.toEqual({ providerSessionId: 'forked-thread' });

    expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    }, { timeoutMs: null });
    expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    }, { timeoutMs: null });
  });

  it('treats a malformed successful response as an indeterminate outcome without aliasing', async () => {
    const request = vi.fn(async () => ({ ok: true }));

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
    })).rejects.toMatchObject({
      name: 'CodexAppServerNativeForkFailure',
      outcome: 'indeterminate_after_dispatch',
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('thread/fork', {
      threadId: 'parent-thread',
      persistExtendedHistory: true,
    }, { timeoutMs: null });
  });

  it('treats a transport failure as indeterminate instead of replaying through the alias', async () => {
    const request = vi.fn(async () => {
      throw new Error('transport interrupted after dispatch');
    });

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
    })).rejects.toMatchObject({
      name: 'CodexAppServerNativeForkFailure',
      outcome: 'indeterminate_after_dispatch',
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not alias a method-not-found error correlated to another request', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('Method not found'), {
        name: 'JsonRpcApplicationError',
        code: -32601,
        method: 'conversation/fork',
      });
    });

    await expect(forkCodexNativeAppServerConversation({
      client: { request },
      parentCodexSessionId: 'parent-thread',
    })).rejects.toMatchObject({
      name: 'CodexAppServerNativeForkFailure',
      outcome: 'indeterminate_after_dispatch',
    });

    expect(request).toHaveBeenCalledTimes(1);
  });
});
