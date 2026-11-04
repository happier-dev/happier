import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { NavigationContext, useNavigation } from '@react-navigation/native';

import { createDeferred, flushHookEffects, installTimerCensus, renderScreen, standardCleanup } from '@/dev/testkit';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { HomeHub } from './HomeHub';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { HOME_HUB_DEFAULT_LAYOUT, type HomeHubLayoutValue } from '@happier-dev/protocol/home';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WidgetAddSurface } from '@/components/widgets/add/WidgetAddSurface';
import type { WidgetAddSection } from '@/components/widgets/add/widgetAddModel';
import { SessionSurfaceEntityDragHandle, SessionSurfaceEntityTargetFeedback } from '@/components/sessions/board/SessionSurfaceEntityDrag';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { Text } from '@/components/ui/text/Text';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { decryptArtifactWithBody } from '@/sync/engine/artifacts/syncArtifacts';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { WelcomePlanet } from '@/components/atmosphere/moments/WelcomePlanet';
import { atmosphereStageStore } from '@/components/atmosphere/atmosphereStage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This composed screen statically imports transport consumers. Install the
// canonical external Socket boundary before that graph, then configure it below.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

type Layout = Pick<HomeHubLayoutValue, 'order' | 'hidden'> & Partial<Pick<HomeHubLayoutValue, 'items' | 'sections'>>;

/** Placed copies as the Home layout stores them (top-level widget items). */
const placed = (...instances: WidgetInstanceV1[]) => instances.map(instance => ({ kind: 'widget' as const, instance }));

// Initial server-owned layout; subsequent assertions inspect the acknowledged HTTP Artifact.
const settings = vi.hoisted(() => ({
    layout: { order: [], hidden: [] } as Layout,
    guidanceKind: 'select_session' as string,
    viewport: { width: 800, height: 600 },
    positions: {} as Record<string, number>,
    scrollOffset: 0,
    presented: undefined as boolean | undefined,
    measureAtmosphere: false,
}));
const atmospherePaints = vi.hoisted(() => ({ count: 0, font: {} }));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    // Font readiness and physical picture allocation are native boundaries.
    useFont: () => atmospherePaints.font,
    createPicture: () => { atmospherePaints.count++; return { dispose() {} }; },
}));
installDisconnectedServerSocketBoundary();
let artifact = createHomeHubArtifactHttpBoundary('account-home');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;
let restoreSyncLoader: (() => void) | undefined;

// Plugin widgets: the app shell's projection, each widget's own data (inside the plugin, behind the
// surface host boundary), and how often the hub and its sections render.
const widgets = vi.hoisted(() => ({
    projection: null as PluginUiProjectionModel | null,
    data: {} as Record<string, number>,
    dataListeners: new Set<() => void>(),
    bodyRenders: {} as Record<string, number>,
    bodyMounts: {} as Record<string, number>,
    hubRenders: 0,
    setupRenders: 0,
    composerSuggestions: [] as (string | undefined)[],
    focused: true,
    focusListeners: new Set<() => void>(),
}));

// The usage summary owner's value (a server read that arrives, and can go, after the home draws).
const usage = vi.hoisted(() => ({
    summary: { entries: [] as unknown[], asOf: null, source: 'none' } as { entries: unknown[]; asOf: null; source: string },
    listeners: new Set<() => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => settings.viewport });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@react-navigation/native', async () => {
    const ReactModule = await import('react');
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    const subscribe = (listener: () => void) => {
        widgets.focusListeners.add(listener);
        return () => { widgets.focusListeners.delete(listener); };
    };
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => ReactModule.useSyncExternalStore(subscribe, () => widgets.focused),
    };
});
// The plugin surface host is the plugin runtime boundary: past it the plugin runs its own code
// and keeps its own data. This stand-in renders one widget's data from its own store.
vi.mock('@/components/plugins/surfaces', async () => {
    const ReactModule = await import('react');
    const subscribe = (listener: () => void) => {
        widgets.dataListeners.add(listener);
        return () => { widgets.dataListeners.delete(listener); };
    };
    return {
        PluginInlineSurfaceHost: (props: { placement: { binding: { surface: { localId: string } } }; launchInput?: Readonly<Record<string, unknown>> }) => {
            const localId = props.placement.binding.surface.localId;
            const value = ReactModule.useSyncExternalStore(subscribe, () => widgets.data[localId] ?? 0);
            widgets.bodyRenders[localId] = (widgets.bodyRenders[localId] ?? 0) + 1;
            ReactModule.useEffect(() => {
                widgets.bodyMounts[localId] = (widgets.bodyMounts[localId] ?? 0) + 1;
                return () => { widgets.bodyMounts[localId] = (widgets.bodyMounts[localId] ?? 0) - 1; };
            }, [localId]);
            return `widget:${localId}=${value}${props.launchInput?.branch ? ` branch:${String(props.launchInput.branch)}` : ''}`;
        },
    };
});
// The popover's positioning and portal are a platform overlay boundary (DOM measurement); past it,
// the content renders as it would inside the real popover.
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const ReactModule = await import('react');
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        Popover: (props: { open: boolean; children: React.ReactNode | ((p: { maxHeight: number; maxWidth: number }) => React.ReactNode) }) => (
            props.open
                ? ReactModule.createElement(ReactModule.Fragment, null, typeof props.children === 'function'
                    ? props.children({ maxHeight: 640, maxWidth: 360 })
                    : props.children)
                : null
        ),
    };
});
vi.mock('@/components/ui/overlays/FloatingOverlay', async (importOriginal) => {
    const ReactModule = await import('react');
    return { ...(await importOriginal<Record<string, unknown>>()), FloatingOverlay: (props: { children: React.ReactNode }) => ReactModule.createElement(ReactModule.Fragment, null, props.children) };
});
// Native/web modal placement and focus containment are platform boundaries; the real modal chrome
// and Home editor below them still render, including their live layout writes.
vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('BaseModal', props, children)
    ),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

// Each section is its own owner with its own tests; the home decides only which show, and where.
vi.mock('./composer/HubComposerSection', () => ({
    // Records how its suggestions are presented; the composer itself is its own suite's.
    HubComposerSection: (props: { suggestions?: string }) => {
        widgets.composerSuggestions.push(props.suggestions);
        return 'section:start';
    },
}));
vi.mock('./HubAttentionSection', () => ({ HubAttentionSection: () => 'section:attention' }));
vi.mock('./HubSetupSection', () => ({
    HubSetupSection: () => {
        widgets.setupRenders += 1;
        return 'section:setup';
    },
}));
vi.mock('@/components/automations/home/AutomationsLatestRunsSection', () => ({ AutomationsLatestRunsSection: () => 'section:automations' }));
// The status line is its own owner (it reads the Activity summary, tested there).
vi.mock('./header/HubStatusLine', () => ({ HubStatusLine: () => 'status-line' }));
vi.mock('@/components/homes/journeys/label/HomeWhereLine', () => ({ HomeWhereLine: () => 'home-where' }));
vi.mock('./usage/useUsageSummary', async () => {
    const ReactModule = await import('react');
    const subscribe = (listener: () => void) => {
        usage.listeners.add(listener);
        return () => { usage.listeners.delete(listener); };
    };
    return { useUsageSummary: () => ReactModule.useSyncExternalStore(subscribe, () => usage.summary) };
});

async function setUsage(entries: unknown[]) {
    await act(async () => {
        usage.summary = { entries, asOf: null, source: entries.length > 0 ? 'live' : 'none' };
        for (const listener of [...usage.listeners]) listener();
    });
    await flushHookEffects({ cycles: 2 });
}
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => {
        // Only the hub itself reads this model, so it counts the hub's renders.
        widgets.hubRenders += 1;
        return { kind: settings.guidanceKind };
    },
}));
vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    // The guidance's own page is its suite's; Home supplies only what it adds beneath it.
    SessionGettingStartedGuidance: (props: { accessory?: unknown }) => ['guidance', props.accessory ?? null],
}));

afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    restoreActionLoader = undefined;
    restoreSyncLoader?.();
    restoreSyncLoader = undefined;
    artifact = createHomeHubArtifactHttpBoundary('account-home');
    settings.layout = { order: [], hidden: [] };
    settings.guidanceKind = 'select_session';
    settings.viewport = { width: 800, height: 600 };
    settings.positions = {};
    settings.scrollOffset = 0;
    settings.presented = undefined;
    settings.measureAtmosphere = false;
    usage.summary = { entries: [], asOf: null, source: 'none' };
    usage.listeners.clear();
    widgets.projection = null;
    widgets.data = {};
    widgets.dataListeners.clear();
    widgets.bodyRenders = {};
    widgets.bodyMounts = {};
    widgets.hubRenders = 0;
    widgets.setupRenders = 0;
    widgets.composerSuggestions = [];
    widgets.focused = true;
    widgets.focusListeners.clear();
});

function RoutedHomeBoundary({ children }: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
}

async function renderHome(request = artifact.request, initial: 'stored' | 'missing' = 'stored') {
    if (!connection) {
        if (initial === 'stored') artifact.seed({ v: 1, items: [], ...settings.layout });
        restoreSyncLoader = (await loadSyncSingletonForTests()).dispose;
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-layout.test', accountId: 'account-home', request });
        const scope = { serverId: connection.home.id, accountId: 'account-home' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
    }
    if (settings.measureAtmosphere) storage.setState(state => ({ ...state,
        localSettings: { ...state.localSettings, homeWelcomeSeenAt: null },
        settings: { ...state.settings, homeAtmosphere: { ...state.settings.homeAtmosphere,
            source: 'planet', moments: { ...state.settings.homeAtmosphere.moments, welcome: true, loading: false },
        } },
    }));
    const element = () => (
        // The route adapter reads navigator presence before consulting useIsFocused.
        // Model a routed Home, rather than a preview that is always focused.
        <RoutedHomeBoundary>
        <InjectedAuthProvider credentials={connection!.credentials}>
        <AppShellPluginUiProjectionValueProvider
            value={{
                pluginUiProjection: widgets.projection ?? EMPTY_PLUGIN_UI_PROJECTION,
                pluginBrowserProjection: null,
                phase: 'current',
                interactionEnabled: true,
                machineId: 'machine-1',
                serverId: connection!.home.id,
                platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
                reloadClientExecutables: () => {},
                reloadConnectedAccountProjection: () => {},
            }}
        >
            {settings.presented === undefined ? <HomeHub /> : <PluginSurfaceFocusEligibilityProvider active={settings.presented} presentationActive={settings.presented}>
                <HomeHub />
            </PluginSurfaceFocusEligibilityProvider>}
        </AppShellPluginUiProjectionValueProvider>
        </InjectedAuthProvider>
        </RoutedHomeBoundary>
    );
    const contentNode = { getBoundingClientRect: () => ({ left: 0, top: 56 - settings.scrollOffset, width: 800, height: 800 }) };
    const rendered = await renderScreen(element(), {
        createNodeMock: node => {
            const testID = node.props && typeof node.props === 'object' && 'testID' in node.props ? node.props.testID : undefined;
            if (settings.measureAtmosphere) return {
                getInnerViewNode: () => contentNode,
                scrollTo: () => {},
                getBoundingClientRect: () => ({ left: 0, top: 0, width: settings.viewport.width, height: settings.viewport.height }),
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                    done(0, 0, settings.viewport.width, settings.viewport.height),
            };
            if (testID === 'home-hub') return { getInnerViewNode: () => contentNode, scrollTo: () => {},
                getBoundingClientRect: () => ({ left: 0, top: 56, width: settings.viewport.width, height: settings.viewport.height }) };
            const id = typeof testID === 'string' ? testID.slice('home-hub.section.'.length) : '';
            return typeof testID === 'string' && testID.startsWith('home-hub.section.')
                ? { getBoundingClientRect: () => ({ left: 0, top: 56 + (settings.positions[id] ?? 0) - settings.scrollOffset, width: settings.positions[id] === undefined ? 0 : 600, height: 200 }) }
                : null;
        },
    });
    const screen = Object.assign(rendered, {
        /** Re-render under the app shell projection currently in `widgets.projection`. */
        rerender: async () => {
            await rendered.update(element());
            await flushHookEffects({ cycles: 2 });
        },
    });
    await flushHookEffects({ cycles: 2 });
    return screen;
}

/** The acknowledged layout's items, and every placed copy in them (inside groups too). */
function storedItems() {
    return artifact.layout().items ?? [];
}
function storedInstances(): WidgetInstanceV1[] {
    return storedItems().flatMap(item => item.kind === 'widget' ? [item.instance] : item.children.map(child => child.instance));
}

/** Customize is a page state; the list that shows, hides and orders sections opens from its bar. */
async function openSections(screen: Awaited<ReturnType<typeof renderHome>>) {
    await act(async () => { screen.pressByTestId('home-hub.customize'); });
    await flushHookEffects({ cycles: 2 });
    await act(async () => { screen.pressByTestId('home-hub.customizing.sections'); });
    await flushHookEffects({ cycles: 2 });
}

/** Whether a rendered subtree draws this text (a stubbed section renders its id as text). */
function holdsText(node: { findAll: (match: (candidate: { children: readonly unknown[] }) => boolean) => readonly unknown[] }, text: string): boolean {
    return node.findAll(candidate => candidate.children.includes(text)).length > 0;
}

function shownSections(text: string): string[] {
    return [...text.matchAll(/section:([a-z]+)/g)].map((match) => match[1]!);
}

describe('HomeHub', () => {
    it('parks planet paints, moments and timers with retained Home and returns without replaying Welcome', async () => {
        const before = storage.getState();
        settings.presented = true;
        settings.measureAtmosphere = true;
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date', 'performance'] });
        const timers = installTimerCensus(stack => stack.replaceAll('\\', '/').includes('/components/atmosphere/') ? 'atmosphere' : null);
        let fires = 0;
        const interval = globalThis.setInterval;
        vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
            const atmosphereTimer = new Error().stack?.replaceAll('\\', '/').includes('/components/atmosphere/');
            return interval(() => { if (atmosphereTimer) fires++; callback(...args); }, delay);
        });
        let screen: Awaited<ReturnType<typeof renderHome>> | undefined;
        try {
            screen = await renderHome();
            await vi.waitFor(() => expect(screen!.findByTestId('home-hero')).not.toBeNull());
            await act(async () => {
                for (let node = screen!.findByTestId('home-hero'); node; node = node.parent) {
                    if (typeof node.type === 'string') node.props.onLayout?.({ nativeEvent: {
                        layout: { x: 0, y: 0, width: settings.viewport.width, height: settings.viewport.height },
                    } });
                }
            });
            // A first arrival exercises the real Welcome state owner; landing it enters digit rest.
            const welcome = screen.findByType(WelcomePlanet);
            await act(async () => welcome.props.onLanded());
            expect(screen.findAllByType(WelcomePlanet)).toHaveLength(0);
            const seen = storage.getState().localSettings.homeWelcomeSeenAt;
            expect(seen).not.toBeNull();
            const restingPaints = atmospherePaints.count;
            await act(async () => { vi.advanceTimersByTime(2000); });
            expect(atmospherePaints.count).toBeGreaterThan(restingPaints);
            settings.presented = false;
            await screen.rerender();
            const hiddenPaints = atmospherePaints.count;
            const hiddenFires = fires;
            await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
                ...state.settings.homeAtmosphere, planet: { ...state.settings.homeAtmosphere.planet, style: 'rich' },
            } } })));
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(atmospherePaints.count - hiddenPaints).toBe(0);
            expect(fires - hiddenFires).toBe(0);
            expect(timers.read().filter(timer => timer.consumer === 'atmosphere')).toHaveLength(0);
            expect(atmosphereStageStore.get().panes).toHaveLength(0);
            settings.presented = true;
            await screen.rerender();
            expect(screen.findAllByType(WelcomePlanet)).toHaveLength(0);
            expect(storage.getState().localSettings.homeWelcomeSeenAt).toBe(seen);
            const resumedPaints = atmospherePaints.count;
            await act(async () => { vi.advanceTimersByTime(2000); });
            expect(atmospherePaints.count).toBeGreaterThan(resumedPaints);
        } finally {
            await screen?.unmount();
            storage.setState(state => ({ ...state,
                settings: { ...state.settings, homeAtmosphere: before.settings.homeAtmosphere },
                localSettings: { ...state.localSettings, homeWelcomeSeenAt: before.localSettings.homeWelcomeSeenAt },
            }));
            timers.stop();
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('parks Home subscriptions while hidden and restores current layout without losing customization', async () => {
        settings.presented = true;
        let reads = 0;
        const screen = await renderHome(async (input, init) => {
            if (new URL(String(input)).pathname === `/v1/artifacts/${artifact.artifactId}` && init?.method !== 'POST') reads++;
            return artifact.request(input, init);
        });
        try {
            await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
            await act(async () => { screen.pressByTestId('home-hub.customize'); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findByTestId('home-hub.customizing.sections')).toBeTruthy();
            settings.presented = false;
            await screen.rerender();
            const parkedReads = reads;
            artifact.seed({ v: 1, items: [], order: ['setup', 'start'], hidden: ['automations'] });
            const wire: Artifact = await (await artifact.request(`https://home-layout.test/v1/artifacts/${artifact.artifactId}`)).json();
            const updated = await decryptArtifactWithBody({ artifact: wire, encryption: null, artifactDataKeys: new Map() });
            if (!updated) throw new Error('Expected the real Home layout codec to open its fixture');
            await act(async () => { storage.getState().updateArtifact(updated); });
            await flushHookEffects({ cycles: 8 });
            expect(reads).toBe(parkedReads);
            settings.presented = true;
            await screen.rerender();
            await vi.waitFor(() => expect(shownSections(screen.getTextContent())).toEqual(['setup', 'start', 'attention']));
            expect(reads).toBeGreaterThan(parkedReads);
            expect(screen.findByTestId('home-hub.customizing.sections')).toBeTruthy();
        } finally { await screen.unmount(); }
    });

    it('reserves the phone sections while its acknowledged layout is unknown, then replaces the placeholder', async () => {
        settings.viewport = { width: 390, height: 900 };
        settings.layout = { order: ['attention', 'automations', 'start'], hidden: ['setup'] };
        const read = createDeferred<void>();
        let pending = true;
        const screen = await renderHome(async (input, init) => {
            if (pending && new URL(String(input)).pathname === `/v1/artifacts/${artifact.artifactId}`) await read.promise;
            return artifact.request(input, init);
        });
        try {
            expect(screen.findByTestId('home-hero')).toBeNull();
            expect(shownSections(screen.getTextContent())).toEqual([]);
            await act(async () => { pending = false; read.resolve(); });
            await flushHookEffects({ cycles: 20 });
            expect(screen.findByTestId('home-hub.layout.loading')).toBeNull();
            expect(shownSections(screen.getTextContent())).toEqual(['attention', 'automations', 'start']);
            expect(holdsText(screen.findByTestId('home-hero')!, 'section:start')).toBe(false);
        } finally { read.resolve(); }
    });
    it('says once that the Home cannot be reached while its sections wait, and offers Retry', async () => {
        const screen = await renderHome();
        publishAppliedActiveServerRuntimeAvailability(true);
        await act(async () => { storage.setState({ endpointStatus: 'offline', socketStatus: 'disconnected', endpointReason: null, syncError: null }); });
        expect(screen.findAllByTestId('home-hub').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('home-unreachable').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('home-unreachable-retry').length).toBeGreaterThan(0);
    });

    it('holds a quiet page while it is not known yet whether a machine can run a session', async () => {
        settings.guidanceKind = 'loading';
        const loading = await renderHome();
        // Neither the hub nor the getting-started guidance (and its mark) draws until the answer.
        expect(loading.findByTestId('home-hub.loading') ?? loading.findByTestId('home-unreachable')).toBeTruthy();
        expect(loading.getTextContent()).not.toContain('guidance');
        expect(shownSections(loading.getTextContent())).toEqual([]);
        standardCleanup();

        settings.guidanceKind = 'connect_machine';
        const firstRun = await renderHome();
        expect(firstRun.getTextContent()).toContain('guidance');
    });

    it('keeps the default composer hidden after an initial layout read failure and retries the Account layout', async () => {
        settings.layout = { order: ['attention', 'automations', 'start'], hidden: ['setup'] };
        let failRead = true;
        const screen = await renderHome(async (input, init) => {
            // A reachable Home with no Machines: an unanswered census would read as an unreachable
            // Home, whose page replaces the layout failure this case exercises.
            if (new URL(String(input)).pathname === '/v1/machines') return Response.json([]);
            if (failRead && new URL(String(input)).pathname === `/v1/artifacts/${artifact.artifactId}`) {
                return Response.json({ invalid: 'artifact response' });
            }
            return artifact.request(input, init);
        });
        await vi.waitFor(() => expect(screen.findByTestId('home-hub.layout.error')).not.toBeNull());
        expect(screen.findByTestId('home-hero')).toBeNull();
        expect(shownSections(screen.getTextContent())).toEqual([]);
        failRead = false;
        await screen.pressByTestIdAsync('home-hub.layout.retry');
        await vi.waitFor(() => expect(shownSections(screen.getTextContent())).toEqual(['attention', 'automations', 'start']));
        expect(holdsText(screen.findByTestId('home-hero')!, 'section:start')).toBe(false);
    });

    it('asks an Account with no name on the no-computer Home, through the one Add your name block and its dismissal', async () => {
        settings.guidanceKind = 'connect_machine';
        const screen = await renderHome();
        const scope = storage.getState().profileScope!;
        const setName = async (name: string | null) => {
            await act(async () => { storage.setState({ profile: { ...storage.getState().profile, id: scope.accountId, name } }); });
            await flushHookEffects({ cycles: 3 });
        };
        await setName(null);
        expect(screen.getTextContent()).toContain('guidance');
        expect(screen.findByTestId('hub-setup.addName')).toBeTruthy();
        // A name set anywhere (another device, Settings, an Action) removes it.
        await setName('Maya Chen');
        expect(screen.findByTestId('hub-setup.addName')).toBeNull();
        await setName(null);
        expect(screen.findByTestId('hub-setup.addName')).toBeTruthy();
        // Hiding it is the Home setup step every surface shares, kept on the Account layout.
        await act(async () => { screen.pressByTestId('hub-setup.addName.dismiss'); });
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByTestId('hub-setup.addName')).toBeNull();
        expect(artifact.layout().hidden).toContain('setup:addName');
    });
    it('shows the Account\'s sections in its order, never hiding "Start a session" or "Needs your attention"', async () => {
        settings.layout = { order: ['automations', 'start'], hidden: ['setup', 'start', 'attention'] };
        const screen = await renderHome();

        expect(shownSections(screen.getTextContent())).toEqual(['automations', 'start', 'attention']);
    });

    it('leads Home with the atmosphere hero: the greeting and a leading composer on the seam', async () => {
        const leading = await renderHome();
        const hero = leading.findByTestId('home-hero');
        expect(hero).toBeTruthy();
        // The composer leads Home by default, so it stands in the hero under the greeting, once.
        expect(shownSections(leading.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);
        expect(holdsText(hero!, 'section:start')).toBe(true);
    });

    it('keeps the Home Look entry after selecting None and can reopen it to restore Planet', async () => {
        const screen = await renderHome();
        await screen.pressByTestIdAsync('look-chip');
        await screen.pressByTestIdAsync('look-source:none');
        expect(storage.getState().settings.homeAtmosphere.source).toBe('none');
        expect(screen.findByTestId('home-hero')).toBeNull();
        // Closing and reopening exercises the actual Home entry, without Customize.
        if (screen.findByTestId('look-panel')) await screen.pressByTestIdAsync('look-chip');
        expect(screen.findByTestId('look-chip')).toBeTruthy();
        await screen.pressByTestIdAsync('look-chip');
        await screen.pressByTestIdAsync('look-source:planet');
        expect(storage.getState().settings.homeAtmosphere.source).toBe('planet');
        expect(screen.findByTestId('home-hero')).toBeTruthy();
    });

    it('keeps a composer moved below other sections where it was put, under the atmosphere hero', async () => {
        settings.layout = { order: ['automations', 'start'], hidden: [] };
        const moved = await renderHome();
        expect(moved.findByTestId('home-hero')).toBeTruthy();
        expect(shownSections(moved.getTextContent())).toEqual(['automations', 'start', 'attention', 'setup']);
        expect(holdsText(moved.findByTestId('home-hero')!, 'section:start')).toBe(false);
        // Moved lower it still stands over the atmosphere: its suggestions keep the hero's presentation,
        // never the plain page's tiles.
        expect(widgets.composerSuggestions.at(-1)).toBe('links');
    });

    it('presents the composer\'s suggestions as tiles only on the plain page', async () => {
        settings.layout = { order: ['automations', 'start'], hidden: [] };
        const screen = await renderHome();
        await screen.pressByTestIdAsync('look-chip');
        await screen.pressByTestIdAsync('look-source:none');
        expect(screen.findByTestId('home-hero')).toBeNull();
        expect(widgets.composerSuggestions.at(-1)).toBe('tiles');
    });

    it('opens Customize over the live page: switches, keyboard moves and reset write the Account layout', async () => {
        const screen = await renderHome();
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);

        await openSections(screen);
        expect(screen.findByTestId('home-hub.customize.popover')).toBeTruthy();
        // Always shown: no switch.
        expect(screen.findByTestId('home-layout.attention.shown')).toBeNull();
        await act(async () => {
            await screen.findByTestId('home-layout.automations.shown')!.props.onValueChange(false);
        });
        await flushHookEffects({ cycles: 2 });
        // The page behind updates at once.
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup']);
        await act(async () => {
            await screen.findByTestId('home-layout.automations.shown')!.props.onValueChange(true);
        });
        await flushHookEffects({ cycles: 2 });
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);

        // Keyboard reordering stages a move on the real shared Entity drag owner.
        await act(async () => {
            screen.findByTestId('home-layout.automations.grip')!.props.onKeyDown({ key: 'Enter', preventDefault() {} });
        });
        await act(async () => {
            screen.findByTestId('home-layout.automations.grip')!.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
        });
        const announcement = (id: string) => screen.findByTestId(id)!.findAllByType(Text)
            .map(node => node.props.children).join('');
        // Home also mounts surface feedback. The foreground list owns this
        // move's announcement and its acknowledgement, so Home stays silent.
        expect.soft(announcement('home-layout.reorder.status')).not.toBe('');
        expect.soft(announcement('home-hub.widget-move-live-region')).toBe('');
        await act(async () => {
            screen.findByTestId('home-layout.automations.grip')!.props.onKeyDown({ key: 'Enter', preventDefault() {} });
        });
        await flushHookEffects({ cycles: 2 });
        await vi.waitFor(() => expect(artifact.writes.at(-1)).toMatchObject({
            order: ['start', 'attention', 'automations', 'setup'],
            hidden: [],
        }));
        expect.soft(announcement('home-layout.reorder.status')).toBe('');
        expect.soft(announcement('home-hub.widget-move-live-region')).toBe('');

        screen.pressByTestId('home-layout.reset');
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout()).toEqual(HOME_HUB_DEFAULT_LAYOUT);
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);

        // The header button closes it again.
        screen.pressByTestId('home-hub.customize');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-hub.customize.popover')).toBeNull();
    });

    it('offers dismissed setup steps back from Customize', async () => {
        settings.layout = { order: [], hidden: ['setup:addPhone', 'setup:addMachine'] };
        const screen = await renderHome();
        await openSections(screen);

        screen.pressByTestId('home-layout.hiddenSetupSteps');
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout().hidden).not.toContain('setup:addPhone');
        expect(artifact.layout().hidden).not.toContain('setup:addMachine');
        expect(screen.findByTestId('home-layout.hiddenSetupSteps')).toBeNull();
    });

    it('customizes Home in a phone sheet, applies changes behind it, and dismisses back to Home', async () => {
        settings.viewport = { width: 390, height: 844 };
        const screen = await renderHome();
        await openSections(screen);

        expect(screen.findByTestId('home-hub.customize.popover')).toBeNull();
        const modal = screen.findByType('BaseModal');
        expect(modal.props.placement).toBe('bottom');
        const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
        expect(screen.findByType(ModalCardFrame).props.presentation).toBe('sheet');
        await act(async () => {
            await screen.findByTestId('home-layout.automations.shown')!.props.onValueChange(false);
        });
        await flushHookEffects({ cycles: 2 });
        expect(shownSections(screen.getTextContent())).not.toContain('automations');
        expect(artifact.layout().hidden).toContain('automations');

        await act(async () => modal.props.onClose());
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-layout.automations.shown')).toBeNull();
        expect(shownSections(screen.getTextContent())).not.toContain('automations');
        // Home is still being customized: the sheet reopens from the same bar.
        await act(async () => screen.pressByTestId('home-hub.customizing.sections'));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByType('BaseModal').props.placement).toBe('bottom');
    });

    it('keeps the Home section structure stable while usage arrives and goes away', async () => {
        settings.layout = { order: ['start', 'attention', 'setup', 'automations'], hidden: [] };
        const screen = await renderHome();
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);

        await setUsage([{ key: 'claude' }]);
        await setUsage([]);

        // Usage arriving changes the Usage section's content, never the page's structure.
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);
    });
});

