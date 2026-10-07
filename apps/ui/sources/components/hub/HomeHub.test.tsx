import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { NavigationContext, useNavigation } from '@react-navigation/native';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { HomeHub } from './HomeHub';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { HomeHubLayoutValue } from '@happier-dev/protocol/home';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Layout = Pick<HomeHubLayoutValue, 'order' | 'hidden'> & Partial<Pick<HomeHubLayoutValue, 'instances' | 'sections'>>;

// Initial server-owned layout; subsequent assertions inspect the acknowledged HTTP Artifact.
const settings = vi.hoisted(() => ({
    layout: { order: [], hidden: [] } as Layout,
    guidanceKind: 'select_session' as string,
    machineCount: 0,
    machineMounts: 0,
    viewport: { width: 800, height: 600 },
    positions: {} as Record<string, number>,
    scrollOffset: 0,
}));
installDisconnectedServerSocketBoundary();
let artifact = createHomeHubArtifactHttpBoundary('account-home');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;

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
vi.mock('./composer/HubComposerSection', () => ({ HubComposerSection: () => 'section:start' }));
vi.mock('./HubAttentionSection', () => ({ HubAttentionSection: () => 'section:attention' }));
vi.mock('./HubSetupSection', () => ({
    HubSetupSection: () => {
        widgets.setupRenders += 1;
        return 'section:setup';
    },
}));
vi.mock('./HubMachinesSection', async () => {
    const ReactModule = await import('react');
    return {
        HubMachinesSection: () => {
            ReactModule.useEffect(() => { settings.machineMounts += 1; }, []);
            return 'section:machines';
        },
    };
});
vi.mock('./HubUsageSection', () => ({ HubUsageSection: () => 'section:usage' }));
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
    SessionGettingStartedGuidance: () => 'guidance',
}));

afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    restoreActionLoader = undefined;
    artifact = createHomeHubArtifactHttpBoundary('account-home');
    settings.layout = { order: [], hidden: [] };
    settings.guidanceKind = 'select_session';
    settings.machineCount = 0;
    settings.machineMounts = 0;
    settings.viewport = { width: 800, height: 600 };
    settings.positions = {};
    settings.scrollOffset = 0;
    usage.summary = { entries: [], asOf: null, source: 'none' };
    usage.listeners.clear();
    widgets.projection = null;
    widgets.data = {};
    widgets.dataListeners.clear();
    widgets.bodyRenders = {};
    widgets.bodyMounts = {};
    widgets.hubRenders = 0;
    widgets.setupRenders = 0;
    widgets.focused = true;
    widgets.focusListeners.clear();
});

function RoutedHomeBoundary({ children }: React.PropsWithChildren) {
    return <NavigationContext.Provider value={useNavigation()}>{children}</NavigationContext.Provider>;
}

