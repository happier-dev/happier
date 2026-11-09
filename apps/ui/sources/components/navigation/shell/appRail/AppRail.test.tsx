import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { stubServerFeaturesFetch } from '@/hooks/server/serverFeaturesTestUtils';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getStorage } from '@/sync/domains/state/storage';
import { INBOX_ARTIFACT_KINDS } from '@/sync/domains/artifacts/inboxArtifacts';
import { t } from '@/text';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import { AppRailSurface } from './AppRail';
import { AppRailAccount } from './AppRailAccount';
import { buildAppRailEntries, buildAppRailPlacementItems } from './appRailModel';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({ styleSheet: { hairlineWidth: 1 } }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Portal measurement is a platform boundary; DropdownMenu and all placement decisions stay real.
vi.mock('@/components/ui/popover', async (importOriginal) => ({ ...await importOriginal<typeof import('@/components/ui/popover')>(),
    Popover: (props: { children: (layout: { maxHeight: number; maxWidth: number }) => React.ReactNode }) =>
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
    const pages = ['channels', 'inspector', 'triage'].map((id): PluginPage => ({
        target: { kind: 'app' },
        visible: true,
        id: `plugin:acme.${id}:${id}`, pluginId: `acme.${id}`, descriptorId: id, localId: id,
        label: id, icon: 'note', order: 10, disabledReason: null, requestedPlacement: { kind: 'rail' },
        placement: {} as PluginPage['placement'], routePath: `/plugins/acme.${id}/${id}`,
    }));
    return buildAppRailEntries(resolveCompactAppDestinations({
        builtins: { externalSessions: true, inbox: true, workflows: true, friends: true, bots: true }, pages,
    }));
}

const layout = (height: number): LayoutChangeEvent => ({
    nativeEvent: { layout: { x: 0, y: 0, width: 56, height } },
} as LayoutChangeEvent);

describe('AppRail measured room', () => {
    // Rail slots are 40 px tall around a 36 px button: a finger's hit area takes half the 4 px gap above and below
    // (and the rail's free width beside it), so two stacked buttons' hit areas meet without overlapping.
    it('splits the gap between stacked rail buttons instead of reaching into the next one', async () => {
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={entries()} activeId={null} onOpen={() => {}}
                renderFooter={item => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>
        </HappierUiPlatformProvider>);
        const reach = readHitFrameReach(screen.findByTestId('app-rail:search')!);
        expect(reach?.top).toBe(2);
        expect(reach?.bottom).toBe(2);
        expect(reach?.left).toBe(4);
    });

    it('keeps the existing Inbox dot while its real summary is unknown and removes it only for known empty membership', async () => {
        const store = getStorage();
        store.setState({ isDataReady: false, artifacts: {}, artifactsLoaded: false,
            artifactInventoryKindsLoaded: [], artifactInventoryKindsPartial: [] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider>
            <AppRailSurface entries={entries()} activeId="inbox" onOpen={() => {}} renderFooter={item => <View testID={item.id} />} />
        </InboxSummaryProvider></InjectedAuthProvider>);
        try {
            const badge = screen.findHostByTestId('app-rail:inbox-badge');
            expect(badge).not.toBeNull();
            expect(badge?.props.children).toBeUndefined();
            await act(async () => { store.setState({ isDataReady: true, artifactInventoryKindsLoaded: INBOX_ARTIFACT_KINDS }); });
            await vi.waitFor(() => expect(screen.findHostByTestId('app-rail:inbox-badge')).toBeNull());
        } finally { await screen.unmount(); }
    });

    it('keeps the mounted Account trigger quiet for unrelated Profile changes and observes its name', async () => {
        const store = getStorage();
        store.setState(state => ({ profile: { ...state.profile, id: 'rail-account', name: 'Ada' } }));
        let commits = 0;
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
            <React.Profiler id="rail-account" onRender={() => { commits++; }}><AppRailAccount /></React.Profiler>
        </InjectedAuthProvider>);
        const before = commits;
        for (let tick = 1; tick <= 5; tick++) {
            await act(async () => store.setState(state => ({ profile: { ...state.profile, timestamp: tick } })));
        }
        expect(commits - before).toBe(0);
        await act(async () => store.setState(state => ({ profile: { ...state.profile, name: 'Grace' } })));
        expect(screen.findHostByTestId('app-rail-account')?.props.accessibilityLabel).toContain('Grace');
        await screen.unmount();
    });

    it('explains unavailable built-in destinations through the shared accessible button', async () => {
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={entries()} activeId={null} onOpen={() => {}}
            renderFooter={item => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>);
        const bots = screen.findHostByTestId('app-rail:bots');
        expect(bots?.props['aria-disabled']).toBe(true);
        const descriptionId = bots?.props['aria-describedby'];
        expect(typeof descriptionId).toBe('string');
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.nativeID === descriptionId
            && node.props.children === t('settingsActions.reasons.notAvailableInThisApp'))).not.toHaveLength(0);
    });

    it('keeps the unavailable destination explanation visible when it is placed in More', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={entries()} activeId={null} onOpen={() => {}}
            preferences={{ orderedIds: [], placements: { bots: 'overflow' } }}
            renderFooter={item => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>);
        await screen.pressByTestIdAsync('app-rail-more.trigger');
        await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
        expect(screen.findAll(node => typeof node.type === 'string'
            && node.props.children === t('settingsActions.reasons.notAvailableInThisApp'))).not.toHaveLength(0);
    });

    it('keeps focusable customization reachable with every destination and footer hidden', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const all = entries();
        const items = buildAppRailPlacementItems(all, true);
        const customize = vi.fn();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            updatesVisible onCustomize={customize}
            preferences={{ orderedIds: [], placements: Object.fromEntries(items.map(item => [item.id, 'hidden' as const])) }} /></InjectedAuthProvider>);
        const trigger = screen.findHostByTestId('app-rail-more.trigger');
        expect(trigger).not.toBeNull();
        expect(trigger?.props.role).toBe('button');
        expect(trigger?.props.tabIndex).not.toBe(-1);
        expect.soft(trigger?.props['aria-expanded']).toBe(false);
        await screen.pressByTestIdAsync('app-rail-more.trigger');
        await flushHookEffects({ cycles: 1, advanceTimersMs: 0 });
        expect.soft(screen.findHostByTestId('app-rail-more.trigger')?.props['aria-expanded']).toBe(true);
        expect.soft(screen.findAll((node) => typeof node.type === 'string'
            && node.props.children === t('commandPalette.noCommandsFound'))).toHaveLength(0);
        for (const item of items) expect(screen.findHostByTestId(`app-rail-more:${item.id}`)).toBeNull();
        const action = screen.findHostByTestId('app-rail-more.customize');
        expect(action?.props.role).toBe('button');
        expect(action?.props.tabIndex).not.toBe(-1);
        await screen.pressByTestIdAsync('app-rail-more.customize');
        expect(customize).toHaveBeenCalledOnce();
    });

    it('shows every destination in the reported tall rail even if the old plugin area was collapsed', async () => {
        const all = entries();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>);
        await act(async () => {
            // Layout is the OS boundary. The screenshot's rail has room for all eleven destinations.
            screen.findByTestId('app-rail')?.props.onLayout?.(layout(810));
            screen.findByTestId('app-rail-plugins')?.props.onLayout?.(layout(0));
        });
        expect(all.plugins.every((entry) => screen.findByTestId(`app-rail:${entry.id}`) !== null)).toBe(true);
        expect(screen.findByTestId('app-rail-more.trigger')).toBeNull();
    });

    it('separates the same icons into Work, Together, Library and plugin bands (owner Q8)', async () => {
        const all = entries();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>);
        await act(async () => screen.findByTestId('app-rail')?.props.onLayout?.(layout(1200)));
        const order: string[] = [];
        const walk = (node: unknown) => {
            if (!node || typeof node !== 'object') return;
            const json = node as { props?: { testID?: unknown }; children?: unknown[] | null };
            // Test-renderer instances: every element in render order, host and composite alike.
            const testID = json.props?.testID;
            if (testID === 'app-rail-band-separator') order.push('|');
            else if (typeof testID === 'string' && testID.startsWith('app-rail:') && !/-(surface|icon|badge)$/.test(testID)
                && order.at(-1) !== testID.slice('app-rail:'.length)) order.push(testID.slice('app-rail:'.length));
            for (const child of json.children ?? []) walk(child);
        };
        walk(screen.findByTestId('app-rail-destinations'));
        expect(order.join(' ')).toBe(['sessions search inbox projects workflows', 'friends bots', 'boards artifacts',
            'plugins plugin:acme.channels:channels plugin:acme.inspector:inspector plugin:acme.triage:triage'].join(' | '));
    });

    it('moves app destinations into More as well when the whole rail is too short', async () => {
        const all = entries();
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={all} activeId={null} onOpen={() => {}}
            renderFooter={(item) => <View testID={item.id} />} /></InboxSummaryProvider></InjectedAuthProvider>);
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
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><InboxSummaryProvider><AppRailSurface entries={all} activeId={null}
            onOpen={() => {}} onCustomize={customize} renderFooter={(item, trigger) => trigger
                ? trigger({ onPress: () => {}, open: false }) : <View testID={item.id} />}
            preferences={{ orderedIds: ['search', 'sessions'], placements: {
                search: 'overflow', 'app-rail-usage': 'overflow', 'app-rail-machines': 'hidden',
            } }} /></InboxSummaryProvider></InjectedAuthProvider>);
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
