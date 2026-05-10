import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    View: 'View',
                    Text: 'Text',
                    ActivityIndicator: 'ActivityIndicator',
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('RoundButton', () => {
    it('forwards testID to the Pressable', async () => {
        const { RoundButton } = await import('./RoundButton');
        const screen = await renderScreen(<RoundButton title="Hello" testID="round-button" />);
        const pressable = screen.findByTestId('round-button');
        if (!pressable) {
            throw new Error('Expected round button pressable to render');
        }
        expect(pressable.props.testID).toBe('round-button');
        expect(pressable.findByType('LinearGradient' as never).props.colors).toEqual(['#000000', '#020202']);
    });

    it('applies a reduced effective opacity when disabled', async () => {
        const { RoundButton } = await import('./RoundButton');
        const screen = await renderScreen(<RoundButton title="Disabled" disabled={true} testID="disabled-round-button" />);
        const pressable = screen.findByTestId('disabled-round-button');
        if (!pressable) {
            throw new Error('Expected disabled round button pressable to render');
        }
        const styleOutput = pressable.props.style({ pressed: false });
        const flattened = Array.isArray(styleOutput)
            ? styleOutput.reduce((acc: Record<string, unknown>, next: Record<string, unknown> | null | undefined) => ({ ...acc, ...(next ?? {}) }), {})
            : (styleOutput ?? {});
        expect(flattened.opacity).toBe(0.35);
    });
});
