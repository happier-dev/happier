import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) =>
                options.android ?? options.default ?? options.native ?? options.ios ?? options.web,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('Switch interactive target', () => {
    it('keeps the default web switch interaction node on the canonical web target', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(
            <Switch
                value={false}
                onValueChange={() => {}}
                testID="web-switch"
                style={{ minWidth: 1, minHeight: 1 }}
            />,
        );

        const interactionNode = screen.findByTestId('web-switch');
        expect(interactionNode?.props.accessibilityRole).toBe('switch');
        expect(typeof interactionNode?.props.onPress).toBe('function');
        expect(flattenStyle(interactionNode?.props.style)).toMatchObject({
            minWidth: resolveMinimumInteractiveTargetSize('web'),
            minHeight: resolveMinimumInteractiveTargetSize('web'),
        });
    });

    it('keeps default and compact native switch interaction nodes on the canonical native target', async () => {
        const { Switch } = await import('./Switch');
        const screen = await renderScreen(
            <>
                <Switch
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-default"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
                <Switch
                    compact
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-compact"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
            </>,
        );
        const minimumTargetSize = resolveMinimumInteractiveTargetSize('android');

        const targetSizes = ['native-switch-default', 'native-switch-compact'].map((testID) => {
            const interactionNode = screen.findByTestId(testID);
            expect(typeof interactionNode?.props.onValueChange).toBe('function');
            const targetStyle = flattenStyle(interactionNode?.props.style);
            return {
                minWidth: targetStyle.minWidth,
                minHeight: targetStyle.minHeight,
            };
        });
        expect(targetSizes).toEqual([
            { minWidth: minimumTargetSize, minHeight: minimumTargetSize },
            { minWidth: minimumTargetSize, minHeight: minimumTargetSize },
        ]);
    });
});
