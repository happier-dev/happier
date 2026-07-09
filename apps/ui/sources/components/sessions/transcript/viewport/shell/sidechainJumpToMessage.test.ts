import { describe, expect, it, vi } from 'vitest';

import {
    applySidechainJumpToMessage,
    applySidechainJumpToMessageRequest,
    resolveSidechainJumpToMessageTarget,
    SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS,
} from './sidechainJumpToMessage';

type Item = Readonly<{
    contains: readonly string[];
    id: string;
    owns: readonly string[];
}>;

const items: readonly Item[] = [
    { id: 'contained-first', owns: [], contains: ['message-1'] },
    { id: 'owner-second', owns: ['message-1'], contains: [] },
    { id: 'contained-third', owns: [], contains: ['hidden-tool'] },
];

describe('sidechain jump to message', () => {
    it('resolves loaded targets by owner first and containment second', () => {
        expect(resolveSidechainJumpToMessageTarget({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            items,
            messageId: 'message-1',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
        })).toEqual({
            ok: true,
            match: 'owner',
            targetIndex: 1,
            targetItem: items[1],
        });

        expect(resolveSidechainJumpToMessageTarget({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            items,
            messageId: 'hidden-tool',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
        })).toEqual({
            ok: true,
            match: 'contained',
            targetIndex: 2,
            targetItem: items[2],
        });

        expect(resolveSidechainJumpToMessageTarget({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            items,
            messageId: 'missing',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
        })).toEqual({ ok: false });
    });

    it('centers the loaded target and does not scroll into footer chrome', () => {
        const scrollToIndex = vi.fn(() => Promise.resolve());
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };

        expect(applySidechainJumpToMessage({
            estimatedItemSizePx: 88,
            listRef,
            targetIndex: 3,
        })).toBe(true);

        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: true,
            index: 3,
            viewPosition: 0.5,
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('falls back to the estimated animated offset when scrollToIndex rejects', async () => {
        const scrollToIndex = vi.fn(() => Promise.reject(new Error('missing layout')));
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };

        applySidechainJumpToMessage({
            estimatedItemSizePx: 88,
            listRef,
            targetIndex: 3,
        });
        await Promise.resolve();

        expect(scrollToOffset).toHaveBeenCalledWith({ animated: true, offset: 264 });
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('swallows synchronous scroll failures as best-effort', () => {
        const scrollToIndex = vi.fn(() => {
            throw new Error('not ready');
        });
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };

        expect(applySidechainJumpToMessage({
            estimatedItemSizePx: 88,
            listRef,
            targetIndex: 3,
        })).toBe(false);
        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('materializes older pages until the requested message is found', async () => {
        const scrollToIndex = vi.fn();
        const currentItems: Item[] = [
            { id: 'current', owns: ['current'], contains: [] },
        ];
        const events: string[] = [];

        await expect(applySidechainJumpToMessageRequest({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => currentItems,
            listRef: { scrollToIndex },
            loadOlder: async () => {
                events.push('load');
                currentItems.unshift({ id: 'older-target', owns: ['target-message'], contains: [] });
                return { loaded: 1, hasMore: true, status: 'loaded' };
            },
            messageId: 'target-message',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
            yieldForRender: async () => {
                events.push('yield');
            },
        })).resolves.toMatchObject({
            loadedPages: 1,
            ok: true,
            targetIndex: 0,
            targetItem: currentItems[0],
        });

        expect(events).toEqual(['load', 'yield']);
        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: true,
            index: 0,
            viewPosition: 0.5,
        });
    });

    it('rechecks a final loaded page before reporting the requested message as missing', async () => {
        const scrollToIndex = vi.fn();
        const currentItems: Item[] = [
            { id: 'current', owns: ['current'], contains: [] },
        ];
        const events: string[] = [];

        await expect(applySidechainJumpToMessageRequest({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => currentItems,
            listRef: { scrollToIndex },
            loadOlder: async () => {
                events.push('load-final');
                currentItems.unshift({ id: 'final-target', owns: ['target-message'], contains: [] });
                return { loaded: 1, hasMore: false, status: 'loaded' };
            },
            messageId: 'target-message',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
            yieldForRender: async () => {
                events.push('yield');
            },
        })).resolves.toMatchObject({
            loadedPages: 1,
            ok: true,
            targetIndex: 0,
            targetItem: currentItems[0],
        });

        expect(events).toEqual(['load-final', 'yield']);
        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: true,
            index: 0,
            viewPosition: 0.5,
        });
    });

    it('stops materializing when the load reports no more older pages', async () => {
        const loadOlder = vi.fn(async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const }));

        await expect(applySidechainJumpToMessageRequest({
            containsMessageId: (item: Item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => [],
            listRef: { scrollToIndex: vi.fn() },
            loadOlder,
            messageId: 'missing',
            ownsMessageId: (item: Item, messageId) => item.owns.includes(messageId),
            yieldForRender: vi.fn(),
        })).resolves.toEqual({
            loadedPages: 0,
            ok: false,
            reason: 'not_found',
        });
        expect(loadOlder).toHaveBeenCalledOnce();
    });

    it('caps jump-to-message materialization at the sidechain load bound', async () => {
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        await expect(applySidechainJumpToMessageRequest({
            containsMessageId: (item: Item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => [],
            listRef: { scrollToIndex: vi.fn() },
            loadOlder,
            messageId: 'missing',
            ownsMessageId: (item: Item, messageId) => item.owns.includes(messageId),
            yieldForRender: vi.fn(),
        })).resolves.toEqual({
            loadedPages: SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS,
            ok: false,
            reason: 'not_found',
        });
        expect(loadOlder).toHaveBeenCalledTimes(SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS);
    });

    it('rechecks the final loaded page when the allowed load cap is reached', async () => {
        const scrollToIndex = vi.fn();
        const currentItems: Item[] = [];
        let loadCount = 0;

        const result = await applySidechainJumpToMessageRequest({
            containsMessageId: (item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => currentItems,
            listRef: { scrollToIndex },
            loadOlder: async () => {
                loadCount += 1;
                if (loadCount === SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS) {
                    currentItems.push({ id: 'final-cap-target', owns: ['target-message'], contains: [] });
                    return { loaded: 1, hasMore: false, status: 'loaded' };
                }
                return { loaded: 1, hasMore: true, status: 'loaded' };
            },
            messageId: 'target-message',
            ownsMessageId: (item, messageId) => item.owns.includes(messageId),
            yieldForRender: vi.fn(async () => {}),
        });

        expect(result).toMatchObject({
            loadedPages: SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS,
            ok: true,
            targetIndex: 0,
        });
        expect(result.ok ? result.targetItem : null).toBe(currentItems[0]);

        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: true,
            index: 0,
            viewPosition: 0.5,
        });
    });

    it('stops without scrolling when aborted during materialization', async () => {
        const scrollToIndex = vi.fn();
        const signal = { aborted: false };

        await expect(applySidechainJumpToMessageRequest({
            containsMessageId: (item: Item, messageId) => item.contains.includes(messageId),
            estimatedItemSizePx: 88,
            getItems: () => [],
            listRef: { scrollToIndex },
            loadOlder: async () => {
                signal.aborted = true;
                return { loaded: 1, hasMore: true, status: 'loaded' };
            },
            messageId: 'missing',
            ownsMessageId: (item: Item, messageId) => item.owns.includes(messageId),
            signal,
            yieldForRender: vi.fn(),
        })).resolves.toEqual({
            loadedPages: 0,
            ok: false,
            reason: 'aborted',
        });
        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
