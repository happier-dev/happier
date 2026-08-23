import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

const runtime = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));

installModalComponentCommonModuleMocks({
    reactNative: async () => await createReactNativeWebMock({
        Platform: {
            get OS() {
                return runtime.platform;
            },
            select: <T,>(choices: { web?: T; default?: T; native?: T; ios?: T; android?: T }) => (
                choices[runtime.platform] ?? choices.native ?? choices.default
            ),
        },
    }),
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, focused: false }));
    if (Array.isArray(style)) return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

function readPhysicalTarget(node: ReactTestInstance): Readonly<{ width: number; height: number }> {
    const style = flattenStyle(node.props.style);
    return {
        width: Math.max(Number(style.width ?? 0), Number(style.minWidth ?? 0)),
        height: Math.max(Number(style.height ?? 0), Number(style.minHeight ?? 0)),
    };
}

afterEach(() => {
    standardCleanup();
    runtime.platform = 'web';
});

describe('ModalCloseButton', () => {
    it.each([
        ['web', 'web', 44],
        ['iOS', 'ios', 44],
        ['Android', 'android', 48],
    ] as const)('keeps a physical, focusable %s close target without relying on hitSlop', async (_name, platform, minimum) => {
        runtime.platform = platform;
        const { ModalCloseButton } = await import('./ModalCloseButton');
        const onPress = vi.fn();
        const screen = await renderScreen(<ModalCloseButton onPress={onPress} />);

        const close = screen.findByTestId('modal-card-close');
        expect(close?.props.accessibilityRole).toBe('button');
        expect(close?.props.focusable).toBe(true);
        expect(close?.props.hitSlop).toBeUndefined();
        expect(readPhysicalTarget(close!)).toEqual({ width: minimum, height: minimum });
        expect(resolveMinimumInteractiveTargetSize(platform)).toBe(minimum);

        screen.pressByTestId('modal-card-close');
        expect(onPress).toHaveBeenCalledOnce();
    });
});
