import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { stubServerFeaturesFetch } from '@/hooks/server/serverFeaturesTestUtils';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storage';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { PluginAppPage } from '@/components/appShell/plugins/pluginAppPages';
import { AppRailSurface } from './AppRail';
import { buildAppRailEntries } from './appRailModel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ styleSheet: { hairlineWidth: 1 } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Portal measurement is a platform boundary; DropdownMenu and all placement decisions stay real.
vi.mock('@/components/ui/popover', () => ({ Popover: (props: { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) =>
    <>{props.children({ maxHeight: 600, maxWidth: 400 })}</> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialStorageState = getStorage().getState();
afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialStorageState, true);
});

function entries() {
    const pages = ['channels', 'inspector', 'triage'].map((id): PluginAppPage => ({
        id: `plugin:acme.${id}:${id}`, pluginId: `acme.${id}`, descriptorId: id, localId: id,
        label: id, icon: 'note', order: 10, disabledReason: null,
        placement: {} as PluginAppPage['placement'], routePath: `/plugins/acme.${id}/${id}`,
    }));
    return buildAppRailEntries(resolveCompactAppDestinations({
        builtins: { externalSessions: true, inbox: true, workflows: true, friends: true }, pages,
    }));
}

const layout = (height: number): LayoutChangeEvent => ({
    nativeEvent: { layout: { x: 0, y: 0, width: 56, height } },
} as LayoutChangeEvent);

describe('AppRail measured room', () => {
    it('shows every destination in the reported tall rail even if the old plugin area was collapsed', async () => {
        const all = entries();
        const screen = await renderScreen(<InboxSummaryProvider><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />} /></InboxSummaryProvider>);
        await act(async () => {
            // Layout is the OS boundary. The screenshot's rail has room for all eleven destinations.
            screen.findByTestId('app-rail')?.props.onLayout?.(layout(810));
            screen.findByTestId('app-rail-plugins')?.props.onLayout?.(layout(0));
        });
        expect(all.plugins.every((entry) => screen.findByTestId(`app-rail:${entry.id}`) !== null)).toBe(true);
        expect(screen.findByTestId('app-rail-more.trigger')).toBeNull();
    });

    it('moves app destinations into More as well when the whole rail is too short', async () => {
        const all = entries();
        const screen = await renderScreen(<InboxSummaryProvider><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />} /></InboxSummaryProvider>);
        await act(async () => {
            screen.findByTestId('app-rail')?.props.onLayout?.(layout(140));
            screen.findByTestId('app-rail-plugins')?.props.onLayout?.(layout(0));
        });
        const shown = [...all.app, ...all.plugins].filter((entry) => screen.findByTestId(`app-rail:${entry.id}`));
        expect(shown.length).toBeLessThanOrEqual(2);
        expect(screen.findByTestId('app-rail-more.trigger')).not.toBeNull();
    });

    it('applies footer and destination placement choices and opens Customize from More', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const all = entries();
        const customize = vi.fn();
        const screen = await renderScreen(<InboxSummaryProvider><AppRailSurface entries={all} activeId={null}
            onOpen={() => {}} onCustomize={customize} renderFooter={(item, trigger) => trigger
                ? trigger({ onPress: () => {}, open: false }) : <View testID={item.id} />}
            preferences={{ orderedIds: ['search', 'sessions'], placements: {
                search: 'overflow', 'app-rail-usage': 'overflow', 'app-rail-machines': 'hidden',
            } }} /></InboxSummaryProvider>);
        await act(async () => screen.findByTestId('app-rail')?.props.onLayout?.(layout(810)));
        expect(screen.findByTestId('app-rail:search')).toBeNull();
        expect(screen.findByTestId('app-rail-usage')).toBeNull();
        expect(screen.findByTestId('app-rail-machines')).toBeNull();
        await screen.pressByTestIdAsync('app-rail-more.trigger');
        await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
        expect(screen.findByTestId('app-rail-more:search')).not.toBeNull();
        expect(screen.findByTestId('app-rail-more:app-rail-usage')).not.toBeNull();
        await screen.pressByTestIdAsync('app-rail-more.customize');
        expect(customize).toHaveBeenCalledOnce();
    });

    it('opens the canonical Usage popover by row press and keyboard from More', async () => {
        getStorage().setState({ settings: settingsDefaults });
        // Configure only the endpoint boundary. Both the feature decision and Usage's popup/data owners stay real.
        await stubServerFeaturesFetch({ connectedServicesQuotasEnabled: true });
        await getServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, force: true });
        const feature = await renderHook(() => useFeatureDecision('connectedServices.quotas'), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
        });
        expect(feature.getCurrent()).toMatchObject({ state: 'enabled' });
        await feature.unmount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={entries()} activeId={null}
            onOpen={() => {}} preferences={{ orderedIds: [], placements: {
                'app-rail-usage': 'overflow', 'app-rail-machines': 'hidden', 'app-rail-account': 'hidden',
            } }} /></InboxSummaryProvider></InjectedAuthProvider>);
        await screen.pressByTestIdAsync('app-rail-more.trigger');
        await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
        expect(screen.findByTestId('app-rail-usage-popover')).toBeNull();
        await screen.pressByTestIdAsync('app-rail-more:app-rail-usage');
        expect(screen.findByTestId('app-rail-usage-popover')).not.toBeNull();
        await act(async () => screen.findByTestId('app-rail-more:app-rail-usage:scroll-frame')?.props.onKeyDown({ nativeEvent: { key: 'Enter' } }));
        expect(screen.findByTestId('app-rail-usage-popover')).toBeNull();
        await act(async () => screen.findByTestId('app-rail-more:app-rail-usage:scroll-frame')?.props.onKeyDown({ nativeEvent: { key: 'Enter' } }));
        expect(screen.findByTestId('app-rail-usage-popover')).not.toBeNull();
    });
});
