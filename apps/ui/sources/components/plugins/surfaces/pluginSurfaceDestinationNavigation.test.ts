import { describe, expect, it, vi } from 'vitest';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import {
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiSettingsPageBindingV1,
} from '@happier-dev/protocol/plugins/ui';

import type { PluginSurfaceOpenRequest } from './openPluginSurface';
import type {
    PluginUiSettingsPageProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createPluginSurfaceDestinationNavigationBinding,
    createPluginSurfaceDestinationOpenSurfaceHandler,
    resolvePluginSurfaceDestinationOpen,
} from './pluginSurfaceDestinationNavigation';

const destination = Object.freeze({ pluginId: 'acme.notes', localId: 'notes' });

function executionOrigin(input: Readonly<{
    pluginId?: string;
    materializationId?: string;
}> = {}): PluginMachineExecutionOriginV1 {
    return {
        serverIdentityId: 'srv_account_a',
        materializationRef: {
            pluginId: input.pluginId ?? destination.pluginId,
            machineId: 'machine-a',
            materializationId: input.materializationId ?? 'install-a',
        },
    };
}

function placement(input: Readonly<{
    container: PluginUiSurfacePlacementProjection['binding']['container'];
    targetKind?: 'app' | 'session' | 'project';
    localId?: string;
    origin?: boolean;
}>): PluginUiSurfacePlacementProjection {
    const pluginId = destination.pluginId;
    const localId = input.localId ?? destination.localId;
    const target = { kind: input.targetKind ?? 'app' } as const;
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId,
        destinationId: localId,
        rendererId: `${localId}-renderer`,
        container: input.container,
        target,
    });
    if (!binding) throw new Error('test fixture must use an admitted destination binding');
    return {
        id: `surfacePlacement:${pluginId}:${input.container}:${localId}`,
        pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: localId,
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: `${localId}-renderer` },
        display: { developerFallback: localId },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
        ...(input.origin === false ? {} : {
            hostOrigin: {
                machineId: 'machine-a',
                serverId: 'server-a',
                generation: 4,
                phase: 'current',
                interactionEnabled: true,
                executionOrigin: executionOrigin({ pluginId }),
            },
        }),
    } satisfies PluginUiSurfacePlacementProjection;
}

function settingsPage(input: Readonly<{
    pluginId?: string;
    localId?: string;
    availability?: PluginUiSettingsPageProjection['availability'];
}> = {}): PluginUiSettingsPageProjection {
    const pluginId = input.pluginId ?? 'acme.settings';
    const localId = input.localId ?? 'preferences';
    const binding = normalizePluginUiSettingsPageBindingV1({
        pluginId,
        pageId: localId,
        rendererId: `${localId}-renderer`,
    });
    if (!binding) throw new Error('test fixture must use an admitted Settings destination binding');
    return {
        id: `settingsPage:${pluginId}:${localId}`,
        pluginId,
        contributionKind: 'settingsPage',
        descriptorId: localId,
        page: {
            id: { pluginId, localId },
            group: { kind: 'host', id: 'general' },
            title: localId,
        },
        binding,
        renderer: { kind: 'reactNative', contributionId: `${localId}-renderer` },
        availability: input.availability ?? { state: 'available', reason: 'available', diagnostics: [] },
        hostOrigin: {
            machineId: 'machine-a',
            serverId: 'server-a',
            generation: 4,
            phase: 'current',
            interactionEnabled: true,
            executionOrigin: executionOrigin({ pluginId }),
        },
    } satisfies PluginUiSettingsPageProjection;
}

const request: PluginSurfaceOpenRequest = Object.freeze({ destination });

const retiredAccountLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => false,
    onRetire: () => Object.freeze({ dispose() {} }),
});

