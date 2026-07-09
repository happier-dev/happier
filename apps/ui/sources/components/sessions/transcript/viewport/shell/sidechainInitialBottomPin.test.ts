import { describe, expect, it, vi } from 'vitest';

import {
    applySidechainInitialBottomPin,
    applySidechainInitialBottomPinRequest,
    resolveSidechainInitialBottomPinPlan,
} from './sidechainInitialBottomPin';

describe('sidechainInitialBottomPin', () => {
    it.each([
        { name: 'jump target', overrides: { hasJumpTarget: true }, reason: 'jump-target' },
        { name: 'already applied', overrides: { alreadyApplied: true }, reason: 'already-applied' },
        { name: 'local interaction', overrides: { deferredForLocalInteraction: true }, reason: 'local-interaction' },
        { name: 'empty list', overrides: { itemCount: 0 }, reason: 'empty' },
        { name: 'missing layout', overrides: { layoutHeightPx: 0 }, reason: 'not-ready' },
        { name: 'missing content', overrides: { contentHeightPx: 0 }, reason: 'not-ready' },
    ] as const)('skips before issuing raw list commands for $name', ({ overrides, reason }) => {
        expect(resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            ...overrides,
        })).toEqual({ ok: false, reason });
    });

    it('targets the standard/web last rendered item', () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });

        expect(plan).toEqual({
            ok: true,
            targetIndex: 2,
        });

        const scrollToIndex = vi.fn();
        const scrollToOffset = vi.fn();
        const scrollToEnd = vi.fn();
        const listRef = { scrollToEnd, scrollToIndex, scrollToOffset };
        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef,
            plan,
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 2,
            viewPosition: 1,
        });
        expect(scrollToOffset).not.toHaveBeenCalled();
        expect(scrollToEnd).not.toHaveBeenCalled();
    });

    it('targets native inverted rendered index zero', () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'newest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });

        expect(plan).toEqual({
            ok: true,
            targetIndex: 0,
        });

        const scrollToIndex = vi.fn();
        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex },
            plan,
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            animated: false,
            index: 0,
            viewPosition: 1,
        });
    });

    it('falls back to the estimated target offset when scrollToIndex rejects', async () => {
        const plan = resolveSidechainInitialBottomPinPlan({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
        });
        const scrollToIndex = vi.fn(() => Promise.reject(new Error('missing layout')));
        const scrollToOffset = vi.fn();

        applySidechainInitialBottomPin({
            estimatedItemSizePx: 88,
            listRef: { scrollToIndex, scrollToOffset },
            plan,
        });
        await Promise.resolve();

        expect(scrollToOffset).toHaveBeenCalledWith({
            animated: false,
            offset: 176,
        });
    });

    it('marks the request applied before issuing the driver-owned command', () => {
        const events: string[] = [];

        expect(applySidechainInitialBottomPinRequest({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            listRef: {
                scrollToIndex: () => {
                    events.push('scrollToIndex');
                },
            },
            setAlreadyApplied: (applied) => {
                events.push(`applied:${applied}`);
            },
        })).toEqual({
            applied: true,
            ok: true,
            plan: {
                ok: true,
                targetIndex: 2,
            },
        });

        expect(events).toEqual(['applied:true', 'scrollToIndex']);
    });

    it('preserves already-applied-before-command behavior even when the ref is unavailable', () => {
        const setAlreadyApplied = vi.fn();

        expect(applySidechainInitialBottomPinRequest({
            alreadyApplied: false,
            contentHeightPx: 600,
            dataOrder: 'oldest-first',
            deferredForLocalInteraction: false,
            estimatedItemSizePx: 88,
            hasJumpTarget: false,
            itemCount: 3,
            layoutHeightPx: 300,
            listRef: null,
            setAlreadyApplied,
        })).toEqual({
            applied: false,
            ok: true,
            plan: {
                ok: true,
                targetIndex: 2,
            },
        });
        expect(setAlreadyApplied).toHaveBeenCalledWith(true);
    });
});
