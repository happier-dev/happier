import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#000', tint: '#fff', disabled: '#666' } },
                surfaceHigh: '#111',
                surface: '#111',
                divider: '#222',
                text: '#fff',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                button: { primary: { background: '#000', tint: '#fff', disabled: '#666' } },
                surfaceHigh: '#111',
                surface: '#111',
                divider: '#222',
                text: '#fff',
            },
        }),
    },
}));

describe('PrimaryCircleIconButton', () => {
    it('forwards testID to the Pressable', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <PrimaryCircleIconButton
                    testID="circle-button"
                    active
                    accessibilityLabel="Send"
                    onPress={() => {}}
                >
                    <span />
                </PrimaryCircleIconButton>,
            );
        });
        const pressable = tree.root.findByType('Pressable' as any);
        expect(pressable.props.testID).toBe('circle-button');
    });
});
