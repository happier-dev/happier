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

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            surface: '#fff',
            divider: '#ddd',
            shadow: { color: '#000', opacity: 0.2 },
            button: { primary: { background: '#000', tint: '#fff' } },
            text: '#111',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

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

    it('applies a reduced effective opacity when disabled', async () => {
        const { RoundButton } = await import('./RoundButton');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<RoundButton title="Disabled" disabled={true} testID="disabled-round-button" />);
        });
        const pressable = tree.root.findByType('Pressable' as any);
        const styleOutput = pressable.props.style({ pressed: false });
        const flattened = Array.isArray(styleOutput)
            ? styleOutput.reduce((acc: Record<string, unknown>, next: Record<string, unknown> | null | undefined) => ({ ...acc, ...(next ?? {}) }), {})
            : (styleOutput ?? {});
        expect(flattened.opacity).toBe(0.35);
    });
});
