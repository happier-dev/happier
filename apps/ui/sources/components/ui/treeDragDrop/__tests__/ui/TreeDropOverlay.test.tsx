import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { TreeDropOverlay } from '../../ui/TreeDropOverlay';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    TREE_DROP_OVERLAY_KIND_NONE,
    TREE_DROP_OVERLAY_KIND_OUTLINE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
} from '../../ui/treeDropOverlayTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function sharedValue<T>(value: T): { value: T } {
    return { value };
}

function buildSharedValues(overrides?: {
    visible?: number;
    kind?: TreeDropOverlayKind;
    top?: number;
    height?: number;
    left?: number;
    right?: number;
    depth?: number;
}): TreeDropOverlaySharedValues {
    return {
        overlayVisible: sharedValue(overrides?.visible ?? 1),
        overlayKind: sharedValue<TreeDropOverlayKind>(overrides?.kind ?? TREE_DROP_OVERLAY_KIND_LINE),
        overlayTop: sharedValue(overrides?.top ?? 120),
        overlayHeight: sharedValue(overrides?.height ?? 2),
        overlayLeft: sharedValue(overrides?.left ?? 16),
        overlayRight: sharedValue(overrides?.right ?? 336),
        overlayDepth: sharedValue(overrides?.depth ?? 0),
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readScale(style: Record<string, unknown>): number {
    const transform = style.transform;
    if (!Array.isArray(transform)) return 1;
    const scaleEntry = transform.find((entry) => entry && typeof entry === 'object' && 'scale' in entry);
    return scaleEntry ? Number((scaleEntry as { scale: number }).scale) : 1;
}

describe('TreeDropOverlay', () => {
    it('uses a Reanimated-compatible easing when animating geometry', async () => {
        await expect(renderScreen(
            <TreeDropOverlay shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE })} indentPx={8} />,
        )).resolves.toBeTruthy();
    });

    it('renders a non-interactive viewport-level container with a high z-index', async () => {
        expect(TreeDropOverlay).toEqual(expect.any(Function));

        const screen = await renderScreen(
            <TreeDropOverlay shared={buildSharedValues()} indentPx={8} testID="tree-drop-overlay" />,
        );

        const root = screen.findByTestId('tree-drop-overlay');
        expect(root).toBeTruthy();
        expect(root?.props.pointerEvents).toBe('none');
        const style = flattenStyle(root?.props.style);
        expect(style.position).toBe('absolute');
        expect(Number(style.zIndex)).toBeGreaterThan(0);
    });

    it('positions the indicator line from the overlay shared values', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, top: 140, height: 2, left: 16, right: 320, depth: 0 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const lineContainer = screen.findByTestId('tree-drop-overlay-line');
        const style = flattenStyle(lineContainer?.props.style);
        expect(style.top).toBe(140);
        expect(style.height).toBe(2);
        expect(style.left).toBe(16);
        // width spans from the indented left to the right edge: 320 - 16 - (depth 0 * 8) = 304.
        expect(style.width).toBe(304);
    });

    it('indents the line by the resolved tree depth', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, left: 16, right: 320, depth: 3 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const lineContainer = screen.findByTestId('tree-drop-overlay-line');
        const style = flattenStyle(lineContainer?.props.style);
        // left shifts by depth * indentPx = 3 * 8 = 24 -> 16 + 24 = 40.
        expect(style.left).toBe(40);
        // width shrinks by the same indent: 320 - 16 - 24 = 280.
        expect(style.width).toBe(280);
    });

    it('shows the line container and hides the outline container for a line visual', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, visible: 1 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const lineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-line')?.props.style);
        const outlineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-outline')?.props.style);
        expect(lineStyle.opacity).toBe(1);
        expect(outlineStyle.opacity).toBe(0);
    });

    it('shows the outline container and hides the line container for an outline visual', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_OUTLINE, visible: 1, top: 200, height: 56, left: 16, right: 320 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const lineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-line')?.props.style);
        const outlineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-outline')?.props.style);
        expect(outlineStyle.opacity).toBe(1);
        expect(lineStyle.opacity).toBe(0);
        // The outline frames the whole target (no depth indent applied).
        expect(outlineStyle.top).toBe(200);
        expect(outlineStyle.height).toBe(56);
        expect(outlineStyle.left).toBe(16);
        expect(outlineStyle.width).toBe(304);
    });

    it('hides both indicators when the overlay is not visible', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ visible: 0, kind: TREE_DROP_OVERLAY_KIND_NONE })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const lineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-line')?.props.style);
        const outlineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-outline')?.props.style);
        expect(lineStyle.opacity).toBe(0);
        expect(outlineStyle.opacity).toBe(0);
    });

    it('flashes the outline with a scale pop when a nest target appears', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_OUTLINE, visible: 1, top: 200 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const outlineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-outline')?.props.style);
        // The appear-flash pushes the outline scale past 1 to read as landing.
        expect(readScale(outlineStyle)).toBeGreaterThan(1);
    });

    it('does not flash the outline when the visual is a reorder line', async () => {
        const screen = await renderScreen(
            <TreeDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, visible: 1, top: 140 })}
                indentPx={8}
                testID="tree-drop-overlay"
            />,
        );

        const outlineStyle = flattenStyle(screen.findByTestId('tree-drop-overlay-outline')?.props.style);
        expect(readScale(outlineStyle)).toBe(1);
    });
});
