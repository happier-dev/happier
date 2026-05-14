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

vi.mock('@/components/ui/layout/layout', () => ({
    useLayoutMaxWidth: () => 850,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), eyebrow: () => ({}) },
}));

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

describe('ItemGroup curated surface chrome', () => {
    it('adds curated surface shadow when surface chrome tokens are visible', async () => {
        const { ItemGroup } = await import('./ItemGroup');
        const screen = await renderScreen(
            <ItemGroup title="Group">
                {React.createElement('View')}
            </ItemGroup>,
        );

        const surfaceStyle = screen.findAllByType('View' as never)
            .map((node) => flattenStyle(node.props.style))
            .find((style) => style.backgroundColor === '#ffffff' && style.borderRadius === 16) ?? {};

        expect(surfaceStyle.borderColor).toBe('rgba(0,0,0,0.08)');
        expect(Number(surfaceStyle.borderWidth)).toBeGreaterThan(0);
        expect(Number(surfaceStyle.borderTopWidth)).toBeGreaterThan(0);
        expect(hasShadow(surfaceStyle)).toBe(true);
    });
});
