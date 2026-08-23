import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizePluginUiSettingsPageBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';

import { usePluginSettingsPageDestinationHandler } from './pluginSettingsPageNavigation';

const hostSpy = vi.hoisted(() => vi.fn());
const fallbackSpy = vi.hoisted(() => vi.fn());
const stackScreenSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const appShellState = vi.hoisted(() => ({
    projection: null as PluginUiProjectionModel | null,
    phase: 'current' as 'establishing' | 'current' | 'retainedOffline' | 'unavailable',
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
    useRouter: () => ({ push: routerPushSpy }),
    Stack: {
        Screen: (props: unknown) => {
            stackScreenSpy(props);
            return React.createElement('StackScreen', { props });
        },
    },
}));

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => routeFocusState.value,
}));

vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: appShellState.projection,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
        phase: appShellState.phase,
        interactionEnabled: appShellState.interactionEnabled,
    }),
}));

vi.mock('@/sync/domains/machines/administration/selectionPreferences', () => ({
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1: { plugins: 'plugins' },
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
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
    return {
        id: `settingsPage:${pluginId}:${pageId}`,
        pluginId,
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
        hostOrigin: {
            machineId: 'machine-1',
            serverId: 'server-1',
            generation: 4,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: {
                serverIdentityId: 'srv_account_a',
                materializationRef: {
                    pluginId,
                    machineId: 'machine-1',
                    materializationId: `${pluginId}-current`,
                },
            },
        },
    };
}

type SettingsPageHostProps = Readonly<{
    binding?: Readonly<{ openSurface?: PluginSurfaceOpenHandler }>;
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

afterEach(() => {
    standardCleanup();
    appShellState.projection = null;
    appShellState.phase = 'current';
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
    administrationTargetSelectorSpy.mockClear();
});

describe('PluginSettingsPageScreen', () => {
    it('keeps a restored Settings destination pending until the app projection has described it', async () => {
        appShellState.projection = null;
        appShellState.phase = 'establishing';
        appShellState.interactionEnabled = false;
        const { PluginSettingsPageScreen } = await import('./PluginSettingsPageScreen');

        const screen = await renderScreen(
            <PluginSettingsPageScreen pluginId="examples.descriptor-only" pageId="settings" />,
        );

        // An empty establishment model is not evidence that this exact route
        // was removed. Preserve route continuity and wait for its first
        // describe instead of rendering the current-missing tombstone.
        expect(screen.getTextContent()).toContain('localized:common.loading');
        expect(hostSpy).not.toHaveBeenCalled();
        expect(fallbackSpy).not.toHaveBeenCalled();
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

        routeFocusState.value = false;
        await screen.update(
            <PluginSettingsPageScreen
                key="settings-route-unfocused"
                pluginId="examples.descriptor-only"
                pageId="settings"
            />,
        );
        expect(screen.root.findByType('PluginSettingsPageHostMock' as never).props.focusEligible).toBe(false);
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
    });
}

/** Mirrors the app-shell's one target binding for route-level navigation tests. */
function SettingsTargetNavigationScope(props: React.PropsWithChildren): React.ReactElement {
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: appShellState.projection
            ? Object.values(appShellState.projection.surfacePlacementsById)
            : [],
        settingsPages: appShellState.projection
            ? Object.values(appShellState.projection.settingsPagesById)
            : [],
        targetKind: 'app',
    });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({
        projection: appShellState.projection,
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
