import * as React from 'react';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
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

    it('mounts feedback only for the active carry and removes it when the carry ends', async () => {
        // Geometry can retain its last worklet value; the React carry lifecycle owns mounting.
        const shared = buildSharedValues();
        const overlay = (active: boolean) => (
            <SessionListDropOverlay active={active} shared={shared} testID="session-list-drop-overlay" />
        );
        const screen = await renderScreen(overlay(false));
        expect(screen.findAllHostsByTestId('session-list-drop-overlay')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('session-list-drop-overlay-outline')).toHaveLength(0);

        await screen.update(overlay(true));
        expect(screen.findHostByTestId('session-list-drop-overlay-outline')).not.toBeNull();

        await screen.update(overlay(false));
        expect(screen.findAllHostsByTestId('session-list-drop-overlay')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('session-list-drop-overlay-outline')).toHaveLength(0);
    });

    it('renders ONE non-interactive viewport-level overlay driven by shared values', async () => {
        const screen = await renderScreen(
            <SessionListDropOverlay active shared={buildSharedValues()} testID="session-list-drop-overlay" />,
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
                active
                shared={buildSharedValues({ kind: TREE_DROP_OVERLAY_KIND_LINE, left: 16, right: 320, depth: 2 })}
                testID="session-list-drop-overlay"
            />,
        );

        const line = screen.findByTestId('session-list-drop-overlay-line');
        const style = flattenStyle(line?.props.style);
        // The line starts at the rows' text edge (the shared column frame), then shifts by depth.
        expect(style.left).toBe(16 + HAPPIER_COLLECTION_LIST_METRICS.contentInset + 2 * SESSION_LIST_DROP_OVERLAY_INDENT_PX);
        // It stays inside the sheet: it ends at the text edge on the trailing side too.
        expect(style.width).toBe(320 - 16 - 2 * HAPPIER_COLLECTION_LIST_METRICS.contentInset - 2 * SESSION_LIST_DROP_OVERLAY_INDENT_PX);
    });
});
