import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findFirstByType, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('SplitCanvasDivider native accessibility (Android)', () => {
    it('keeps a row-axis divider visually centered in one 48dp target without changing its layout footprint', async () => {
        const { SplitCanvasDivider } = await import('./SplitCanvasDivider');
        const tree = (await renderScreen(
            <SplitCanvasDivider
                axis="row"
                splitId="split-root"
                containerSizePx={1000}
                ratio={0.5}
                minRatio={0.2}
                maxRatio={0.8}
                onCommitRatio={() => {}}
            />,
        )).tree;
        const target = findFirstByType(tree, 'View');
        const handle = findFirstByType(tree, 'Pressable');
        if (!target || !handle) throw new Error('expected native split canvas divider target');

        expect(flattenStyle(target.props.style)).toEqual(expect.objectContaining({
            width: 48,
            marginHorizontal: -19,
        }));
        expect(flattenStyle(handle.props.style)).toEqual(expect.objectContaining({ width: 48 }));
        expect(handle.props.hitSlop).toBeUndefined();
        expect(handle.props.accessibilityRole).toBe('adjustable');
    });

    it('keeps a column-axis divider visually centered in one 48dp target without changing its layout footprint', async () => {
        const { SplitCanvasDivider } = await import('./SplitCanvasDivider');
        const tree = (await renderScreen(
            <SplitCanvasDivider
                axis="column"
                splitId="split-root"
                containerSizePx={800}
                ratio={0.5}
                minRatio={0.2}
                maxRatio={0.8}
                onCommitRatio={() => {}}
            />,
        )).tree;
        const target = findFirstByType(tree, 'View');
        const handle = findFirstByType(tree, 'Pressable');
        if (!target || !handle) throw new Error('expected native split canvas divider target');

        expect(flattenStyle(target.props.style)).toEqual(expect.objectContaining({
            height: 48,
            marginVertical: -15,
        }));
        expect(flattenStyle(handle.props.style)).toEqual(expect.objectContaining({ height: 48 }));
        expect(handle.props.hitSlop).toBeUndefined();
    });
});
