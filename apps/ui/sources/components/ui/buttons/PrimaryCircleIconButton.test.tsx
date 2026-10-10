import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    ActivityIndicator: 'ActivityIndicator',
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                button: { primary: { background: '#000', tint: '#fff', disabled: '#666', gradient: { colors: ['#000', '#111'], start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } } } },
                surfaceHigh: '#111',
                surface: '#111',
                divider: '#222',
                text: '#fff',
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

let originalPlatform = Platform.OS;
beforeEach(() => {
    originalPlatform = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});
afterEach(() => Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform }));

describe('PrimaryCircleIconButton', () => {
    it('does not add an opaque primary gradient inside its containing glass plane', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="chrome" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <PrimaryCircleIconButton testID="glass-circle" active accessibilityLabel="Send" onPress={() => {}}><span /></PrimaryCircleIconButton>
        </HappierMaterialRoleProvider>);
        expect(screen.findByTestId('glass-circle')!.findAllByType('Stop' as never).slice(0, 2).map(node => node.props.stopColor)).toEqual(['rgba(235, 230, 225, 0.1)', 'rgba(235, 230, 225, 0.1)']);
    });
    it('forwards testID to the Pressable', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        const screen = await renderScreen(<PrimaryCircleIconButton
            testID="circle-button"
            active
            accessibilityLabel="Send"
            onPress={() => {}}
        >
            <span />
        </PrimaryCircleIconButton>);
        const pressable = screen.findByTestId('circle-button');
        if (!pressable) {
            throw new Error('Expected primary circle icon button pressable to render');
        }
        expect(pressable.props.testID).toBe('circle-button');
        expect(pressable.findAllByType('Stop' as never).slice(0, 2).map(node => node.props.stopColor)).toEqual(['#000', '#111']);
    });

    it('does not emit raw text nodes under Pressable when icon children render as text on web', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<PrimaryCircleIconButton
                    testID="circle-button"
                    active
                    accessibilityLabel="Send"
                    onPress={() => {}}
                >
                    <>{'.'}</>
                </PrimaryCircleIconButton>)).tree;

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
