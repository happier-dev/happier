import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                border: { surface: 'rgba(0,0,0,0.08)' },
                effect: { surfaceHighlight: 'transparent' },
            },
        },
    });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

afterEach(() => {
    standardCleanup();
    vi.resetModules();
});

describe('SurfaceCard curated surface chrome', () => {
    it('adds curated surface shadow when surface chrome tokens are visible', async () => {
        const { SurfaceCard } = await import('./SurfaceCard');
        const screen = await renderScreen(
            <SurfaceCard>
                {React.createElement('View')}
            </SurfaceCard>,
        );

        const surfaceStyle = screen.findAllByType('View' as never)
            .map((node) => flattenStyle(node.props.style))
            .find((style) => style.minWidth === 0 && style.borderRadius === 16) ?? {};

        expect(hasShadow(surfaceStyle)).toBe(true);
    });
});
