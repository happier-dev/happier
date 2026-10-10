import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { normalizePluginUiDestinationBindingV1, PluginUiDestinationBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginUiProjection, createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';

describe('plugin surface execution requirement', () => {
    afterEach(async () => { await standardCleanup(); });

    it('binds through real Account and machine owners and rejects a replaced occurrence before rerender', async () => {
        installDisconnectedServerSocketBoundary();
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://surface-source.example.test',
            serverIdentityId: 'srv_surface_source', accountId: 'account-surface-source' });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Account restoration did not establish a lifetime');
        const scope = lifetime.scope;
        const pluginId = 'acme.surface-source';
        const machineId = 'machine-source';
        const entryId = `surfacePlacement:${pluginId}:home`;
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'home', rendererId: 'home',
            container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Source fixture must use an admitted destination');
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'surface-source-root' };
        const project = (occurrenceId: string, generation: number) => {
            const model = normalizePluginUiProjection({ v: 2, generation, agentsById: {}, actionsById: {}, toolsById: {},
                commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Source surface', version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: 'surface-source-root' }, occurrenceId, sourceCustody,
                    executionTarget: { default: 'installation' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entryId]: {
                    id: entryId, pluginId, occurrenceId, contributionKind: 'surfacePlacement', descriptorId: 'home', binding: PluginUiDestinationBindingV1Schema.parse(binding), target: binding.target,
                    renderer: { kind: 'hostedHtml', contributionId: 'home', source: artifactHtmlBundleFromBodyV1('<p>Source</p>'), requiredHostMethods: ['context'] },
                    display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
                } } } },
            });
            const union = unionPluginUiProjections([{ machineId, serverId: connection.home.id, serverIdentityId: 'srv_surface_source',
                phase: 'current', interactionEnabled: true, projection: model }]).pluginUiProjection;
            if (!union) throw new Error('Source projection failed admission');
            if (!union.surfacePlacementsById[entryId]) throw new Error('Source placement failed canonical admission');
            return union;
        };
        const initialProjection = project('occurrence-a', 1);
        let committedProjection = initialProjection;
        const machine = createMachineFixture({ id: machineId, active: true, activeAt: Date.now() });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: { [machineId]: machine }, machineListByServerId: { [connection.home.id]: [machine] },
            machineListStatusByServerId: { [connection.home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        function Wrapper({ children }: React.PropsWithChildren) {
            return React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
                pluginUiProjection: committedProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: null, serverId: null, platform: 'web', accountLifetime: lifetime,
                reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {},
            }, children });
        }
        try {
            const hook = await renderHook(() => usePluginSurfaceExecutionOrigin({ pluginId, projection: initialProjection,
                entry: initialProjection.surfacePlacementsById[entryId], enabled: true }), { wrapper: Wrapper });
            const mounted = hook.getCurrent();
            expect(mounted.selectedSupply, JSON.stringify(mounted.selection.state)).toMatchObject({ occurrenceId: 'occurrence-a', generation: 1 });
            expect(mounted.isExecutionOriginCurrent()).toBe(true);
            const supply = mounted.selectedSupply;
            if (!supply?.executionOrigin) throw new Error('Selected source supply must retain its exact origin');
            const action = { id: 'refresh', pluginId, occurrenceId: 'occurrence-a', title: 'Refresh', scopes: ['session'],
                surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } satisfies PluginProjectedActionV2;
            const execute = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: { refreshed: true } } }));
            const controller = createBoundPluginSurfaceController({ facts: {
                pluginId, contributionId: 'home', surfaceId: entryId, placement: 'appSurface', platform: 'web', channel: 'internal',
                machineId: supply.machineId, serverId: supply.serverId, projectionGeneration: supply.generation,
                occurrenceId: supply.occurrenceId, executionOrigin: supply.executionOrigin, accountLifetime: lifetime,
                interactionEnabled: true, daemonInteractionEnabled: true,
                resolveContributedAction: createPluginUiProjectedActionResolver({ [`${pluginId}/refresh`]: action }),
            }, binding: { executeContributedAction: execute, isExecutionOriginCurrent: mounted.isExecutionOriginCurrent } });
            await expect(controller.dispatchAction({ pluginId, localId: 'refresh' })).resolves.toEqual({ refreshed: true });
            expect(execute).toHaveBeenCalledWith(machineId, expect.objectContaining({ serverId: connection.home.id,
                expectedContributorOccurrenceId: 'occurrence-a', qualifiedActionId: `${pluginId}/refresh`, isCurrent: expect.any(Function) }));
            execute.mockClear();
            committedProjection = project('occurrence-b', 2);
            await hook.rerender();
            // Deliberately hold the mounted entry at A: the committed owner has B.
            expect(mounted.isExecutionOriginCurrent()).toBe(false);
            await expect(controller.dispatchAction({ pluginId, localId: 'refresh' })).resolves.toMatchObject({ code: 'unavailable' });
            expect(execute).not.toHaveBeenCalled();
            expect(controller.isCurrent()).toBe(true);
            controller.dispose();
            await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'other-account' } }); });
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            await hook.unmount();
        } finally { await connection.dispose(); }
    });
    it('keeps local presentation machine-free but recognizes packaged renderer daemon methods', () => {
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['context', 'openSurface'] } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['readResource', 'watchResource'] } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['selectActionInput'] } })).toBe(true);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            reactNativeBundlesById: { 'reactNativeBundle:acme.panel:home': {
                id: 'reactNativeBundle:acme.panel:home', pluginId: 'acme.panel', contributionKind: 'reactNativeBundle',
                contributionId: 'home', requiredHostMethods: ['readResource'],
            } },
        }, renderer: { kind: 'reactNative', contributionId: 'home' },
            resourceCapability: { readable: true, dynamic: false } })).toBe(true);
    });
    it('leaves malformed host requirements to renderer admission without attempting execution selection', () => {
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['not-a-host-method'] },
            resourceCapability: { readable: true, dynamic: true } })).toBe(false);
    });
    it('recognizes a header-only daemon declaration before an execution supplier is selected', () => {
        const action = { id: 'refresh', pluginId: 'acme.panel', occurrenceId: 'header-action-occurrence', title: 'Refresh', scopes: ['session'],
            surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: false } satisfies PluginProjectedActionV2;
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel',
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, actionsById: { 'acme.panel/refresh': action } },
            renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['context'] },
            headerActions: [{ command: { kind: 'executeAction', action: { pluginId: 'acme.panel', localId: 'refresh' } } }],
        })).toBe(true);
    });
});
