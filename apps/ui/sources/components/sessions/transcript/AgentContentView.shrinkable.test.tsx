import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardState: () => ({ isVisible: false, height: 0 }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
    ScrollView: 'ScrollView',
}));

vi.mock('./useKeyboardDismissOnTap', () => ({
    useKeyboardDismissOnTap: () => ({}),
}));

describe('AgentContentView (shrinkable layout)', () => {
    it('keeps the content region shrinkable so the composer can remain visible in split panes', async () => {
        const { AgentContentView } = await import('./AgentContentView');

        const screen = await renderScreen(
            <AgentContentView
                content={<Content />}
                placeholder={<Placeholder />}
                input={<Composer />}
            />,
        );

        const composer = screen.tree.root.findByType('Composer');
        const outerContainer = findAncestorWithStyle(composer, (style) => {
            return style != null && typeof style === 'object' && 'paddingBottom' in style && 'flexGrow' in style;
        });
        expect(outerContainer?.props?.style).toEqual(
            expect.objectContaining({
                flexBasis: 0,
                flexGrow: 1,
                minHeight: 0,
                minWidth: 0,
            }),
        );

        const placeholder = screen.tree.root.findByType('Placeholder');
        const contentRegion = findAncestorWithStyle(placeholder, (style) => {
            return style != null && typeof style === 'object' && !('paddingBottom' in style) && 'flexGrow' in style;
        });
        expect(contentRegion?.props?.style).toEqual(
            expect.objectContaining({
                flexBasis: 0,
                flexGrow: 1,
                minHeight: 0,
                minWidth: 0,
            }),
        );

        const content = screen.tree.root.findByType('Content');
        const contentLayer = findAncestorWithStyle(content, (style) => {
            return style != null && typeof style === 'object' && (style as Record<string, unknown>).position === 'absolute';
        });
        expect(findStyleEntry(contentLayer?.props?.style, (style) => style.position === 'absolute')).toEqual(
            expect.objectContaining({
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                minWidth: 0,
                overflow: 'hidden',
            }),
        );

        const composerHost = findAncestorWithStyle(composer, (style) => {
            return style != null && typeof style === 'object' && 'minWidth' in (style as Record<string, unknown>);
        });
        expect(findStyleEntry(composerHost?.props?.style, (style) => 'minWidth' in style)).toEqual(
            expect.objectContaining({
                minWidth: 0,
            }),
        );
    });
});

function Content() {
    return React.createElement('Content');
}

function findStyleEntry(
    style: unknown,
    predicate: (style: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
    if (style != null && typeof style === 'object' && !Array.isArray(style)) {
        return predicate(style as Record<string, unknown>) ? (style as Record<string, unknown>) : undefined;
    }
    if (!Array.isArray(style)) return undefined;
    return style.find((entry) => entry != null && typeof entry === 'object' && predicate(entry as Record<string, unknown>));
}

function Placeholder() {
    return React.createElement('Placeholder');
}

function Composer() {
    return React.createElement('Composer');
}

function findAncestorWithStyle(
    node: { parent?: { parent?: unknown; props?: { style?: unknown } } | null } | null | undefined,
    predicate: (style: unknown) => boolean,
) {
    let current = node?.parent ?? null;
    while (current) {
        const style = current.props?.style;
        if (predicate(style)) return current;
        if (Array.isArray(style) && style.some((entry) => predicate(entry))) return current;
        current = current.parent ?? null;
    }
    return null;
}
