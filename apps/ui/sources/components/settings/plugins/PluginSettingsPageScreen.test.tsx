import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    normalizePluginUiSettingsPageBindingV1,
    type PluginUiHostApiRequestEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui';

import { createMachineFixture, renderScreen as renderScreenWithProviders, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    usePluginSurfaceCurrentUiContextEligibility,
    usePluginSurfaceFocusEligibility,
} from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSettingsPageProjection,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

import { usePluginSettingsPageDestinationHandler } from './pluginSettingsPageNavigation';

const hostSpy = vi.hoisted(() => vi.fn());
const fallbackSpy = vi.hoisted(() => vi.fn());
const stackScreenSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const nativeBackState = vi.hoisted(() => ({
    enabled: false,
    consume: null as null | (() => boolean),
}));
const routeRemovalState = vi.hoisted(() => ({
    active: false,
    consume: null as null | (() => boolean),
}));
const appShellState = vi.hoisted(() => ({
    projection: null as PluginUiProjectionModel | null,
    phase: 'current' as 'establishing' | 'current' | 'retainedOffline' | 'unavailable',
    hasEstablishingMembers: false,
    interactionEnabled: true,
}));
const routeFocusState = vi.hoisted(() => ({ value: true }));
const administrationTargetSelectorSpy = vi.hoisted(() => vi.fn());
type DaemonTargetFixture = Readonly<{
    target: Readonly<{ serverIdentityId: string; machineId: string }>;
    machine: Readonly<{ id: string; daemonStateVersion: number }>;
    serverId: string;
}>;
const daemonTargetSelectionState = vi.hoisted(() => ({
    value: {
        target: { serverIdentityId: 'settings-server-identity', machineId: 'settings-machine' },
        machine: { id: 'settings-machine', daemonStateVersion: 3 },
        serverId: 'settings-server',
    } as DaemonTargetFixture | null,
}));
/** The one administration selection this screen both writes to and names. */
const administrationSelectionFixture = vi.hoisted(() => Object.freeze({
    candidates: [],
    pickerRows: [],
    state: { kind: 'online' as const },
    selectedTarget: { serverIdentityId: 'settings-server-identity', machineId: 'settings-machine' },
    canExecute: true,
    selectTarget: () => {},
    clearTarget: () => {},
    resolveExecutionTarget: () => daemonTargetSelectionState.value,
}));

vi.mock('expo-router', () => ({
    usePathname: () => '/settings/plugins/examples.descriptor-only/settings',
    useRouter: () => ({ push: routerPushSpy, replace: routerReplaceSpy }),
    Stack: {
        Screen: (props: unknown) => {
            stackScreenSpy(props);
            return React.createElement('StackScreen', { props });
        },
    },
}));

vi.mock('@/components/ui/overlays/NativeBackLayerBoundary', () => ({
    useNativeBackLayerBackHandler: (enabled: boolean, consume: () => boolean) => {
        nativeBackState.enabled = enabled;
        nativeBackState.consume = consume;
    },
}));

vi.mock('@/utils/navigation/RouteRemovalStepConsumer', () => ({
    RouteRemovalStepConsumer: (props: Readonly<{ active: boolean; consume: () => boolean }>) => {
        routeRemovalState.active = props.active;
        routeRemovalState.consume = props.consume;
        return null;
    },
}));

vi.mock('@/keyboard/escape', () => ({
    ESCAPE_LAYER_PRIORITIES: { pane: 10 },
    useEscapeLayer: () => {},
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        // This fixture renders an installed route, not a navigator-free preview.
        NavigationContext: React.createContext({}),
        useIsFocused: () => routeFocusState.value,
    };
});

vi.mock('@/sync/domains/machines/administration/useTargetSelection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/machines/administration/useTargetSelection')>()),
    useMachineAdministrationTargetSelection: () => administrationSelectionFixture,
}));

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: unknown) => {
        administrationTargetSelectorSpy(props);
        return React.createElement('MachineAdministrationTargetSelector');
    },
}));

