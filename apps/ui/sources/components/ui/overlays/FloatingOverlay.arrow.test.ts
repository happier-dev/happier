import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { FloatingOverlay } from './FloatingOverlay';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                modal: { border: 'rgba(0,0,0,0.1)' },
                shadow: { color: 'rgba(0,0,0,0.2)', opacity: 0.2 },
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (
            factory: (
                theme: {
                    colors: {
                        surface: string;
                        modal: { border: string };
                        shadow: { color: string; opacity: number };
                        textSecondary: string;
                    };
                },
                runtime: Record<string, unknown>,
            ) => unknown,
        ) =>
            factory(
                {
                    colors: {
                        surface: '#fff',
                        modal: { border: 'rgba(0,0,0,0.1)' },
                        shadow: { color: 'rgba(0,0,0,0.2)', opacity: 0.2 },
                        textSecondary: '#666',
                    },
                },
                {},
            ),
    },
}));

vi.mock('react-native-reanimated', () => {
    const AnimatedView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedView', props, props.children);
    const AnimatedScrollView = (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AnimatedScrollView', props, props.children);
    return {
        __esModule: true,
        default: {
            View: AnimatedView,
            ScrollView: AnimatedScrollView,
        },
    };
});

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => React.createElement('ScrollEdgeFades'),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => React.createElement('ScrollEdgeIndicators'),
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

async function renderOverlay(props: Omit<React.ComponentProps<typeof FloatingOverlay>, 'children'>) {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
        const overlayProps: React.ComponentProps<typeof FloatingOverlay> = {
            ...props,
            children: React.createElement(Child),
        };
        tree = renderer.create(React.createElement(FloatingOverlay, overlayProps));
    });
    return tree!;
}

function Child() {
    return null;
}

describe('FloatingOverlay', () => {
    it('renders an arrow when configured', async () => {
        const tree = await renderOverlay({
            maxHeight: 200,
            arrow: { placement: 'bottom' },
        });

        const arrows = tree.root.findAllByProps({ testID: 'floating-overlay-arrow' });
        const hostArrows = arrows.filter((node) => typeof node.type === 'string');
        expect(hostArrows).toHaveLength(1);
    });

    it('renders edge indicators when enabled without edge fades', async () => {
        const tree = await renderOverlay({
            maxHeight: 200,
            edgeIndicators: true,
            edgeFades: false,
        });

        const indicators = tree.root.findAll((node) => (node.type as unknown) === 'ScrollEdgeIndicators');
        expect(indicators).toHaveLength(1);
    });
});
