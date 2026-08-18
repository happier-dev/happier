import { beforeEach, describe, expect, it } from 'vitest';

import {
    forgetSessionViewContentWidthSurface,
    readSeededSessionViewContentWidth,
    rememberSessionViewContentWidth,
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

    it('collapses the bottom spacing while the software keyboard is open', () => {
        // The spacing is breathing room below the composer when the keyboard is down; with the
        // keyboard open it reads as a gap between the composer and the keyboard top (measured
        // on-device: tabs mode floated the composer 8 CSS px above the keyboard while cockpit
        // mode — chatBottomSpacing 'none' — sat flush). It must collapse like every other
        // bottom reservation while the keyboard is open.
        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 752,
            contentMaxWidthPx: 720,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
            softwareKeyboardOpen: true,
        })).toBe(0);

        expect(resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx: 11,
            availableWidthPx: 900,
            contentMaxWidthPx: 720,
            softwareKeyboardOpen: true,
        })).toBe(0);
    });

    it('drops the bottom spacing by exactly the AgentInput edge gap when a narrow pane stops using the window-width fallback', () => {
        // Narrow multi-pane (Tauri) surface: the window is wide (1200) but the pane content is narrow (752).
        // First frame (measured width not yet committed) falls back to the window width, which does NOT fill,
        // so the full default gap is used. After onLayout commits the narrow width, the content fills and the
        // compact (edge - outer) gap is used. The delta is the visible first-frame shift we must eliminate.
        const safeAreaBottomPx = 11;
        const contentMaxWidthPx = 720;
        const narrowPaneContentWidthPx = 752;
        const windowWidthPx = 1200;

        const firstFrameSpacing = resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx,
            availableWidthPx: resolveSessionViewAvailableWidth({
                measuredContentWidthPx: null,
                windowWidthPx,
            }),
            contentMaxWidthPx,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        });
        const settledSpacing = resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx,
            availableWidthPx: resolveSessionViewAvailableWidth({
                measuredContentWidthPx: narrowPaneContentWidthPx,
                windowWidthPx,
            }),
            contentMaxWidthPx,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        });

        expect(firstFrameSpacing).toBe(safeAreaBottomPx + SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX);
        expect(settledSpacing).toBe(
            safeAreaBottomPx + SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX - SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        );
        expect(firstFrameSpacing - settledSpacing).toBe(
            SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX
            - SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX
            + SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        );
    });
});

describe('session view content width seed cache', () => {
    const surfaceA = 'surface-a';
    const surfaceB = 'surface-b';

    beforeEach(() => {
        forgetSessionViewContentWidthSurface(surfaceA);
        forgetSessionViewContentWidthSurface(surfaceB);
    });

    it('returns null for a surface that has never measured its content width', () => {
        expect(readSeededSessionViewContentWidth({
            surfaceId: surfaceA,
            windowWidthPx: 1200,
        })).toBeNull();
    });

    it('keeps the measured width available on the next mount of the same surface (survives a session switch)', () => {
        rememberSessionViewContentWidth({
            surfaceId: surfaceA,
            measuredWidthPx: 752,
            windowWidthPx: 1200,
        });

        expect(readSeededSessionViewContentWidth({
            surfaceId: surfaceA,
            windowWidthPx: 1200,
        })).toBe(752);
    });

    it('invalidates the seeded width when the window width changes (real resize)', () => {
        rememberSessionViewContentWidth({
            surfaceId: surfaceA,
            measuredWidthPx: 752,
            windowWidthPx: 1200,
        });

        expect(readSeededSessionViewContentWidth({
            surfaceId: surfaceA,
            windowWidthPx: 980,
        })).toBeNull();
    });

    it('does not leak a measured width across distinct pane surfaces', () => {
        rememberSessionViewContentWidth({
            surfaceId: surfaceA,
            measuredWidthPx: 752,
            windowWidthPx: 1200,
        });

        expect(readSeededSessionViewContentWidth({
            surfaceId: surfaceB,
            windowWidthPx: 1200,
        })).toBeNull();
    });

    it('ignores non-finite or non-positive measured widths so a transient zero layout never seeds', () => {
        rememberSessionViewContentWidth({
            surfaceId: surfaceA,
            measuredWidthPx: 0,
            windowWidthPx: 1200,
        });

        expect(readSeededSessionViewContentWidth({
            surfaceId: surfaceA,
            windowWidthPx: 1200,
        })).toBeNull();
    });
});

describe('SessionView content width source across a session switch', () => {
    const paneSurfaceId = 'pane-surface-1';
    const windowWidthPx = 1200;
    const narrowPaneContentWidthPx = 752;
    const safeAreaBottomPx = 11;
    const contentMaxWidthPx = 720;

    // Mirrors the per-session remount: the inner `measuredContentWidth` state seeds from the
    // pane-keyed width source on mount, commits the measured width on `onLayout`, then a session
    // switch remounts that state. The width source must outlive the remount so the FIRST committed
    // value equals the settled value (no window-width fallback frame).
    function seedMeasuredContentWidthOnMount(): number | null {
        return readSeededSessionViewContentWidth({ surfaceId: paneSurfaceId, windowWidthPx });
    }
    function commitMeasuredContentWidth(measuredWidthPx: number): void {
        rememberSessionViewContentWidth({ surfaceId: paneSurfaceId, measuredWidthPx, windowWidthPx });
    }
    function resolveSpacingForMeasuredWidth(measuredContentWidthPx: number | null): number {
        return resolveSessionViewContentBottomSpacing({
            chatBottomSpacing: 'default',
            safeAreaBottomPx,
            availableWidthPx: resolveSessionViewAvailableWidth({ measuredContentWidthPx, windowWidthPx }),
            contentMaxWidthPx,
            inputOuterBottomPaddingPx: SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX,
        });
    }

    beforeEach(() => {
        forgetSessionViewContentWidthSurface(paneSurfaceId);
    });

    it('seeds the first frame after a switch with the previously measured width instead of resetting to null', () => {
        // First mount: nothing seeded yet, then onLayout commits the narrow width.
        expect(seedMeasuredContentWidthOnMount()).toBeNull();
        commitMeasuredContentWidth(narrowPaneContentWidthPx);

        // Session switch remounts the inner subtree; the seed must come from the pane-keyed source.
        const firstFrameAfterSwitch = seedMeasuredContentWidthOnMount();
        expect(firstFrameAfterSwitch).toBe(narrowPaneContentWidthPx);
    });

    it('keeps the resolved bottom spacing stable on the first frame after a switch (no 24px jump)', () => {
        seedMeasuredContentWidthOnMount();
        commitMeasuredContentWidth(narrowPaneContentWidthPx);
        const settledSpacing = resolveSpacingForMeasuredWidth(narrowPaneContentWidthPx);

        const firstFrameAfterSwitch = seedMeasuredContentWidthOnMount();
        const firstFrameSpacingAfterSwitch = resolveSpacingForMeasuredWidth(firstFrameAfterSwitch);

        expect(firstFrameSpacingAfterSwitch).toBe(settledSpacing);
    });
});