vi.mock('@/components/plugins/surfaces', () => ({
    PluginSettingsPageHost: (props: unknown) => {
        hostSpy(props);
        return React.createElement(PluginSettingsPageHostFocusProbe, { props });
    },
}));

vi.mock('@/components/sessions/panes/PluginSurfaceFallback', () => ({
    PluginSurfaceFallback: (props: unknown) => {
        fallbackSpy(props);
        return React.createElement('PluginSurfaceFallbackMock', { props });
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        getPreferredLanguage: () => 'en',
        translate: (key) => `localized:${key}`,
    });
});

function settingsPage(input: Readonly<{
    pluginId?: string;
    pageId?: string;
}> = {}): PluginUiSettingsPageProjection {
    const pluginId = input.pluginId ?? 'examples.descriptor-only';
    const pageId = input.pageId ?? 'settings';
    const binding = normalizePluginUiSettingsPageBindingV1({
        pluginId,
        pageId,
        rendererId: 'settings-form',
    });
    if (!binding) throw new Error('Settings page fixture needs a normalized binding');
    const page: PluginUiSettingsPageProjection = {
        id: `settingsPage:${pluginId}:${pageId}`,
        pluginId,
        occurrenceId: `${pluginId}-occurrence-4`,
        contributionKind: 'settingsPage',
        descriptorId: pageId,
        page: {
            id: { pluginId, localId: pageId },
            group: {
                kind: 'plugin',
                id: { pluginId, localId: 'descriptor-preferences' },
            },
            title: 'Descriptor-only settings',
        },
        binding,
        renderer: { kind: 'declarative' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
    };
    const projected = composeSettingsProjection({ ...EMPTY_PLUGIN_UI_PROJECTION, settingsPagesById: { [page.id]: page } });
    const admitted = projected?.settingsPagesById[page.id];
    if (!admitted) throw new Error('Settings fixture must have a canonically admitted destination');
    return admitted;
}

installDisconnectedServerSocketBoundary();
let settingsConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function composeSettingsProjection(raw: PluginUiProjectionModel | null,
    phase = appShellState.phase, interactionEnabled = appShellState.interactionEnabled) {
    if (!raw) return null;
    const packages = Object.fromEntries(Object.values(raw.settingsPagesById).map(page => [page.pluginId, {
        id: page.pluginId, displayName: page.pluginId, version: '1.0.0', enabled: true,
        source: { kind: 'bundled' as const, locator: page.pluginId }, occurrenceId: `${page.pluginId}-occurrence-4`,
        sourceCustody: { kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'settings-page-fixture-root' } },
    }]));
    return unionPluginUiProjections([{ machineId: 'machine-1', serverId: 'server-1', serverIdentityId: 'srv_account_a',
        phase, interactionEnabled,
        projection: { ...raw, generation: 4, installedPackagesById: packages } }]).pluginUiProjection;
}

function SettingsProjectionFixture({ children }: React.PropsWithChildren) {
    const raw = appShellState.projection;
    const projection = React.useMemo(() => composeSettingsProjection(raw), [raw, appShellState.phase, appShellState.interactionEnabled]);
    return <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection,
        pluginBrowserProjection: null, phase: appShellState.phase, hasEstablishingMembers: appShellState.hasEstablishingMembers,
        interactionEnabled: appShellState.interactionEnabled, machineId: 'machine-1', serverId: 'server-1', platform: 'web',
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
        reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
    }}>{children}</AppShellPluginUiProjectionValueProvider>;
}

function renderScreen(element: React.ReactElement) {
    return renderScreenWithProviders(element, { wrapper: SettingsProjectionFixture });
}

