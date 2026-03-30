import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { FloatingOverlay } from './FloatingOverlay';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                        React.createElement('ScrollView', props, props.children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                modal: { border: 'rgba(0,0,0,0.1)' },
                shadow: { color: 'rgba(0,0,0,0.2)', opacity: 0.2 },
                textSecondary: '#666',
            },
        },
    });
});

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
    return renderScreen(
        React.createElement(FloatingOverlay, {
            ...props,
            children: React.createElement(Child),
        }),
    );
}

function Child() {
    return null;
}

describe('FloatingOverlay', () => {
    it('renders an arrow when configured', async () => {
        const screen = await renderOverlay({
            maxHeight: 200,
            arrow: { placement: 'bottom' },
        });

        expect(screen.findByTestId('floating-overlay-arrow')).toBeTruthy();
    });

    it('renders edge indicators when enabled without edge fades', async () => {
        const screen = await renderOverlay({
            maxHeight: 200,
            edgeIndicators: true,
            edgeFades: false,
        });

        expect(screen.findByType('ScrollEdgeIndicators')).toBeTruthy();
    });
});