describe('HomeHub plugin widgets', () => {
    it('shows Capacity through the canonical widget frame only for a missing layout, without writing it on mount', async () => {
        const screen = await renderHome(artifact.request, 'missing');
        expect(screen.findByTestId('home-hub.section.default:builtin:usage_capacity')).toBeTruthy();
        expect(screen.findByTestId('home-hub.section.usage')).toBeNull();
        expect(artifact.writes).toEqual([]);
    });

    it('keeps a present-empty layout empty rather than adding the missing-Home Capacity preset', async () => {
        const screen = await renderHome();
        expect(screen.findByTestId('home-hub.section.default:builtin:usage_capacity')).toBeNull();
        expect(artifact.writes).toEqual([]);
    });
    const LATEST = 'default:acme.review/latest';
    const CHECKS = 'default:acme.ci/checks';

    function installWidgets() {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.review', localId: 'latest', title: 'Latest reviews', target: 'app', homeDefault: 'shown' },
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app', homeDefault: 'shown' },
            { pluginId: 'acme.ci', localId: 'runs', title: 'Recent runs', target: 'app' },
            // Session types are available on Home but need an explicitly configured instance.
            { pluginId: 'acme.ci', localId: 'session-log', title: 'Session log', target: 'session' },
        ], {
            'acme.review': widgetInstalledPackage('acme.review', 'Review Assistant'),
            'acme.ci': widgetInstalledPackage('acme.ci', 'CI'),
        });
    }

    function layoutEvent(y: number, height: number) {
        return { nativeEvent: { layout: { x: 0, y, width: 600, height } } };
    }

    /** The page's viewport and each widget section's place in it, as the platform reports them. */
    async function lay(screen: Awaited<ReturnType<typeof renderHome>>, places: Readonly<Record<string, number>>) {
        await act(async () => {
            settings.positions = { ...places };
            screen.findByTestId('home-hub')!.props.onLayout(layoutEvent(0, 800));
            for (const id of Object.keys(places)) {
                // Layout y belongs to the grid cell. The native/DOM node supplies content geometry.
                screen.findByTestId(`home-hub.section.${id}`)!.props.onLayout(layoutEvent(0, 200));
            }
        });
        await flushHookEffects({ cycles: 2 });
    }

    it.each(['widget', 'group'] as const)('keeps a hidden %s in Sections, suspends its data subscription, and restores the same copy', async kind => {
        widgets.projection = widgetProjectionOf([{ pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' }],
            { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const instance: WidgetInstanceV1 = { v: 1, id: 'checks-copy', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} };
        const child = { kind: 'widget' as const, instance, size: 'small' as const };
        const sectionId = kind === 'widget' ? instance.id : 'checks-group';
        const items: HomeHubLayoutValue['items'] = kind === 'widget' ? [child] : [{ kind: 'group', id: sectionId, title: 'Checks group',
            width: 'full', frameStyle: 'card', dividers: 'hairline', children: [child] }];
        settings.layout = { order: ['start', 'attention', 'setup', sectionId, 'automations'], hidden: [], items };
        const screen = await renderHome(async (input, init) => {
            // Exercise the explicit Remove under the existing persisted UI waiver.
            // This single-layout HTTP boundary does not host approval Artifacts.
            if (new URL(String(input)).pathname === '/v2/account/settings') return Response.json({
                content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                    approvalWaivedSurfaces: { 'widgets.item.remove': ['ui'] } } } }, version: 1,
            });
            return artifact.request(input, init);
        });
        await lay(screen, { [instance.id]: 300 });
        await vi.waitFor(() => expect(widgets.bodyMounts.checks).toBe(1));
        await openSections(screen);
        const before = structuredClone(artifact.layout());
        const toggle = () => screen.findByTestId(`home-layout.${sectionId}.shown`);
        expect(toggle()).not.toBeNull();
        await act(async () => toggle()!.props.onValueChange(false));
        await vi.waitFor(() => expect(artifact.layout().hidden).toContain(sectionId));
        expect(artifact.layout().items).toEqual(before.items);
        expect(artifact.layout().order).toEqual(before.order);
        expect(toggle()!.props.value).toBe(false);
        expect(screen.findByTestId(`home-hub.section.${instance.id}`)).toBeNull();
        expect(widgets.bodyMounts.checks).toBe(0);
        expect(widgets.dataListeners.size).toBe(0);
        await act(async () => screen.pressByTestId('home-hub.customizing.add'));
        await flushHookEffects({ cycles: 3 });
        const add = screen.root.findAllByType(WidgetAddSurface).find(node => node.props.open === true)!;
        const entry = add.props.sections.flatMap((section: WidgetAddSection) => section.entries)
            .find((candidate: { title: string }) => candidate.title === 'Checks')!;
        // Off in Sections means it does not contribute to "N on Home" or "On Home" in Add.
        expect(entry.added).toBe(false);
        expect(entry.count).toBeUndefined();
        await act(async () => add.props.onRequestClose());
        await act(async () => toggle()!.props.onValueChange(true));
        await vi.waitFor(() => expect(artifact.layout().hidden).not.toContain(sectionId));
        await lay(screen, { [instance.id]: 300 });
        await vi.waitFor(() => expect(widgets.bodyMounts.checks).toBe(1));
        expect(toggle()!.props.value).toBe(true);
        expect(artifact.layout()).toEqual(before);
        if (kind === 'widget') {
            const menu = screen.findAllByType(ItemRowActions).find(node => node.props.overflowTriggerTestID === `home-hub.${instance.id}.menuTrigger`)!;
            await act(async () => menu.props.actions.find((action: { id: string }) => action.id === 'hide').onPress());
            await vi.waitFor(() => expect(artifact.layout().items).toEqual([]));
            expect(artifact.layout().hidden).not.toContain(instance.id);
        }
    });

    it('draws a group as one frame around its widgets; a grouped widget offers group entries, never its own frame', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const first: WidgetInstanceV1 = { v: 1, id: 'checks-first', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} };
        const second = { ...first, id: 'checks-second' };
        // The Account layout as stored: one titled Card · Lines group holding both copies.
        settings.layout = { order: ['start', 'attention', 'setup', 'happier'], hidden: [], items: [{ kind: 'group', id: 'happier', title: 'happier',
            width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
                { kind: 'widget', instance: first, size: 'small' }, { kind: 'widget', instance: second, size: 'small' }] }] } as unknown as Layout;
        const screen = await renderHome();
        await lay(screen, { [first.id]: 300, [second.id]: 300 });

        // Both widgets are drawn inside the group's one frame, under its title.
        const group = screen.findByTestId('home-hub.section.happier.group')!;
        expect(group.findAll(node => node.props.testID === `home-hub.section.${first.id}`).length).toBeGreaterThan(0);
        expect(group.findAll(node => node.props.testID === `home-hub.section.${second.id}`).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('happier');

        const childMenu = screen.findAllByType(ItemRowActions).find(node => node.props.overflowTriggerTestID === `home-hub.${first.id}.menuTrigger`)!;
        const ids = childMenu.props.actions.map((action: { id: string }) => action.id);
        expect(ids).toEqual(expect.arrayContaining(['removeFromGroup', 'ungroup']));
        expect(ids).not.toContain('frameStyle');

        // Remove from group: the widget goes back on its own card beside the group; the group keeps the other.
        await act(async () => { childMenu.props.actions.find((action: { id: string }) => action.id === 'removeFromGroup').onPress(); });
        await vi.waitFor(() => {
            const items = (artifact.layout() as unknown as { items: Array<{ kind: string; id?: string; instance?: { id: string }; children?: unknown[] }> }).items;
            expect(items.find(item => item.kind === 'group')?.children).toHaveLength(1);
            expect(items.some(item => item.kind === 'widget' && item.instance?.id === first.id)).toBe(true);
        });
    });

    it('lifts a whole group by its grip, and reorders widgets inside a group on the line between them', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const copy = (id: string): WidgetInstanceV1 => ({ v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} });
        const lone = copy('lone'); const first = copy('grouped-first'); const second = copy('grouped-second');
        settings.layout = { order: ['start', 'attention', 'setup', lone.id, 'happier'], hidden: [], items: [{ kind: 'widget', instance: lone },
            { kind: 'group', id: 'happier', title: 'happier', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
                { kind: 'widget', instance: first, size: 'small' }, { kind: 'widget', instance: second, size: 'small' }] }] };
        const screen = await renderHome();
        await lay(screen, { [lone.id]: 300, [first.id]: 500, [second.id]: 500 });
        // On a hover pointer the cards carry no grips until Home is being customized.
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        const dragOf = (testID: string) => screen.root.findAllByType(SessionSurfaceEntityDragHandle).find(handle => handle.props.testID === testID)!.props.drag;
        const destination = (drag: ReturnType<typeof dragOf>, match: Readonly<Record<string, unknown>>) => drag.runtime.getDestinations(drag.sourceId)
            .find(entry => entry.destination !== null && typeof entry.destination === 'object'
                && Object.entries(match).every(([key, value]) => (entry.destination as Record<string, unknown>)[key] === value));
        const carryTo = async (drag: ReturnType<typeof dragOf>, match: Readonly<Record<string, unknown>>) => {
            let carry: ReturnType<typeof drag.runtime.begin> = null;
            await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
            let target: ReturnType<typeof destination>;
            await vi.waitFor(async () => {
                await flushHookEffects();
                target = destination(drag, match);
                expect(target?.admission.status).toBe('allowed');
            });
            await act(async () => { carry!.choose(target!.targetId, target!.destination); expect((await carry!.release())?.status).toBe('applied'); });
            await flushHookEffects({ cycles: 4 });
        };
        // The whole group lifts by its grip and lands before the lone widget.
        await carryTo(dragOf('home-hub.section.happier.move'), { anchorId: lone.id, placement: 'before' });
        await vi.waitFor(() => expect(artifact.layout().order.slice(0, 5)).toEqual(['start', 'attention', 'setup', 'happier', lone.id]));

        // Inside the group, the line between its widgets reorders them there.
        await carryTo(dragOf(`home-hub.section.${second.id}.move`), { anchorId: first.id, placement: 'before', groupId: 'happier' });
        await vi.waitFor(() => {
            const group = storedItems().find(item => item.kind === 'group');
            expect(group?.kind === 'group' ? group.children.map(child => child.instance.id) : []).toEqual([second.id, first.id]);
        });

        // Extracting a child above its group must keep Home's preceding sections in place.
        await carryTo(dragOf(`home-hub.section.${second.id}.move`), { anchorId: 'happier', placement: 'before' });
        await vi.waitFor(() => expect(artifact.layout().order.slice(0, 6)).toEqual(['start', 'attention', 'setup', second.id, 'happier', lone.id]));
        expect(storedItems().find(item => item.kind === 'group')).toMatchObject({ children: [{ instance: first }] });
    });

    it.each([false, true])('extracts c1ea from 53ab immediately above 0389 (retained order slots: %s)', async retainedSlots => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const copy = (id: string): WidgetInstanceV1 => ({ v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} });
        // Resume 13's live stored order retains five unresolved ids before the groups.
        const unresolved = retainedSlots ? ['55249652', '95e264e9', '9bc23fb9', 'b3785069', 'b5c03de6'] : [];
        const preceding = ['start', 'attention', 'daily', 'setup', 'triage', 'automations'];
        settings.layout = { order: [...preceding, ...unresolved, '53ab', '0389'], hidden: [], items: [
            ...placed(copy('daily'), copy('triage')),
            { kind: 'group', id: '53ab', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
                { kind: 'widget', instance: copy('c1ea'), size: 'small' }, { kind: 'widget', instance: copy('fb086'), size: 'small' }] },
            { kind: 'group', id: '0389', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
                { kind: 'widget', instance: copy('session'), size: 'small' }] },
        ] };
        const screen = await renderHome();
        await lay(screen, { daily: 250, triage: 350, c1ea: 450, fb086: 450, session: 650 });
        // On a hover pointer the cards carry no grips until Home is being customized.
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        const drag = screen.root.findAllByType(SessionSurfaceEntityDragHandle)
            .find(handle => handle.props.testID === 'home-hub.section.c1ea.move')!.props.drag;
        let carry: ReturnType<typeof drag.runtime.begin> = null;
        await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
        let destination: ReturnType<typeof drag.runtime.getDestinations>[number] | undefined;
        await vi.waitFor(async () => {
            await flushHookEffects();
            destination = drag.runtime.getDestinations(drag.sourceId).find(entry => {
                const value = entry.destination;
                return value !== null && typeof value === 'object' && !Array.isArray(value)
                    && 'anchorId' in value && 'placement' in value
                    && value.anchorId === '0389' && value.placement === 'before';
            });
            expect(destination?.admission.status).toBe('allowed');
        });
        expect(destination?.admission).toMatchObject({ status: 'allowed', effect: { preview: { glyph: 'above' } } });
        await act(async () => {
            carry!.choose(destination!.targetId, destination!.destination);
            expect((await carry!.release())?.status).toBe('applied');
        });
        await vi.waitFor(() => expect(artifact.layout().order).toEqual([...preceding, ...unresolved, '53ab', 'c1ea', '0389']));
        expect(storedItems().find(item => item.kind === 'group' && item.id === '53ab')).toMatchObject({ children: [{ instance: copy('fb086') }] });
    });

    it('customizes Home on the page: each group bar names, sizes and opens it, and one new-row target ends the page', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const copy = (id: string): WidgetInstanceV1 => ({ v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} });
        const lone = copy('lone'); const first = copy('grouped-first'); const second = copy('grouped-second');
        settings.layout = { order: ['start', 'attention', 'setup', 'g', lone.id], hidden: [], items: [
            { kind: 'group', id: 'g', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [
                { kind: 'widget', instance: first, size: 'small' }, { kind: 'widget', instance: second, size: 'small' }] },
            { kind: 'widget', instance: lone }] };
        const screen = await renderHome();
        await lay(screen, { [lone.id]: 500, [first.id]: 300, [second.id]: 300 });
        const group = () => storedItems().find(item => item.kind === 'group');
        // View mode: no bar, no new-row target.
        expect(screen.findByTestId('home-hub.customizing')).toBeNull();
        expect(screen.findByTestId('home-hub.section.g.bar')).toBeNull();
        expect(screen.findByTestId('home-hub.new-row')).toBeNull();

        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        // Customize is the page's own state: nothing opens over the groups it edits.
        expect(screen.findByTestId('home-hub.customizing')).not.toBeNull();
        expect(screen.findByTestId('home-hub.customize.popover')).toBeNull();
        expect(screen.findAllByType('BaseModal')).toHaveLength(0);

        // The name is a field on the bar: an untitled group shows the name Sections gives it (its widgets'
        // names), and typing there sets a real one through the Home layout.
        expect(screen.findByTestId('home-hub.section.g.bar.name')!.props.value).toBe('Checks · Checks');
        await act(async () => { screen.findByTestId('home-hub.section.g.bar.name')!.props.onChangeText('Release checks'); });
        await act(async () => { screen.findByTestId('home-hub.section.g.bar.name')!.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(group()).toMatchObject({ title: 'Release checks' }));
        await flushHookEffects({ cycles: 2 });
        // Still one name on screen: the field, never a second header above it.
        expect(screen.findByTestId('home-hub.section.g.bar.name')!.props.value).toBe('Release checks');
        expect(screen.findByTestId('home-hub.section.g.frame.title')).toBeNull();

        // Half | Full sits on the bar.
        const width = screen.root.findAll(node => node.props.testIDPrefix === 'home-hub.section.g.bar.width')[0]!;
        await act(async () => { width.props.onSelectTab('half'); });
        await vi.waitFor(() => expect(group()).toMatchObject({ width: 'half' }));

        // The bar's ⋯ is the one group menu, without a second Rename beside the field.
        const menu = screen.findAllByType(ItemRowActions).find(node => node.props.overflowTriggerTestID === 'home-hub.section.g.bar.menu.trigger')!;
        const ids = menu.props.actions.map((action: { id: string }) => action.id);
        expect(ids).toEqual(expect.arrayContaining(['saveGroup', 'ungroup']));
        expect(ids).not.toContain('rename');

        // The page ends with the one new-row target: a grouped widget dropped there leaves its group for the end of Home.
        expect(screen.findByTestId('home-hub.new-row')).not.toBeNull();
        // Drawn as the dashed slot the lab draws (it takes its words' height); the room to aim at is the drag owner's, never drawn.
        expect(flattenTestStyle(screen.findByTestId('home-hub.new-row')!.props.style).minHeight).toBeUndefined();
        const drag = screen.root.findAllByType(SessionSurfaceEntityDragHandle).find(handle => handle.props.testID === `home-hub.section.${first.id}.move`)!.props.drag;
        const newRow = screen.root.findAllByType(SessionSurfaceEntityTargetFeedback).find(node => node.props.testID === 'home-hub.new-row.drop')!.props.drag;
        let carry: ReturnType<typeof drag.runtime.begin> = null;
        await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
        let destination: ReturnType<typeof drag.runtime.getDestinations>[number] | undefined;
        await vi.waitFor(async () => {
            await flushHookEffects();
            destination = drag.runtime.getDestinations(drag.sourceId).find(entry => entry.targetId === newRow.targetId);
            expect(destination?.admission.status).toBe('allowed');
        });
        await act(async () => { carry!.choose(destination!.targetId, destination!.destination); expect((await carry!.release())?.status).toBe('applied'); });
        await vi.waitFor(() => expect(artifact.layout().order.at(-1)).toBe(first.id));
        expect(artifact.layout().order.indexOf('g')).toBeLessThan(artifact.layout().order.indexOf(lone.id));
        expect(group()).toMatchObject({ children: [{ instance: second }] });

        // Done leaves Customize; the group shows its name as its header again.
        await act(async () => { screen.pressByTestId('home-hub.customizing.done'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-hub.customizing')).toBeNull();
        expect(screen.findByTestId('home-hub.section.g.bar')).toBeNull();
        expect(screen.getTextContent()).toContain('Release checks');
    });

    it.each(['installed', 'builtin'] as const)('lands a top-level %s widget carried to the new-row target at the end of Home', async kind => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const copy = (id: string): WidgetInstanceV1 => ({ v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} });
        const first: WidgetInstanceV1 = kind === 'builtin' ? { v: 1, id: 'first', definition: { kind: 'builtin', id: 'your_home' }, bindings: {} } : copy('first');
        const second = copy('second'); const third = copy('third');
        settings.layout = { order: ['start', 'attention', 'setup', first.id, second.id, third.id], hidden: [], items: placed(first, second, third) };
        const screen = await renderHome();
        await lay(screen, { [first.id]: 300, [second.id]: 300, [third.id]: 300 });
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        const drag = screen.root.findAllByType(SessionSurfaceEntityDragHandle).find(handle => handle.props.testID === `home-hub.section.${first.id}.move`)!.props.drag;
        const newRow = screen.root.findAllByType(SessionSurfaceEntityTargetFeedback).find(node => node.props.testID === 'home-hub.new-row.drop')!.props.drag;
        let carry: ReturnType<typeof drag.runtime.begin> = null;
        await act(async () => { carry = drag.runtime.begin(drag.sourceId, 'keyboard'); });
        let destination: ReturnType<typeof drag.runtime.getDestinations>[number] | undefined;
        await vi.waitFor(async () => {
            await flushHookEffects();
            destination = drag.runtime.getDestinations(drag.sourceId).find(entry => entry.targetId === newRow.targetId);
            expect(destination?.admission.status).toBe('allowed');
        });
        await act(async () => { carry!.choose(destination!.targetId, destination!.destination); expect((await carry!.release())?.status).toBe('applied'); });
        await vi.waitFor(() => expect(artifact.layout().order.at(-1)).toBe(first.id));
        expect(artifact.layout().order.filter(id => [first.id, second.id, third.id].includes(id))).toEqual([second.id, third.id, first.id]);
    });

    it('opens Add from a group\'s empty slot and puts the new widget into that group', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const only: WidgetInstanceV1 = { v: 1, id: 'grouped-only', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} };
        settings.layout = { order: ['start', 'attention', 'setup', 'happier'], hidden: [], items: [{ kind: 'group', id: 'happier', width: 'full',
            frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: only, size: 'small' }] }] };
        const screen = await renderHome();
        await lay(screen, { [only.id]: 300 });
        // While customizing, the lone widget keeps its half beside an empty slot.
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId('home-hub.section.happier.slot.add'); });
        await flushHookEffects({ cycles: 3 });
        const surface = screen.root.findAllByType(WidgetAddSurface).find(node => node.props.open === true)!;
        const entry = surface.props.sections.flatMap((section: WidgetAddSection) => section.entries)
            .find((candidate: { title: string }) => candidate.title === 'Checks')!;
        const setup = entry.setup!();
        await act(async () => { await expect(setup.submit(setup.initial)).resolves.toMatchObject({ ok: true }); });
        await vi.waitFor(() => {
            const group = storedItems().find(item => item.kind === 'group');
            expect(group?.kind === 'group' ? group.children.length : 0).toBe(2);
        });
    });

    it('renders independently bound stored copies and full width on phone, retaining a hidden missing type', async () => {
        const copy = (id: string, branch: string): WidgetInstanceV1 => ({ v: 1, id, displayName: branch,
            definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } },
            bindings: { branch: { kind: 'value', value: branch } } });
        const first = copy('checks-main', 'main');
        const second = copy('checks-release', 'release');
        const missing: WidgetInstanceV1 = { v: 1, id: 'retired-copy', displayName: 'Retired checks',
            definition: { kind: 'installed', surface: { pluginId: 'removed.plugin', localId: 'checks' } }, bindings: {} };
        widgets.projection = widgetProjectionOf([{ pluginId: 'acme.ci', localId: 'checks', target: 'app', title: 'Checks',
            inputs: { fields: [{ path: 'branch', title: 'Branch', widget: 'text', required: true }] },
            inputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'], additionalProperties: false },
        }], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        settings.layout = { order: ['start', 'attention', 'setup', first.id, second.id, missing.id], hidden: [],
            items: [...placed(first), { kind: 'widget', instance: second, size: 'full' }, ...placed(missing)] };
        const screen = await renderHome();
        await lay(screen, { [first.id]: 300, [second.id]: 500, [missing.id]: 700 });
        expect(screen.getTextContent()).toContain('branch:main');
        expect(screen.getTextContent()).toContain('branch:release');
        expect(screen.findByTestId(`home-hub.section.${missing.id}.widget-state`)).not.toBeNull();
        expect(screen.root.findAllByType(CardGridCell).some(cell => cell.props.span === 'row'
            && cell.findAll(node => node.props.testID === `home-hub.section.${second.id}`).length > 0)).toBe(true);
        expect(artifact.writes).toEqual([]);

        settings.viewport = { width: 390, height: 844 };
        await screen.rerender();
        expect(storedItems().find(item => item.kind === 'widget' && item.instance.id === second.id)).toMatchObject({ size: 'full' });
        expect(screen.getTextContent()).toContain('branch:main');
        expect(screen.getTextContent()).toContain('branch:release');
        await openSections(screen);
        await act(async () => { await screen.findByTestId(`home-layout.${missing.id}.shown`)!.props.onValueChange(false); });
        await flushHookEffects({ cycles: 3 });
        expect(storedInstances()).toEqual([first, second, missing]);
        expect(artifact.layout().hidden).toContain(missing.id);
        expect(storedItems().find(item => item.kind === 'widget' && item.instance.id === second.id)).toMatchObject({ size: 'full' });
        expect(screen.findByTestId(`home-hub.section.${missing.id}`)).toBeNull();
        expect(screen.getTextContent()).toContain('branch:release');
    });

    it('moves a configured copy through the mounted chooser above the first widget, preserving preceding sections and its sibling', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const first: WidgetInstanceV1 = { v: 1, id: 'checks-first', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} };
        const second = { ...first, id: 'checks-second' };
        settings.layout = { order: ['start', 'attention', 'setup', first.id, second.id], hidden: [], items: placed(first, second) };
        const screen = await renderHome();
        await lay(screen, { [first.id]: 300, [second.id]: 500 });
        // On a hover pointer the cards carry no grips until Home is being customized.
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        const move = `home-hub.section.${second.id}.move`;
        await act(async () => { screen.pressByTestId(move); });
        const chooser = () => screen.findAllByType(DropdownMenu).find(node => node.props.open === true)!;
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(chooser()?.props.items[0]).toMatchObject({ disabled: false });
        });
        expect(artifact.writes).toEqual([]);
        await act(async () => { chooser().props.onOpenChange(false); });
        expect(artifact.writes).toEqual([]);
        await act(async () => { screen.pressByTestId(move); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(chooser()?.props.items[0]).toMatchObject({ disabled: false });
        });
        expect(chooser().props.closeOnSelect).toBe(false);
        await act(async () => { await chooser().props.onSelect('0'); });
        await vi.waitFor(() => {
            expect(artifact.layout().order.slice(0, 5)).toEqual(['start', 'attention', 'setup', second.id, first.id]);
            expect(storedInstances()).toEqual([first, second]);
        });
        expect(screen.findAllByType(DropdownMenu).some(node => node.props.open === true)).toBe(false);
    });

    it('renames one copy in place and repairs another copy’s missing input from its card, each through the Home Artifact', async () => {
        const main: WidgetInstanceV1 = { v: 1, id: 'checks-main', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } },
            bindings: { branch: { kind: 'value', value: 'main' } } };
        const unbound: WidgetInstanceV1 = { v: 1, id: 'checks-unbound', definition: main.definition, bindings: {} };
        widgets.projection = widgetProjectionOf([{ pluginId: 'acme.ci', localId: 'checks', target: 'app', title: 'Checks',
            inputs: { fields: [{ path: 'branch', title: 'Branch', widget: 'text', required: true }] },
            inputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'], additionalProperties: false },
        }], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        settings.layout = { order: ['start', 'attention', 'setup', main.id, unbound.id], hidden: [], items: placed(main, unbound) };
        const screen = await renderHome();
        await lay(screen, { [main.id]: 300, [unbound.id]: 500 });

        // ⋯ → Rename: the title becomes a field; Enter keeps the new name for this copy only.
        const menu = screen.findByTestId(`home-hub.${main.id}.menu`)!.findByType(ItemRowActions);
        const actionIds = menu.props.actions.map((action: { id: string }) => action.id);
        expect(actionIds.slice(0, 2)).toEqual(['editInputs', 'rename']);
        const onRename = menu.props.actions.find((action: { id: string }) => action.id === 'rename')?.onPress;
        if (!onRename) throw new Error('Expected the rename action to be executable');
        await act(async () => { onRename(); });
        await flushHookEffects({ cycles: 2 });
        const field = screen.findByTestId(`home-hub.section.${main.id}-title-input`)!;
        await act(async () => { field.props.onChangeText('  Release soak '); });
        await act(async () => { screen.findByTestId(`home-hub.section.${main.id}-title-input`)!.props.onSubmitEditing(); });
        await flushHookEffects({ cycles: 3 });
        expect(storedInstances()).toEqual([{ ...main, displayName: 'Release soak' }, unbound]);
        expect(screen.findByTestId(`home-hub.section.${main.id}-title-input`)).toBeNull();

        // The copy with nothing bound says so in its card, and its repair opens the same step.
        await act(async () => { screen.pressByTestId(`home-hub.section.${unbound.id}.widget-inputs-repair`); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId(`home-hub.section.${unbound.id}.editInputs`)).not.toBeNull();
        await act(async () => { screen.changeTextByTestId(`home-hub.section.${unbound.id}.editInputs.field.branch.input`, 'release'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId(`home-hub.section.${unbound.id}.editInputs.submit`); });
        await flushHookEffects({ cycles: 4 });
        expect(storedInstances()).toEqual([
            { ...main, displayName: 'Release soak' },
            { ...unbound, bindings: { branch: { kind: 'value', value: 'release' } } },
        ]);
        expect(screen.findByTestId(`home-hub.section.${unbound.id}.editInputs`)).toBeNull();
    });

    async function setWidgetData(localId: string, value: number) {
        await act(async () => {
            widgets.data = { ...widgets.data, [localId]: value };
            for (const listener of [...widgets.dataListeners]) listener();
        });
        await flushHookEffects({ cycles: 2 });
    }

    it('projects default widgets without writing an Artifact and keeps all offered types available in the shared catalog', async () => {
        installWidgets();
        const screen = await renderHome();

        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations']);
        expect(screen.findByTestId(`home-hub.section.${LATEST}`)).toBeTruthy();
        expect(screen.findByTestId(`home-hub.section.${CHECKS}`)).toBeTruthy();
        expect(screen.findByTestId('home-hub.section.default:acme.ci/runs')).toBeNull();
        expect(screen.findByTestId('home-hub.section.widget:acme.ci/session-log')).toBeNull();

        expect(artifact.writes).toEqual([]);
        // Customize operates on placed instances, preserving their independent identities.
        await openSections(screen);
        expect(screen.findByTestId(`home-layout.${LATEST}.shown`)!.props.value).toBe(true);
        await act(async () => {
            await screen.findByTestId(`home-layout.${LATEST}.shown`)!.props.onValueChange(false);
        });
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout().hidden).toEqual([LATEST]);
        expect(screen.findByTestId(`home-layout.${LATEST}.shown`)!.props.value).toBe(false);
        expect(screen.findByTestId(`home-hub.section.${LATEST}`)).toBeNull();
        expect(screen.findByTestId(`home-hub.section.${CHECKS}`)).toBeTruthy();
    });

    it('builds a widget body only while Home is focused and the widget is near the viewport', async () => {
        installWidgets();
        const screen = await renderHome();
        // Not laid out yet: nothing runs.
        expect(widgets.bodyMounts.latest ?? 0).toBe(0);

        await lay(screen, { [LATEST]: 900, [CHECKS]: 5000 });
        expect(widgets.bodyMounts.latest).toBe(1);
        expect(widgets.bodyMounts.checks ?? 0).toBe(0);
        expect(screen.findByTestId(`home-hub.section.${CHECKS}.deferred`)).toBeTruthy();

        // Scrolled far down: the first leaves, the second arrives.
        await act(async () => {
            settings.scrollOffset = 4600;
            screen.findByTestId('home-hub')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 4600 } } });
        });
        await flushHookEffects({ cycles: 2 });
        expect(widgets.bodyMounts.latest).toBe(0);
        expect(widgets.bodyMounts.checks).toBe(1);

        // Another page covers Home: nothing keeps running behind it.
        await act(async () => {
            widgets.focused = false;
            for (const listener of [...widgets.focusListeners]) listener();
        });
        await flushHookEffects({ cycles: 2 });
        expect(widgets.bodyMounts.checks).toBe(0);
    });

    it('re-renders only the widget whose data changed — never the hub or its sibling sections', async () => {
        installWidgets();
        const screen = await renderHome();
        await lay(screen, { [LATEST]: 900, [CHECKS]: 1100 });
        expect(widgets.bodyMounts.latest).toBe(1);
        expect(widgets.bodyMounts.checks).toBe(1);

        const before = {
            hub: widgets.hubRenders,
            setup: widgets.setupRenders,
            checks: widgets.bodyRenders.checks,
            latest: widgets.bodyRenders.latest!,
        };
        await setWidgetData('latest', 1);
        await setWidgetData('latest', 2);

        expect(screen.getTextContent()).toContain('widget:latest=2');
        expect(widgets.bodyRenders.latest).toBe(before.latest + 2);
        expect(widgets.bodyRenders.checks).toBe(before.checks);
        expect(widgets.setupRenders).toBe(before.setup);
        expect(widgets.hubRenders).toBe(before.hub);

        // A new projection that leaves the widgets as they were (another plugin updated) reaches the
        // hub, but no section re-renders for it.
        installWidgets();
        const setupBeforeProjection = widgets.setupRenders;
        await screen.rerender();
        expect(widgets.setupRenders).toBe(setupBeforeProjection);
        before.hub = widgets.hubRenders;

        // Scrolling moves the window, never the hub.
        await act(async () => {
            settings.scrollOffset = 300;
            screen.findByTestId('home-hub')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 300 } } });
        });
        await flushHookEffects({ cycles: 2 });
        expect(widgets.hubRenders).toBe(before.hub);
        expect(widgets.setupRenders).toBe(before.setup);
    });
});