beforeEach(async () => {
    settingsConnection = await restoreServerAccountForTest({ serverUrl: 'https://server-1',
        serverIdentityId: 'srv_account_a', accountId: 'settings-account', request: async url => {
            if (new URL(String(url)).pathname === '/health') return Response.json({ status: 'ok' });
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || settingsConnection.home.id !== 'server-1') throw new Error('Settings fixture must have its actual applied Home');
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: 0 });
    storage.setState({ profileScope: lifetime.scope, settingsScope: lifetime.scope, endpointStatus: 'online', isDataReady: true,
        machines: { 'machine-1': machine }, machineListByServerId: { 'server-1': [machine] },
        machineListStatusByServerId: { 'server-1': 'idle' } });
});

function replacePageLocationRequest(
    payload: Readonly<{ subPath: string; backLocation: string }>,
): PluginUiHostApiRequestEnvelopeV1 {
    return {
        version: 1,
        requestId: `replace:${payload.subPath || 'root'}`,
        surface: {
            pluginId: 'examples.descriptor-only',
            contributionId: 'settings-form',
            surfaceId: 'settingsPage:examples.descriptor-only:settings',
            placement: 'appSurface',
            platform: 'web',
            channel: 'internal',
            resourceScope: [],
            diagnostics: [],
        },
        method: 'replacePageLocation',
        payload,
    };
}

type SettingsPageHostProps = Readonly<{
    binding?: Readonly<{
        openSurface?: PluginSurfaceOpenHandler;
        mountedHostApiHandlers?: Readonly<{
            replacePageLocation?: (
                request: PluginUiHostApiRequestEnvelopeV1,
            ) => unknown;
        }>;
    }>;
    subPath?: string;
    unavailableAction?: Readonly<{ label: string; onPress: () => void }>;
    projectionInteractionEnabled?: boolean;
    daemonSettingsTarget?: Readonly<{
        kind: string;
        serverIdentityId: string;
        machineId: string;
        serverId: string;
    }> | null;
    isDaemonSettingsTargetCurrent?: (target: Readonly<{
        kind: 'daemon';
        serverIdentityId: string;
        machineId: string;
        serverId: string;
    }>) => boolean;
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
}>;

function latestHostProps(): SettingsPageHostProps {
    return hostSpy.mock.calls.at(-1)?.[0] as SettingsPageHostProps;
}

afterEach(async () => {
    await standardCleanup();
    await settingsConnection?.dispose();
    settingsConnection = null;
    appShellState.projection = null;
    appShellState.phase = 'current';
    appShellState.hasEstablishingMembers = false;
    appShellState.interactionEnabled = true;
    routeFocusState.value = true;
    daemonTargetSelectionState.value = {
        target: { serverIdentityId: 'settings-server-identity', machineId: 'settings-machine' },
        machine: { id: 'settings-machine', daemonStateVersion: 3 },
        serverId: 'settings-server',
    };
    hostSpy.mockClear();
    fallbackSpy.mockClear();
    stackScreenSpy.mockClear();
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    nativeBackState.enabled = false;
    nativeBackState.consume = null;
    routeRemovalState.active = false;
    routeRemovalState.consume = null;
    administrationTargetSelectorSpy.mockClear();
});

