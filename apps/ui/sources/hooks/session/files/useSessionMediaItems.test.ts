import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

type Page = Readonly<{ mediaCount: number; hasMore: boolean; status?: string }>;

const state = vi.hoisted(() => ({
    messages: [] as unknown[],
    pages: [] as Array<Readonly<{ mediaCount: number; hasMore: boolean; status?: string }>>,
    nextSeq: 1,
    loadOlderMessages: vi.fn(),
}));

function mediaMessage(seq: number) {
    const path = `.happier/uploads/generated/m${seq}/img.png`;
    return {
        kind: 'agent-text', id: `m${seq}`, seq, localId: null, createdAt: seq * 1000, text: '',
        meta: {
            happier: {
                kind: 'session_media.v1',
                payload: {
                    media: [{
                        id: `media-${seq}`, role: 'output', category: 'generated', mediaKind: 'image',
                        name: 'img.png', path, mimeType: 'image/png', sizeBytes: 10,
                        origin: { source: 'provider-generated' },
                    }],
                },
            },
        },
    };
}

// Genuine boundaries: the sync engine's paging RPC and the transcript store subscription.
vi.mock('@/sync/sync', () => ({
    sync: { loadOlderMessages: (...args: unknown[]) => state.loadOlderMessages(...args) },
}));
vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: state.messages, isLoaded: true }),
}));

describe('useSessionMediaItems', () => {
    beforeEach(() => {
        state.messages = [];
        state.pages = [];
        state.nextSeq = 1;
        state.loadOlderMessages.mockReset();
        state.loadOlderMessages.mockImplementation(async () => {
            const page: Page = state.pages.shift() ?? { mediaCount: 0, hasMore: false, status: 'no_more' };
            state.messages = [
                ...state.messages,
                ...Array.from({ length: page.mediaCount }, () => mediaMessage(state.nextSeq++)),
            ];
            return { loaded: page.mediaCount, hasMore: page.hasMore, status: page.status ?? 'loaded' };
        });
    });

    it('pages older history only until the requested number of media items is available', async () => {
        state.pages = [
            { mediaCount: 3, hasMore: true },
            { mediaCount: 3, hasMore: true },
            { mediaCount: 3, hasMore: true },
            { mediaCount: 3, hasMore: true },
        ];
        const { useSessionMediaItems } = await import('./useSessionMediaItems');
        const hook = await renderHook(() => useSessionMediaItems('s1', true, 8));

        expect(state.loadOlderMessages).toHaveBeenCalledTimes(3);
        expect(state.loadOlderMessages).toHaveBeenCalledWith('s1');
        expect(hook.getCurrent().items).toHaveLength(9);
        expect(hook.getCurrent().isLoadingHistory).toBe(false);
        expect(hook.getCurrent().historyExhausted).toBe(false);
    });

    it('pages the whole history when no limit is requested', async () => {
        state.pages = [
            { mediaCount: 3, hasMore: true },
            { mediaCount: 3, hasMore: true },
            { mediaCount: 1, hasMore: false },
        ];
        const { useSessionMediaItems } = await import('./useSessionMediaItems');
        const hook = await renderHook(() => useSessionMediaItems('s1', true, null));

        expect(state.loadOlderMessages).toHaveBeenCalledTimes(3);
        expect(hook.getCurrent().items).toHaveLength(7);
        expect(hook.getCurrent().historyExhausted).toBe(true);
    });

    it('does not touch the transcript paging while disabled', async () => {
        const { useSessionMediaItems } = await import('./useSessionMediaItems');
        await renderHook(() => useSessionMediaItems('s1', false, 8));

        expect(state.loadOlderMessages).not.toHaveBeenCalled();
    });
});
