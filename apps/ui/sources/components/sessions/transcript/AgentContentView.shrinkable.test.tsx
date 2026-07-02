import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-keyboard-controller', () => ({
    useKeyboardHandler: () => undefined,
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
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

        const keyboardHost = screen.tree.root.findByProps({ testID: 'agent-content-keyboard-host' });
        expect(keyboardHost).toBeTruthy();

        const composer = screen.tree.root.findByType('Composer');
        const contentRegion = screen.tree.root.findByProps({ testID: 'agent-content-scroll-region' });
        expect(contentRegion.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                }),
            ]),
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

        expect(screen.tree.root.findByProps({ testID: 'agent-content-input-footer' }).props.children).toEqual(
            expect.objectContaining({
                type: Composer,
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