describe('PluginSettingsPageScreen', () => {
    it('uses the shared plugin page-location owner for internal route replacement and system Back', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(
            <PluginSettingsPageScreen
                pluginId="examples.descriptor-only"
                pageId="settings"
                subPath=""
            />,
        );

        const replacePageLocation = latestHostProps().binding?.mountedHostApiHandlers?.replacePageLocation;
        expect(replacePageLocation).toBeTypeOf('function');
        expect(replacePageLocation?.(replacePageLocationRequest({
            subPath: 'bindings/7',
            backLocation: '',
        }))).toEqual({ subPath: 'bindings/7' });
        expect(routerReplaceSpy).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/(app)/settings/plugins/[pluginId]/[pageId]',
            params: expect.objectContaining({
                pluginId: 'examples.descriptor-only',
                pageId: 'settings',
                subPath: 'bindings/7',
            }),
        }));
        expect(latestHostProps().subPath).toBe('');
        expect(routeRemovalState.active).toBe(true);
        expect(routeRemovalState.consume?.()).toBe(true);
        expect(routerReplaceSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            params: expect.objectContaining({ subPath: '' }),
        }));
    });

    it('retires a declared Back step when the page renderer becomes unavailable', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');
        const screen = await renderScreen(
            <PluginSettingsPageScreen
                pluginId="examples.descriptor-only"
                pageId="settings"
                subPath=""
            />,
        );

        latestHostProps().binding?.mountedHostApiHandlers?.replacePageLocation?.(
            replacePageLocationRequest({ subPath: 'bindings/7', backLocation: '' }),
        );
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: {
                [page.id]: {
                    ...page,
                    availability: {
                        state: 'disabled',
                        reason: 'disabled',
                        diagnostics: [],
                    },
                },
            },
        };
        await screen.update(
            <PluginSettingsPageScreen
                pluginId="examples.descriptor-only"
                pageId="settings"
                subPath="bindings/7"
            />,
        );
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        await screen.update(
            <PluginSettingsPageScreen
                pluginId="examples.descriptor-only"
                pageId="settings"
                subPath="bindings/7"
            />,
        );

        routerReplaceSpy.mockClear();
        expect(routeRemovalState.consume?.()).toBe(false);
        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('keeps a restored Settings destination pending until the app projection has described it', async () => {
        appShellState.projection = null;
        appShellState.phase = 'current';
        appShellState.hasEstablishingMembers = true;
        appShellState.interactionEnabled = true;
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(
            <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />,
        );

        // An empty establishment model is not evidence that this exact route
        // was removed. Preserve route continuity and wait for its first
        // describe instead of rendering the current-missing tombstone: the
        // shared surface fallback shows only its loading state here.
        expect(hostSpy).not.toHaveBeenCalled();
        expect(fallbackSpy).toHaveBeenCalled();
        expect(new Set(fallbackSpy.mock.calls.map(([fallbackProps]) => (
            (fallbackProps as { state?: string }).state
        )))).toEqual(new Set(['loading']));
    });

    it('inherits the current Settings route focus fact without treating an inactive route as offline', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');
        const screen = await renderScreen(
            <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />,
        );

        expect(screen.root.findByType('PluginSettingsPageHostMock' as never).props.focusEligible).toBe(true);
        // Presentation focus is not semantic currentness. The Settings route is
        // the one owner that can elect its mounted surface as the current UI
        // context, so a focused route must publish that fact too — otherwise the
        // mount's Host API `publishCurrentUiContext` stays permanently fenced.
        expect(
            screen.root.findByType('PluginSettingsPageHostMock' as never).props.currentUiContextEligible,
        ).toBe(true);

        routeFocusState.value = false;
        await screen.update(
            <PluginSettingsPageScreen
                key="settings-route-unfocused"
                pluginId="examples.descriptor-only"
                pageId="settings"
            />,
        );
        expect(screen.root.findByType('PluginSettingsPageHostMock' as never).props.focusEligible).toBe(false);
        expect(
            screen.root.findByType('PluginSettingsPageHostMock' as never).props.currentUiContextEligible,
        ).toBe(false);
    });

    it('resolves one admitted qualified Settings page into the shared host, without route-local renderer selection', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(
            <SettingsTargetNavigationScope>
                <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />
            </SettingsTargetNavigationScope>,
        );

        expect(hostSpy).toHaveBeenCalledWith(expect.objectContaining({
            page,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            projectionInteractionEnabled: true,
        }));
        expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it('lends the active route\'s recovery action to the generic host fallback', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        const action = latestHostProps().unavailableAction;
        expect(action?.label).toBe('localized:settingsPlugins.managePlugin');
        action?.onPress();
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'examples.descriptor-only' },
        });
    });

    it('keeps a retained offline Settings page visible but noninteractive', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        appShellState.phase = 'retainedOffline';
        appShellState.interactionEnabled = true;
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        expect(latestHostProps().projectionInteractionEnabled).toBe(false);
    });

    it('does not construct a route-local destination binding outside the app target scope', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        expect(latestHostProps().binding?.openSurface).toBeUndefined();
    });

    it('gives a mounted Settings page the one exact cross-plugin Settings route capability', async () => {
        const sourcePage = settingsPage();
        const targetPage = settingsPage({ pluginId: 'examples.other-plugin', pageId: 'advanced' });
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: {
                [sourcePage.id]: sourcePage,
                [targetPage.id]: targetPage,
            },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(
            <SettingsTargetNavigationScope>
                <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />
            </SettingsTargetNavigationScope>,
        );

        const openSurface = latestHostProps().binding?.openSurface;
        expect(openSurface).toBeTypeOf('function');
        if (!openSurface) throw new Error('mounted Settings page must receive the host openSurface capability');
        await expect(openSurface({
            destination: { pluginId: 'examples.other-plugin', localId: 'advanced' },
        })).resolves.toEqual({ ok: true });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/plugins/examples.other-plugin/advanced');
    });

    it('refuses a Settings-page launch input instead of dropping it during route navigation', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(
            <SettingsTargetNavigationScope>
                <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />
            </SettingsTargetNavigationScope>,
        );

        const openSurface = latestHostProps().binding?.openSurface;
        if (!openSurface) throw new Error('mounted Settings page must receive the host openSurface capability');
        await expect(openSurface({
            destination: { pluginId: 'examples.descriptor-only', localId: 'settings' },
            input: { preserved: 'nowhere' },
        })).resolves.toEqual({
            ok: false,
            code: 'unsupported_method',
            reason: 'plugin_surface_open_launch_input_unsupported',
        });
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('uses the exact Administration daemon target for declarative Settings fields, not the app-shell origin', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        const hostProps = latestHostProps();
        expect(hostProps.daemonSettingsTarget).toEqual({
            kind: 'daemon',
            serverIdentityId: 'settings-server-identity',
            machineId: 'settings-machine',
            serverId: 'settings-server',
        });
        expect(hostProps.settingsScopesEnabled).toEqual({ account: true, daemon: true });
        expect(hostProps.isDaemonSettingsTargetCurrent?.({
            kind: 'daemon',
            serverIdentityId: 'settings-server-identity',
            machineId: 'settings-machine',
            serverId: 'settings-server',
        })).toBe(true);

        // Same machine, same server, RESTARTED daemon. The generation alone has
        // to break currentness: a Settings or Secrets write staged against the
        // pre-restart authority would otherwise be dispatched to a different one
        // under an identity that still looks correct. Every other field is held
        // constant so this asserts the generation term and nothing else.
        daemonTargetSelectionState.value = {
            target: { serverIdentityId: 'settings-server-identity', machineId: 'settings-machine' },
            machine: { id: 'settings-machine', daemonStateVersion: 4 },
            serverId: 'settings-server',
        };
        expect(hostProps.isDaemonSettingsTargetCurrent?.({
            kind: 'daemon',
            serverIdentityId: 'settings-server-identity',
            machineId: 'settings-machine',
            serverId: 'settings-server',
        })).toBe(false);

        daemonTargetSelectionState.value = {
            target: { serverIdentityId: 'next-server-identity', machineId: 'next-machine' },
            machine: { id: 'next-machine', daemonStateVersion: 4 },
            serverId: 'next-server',
        };
        expect(hostProps.isDaemonSettingsTargetCurrent?.({
            kind: 'daemon',
            serverIdentityId: 'settings-server-identity',
            machineId: 'settings-machine',
            serverId: 'settings-server',
        })).toBe(false);
    });

    // A deep link lands on this page with no plugin-home context, so the machine
    // its fields, secrets and lifecycle operations address has to be named here
    // — by the SAME selection that produced the daemon target above, not a
    // second copy of the decision.
    it('names the administration machine it writes to, from the one selection its target came from', async () => {
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        expect(administrationTargetSelectorSpy).toHaveBeenCalledWith(expect.objectContaining({
            selection: administrationSelectionFixture,
        }));
        expect(latestHostProps().daemonSettingsTarget).toEqual({
            kind: 'daemon',
            serverIdentityId: administrationSelectionFixture.selectedTarget.serverIdentityId,
            machineId: administrationSelectionFixture.selectedTarget.machineId,
            serverId: 'settings-server',
        });
    });

    it('fails daemon Settings closed instead of falling back to the app-shell origin with no Administration target', async () => {
        daemonTargetSelectionState.value = null;
        const page = settingsPage();
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        expect(latestHostProps()).toEqual(expect.objectContaining({
            daemonSettingsTarget: null,
            perActiveServerIdentityId: 'settings-server-identity',
            settingsScopesEnabled: { account: true, daemon: false },
        }));
    });

    it('keeps an unknown page at its own unavailable route instead of redirecting to another plugin', async () => {
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="removed" />);

        expect(hostSpy).not.toHaveBeenCalled();
        const fallback = fallbackSpy.mock.calls.at(-1)?.[0] as Readonly<{
            action?: Readonly<{ label: string; onPress: () => void }>;
            testID?: string;
        }> | undefined;
        expect(fallback).toEqual(expect.objectContaining({
            testID: 'plugin-settings-page-unavailable',
            action: expect.objectContaining({
                label: 'localized:settingsPlugins.managePlugin',
            }),
        }));
        expect(fallback?.action).toBeDefined();
        fallback?.action?.onPress();
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'examples.descriptor-only' },
        });
    });

    it('renders localized tombstone copy for an unavailable selected page without mounting its renderer', async () => {
        const page: PluginUiSettingsPageProjection = {
            ...settingsPage(),
            availability: { state: 'disabled', reason: 'feature_disabled', diagnostics: [] },
        };
        appShellState.projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            settingsPagesById: { [page.id]: page },
        };
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        await renderScreen(<PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />);

        expect(hostSpy).not.toHaveBeenCalled();
        const fallback = fallbackSpy.mock.calls.at(-1)?.[0] as Readonly<{
            action?: Readonly<{ label: string; onPress: () => void }>;
            reasonCode?: string;
            testID?: string;
        }> | undefined;
        expect(fallback).toEqual(expect.objectContaining({
            testID: 'plugin-settings-page-unavailable',
            reasonCode: 'feature_disabled',
            action: expect.objectContaining({
                label: 'localized:settingsPlugins.managePlugin',
            }),
        }));
        expect(fallback?.action).toBeDefined();
        fallback?.action?.onPress();
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'examples.descriptor-only' },
        });
        expect(stackScreenSpy).toHaveBeenCalledWith({
            options: { title: page.page.title },
        });
    });
});