async function renderHome() {
    if (!connection) {
        artifact.seed({ v: 1, instances: [], ...settings.layout });
        await import('@/sync/syncEngine');
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-layout.test', accountId: 'account-home', request: artifact.request });
        const scope = { serverId: connection.home.id, accountId: 'account-home' };
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
    }
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
                clientExecutableActivation: { status: 'ready' },
                reloadClientExecutables: () => {},
                reloadConnectedAccountProjection: () => {},
            }}
        >
            <HomeHub />
        </AppShellPluginUiProjectionValueProvider>
        </InjectedAuthProvider>
        </RoutedHomeBoundary>
    );
    const contentNode = { getBoundingClientRect: () => ({ left: 0, top: 56 - settings.scrollOffset, width: 800, height: 800 }) };
    const rendered = await renderScreen(element(), {
        createNodeMock: node => {
            const testID = node.props && typeof node.props === 'object' && 'testID' in node.props ? node.props.testID : undefined;
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

function shownSections(text: string): string[] {
    return [...text.matchAll(/section:([a-z]+)/g)].map((match) => match[1]!);
}

describe('HomeHub', () => {
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

    it('shows the Account\'s sections in its order, never hiding "Start a session" or "Needs your attention"', async () => {
        settings.layout = { order: ['usage', 'start'], hidden: ['setup', 'start', 'attention'] };
        const screen = await renderHome();

        // Machines is off until the person turns it on.
        expect(shownSections(screen.getTextContent())).toEqual(['usage', 'start', 'attention', 'automations']);
    });

    it('opens Customize over the live page: switches, keyboard moves and reset write the Account layout', async () => {
        const screen = await renderHome();
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'usage']);

        screen.pressByTestId('home-hub.customize');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-hub.customize.popover')).toBeTruthy();
        // Always shown: no switch.
        expect(screen.findByTestId('home-layout.attention.shown')).toBeNull();
        await act(async () => {
            await screen.findByTestId('home-layout.machines.shown')!.props.onValueChange(true);
        });
        await flushHookEffects({ cycles: 2 });
        // The page behind updates at once.
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'machines', 'usage']);

        // Keyboard reordering stages a move on the real shared Entity drag owner.
        await act(async () => {
            screen.findByTestId('home-layout.usage.grip')!.props.onKeyDown({ key: 'Enter', preventDefault() {} });
        });
        await act(async () => {
            screen.findByTestId('home-layout.usage.grip')!.props.onKeyDown({ key: 'ArrowUp', preventDefault() {} });
        });
        await act(async () => {
            screen.findByTestId('home-layout.usage.grip')!.props.onKeyDown({ key: 'Enter', preventDefault() {} });
        });
        await flushHookEffects({ cycles: 2 });
        await vi.waitFor(() => expect(artifact.writes.at(-1)).toMatchObject({
            order: ['start', 'attention', 'setup', 'automations', 'usage', 'machines'],
            hidden: [],
        }));

        screen.pressByTestId('home-layout.reset');
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout()).toEqual({ v: 1, instances: [], order: [], hidden: [] });
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'usage']);

        // The header button closes it again.
        screen.pressByTestId('home-hub.customize');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-hub.customize.popover')).toBeNull();
    });

    it('offers dismissed setup steps back from Customize', async () => {
        settings.layout = { order: [], hidden: ['setup:addPhone', 'setup:addMachine'] };
        const screen = await renderHome();
        screen.pressByTestId('home-hub.customize');
        await flushHookEffects({ cycles: 2 });

        screen.pressByTestId('home-layout.hiddenSetupSteps');
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout().hidden).not.toContain('setup:addPhone');
        expect(artifact.layout().hidden).not.toContain('setup:addMachine');
        expect(screen.findByTestId('home-layout.hiddenSetupSteps')).toBeNull();
    });

    it('customizes Home in a phone sheet, applies changes behind it, and dismisses back to Home', async () => {
        settings.viewport = { width: 390, height: 844 };
        const screen = await renderHome();
        await act(async () => screen.pressByTestId('home-hub.customize'));
        await flushHookEffects({ cycles: 2 });

        expect(screen.findByTestId('home-hub.customize.popover')).toBeNull();
        const modal = screen.findByType('BaseModal');
        expect(modal.props.placement).toBe('bottom');
        const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');
        expect(screen.findByType(ModalCardFrame).props.presentation).toBe('sheet');
        await act(async () => {
            await screen.findByTestId('home-layout.machines.shown')!.props.onValueChange(true);
        });
        await flushHookEffects({ cycles: 2 });
        expect(shownSections(screen.getTextContent())).toContain('machines');
        expect(artifact.layout().hidden).not.toContain('machines');

        await act(async () => modal.props.onClose());
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('home-layout.machines.shown')).toBeNull();
        expect(shownSections(screen.getTextContent())).toContain('machines');
        await act(async () => screen.pressByTestId('home-hub.customize'));
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByType('BaseModal').props.placement).toBe('bottom');
    });

    it('keeps the Machines section mounted while usage arrives and goes away', async () => {
        settings.machineCount = 1;
        settings.layout = { order: ['start', 'attention', 'setup', 'automations', 'machines', 'usage'], hidden: [] };
        const screen = await renderHome();
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'machines', 'usage']);
        expect(settings.machineMounts).toBe(1);

        await setUsage([{ key: 'claude' }]);
        await setUsage([]);

        // Usage arriving changes the Usage section's content, never the page's structure.
        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'machines', 'usage']);
        expect(settings.machineMounts).toBe(1);
    });
});

