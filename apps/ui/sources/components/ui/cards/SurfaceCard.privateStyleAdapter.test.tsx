import * as React from 'react';
import type { ComponentProps } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SurfaceCard } from './SurfaceCard';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

expectTypeOf<StyleProp<ViewStyle> | undefined>()
    .toMatchTypeOf<ComponentProps<typeof SurfaceCard>['style']>();

describe('SurfaceCard private native-style adapter', () => {
    it('applies a core-only view transform on its native surface host', async () => {
        const transform = [{ scaleX: 0.8 }, { scaleY: 0.8 }];
        const screen = await renderScreen(
            <SurfaceCard testID="core-card" style={{ transform }}>
                {React.createElement('View')}
            </SurfaceCard>,
        );

        const card = screen.findByTestId('core-card');
        if (!card) {
            throw new Error('Expected the core SurfaceCard to render its native surface host');
        }
        expect(card.type).toBe('View');
        const styledSurface = screen.findAllByType('View' as never).find((node) => (
            flattenStyle(node.props.style).transform === transform
        ));
        expect(styledSurface).toBeDefined();
    });
});
