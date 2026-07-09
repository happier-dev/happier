import { describe, expect, it } from 'vitest';

import {
    createSidechainShellRuntimeModel,
    type SidechainShellRuntimeItem,
} from './sidechainShellRuntimeModel';

function item(id: string, heightPx = 100): SidechainShellRuntimeItem {
    return {
        heightPx,
        id,
    };
}

describe('sidechain shell runtime contract', () => {
    it('routes standard initial bottom-pin requests through the shell helper and skips the second request', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1'), item('m2'), item('m3')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });

        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'not_ready',
        });

        model.commitLayout();
        model.commitContent();

        expect(model.requestInitialBottomPin()).toEqual({
            method: 'scroll-to-index',
            ok: true,
            targetIndex: 2,
            targetItemId: 'm3',
            targetScrollTop: 50,
        });
        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'already_applied',
        });
    });

    it('routes native inverted initial bottom-pin requests to rendered index zero', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('oldest'), item('middle'), item('newest')],
            layoutHeightPx: 250,
            platformOS: 'ios',
        });

        model.commitLayout();
        model.commitContent();

        expect(model.requestInitialBottomPin()).toEqual({
            method: 'scroll-to-index',
            ok: true,
            targetIndex: 0,
            targetItemId: 'newest',
            targetScrollTop: 0,
        });
    });

    it('models shell fallback offset when the list cannot measure the initial target', () => {
        const model = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 88,
            footerHeightPx: 64,
            items: [item('m1'), item('m2'), item('m3')],
            layoutHeightPx: 250,
            platformOS: 'web',
        });

        model.commitLayout();
        model.commitContent();

        expect(model.requestInitialBottomPin({ simulateScrollToIndexFailure: true })).toEqual({
            method: 'estimated-offset-fallback',
            ok: true,
            targetIndex: 2,
            targetItemId: 'm3',
            targetScrollTop: 114,
        });
        expect(model.requestInitialBottomPin()).toEqual({
            ok: false,
            reason: 'already_applied',
        });
    });

    it('marks web local-height-change programmatic write echoes as non-genuine', () => {
        const preserve = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 12 }, (_value, index) => item(`message-${index}`, 100)),
            layoutHeightPx: 300,
            initialScrollTopPx: 240,
            platformOS: 'web',
        });

        expect(preserve.applyWebLocalHeightChange({ growthPx: 120, mode: 'preserve-position' })).toEqual({
            echoIsGenuineUserMovement: false,
            targetScrollTop: 360,
        });

        const follow = createSidechainShellRuntimeModel({
            estimatedItemSizePx: 80,
            footerHeightPx: 40,
            items: Array.from({ length: 12 }, (_value, index) => item(`message-${index}`, 100)),
            layoutHeightPx: 300,
            initialScrollTopPx: 940,
            platformOS: 'web',
        });

        expect(follow.applyWebLocalHeightChange({ growthPx: 120, mode: 'follow-bottom' })).toEqual({
            echoIsGenuineUserMovement: false,
            targetScrollTop: 1060,
        });
    });
});
