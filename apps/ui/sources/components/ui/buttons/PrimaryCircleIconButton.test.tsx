import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
import Color from 'color';

vi.unmock('color');

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
                text: { primary: '#f0f0f0', tertiary: '#888888' },
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
    it('keeps its solid primary gradient inside its containing glass plane', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="chrome" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <PrimaryCircleIconButton testID="glass-circle" active accessibilityLabel="Send" onPress={() => {}}><span /></PrimaryCircleIconButton>
        </HappierMaterialRoleProvider>);
        expect(screen.findByTestId('glass-circle')!.findAllByType('Stop' as never).slice(0, 2)
            .map(node => Color(node.props.stopColor).hex())).toEqual(['#000000', '#111111']);
    });

    it('keeps its own fill while it works, so its spinner reads in the fill\'s ink rather than on the disabled slab', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
        // After Send the composer passes `active={false}` (the press is locked) and `loading`.
        const screen = await renderScreen(<PrimaryCircleIconButton testID="sending" active={false} loading accessibilityLabel="Send" onPress={() => {}}><span /></PrimaryCircleIconButton>);
        const circle = screen.findByTestId('sending')!;
        expect(circle.findAllByType('Stop' as never).slice(0, 2).map(node => Color(node.props.stopColor).hex())).toEqual(['#000000', '#111111']);
        expect(Color(circle.findByType(ActivitySpinner).props.color).hex()).toBe('#FFFFFF');
    });

    it('hands its children the ink of the fill they sit on: the fill\'s ink, the page ink, or the muted ink while disabled', async () => {
        const { PrimaryCircleIconButton } = await import('./PrimaryCircleIconButton');
        const ink = (props: { active: boolean; disabled?: boolean }) => {
            let seen: string | null = null;
            return renderScreen(<PrimaryCircleIconButton active={props.active} disabled={props.disabled} accessibilityLabel="Send" onPress={() => {}}>
                {(foreground: string) => { seen = foreground; return <span />; }}
            </PrimaryCircleIconButton>).then(() => Color(seen!).hex());
        };
        expect(await ink({ active: true })).toBe('#FFFFFF');
        // Inactive but pressable (a quiet circle on the slab): the page ink.
        expect(await ink({ active: false })).toBe('#F0F0F0');
        // An empty composer's Send: muted, never the fill's ink on the slab (dark on dark).
        expect(await ink({ active: false, disabled: true })).toBe('#888888');
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
