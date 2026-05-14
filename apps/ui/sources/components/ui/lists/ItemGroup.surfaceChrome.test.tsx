import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    themeOverride: {} as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ theme: shared.themeOverride });
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

async function renderItemGroup() {
    const { ItemGroup } = await import('./ItemGroup');
    return renderScreen(
        <ItemGroup title="Group">
            {React.createElement('View')}
        </ItemGroup>,
    );
}

function findGroupSurfaceStyle(screen: Awaited<ReturnType<typeof renderItemGroup>>): Record<string, unknown> {
    const matchingNode = screen.findAllByType('View' as never).find((node) => {
        const style = flattenStyle(node.props.style);
        return style.backgroundColor === '#ffffff' && style.borderRadius === 16;
    });
    return matchingNode ? flattenStyle(matchingNode.props.style) : {};
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

afterEach(() => {
    standardCleanup();
    vi.resetModules();
    shared.themeOverride = {};
});

describe('ItemGroup surface chrome', () => {
    it('does not add curated surface shadow when surface chrome tokens are transparent', async () => {
        const screen = await renderItemGroup();
        const style = findGroupSurfaceStyle(screen);

        expect(style.borderWidth).toBe(0);
        expect(style.borderTopWidth).toBe(0);
        expect(hasShadow(style)).toBe(false);
    });
});
