import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            text: '#111',
            textSecondary: '#777',
            surface: '#fff',
            groupped: { background: '#fafafa', sectionTitle: '#666' },
            shadowLevels: ['#00000000', '#00000012'],
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('SessionsListStorageChrome', () => {
    beforeEach(() => {
        standardCleanup();
        routerPushSpy.mockReset();
    });

    it('renders the external browse action above every unified-list filter and routes it to the canonical browse screen', async () => {
        const { SessionsListStorageChrome } = await import('./SessionsListStorageChrome');
        const screen = await renderScreen(
            <SessionsListStorageChrome
                externalSessionsEnabled={true}
                storageKind="all"
            />,
        );

        const itemGroups = screen.findAllByType('ItemGroup' as never);
        expect(itemGroups).toHaveLength(1);
        expect(itemGroups[0]?.props.constrainToContentWidth).toBe(false);
        const browseItem = screen.findByProps({ testID: 'external-sessions-browse-button' });
        expect(browseItem.props.title).toBe('externalSessions.browseOpenExisting');
        expect(browseItem.props.subtitle).toBeUndefined();
        expect(browseItem.props.density).toBe('cozy');
        expect(browseItem.props.icon).toBeUndefined();
        expect(browseItem.props.leftElement?.props?.size).toBeGreaterThanOrEqual(18);
        expect(browseItem.props.leftElement?.props?.size).toBeLessThanOrEqual(20);
        expect(browseItem.props.iconBoxSize).toBe(20);
        expect(browseItem.props.showChevron).toBe(false);
        expect(browseItem.props.showDivider).toBe(false);
        expect(flattenStyle(browseItem.props.pressableStyle).minHeight).toBeGreaterThanOrEqual(44);
        expect(screen.findAllByType('SessionListStorageTabsBar' as never)).toHaveLength(0);
        const browseContainerStyle = flattenStyle(itemGroups[0]?.props.style);
        expect(browseContainerStyle.marginTop).toBe(-4);
        expect(browseContainerStyle.maxWidth).toBeUndefined();
        expect(browseContainerStyle.backgroundColor).toBeUndefined();
        const browseSurfaceStyle = flattenStyle(itemGroups[0]?.props.containerStyle);
        expect(browseSurfaceStyle.backgroundColor).toBe('transparent');
        expect(browseSurfaceStyle.borderColor).toBe('transparent');
        expect(browseSurfaceStyle.borderWidth).toBe(0);
        expect(browseSurfaceStyle.borderTopWidth).toBe(0);
        expect(browseSurfaceStyle.boxShadow).toBe('none');
        expect(browseSurfaceStyle.shadowOpacity).toBe(0);
        expect(browseSurfaceStyle.elevation).toBe(0);

        await screen.pressByTestIdAsync('external-sessions-browse-button');

        expect(routerPushSpy).toHaveBeenCalledWith('/external/browse');
    });

    it('hides only the external browse action when the feature is disabled', async () => {
        const { SessionsListStorageChrome } = await import('./SessionsListStorageChrome');
        const screen = await renderScreen(
            <SessionsListStorageChrome externalSessionsEnabled={false} storageKind="all" />,
        );

        expect(screen.findAllByProps({ testID: 'external-sessions-browse-button' })).toHaveLength(0);
    });
});