describe('plugin surface destination navigation', () => {
    it('routes a Session sidebar binding invocation to its same-target bottom owner', async () => {
        const sessionSidebar = placement({
            container: 'rightSidebarTab',
            targetKind: 'session',
            localId: 'session-sidebar',
        });
        const bottomPane = placement({
            container: 'bottomPane',
            targetKind: 'session',
            localId: 'activity-log',
        });
        const openSidebar = vi.fn(async () => ({ ok: true as const }));
        const openBottomPane = vi.fn(async () => ({ ok: true as const }));
        const binding = createPluginSurfaceDestinationNavigationBinding({
            placements: [sessionSidebar, bottomPane],
            targetKind: 'session',
            runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
        });
        binding.registerOwner({ container: 'rightSidebarTab', handler: openSidebar });
        binding.registerOwner({ container: 'bottomPane', handler: openBottomPane });

        await expect(binding.openSurface({
            destination: { pluginId: destination.pluginId, localId: 'activity-log' },
        })).resolves.toEqual({ ok: true });
        expect(openBottomPane).toHaveBeenCalledTimes(1);
        expect(openSidebar).not.toHaveBeenCalled();
    });

    it('routes an app-page binding invocation to the same-target Settings route owner', async () => {
        const page = settingsPage();
        const openSettingsPage = vi.fn(async () => ({ ok: true as const }));
        const binding = createPluginSurfaceDestinationNavigationBinding({
            placements: [],
            settingsPages: [page],
            targetKind: 'app',
        });
        binding.registerOwner({ container: 'settingsPage', handler: openSettingsPage });

        // This is the exact public binding passed to an app-page surface; it
        // contains no router or route reconstruction logic of its own.
        const appPageBinding = { openSurface: binding.openSurface };
        await expect(appPageBinding.openSurface({
            destination: { pluginId: 'acme.settings', localId: 'preferences' },
        })).resolves.toEqual({ ok: true });
        expect(openSettingsPage).toHaveBeenCalledTimes(1);
    });

    it('routes a Project Details binding invocation to its same-target right-pane owner', async () => {
        const detailsTab = placement({
            container: 'detailsTab',
            targetKind: 'project',
            localId: 'project-details',
        });
        const rightPane = placement({
            container: 'rightPane',
            targetKind: 'project',
            localId: 'project-companion',
        });
        const openRightPane = vi.fn(async () => ({ ok: true as const }));
        const targetBinding = createPluginSurfaceDestinationNavigationBinding({
            placements: [detailsTab, rightPane],
            targetKind: 'project',
            runtimeAdmission: { platform: 'web', formFactor: 'tablet' },
        });
        targetBinding.registerOwner({ container: 'rightPane', handler: openRightPane });

        // A mounted Details surface receives the target binding and delegates
        // this qualified destination; it does not decide a pane or rebuild a
        // Project target from its durable resource.
        const detailsSurfaceBinding = { openSurface: targetBinding.openSurface };
        await expect(detailsSurfaceBinding.openSurface({
            destination: { pluginId: destination.pluginId, localId: 'project-companion' },
        })).resolves.toEqual({ ok: true });
        expect(openRightPane).toHaveBeenCalledTimes(1);
    });

    it('fails closed when two mounted owners claim one target container', async () => {
        const sidebar = placement({ container: 'rightSidebarTab', targetKind: 'session' });
        const firstOwner = vi.fn(async () => ({ ok: true as const }));
        const secondOwner = vi.fn(async () => ({ ok: true as const }));
        const binding = createPluginSurfaceDestinationNavigationBinding({
            placements: [sidebar],
            targetKind: 'session',
        });
        binding.registerOwner({ container: 'rightSidebarTab', handler: firstOwner });
        binding.registerOwner({ container: 'rightSidebarTab', handler: secondOwner });

        await expect(binding.openSurface(request)).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_owner_unavailable',
        });
        expect(firstOwner).not.toHaveBeenCalled();
        expect(secondOwner).not.toHaveBeenCalled();
    });

    it('delegates one exact Settings destination to the incumbent Settings route owner', async () => {
        const page = settingsPage();
        const openSettingsPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [],
            settingsPages: [page],
            targetKind: 'app',
            handlers: { settingsPage: openSettingsPage },
        });

        const request: PluginSurfaceOpenRequest = Object.freeze({
            destination: { pluginId: 'acme.settings', localId: 'preferences' },
        });

        await expect(open(request)).resolves.toEqual({ ok: true });
        expect(openSettingsPage).toHaveBeenCalledWith(expect.objectContaining({
            placement: page,
            request,
            authority: expect.objectContaining({
                machineId: 'machine-a',
                generation: 4,
            }),
        }));
    });

    it('does not route an unavailable exact Settings page through an incumbent fallback', async () => {
        const page = settingsPage({
            availability: { state: 'fallback', reason: 'feature_disabled', diagnostics: ['feature_disabled'] },
        });
        const openSettingsPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [],
            settingsPages: [page],
            targetKind: 'app',
            handlers: { settingsPage: openSettingsPage },
        });

        await expect(open({
            destination: { pluginId: 'acme.settings', localId: 'preferences' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'feature_disabled',
        });
        expect(openSettingsPage).not.toHaveBeenCalled();
    });

    it('does not route an exact Settings page after its Account lifetime retires', async () => {
        const page = settingsPage();
        const openSettingsPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [],
            settingsPages: [page],
            targetKind: 'app',
            accountLifetime: retiredAccountLifetime,
            handlers: { settingsPage: openSettingsPage },
        });

        await expect(open({
            destination: { pluginId: 'acme.settings', localId: 'preferences' },
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_origin_unavailable',
        });
        expect(openSettingsPage).not.toHaveBeenCalled();
    });

    it('delegates one exact qualified binding to its only admitted container adapter', async () => {
        const rightSidebarTab = placement({ container: 'rightSidebarTab' });
        const openRightSidebarTab = vi.fn(async () => ({ ok: true as const }));
        const openPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [rightSidebarTab],
            targetKind: 'app',
            handlers: {
                rightSidebarTab: openRightSidebarTab,
                appPage: openPage,
            },
        });

        await expect(open(request)).resolves.toEqual({ ok: true });
        expect(openRightSidebarTab).toHaveBeenCalledWith(expect.objectContaining({
            placement: rightSidebarTab,
            request,
            authority: expect.objectContaining({
                machineId: 'machine-a',
                generation: 4,
            }),
        }));
        expect(openPage).not.toHaveBeenCalled();
    });

    it('rejects a desktop/tablet pane at phone admission before its owner can select it', async () => {
        const rightPane = placement({ container: 'rightPane', targetKind: 'session' });
        const openRightPane = vi.fn(async () => ({ ok: true as const }));
        const phoneOpen = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [rightPane],
            targetKind: 'session',
            runtimeAdmission: { platform: 'ios', formFactor: 'phone' },
            handlers: { rightPane: openRightPane },
        });

        await expect(phoneOpen(request)).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_platform_unavailable',
        });
        expect(openRightPane).not.toHaveBeenCalled();

        const tabletOpen = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [rightPane],
            targetKind: 'session',
            runtimeAdmission: { platform: 'ios', formFactor: 'tablet' },
            handlers: { rightPane: openRightPane },
        });

        await expect(tabletOpen(request)).resolves.toEqual({ ok: true });
        expect(openRightPane).toHaveBeenCalledTimes(1);
    });

    it('rejects a duplicate exact target binding instead of retaining the sidebar tab-first/page fallback', async () => {
        const rightSidebarTab = placement({ container: 'rightSidebarTab' });
        const page = placement({ container: 'appPage' });
        const openRightSidebarTab = vi.fn(async () => ({ ok: true as const }));
        const openPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [rightSidebarTab, page],
            targetKind: 'app',
            handlers: {
                rightSidebarTab: openRightSidebarTab,
                appPage: openPage,
            },
        });

        await expect(open(request)).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_ambiguous',
        });
        expect(openRightSidebarTab).not.toHaveBeenCalled();
        expect(openPage).not.toHaveBeenCalled();
    });

    it('fails closed when a direct scope loses its current projection authority', () => {
        const directSessionTab = placement({ container: 'rightSidebarTab', targetKind: 'session', origin: false });

        expect(resolvePluginSurfaceDestinationOpen({
            placements: [directSessionTab],
            targetKind: 'session',
            scopedLaunchFacts: {
                serverId: 'server-a',
                machineId: 'machine-a',
                generation: 4,
                interactionEnabled: false,
            },
            request,
        })).toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_origin_unavailable',
        });
    });

    it('does not substitute an app page when a session surface requests the same qualified reference', async () => {
        const appPage = placement({ container: 'appPage', targetKind: 'app' });
        const openPage = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [appPage],
            targetKind: 'session',
            handlers: { appPage: openPage },
        });

        await expect(open(request)).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_open_destination_unknown',
        });
        expect(openPage).not.toHaveBeenCalled();
    });

    it('rejects a sub-path for a pane destination instead of selecting it and dropping the location', async () => {
        const rightSidebarTab = placement({ container: 'rightSidebarTab' });
        const openRightSidebarTab = vi.fn(async () => ({ ok: true as const }));
        const open = createPluginSurfaceDestinationOpenSurfaceHandler({
            placements: [rightSidebarTab],
            targetKind: 'app',
            handlers: { rightSidebarTab: openRightSidebarTab },
        });

        await expect(open({ ...request, subPath: 'repair' })).resolves.toEqual({
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_unsupported',
        });
        expect(openRightSidebarTab).not.toHaveBeenCalled();
    });
});
