import { describe, expect, it } from 'vitest';

import {
    resolveSessionViewAvailableWidth,
    resolveSessionViewContentBottomSpacing,
    SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
    SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX,
    SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX,
} from './resolveSessionViewContentBottomSpacing';

describe('resolveSessionViewAvailableWidth', () => {
    it('uses measured main content width before the fallback window width', () => {
        expect(resolveSessionViewAvailableWidth({
            measuredContentWidthPx: 752,
            windowWidthPx: 1100,
        })).toBe(752);
    });

    it('falls back to window width until the main content width is measured', () => {
        expect(resolveSessionViewAvailableWidth({
            measuredContentWidthPx: null,
            windowWidthPx: 1100,
        })).toBe(1100);
    });
});

describe('resolveSessionViewContentBottomSpacing', () => {
    it('removes session bottom spacing when requested by embedded chrome', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'none',
            safeAreaBottomPx: 11,
            availableWidthPx: 900,
            contentMaxWidthPx: 720,
        })).toBe(0);
    });

    it('keeps default bottom spacing when content is visibly inset inside the main pane', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 900,
            contentMaxWidthPx: 720,
        })).toBe(11 + SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX);
    });

    it('uses reduced bottom spacing when content fills the main pane width', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
        })).toBe(11 + SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX);
    });

    it('does not introduce extra bottom spacing when the current platform has no content gap', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
            defaultContentBottomGapPx: 0,
        })).toBe(11);
    });

    it('accounts for AgentInput outer padding so compact visual bottom spacing is exact', () => {
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        })).toBe(11 + SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX - SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX);
    });
});
