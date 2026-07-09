import { describe, expect, it, vi } from 'vitest';

import { performSidechainIndexCommand } from './sidechainListCommands';

describe('performSidechainIndexCommand', () => {
    it('writes the target index through the sidechain list driver', () => {
        const scrollToIndex = vi.fn(() => Promise.resolve());
        const scrollToOffset = vi.fn();

        expect(performSidechainIndexCommand({
            animated: true,
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex, scrollToOffset },
            targetIndex: 3,
            viewPosition: 0.5,
        })).toBe(true);

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 3,
            animated: true,
            viewPosition: 0.5,
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
    });

    it('falls back to the estimated offset when index materialization rejects', async () => {
        const scrollToIndex = vi.fn(() => Promise.reject(new Error('missing layout')));
        const scrollToOffset = vi.fn();

        expect(performSidechainIndexCommand({
            animated: false,
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex, scrollToOffset },
            targetIndex: 2,
            viewPosition: 1,
        })).toBe(true);
        await Promise.resolve();

        expect(scrollToOffset).toHaveBeenCalledWith({
            offset: 176,
            animated: false,
        });
    });

    it('returns false when the target or list writer is unavailable', () => {
        expect(performSidechainIndexCommand({
            animated: true,
            estimatedItemSizePx: 88,
            listRef: null,
            targetIndex: 0,
            viewPosition: 0.5,
        })).toBe(false);
        expect(performSidechainIndexCommand({
            animated: true,
            estimatedItemSizePx: 88,
            listRef: { scrollToOffset: vi.fn() },
            targetIndex: 0,
            viewPosition: 0.5,
        })).toBe(false);
        expect(performSidechainIndexCommand({
            animated: true,
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex: vi.fn() },
            targetIndex: -1,
            viewPosition: 0.5,
        })).toBe(false);
    });

    it('swallows synchronous write failures as best-effort', () => {
        const scrollToIndex = vi.fn(() => {
            throw new Error('not ready');
        });
        const scrollToOffset = vi.fn();

        expect(performSidechainIndexCommand({
            animated: true,
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex, scrollToOffset },
            targetIndex: 3,
            viewPosition: 0.5,
        })).toBe(false);
        expect(scrollToOffset).not.toHaveBeenCalled();
    });
});
