import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native', () => ({
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#777',
                surfacePressedOverlay: '#333',
                text: '#111',
            },
        },
    }),
    StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors: { textSecondary: '#777', surfacePressedOverlay: '#333', text: '#111' } }, {}) : input) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({ t: (k: string) => k }));

describe('ToolTimelineRowHeader', () => {
    it('shows an open action button with open-outline icon when canOpen is true', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');
        const onOpen = vi.fn();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    subtitle="Sub"
                    statusText="ok"
                    onPress={() => {}}
                    canOpen={true}
                    onOpen={onOpen}
                />,
            );
        });

        const icons = tree!.root.findAllByType('Ionicons') as any[];
        expect(icons.some((i) => i.props?.name === 'open-outline')).toBe(true);
    });

    it('crossfades the left icon to a chevron-down on hover when expandable (web)', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    onPress={() => {}}
                    canOpen={false}
                    onOpen={null}
                    disclosure={{ behavior: 'hover', state: 'collapsed' }}
                />,
            );
        });

        const chevrons = tree!.root.findAllByType('Ionicons') as any[];
        expect(chevrons.some((i) => i.props?.name === 'chevron-down')).toBe(true);

        const getChevronLayerOpacity = () => {
            const overlayViews = tree!.root.findAll(
                (node) =>
                    String(node.type) === 'View' &&
                    Array.isArray((node.props as any).style) &&
                    (node.props as any).style.some((s: any) => s?.position === 'absolute'),
            ) as any[];
            expect(overlayViews.length).toBeGreaterThan(0);
            const style = overlayViews[0]!.props.style as any[];
            const opacityEntries = style.filter((s: any) => typeof s?.opacity === 'number');
            if (opacityEntries.length === 0) return undefined;
            return opacityEntries[opacityEntries.length - 1]!.opacity;
        };

        expect(getChevronLayerOpacity()).toBe(0);

        const pressable = tree!.root.findByType('Pressable') as any;
        await act(async () => {
            pressable.props.onHoverIn?.();
        });

        expect(getChevronLayerOpacity()).toBe(1);
    });

    it('shows a persistent chevron-up when expanded by user', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    onPress={() => {}}
                    canOpen={false}
                    onOpen={null}
                    disclosure={{ behavior: 'persistent', state: 'expanded' }}
                />,
            );
        });

        const icons = tree!.root.findAllByType('Ionicons') as any[];
        expect(icons.some((i) => i.props?.name === 'chevron-up')).toBe(true);
        expect(icons.some((i) => i.props?.name === 'chevron-down')).toBe(false);
    });
});
