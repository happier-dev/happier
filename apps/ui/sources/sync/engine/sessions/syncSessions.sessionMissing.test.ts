import { describe, expect, it, vi } from 'vitest';
import {
    fetchAndApplyMessages,
    fetchAndApplyNewerMessages,
    fetchAndApplyOlderMessages,
} from './syncSessions';

describe('syncSessions missing-session guard', () => {
    it('treats initial fetch as no-op when session is not known on active server', async () => {
        const request = vi.fn(async () => {
            throw new Error('request should not run');
        });
        const applyMessages = vi.fn();
        const markMessagesLoaded = vi.fn();

        await expect(
            fetchAndApplyMessages({
                sessionId: 'missing-session',
                getSessionEncryption: () => null,
                isSessionKnown: () => false,
                request,
                sessionReceivedMessages: new Map(),
                applyMessages,
                markMessagesLoaded,
                log: { log: () => {} },
            } as any),
        ).resolves.toBeUndefined();

        expect(request).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
        expect(markMessagesLoaded).not.toHaveBeenCalled();
    });

    it('treats incremental fetch as no-op when session is not known on active server', async () => {
        const request = vi.fn(async () => {
            throw new Error('request should not run');
        });
        const applyMessages = vi.fn();

        await expect(
            fetchAndApplyNewerMessages({
                sessionId: 'missing-session',
                afterSeq: 5,
                limit: 150,
                getSessionEncryption: () => null,
                isSessionKnown: () => false,
                request,
                sessionReceivedMessages: new Map(),
                applyMessages,
                log: { log: () => {} },
            } as any),
        ).resolves.toEqual({
            applied: 0,
            page: {
                messages: [],
                nextAfterSeq: null,
            },
        });

        expect(request).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('treats older-page fetch as no-op when session is not known on active server', async () => {
        const request = vi.fn(async () => {
            throw new Error('request should not run');
        });
        const applyMessages = vi.fn();

        await expect(
            fetchAndApplyOlderMessages({
                sessionId: 'missing-session',
                beforeSeq: 5,
                limit: 150,
                getSessionEncryption: () => null,
                isSessionKnown: () => false,
                request,
                sessionReceivedMessages: new Map(),
                applyMessages,
                log: { log: () => {} },
            } as any),
        ).resolves.toEqual({
            applied: 0,
            page: {
                messages: [],
                nextBeforeSeq: null,
                hasMore: false,
            },
        });

        expect(request).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });
});
