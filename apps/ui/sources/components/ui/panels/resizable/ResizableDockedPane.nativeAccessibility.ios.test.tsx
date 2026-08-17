import * as React from 'react';
import { act } from 'react-test-renderer';
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
            OS: 'ios',
            select: (values: Record<string, unknown>) => values.ios ?? values.native ?? values.default,
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('ResizableDockedPane native accessibility (iOS)', () => {
    it('exposes one 44pt adjustable divider that changes the canonical size', async () => {
        const onCommitWidthPx = vi.fn();
        const { ResizableDockedPane } = await import('../ResizableDockedPane');
        const tree = (await renderScreen(
            <ResizableDockedPane
                widthPx={320}
                minWidthPx={200}
                maxWidthPx={480}
                onCommitWidthPx={onCommitWidthPx}
            >
                <ViewStub />
            </ResizableDockedPane>,
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
        expect(handle.props.hitSlop).toEqual({ right: 34 });

        await act(async () => {
            handle.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'increment' } });
            handle.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'decrement' } });
        });

        expect(onCommitWidthPx).toHaveBeenNthCalledWith(
            1,
            328,
            expect.objectContaining({ clampedSizePx: 328 }),
        );
        expect(onCommitWidthPx).toHaveBeenNthCalledWith(
            2,
            312,
            expect.objectContaining({ clampedSizePx: 312 }),
        );
    });

    it('keeps a right-edge target inside its owning pane', async () => {
        const { ResizableDockedPane } = await import('../ResizableDockedPane');
        const tree = (await renderScreen(
            <ResizableDockedPane
                widthPx={320}
                minWidthPx={200}
                maxWidthPx={480}
                onCommitWidthPx={() => {}}
                resizeEdge="right"
            >
                <ViewStub />
            </ResizableDockedPane>,
        )).tree;
        const handle = findFirstByType(tree, 'Pressable');
        if (!handle) throw new Error('expected right-edge resizable docked pane handle');

        expect(handle.props.hitSlop).toEqual({ left: 34 });
    });
});

function ViewStub() {
    return React.createElement('ViewStub');
}
