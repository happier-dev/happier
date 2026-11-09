import * as React from 'react';
import { Platform } from 'react-native';

import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// The harness installs the server socket boundary as it loads: import it before any runtime module.
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX } from '@/components/ui/lists/itemGroupSpacing';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

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

const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'app' });

function setExternalSessionsEnabled(enabled: boolean) {
    storage.setState({ settings: { ...storage.getState().settings, featureToggles: {
        ...storage.getState().settings.featureToggles, 'sessions.direct': enabled,
    } } });
}

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
        setExternalSessionsEnabled(true);
    });

    it('renders the external browse action above every unified-list filter and routes it to the canonical browse screen', async () => {
        const { SessionsListStorageChrome } = await import('./SessionsListStorageChrome');
        const screen = await renderScreen(
            <SessionsListStorageChrome column="sessions" />,
            { wrapper: runtime.Wrapper },
        );

        const itemGroups = screen.findAllByType('ItemGroup' as never);
        expect(itemGroups).toHaveLength(1);
        expect(itemGroups[0]?.props.constrainToContentWidth).toBe(false);
        const browseItem = screen.findByProps({ testID: 'external-sessions-browse-button' });
        expect(browseItem.props.title).toBe('externalSessions.browseOpenExisting');
        expect(browseItem.props.subtitle).toBeUndefined();
        // The action row shares ONE grid with the session rows underneath it, and it must not
        // describe that grid a second time. Every column it occupies has to be decided by the
        // `tight` density tokens (which are what `SessionItem`'s minimal row is cut from), so the
        // discriminating contract is that the row hands the whole geometry to those owners:
        // no local box size, no locally sized glyph, no hand-rolled minimum row height.
        expect(browseItem.props.density).toBe('tight');
        expect(browseItem.props.leftElement).toBeUndefined();
        expect(browseItem.props.icon).toBeDefined();
        // Sized by `resizeItemIconForDensity` from ITEM_ICON_GLYPH_SIZE.tight, never by the caller.
        expect(browseItem.props.icon?.props?.size).toBeUndefined();
        // Absent, so the reserved box stays ITEM_ICON_BOX_SIZE.tight — the session avatar's box.
        expect(browseItem.props.iconBoxSize).toBeUndefined();
        expect(browseItem.props.showChevron).toBe(false);
        expect(browseItem.props.showDivider).toBe(false);
        // `pressableStyle` lands on the Pressable, not the row container, so a height set there
        // leaves dead space around the row box. The height belongs on `style`; the pressable only
        // carries the fill's shape.
        const pressableStyle = flattenStyle(browseItem.props.pressableStyle);
        expect(pressableStyle.height).toBeUndefined();
        expect(pressableStyle.minHeight).toBeUndefined();
        const browseRowStyle = flattenStyle(browseItem.props.style);
        const sessionRowHeight = resolveSessionListDensityViewState(
            settingsDefaults.sessionListDensity,
            { isTablet: false, platform: Platform.OS },
        ).rowHeight;
        expect(browseRowStyle.height).toBe(sessionRowHeight);
        expect(browseRowStyle.minHeight).toBe(sessionRowHeight);
        expect(screen.findAllByType('SessionListStorageTabsBar' as never)).toHaveLength(0);
        const browseContainerStyle = flattenStyle(itemGroups[0]?.props.style);
        // Cancels the untitled group's own top spacer exactly, then keeps the column's small gap
        // under the title strip (ColumnDestinationRows `column` placement).
        expect(browseContainerStyle.marginTop).toBe(
            -(Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX) ?? 0) + 8,
        );
        expect(browseContainerStyle.maxWidth).toBeUndefined();
        expect(browseContainerStyle.backgroundColor).toBeUndefined();
        // Destinations are not sessions: quiet navigation rows on the column's surface, never a sheet.
        expect(itemGroups[0]?.props.surface).toBe('none');

        await screen.pressByTestIdAsync('external-sessions-browse-button');

        expect(routerPushSpy).toHaveBeenCalledWith('/external/browse');
    });

    it('hides only the external browse action when the feature is disabled', async () => {
        setExternalSessionsEnabled(false);
        const { SessionsListStorageChrome } = await import('./SessionsListStorageChrome');
        const screen = await renderScreen(
            <SessionsListStorageChrome column="sessions" />,
            { wrapper: runtime.Wrapper },
        );

        expect(screen.findAllByProps({ testID: 'external-sessions-browse-button' })).toHaveLength(0);
    });
});
