import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    TREE_DROP_OVERLAY_KIND_LINE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';

import { SessionListDropOverlay, SESSION_LIST_DROP_OVERLAY_INDENT_PX } from './SessionListDropOverlay';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function sharedValue<T>(value: T): { value: T } {
    return { value };
}

function buildSharedValues(overrides?: Partial<{
    visible: number;
    kind: TreeDropOverlayKind;
    top: number;
    height: number;
    left: number;
    right: number;
    depth: number;
}>): TreeDropOverlaySharedValues {
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

describe('SessionListDropOverlay', () => {
    it('exposes a session indent constant migrated from the deleted row indicator', () => {
        expect(SESSION_LIST_DROP_OVERLAY_INDENT_PX).toBe(6);
    });

    it('renders ONE non-interactive viewport-level overlay driven by shared values', async () => {
        const screen = await renderScreen(
            <SessionListDropOverlay shared={buildSharedValues()} testID="session-list-drop-overlay" />,
        );

        const root = screen.findByTestId('session-list-drop-overlay');
        expect(root).toBeTruthy();
        expect(root?.props.pointerEvents).toBe('none');
        const style = flattenStyle(root?.props.style);
        expect(style.position).toBe('absolute');
        expect(Number(style.zIndex)).toBeGreaterThan(0);
    });

    it('applies the session indent to the reorder line for nested depths', async () => {
        const screen = await renderScreen(
            <SessionListDropOverlay
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, left: 16, right: 320, depth: 2 })}
                testID="session-list-drop-overlay"
            />,
        );

        const line = screen.findByTestId('session-list-drop-overlay-line');
        const style = flattenStyle(line?.props.style);
        // left shifts by depth * SESSION_LIST_DROP_OVERLAY_INDENT_PX = 2 * 6 = 12 -> 16 + 12 = 28.
        expect(style.left).toBe(16 + 2 * SESSION_LIST_DROP_OVERLAY_INDENT_PX);
    });
});