function PluginSettingsPageHostFocusProbe(props: Readonly<{ props: unknown }>): React.ReactElement {
    return React.createElement('PluginSettingsPageHostMock', {
        props: props.props,
        focusEligible: usePluginSurfaceFocusEligibility(),
        currentUiContextEligible: usePluginSurfaceCurrentUiContextEligibility(),
    });
}

/** Mirrors the app-shell's one target binding for route-level navigation tests. */
function SettingsTargetNavigationScope(props: React.PropsWithChildren): React.ReactElement {
    const projection = useAppShellPluginUiProjection().pluginUiProjection;
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: projection
            ? Object.values(projection.surfacePlacementsById).filter(
                (placement): placement is PluginUiSurfacePlacementProjection => placement.binding.kind === 'destination',
            )
            : [],
        settingsPages: projection
            ? Object.values(projection.settingsPagesById)
            : [],
        targetKind: 'app',
    });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({
        projection,
    });
    const settingsOwner = React.useMemo(() => ({
        container: 'settingsPage' as const,
        handler: openSettingsPage,
    }), [openSettingsPage]);
    useRegisterPluginSurfaceDestinationNavigationOwner(settingsOwner, binding);
    return (
        <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
            {props.children}
        </PluginSurfaceDestinationNavigationBindingProvider>
    );
}
