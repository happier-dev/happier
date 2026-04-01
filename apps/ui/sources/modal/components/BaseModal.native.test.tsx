import React from 'react';
import { StyleSheet as ReactNativeStyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyleProp(styleProp: unknown): Record<string, unknown> {
    const flattened = ReactNativeStyleSheet.flatten(styleProp as never);
    if (!flattened || typeof flattened !== 'object') return {};
    return flattened as Record<string, unknown>;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (options: Record<string, unknown>) => options?.ios ?? options?.native ?? options?.default,
        },
    });
});
vi.mock('react-native-safe-area-context', async () => {
    return {
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
        initialWindowMetrics: {
            insets: { top: 24, bottom: 16, left: 0, right: 0 },
            frame: { x: 0, y: 0, width: 0, height: 0 },
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                overlay: {
                    scrimWizard: 'rgba(0,0,0,0.5)',
                },
            },
        },
    });
});

describe('BaseModal (native)', () => {
    it('pads the centering container by the safe area insets (so content never overlaps the iOS status bar)', async () => {
        const { BaseModal } = await import('./BaseModal');

        const screen = await renderScreen(
            React.createElement(BaseModal, {
                visible: true,
                children: React.createElement('Child'),
            }),
        );

        const container = screen.findAllByType('KeyboardAvoidingView' as any)?.[0];
        const style = flattenStyleProp(container?.props?.style);
        expect(style.paddingTop).toBe(24);
        expect(style.paddingBottom).toBe(16);
    });
});
