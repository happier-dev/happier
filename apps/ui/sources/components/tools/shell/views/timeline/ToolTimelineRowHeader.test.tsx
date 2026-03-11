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
    TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
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

    it('renders the open action outside the primary row pressable on web', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    onPress={() => {}}
                    canOpen={true}
                    onOpen={() => {}}
                />,
            );
        });

        const pressables = tree!.root.findAllByType('Pressable') as any[];
        expect(pressables).toHaveLength(2);

        const openButton = pressables[1];
        let ancestor = openButton.parent;
        while (ancestor) {
            expect(ancestor.type).not.toBe('Pressable');
            ancestor = ancestor.parent;
        }
    });

    it('stops propagation before invoking the open action button callback', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');
        const onOpen = vi.fn();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    onPress={() => {}}
                    canOpen={true}
                    onOpen={onOpen}
                />,
            );
        });

        const pressables = tree!.root.findAllByType('Pressable') as any[];
        const openButton = pressables[1];
        const stopPropagation = vi.fn();

        await act(async () => {
            openButton.props.onPress?.({ stopPropagation });
        });

        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('keeps the open action visually hidden until hover on web', async () => {
        const { ToolTimelineRowHeader } = await import('./ToolTimelineRowHeader');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRowHeader
                    density="comfortable"
                    icon={React.createElement('Text', null, 'ICON')}
                    title="Title"
                    onPress={() => {}}
                    canOpen={true}
                    onOpen={() => {}}
                />,
            );
        });

        const findOpenWrapper = () =>
            tree!.root.findAll(
                (node) =>
                    String(node.type) === 'View' &&
                    Array.isArray((node.props as any).style) &&
                    (node.props as any).style.some((entry: any) => entry?.width === 26),
            )[0] as any;

        const openWrapper = findOpenWrapper();
        expect(openWrapper).toBeTruthy();
        const baseOpacity = (openWrapper.props.style as any[]).find((entry: any) => typeof entry?.opacity === 'number')?.opacity;
        expect(baseOpacity).toBe(0);

        const pressable = tree!.root.findAllByType('Pressable')[0] as any;
        await act(async () => {
            pressable.props.onHoverIn?.();
        });

        const hoverOpacity = ((findOpenWrapper().props.style as any[]).find((entry: any) => typeof entry?.opacity === 'number')?.opacity);
        expect(hoverOpacity).toBe(1);
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
