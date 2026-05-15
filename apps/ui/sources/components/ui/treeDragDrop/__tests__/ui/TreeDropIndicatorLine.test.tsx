import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { TreeDropIndicatorLine } from '../../ui/TreeDropIndicatorLine';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('TreeDropIndicatorLine', () => {
    it('indents from the target visual depth rather than the dragged source depth', async () => {
        expect(TreeDropIndicatorLine).toEqual(expect.any(Function));

        const screen = await renderScreen(
            <TreeDropIndicatorLine
                visual={{ kind: 'line', targetId: 'folder:b', edge: 'top', depth: 3 }}
                indentPx={8}
                testID="tree-drop-line"
            />,
        );

        const line = screen.findByTestId('tree-drop-line');
        expect(flattenStyle(line?.props.style).marginLeft).toBe(24);
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
