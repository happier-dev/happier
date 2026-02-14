import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    TextInput: ({ children, ...props }: any) => React.createElement('TextInput', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                divider: '#ddd',
                text: '#111',
                surfaceHighest: '#fff',
            },
        },
    }),
}));

describe('MonacoEditorSurface (web)', () => {
    it('renders a fallback TextInput when Monaco is unavailable', async () => {
        const { MonacoEditorSurface } = await import('./MonacoEditorSurface.web');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <MonacoEditorSurface
                    resetKey="1"
                    value="hello"
                    language="typescript"
                    onChange={() => {}}
                />,
            );
        });

        const inputs = tree.root.findAllByType('TextInput' as any);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.props.value).toBe('hello');
    });
});

