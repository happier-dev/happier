import { describe, expect, it, vi } from 'vitest';

import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import { forkCodexAppServerConversationNative } from './nativeFork';

function createClientDouble(requestImpl: DisposableCodexAppServerClient['request']): DisposableCodexAppServerClient {
    return {
        request: requestImpl,
        notify: vi.fn(async () => {}),
        registerRequestHandler: vi.fn(() => () => {}),
        registerNotificationHandler: vi.fn(() => () => {}),
        dispose: vi.fn(async () => {}),
    };
}

describe('forkCodexAppServerConversationNative', () => {
    it('returns null without creating a client when the parent session id is blank', async () => {
        const createClient = vi.fn(async () => createClientDouble(vi.fn()));

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: '   ',
            }, { createClient }),
        ).resolves.toBeNull();

        expect(createClient).not.toHaveBeenCalled();
    });

    it('prefers thread/fork and reads nested thread ids from the response payload', async () => {
        const request = vi.fn(async () => ({ thread: { id: ' forked-thread ' } }));
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: ' parent-thread ',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'forked-thread' });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('falls back to conversation/fork when thread/fork fails', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockRejectedValueOnce(new Error('method not found'))
            .mockResolvedValueOnce({ id: 'compat-thread' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'compat-thread' });

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });

    it('falls back to conversation/fork when thread/fork returns no usable thread id', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockResolvedValueOnce({ threadId: '   ' })
            .mockResolvedValueOnce({ thread: { threadId: 'compat-thread' } });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toEqual({ vendorSessionId: 'compat-thread' });

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
    });

    it('returns null when neither fork method yields a usable thread id', async () => {
        const request = vi.fn<DisposableCodexAppServerClient['request']>()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ threadId: '' });
        const client = createClientDouble(request);

        await expect(
            forkCodexAppServerConversationNative({
                directory: '/repo',
                parentCodexSessionId: 'parent-thread',
            }, {
                createClient: async () => client,
            }),
        ).resolves.toBeNull();

        expect(request).toHaveBeenNthCalledWith(1, 'thread/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(request).toHaveBeenNthCalledWith(2, 'conversation/fork', { threadId: 'parent-thread', persistExtendedHistory: true });
        expect(client.dispose).toHaveBeenCalledTimes(1);
    });
});
