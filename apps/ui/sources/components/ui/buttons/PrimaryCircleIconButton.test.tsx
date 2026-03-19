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
        create: (factory: any) => {
            const theme = {
                colors: {
                    button: { primary: { background: '#000', tint: '#fff', disabled: '#666' } },
                    surfaceHigh: '#111',
                    surface: '#111',
                    divider: '#222',
                    text: '#fff',
                },
            };
            return typeof factory === 'function' ? factory(theme) : factory;
        },
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
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

    it('does not emit raw text nodes under Pressable when icon children render as text on web', async () => {
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
                    <>{'.'}</>
                </PrimaryCircleIconButton>,
            );
        });

        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parentType);
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : parentType;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(tree.toJSON(), null);

        expect(badNodes).toEqual([]);
    });
});
