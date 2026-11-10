import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { getStorage } from '@/sync/domains/state/storage';

import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';
import { APP_RAIL_ITEM_SLOT_PX, APP_RAIL_WIDTH_PX } from './appRailMetrics';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ styleSheet: { hairlineWidth: 1 } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal, { maxHeight: 600, maxWidth: 400, placement: 'bottom' });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialStorageState = getStorage().getState();
afterEach(() => {
    standardCleanup();
    getStorage().setState(initialStorageState, true);
});

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('AppRail badge placement', () => {
    it('draws every rail badge inside the rail slot its glyph stands in, so one offset reads the same everywhere', async () => {
        getStorage().setState(state => ({
            profile: { ...state.profile, connectedAccountsV4: [{ status: 'needs_reauth' }, { status: 'needs_reauth' }] },
        }) as never);
        const pages: PluginPage[] = [{
            target: { kind: 'app' },
            visible: true,
            id: 'plugin:acme.channels:channels', pluginId: 'acme.channels', descriptorId: 'channels', localId: 'channels',
            label: 'channels', icon: 'note', order: 10, disabledReason: null,
            placement: {} as PluginPage['placement'], routePath: '/plugins/acme.channels/channels',
            badge: { label: 'Beta', tone: 'info' },
        } as PluginPage];
        const entries = buildAppRailEntries(resolveCompactAppDestinations({
            builtins: { externalSessions: true, inbox: true, workflows: true, friends: true }, pages,
        }));
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider>
            <AppRailSurface entries={entries} activeId={null} onOpen={() => {}} updatesVisible
                preferences={{ orderedIds: [], placements: { 'plugin:acme.channels:channels': 'pinned', 'app-rail-usage': 'pinned' } }} />
        </InboxSummaryProvider></InjectedAuthProvider>);

        const badges = screen.findAll(node => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.endsWith('-badge'));
        const ids = badges.map(node => node.props.testID as string);
        expect(ids).toContain('app-rail-usage-badge');
        expect(ids).toContain('app-rail:plugin:acme.channels:channels-badge');
        for (const badge of badges) {
            let parent = badge.parent;
            while (parent && typeof parent.type !== 'string') parent = parent.parent;
            const style = flatten(parent?.props.style);
            expect({ id: badge.props.testID, width: style.width, height: style.height })
                .toEqual({ id: badge.props.testID, width: APP_RAIL_WIDTH_PX, height: APP_RAIL_ITEM_SLOT_PX });
        }
    });
});
