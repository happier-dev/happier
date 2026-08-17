import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findFirstByType, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The ordinary divider suite is a web drag harness. This isolated renderer
// makes the native platform target factual rather than mutating that harness.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        PanResponder: { create: () => ({ panHandlers: {} }) },
        Platform: {
            OS: 'android',
            select: (values: Record<string, unknown>) => values.android ?? values.native ?? values.default,
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('ResizableDockedPaneVertical native accessibility (Android)', () => {
    it('exposes one 48dp adjustable divider with the current value and actions', async () => {
        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');
        const tree = (await renderScreen(
            <ResizableDockedPaneVertical
                heightPx={320}
                minHeightPx={200}
                maxHeightPx={480}
                onCommitHeightPx={() => {}}
            >
                <ViewStub />
            </ResizableDockedPaneVertical>,
        )).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected resizable docked pane handle');

        expect(handle.props).toMatchObject({
            accessibilityRole: 'adjustable',
            accessibilityValue: { min: 200, max: 480, now: 320 },
            accessibilityActions: [
                { name: 'increment' },
                { name: 'decrement' },
            ],
        });
        expect(handle.props.hitSlop).toEqual({ bottom: 30 });
    });

    it('keeps a bottom-edge target inside its owning pane', async () => {
        const { ResizableDockedPaneVertical } = await import('./ResizableDockedPaneVertical');
        const tree = (await renderScreen(
            <ResizableDockedPaneVertical
                heightPx={320}
                minHeightPx={200}
                maxHeightPx={480}
                onCommitHeightPx={() => {}}
                resizeEdge="bottom"
            >
                <ViewStub />
            </ResizableDockedPaneVertical>,
        )).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected bottom-edge resizable docked pane handle');

        expect(handle.props.hitSlop).toEqual({ top: 30 });
    });
});

function ViewStub() {
    return React.createElement('ViewStub');
}