describe('HomeHub plugin widgets', () => {
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

    it('renders independently bound stored copies and full width on phone, retaining a missing type until it is removed', async () => {
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
        settings.layout = { order: ['start', 'attention', 'setup', first.id, second.id, missing.id], hidden: [], instances: [first, second, missing],
            sections: { [second.id]: { size: 'full' } } };
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
        expect(artifact.layout().sections?.[second.id]?.size).toBe('full');
        expect(screen.getTextContent()).toContain('branch:main');
        expect(screen.getTextContent()).toContain('branch:release');
        await act(async () => { screen.pressByTestId('home-hub.customize'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { await screen.findByTestId(`home-layout.${missing.id}.shown`)!.props.onValueChange(false); });
        await flushHookEffects({ cycles: 3 });
        expect(artifact.layout().instances).toEqual([first, second]);
        expect(artifact.layout().sections?.[second.id]?.size).toBe('full');
        expect(screen.findByTestId(`home-hub.section.${missing.id}`)).toBeNull();
        expect(screen.getTextContent()).toContain('branch:release');
    });

    it('moves a configured copy through the mounted chooser to the native first Home position, preserving its sibling', async () => {
        widgets.projection = widgetProjectionOf([
            { pluginId: 'acme.ci', localId: 'checks', title: 'Checks', target: 'app' },
        ], { 'acme.ci': widgetInstalledPackage('acme.ci', 'CI') });
        const first: WidgetInstanceV1 = { v: 1, id: 'checks-first', definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'checks' } }, bindings: {} };
        const second = { ...first, id: 'checks-second' };
        settings.layout = { order: ['start', 'attention', 'setup', first.id, second.id], hidden: [], instances: [first, second] };
        const screen = await renderHome();
        await lay(screen, { [first.id]: 300, [second.id]: 500 });
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
            expect(artifact.layout().order[0]).toBe(second.id);
            expect(artifact.layout().instances).toEqual([first, second]);
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
        settings.layout = { order: ['start', 'attention', 'setup', main.id, unbound.id], hidden: [], instances: [main, unbound] };
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
        expect(artifact.layout().instances).toEqual([{ ...main, displayName: 'Release soak' }, unbound]);
        expect(screen.findByTestId(`home-hub.section.${main.id}-title-input`)).toBeNull();

        // The copy with nothing bound says so in its card, and its repair opens the same step.
        await act(async () => { screen.pressByTestId(`home-hub.section.${unbound.id}.widget-inputs-repair`); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId(`home-hub.section.${unbound.id}.editInputs`)).not.toBeNull();
        await act(async () => { screen.changeTextByTestId(`home-hub.section.${unbound.id}.editInputs.field.branch.input`, 'release'); });
        await flushHookEffects({ cycles: 2 });
        await act(async () => { screen.pressByTestId(`home-hub.section.${unbound.id}.editInputs.submit`); });
        await flushHookEffects({ cycles: 4 });
        expect(artifact.layout().instances).toEqual([
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

        expect(shownSections(screen.getTextContent())).toEqual(['start', 'attention', 'setup', 'automations', 'usage']);
        expect(screen.findByTestId(`home-hub.section.${LATEST}`)).toBeTruthy();
        expect(screen.findByTestId(`home-hub.section.${CHECKS}`)).toBeTruthy();
        expect(screen.findByTestId('home-hub.section.default:acme.ci/runs')).toBeNull();
        expect(screen.findByTestId('home-hub.section.widget:acme.ci/session-log')).toBeNull();

        expect(artifact.writes).toEqual([]);
        // Customize operates on placed instances, preserving their independent identities.
        screen.pressByTestId('home-hub.customize');
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId(`home-layout.${LATEST}.shown`)!.props.value).toBe(true);
        await act(async () => {
            await screen.findByTestId(`home-layout.${LATEST}.shown`)!.props.onValueChange(false);
        });
        await flushHookEffects({ cycles: 2 });
        expect(artifact.layout().hidden).toEqual(['machines', LATEST]);
        expect(screen.findByTestId(`home-layout.${LATEST}.shown`)).toBeNull();
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
