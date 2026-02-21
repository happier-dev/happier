import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: { ...(actual.Platform ?? {}), OS: 'web' },
        View: 'View',
        Text: 'Text',
        ActivityIndicator: 'ActivityIndicator',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                button: { primary: { background: '#000', tint: '#fff' } },
                text: '#111',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                button: { primary: { background: '#000', tint: '#fff' } },
                text: '#111',
            },
        }),
    },
}));

describe('RoundButton', () => {
    it('forwards testID to the Pressable', async () => {
        const { RoundButton } = await import('./RoundButton');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<RoundButton title="Hello" testID="round-button" />);
        });
        const pressable = tree.root.findByType('Pressable' as any);
        expect(pressable.props.testID).toBe('round-button');
    });
});
