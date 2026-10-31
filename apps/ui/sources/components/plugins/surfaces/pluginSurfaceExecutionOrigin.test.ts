import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { normalizePluginUiDestinationBindingV1, PluginUiDestinationBindingV1Schema } from '@happier-dev/protocol/plugins/ui';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginUiProjection, normalizePluginInstalledUiDeclarations, createPluginUiProjectedActionResolver, type PluginUiInstalledPackageProjection } from '@/sync/domains/plugins/ui/projection';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol';
import { mergeInstalledPluginUiProjections, readPluginUiContributionSupplies, unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { createDeferred, createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import * as machineRpcBoundary from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjection';
import { useMountedTargetedContributions } from './mountedTargetedContributions';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createPluginExecutionOriginActionDeps } from '@/sync/ops/actions/pluginExecutionOriginActionDeps';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { readPluginMachineExecutionLastUsedTarget, setPluginMachineExecutionOriginPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import { clearMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/context', segments: ['(app)', 'session', '[id]'] }).module;
});

vi.mock('socket.io-client', async (importOriginal) => {
    const { createSocketIoClientBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    return createSocketIoClientBoundary(importOriginal);
});

describe('plugin surface execution requirement', () => {
    afterEach(async () => { await standardCleanup(); });

    it('binds through real Account and machine owners and rejects a replaced occurrence before rerender', async () => {
        const census = ['machine-source', 'machine-other-source'].map(id => createPlainMachineRowFixture({
            id, accountId: 'account-surface-source',
        }));
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://surface-source.example.test',
            serverIdentityId: 'srv_surface_source', accountId: 'account-surface-source', credentials: { token: `e30.${Buffer.from(JSON.stringify({
                sub: 'account-surface-source', provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0,
            })).toString('base64url')}.signature` }, request: async url => new URL(String(url)).pathname === '/v1/machines'
                ? Response.json({ machines: census }) : null });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Account restoration did not establish a lifetime');
        const scope = lifetime.scope;
        // Restore the real Account before freezing its clock, as the Home testkit requires.
        // A cold Action import must not age this admitted Machine fixture into an offline one.
        const admittedAtMs = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(admittedAtMs);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = (await TokenStorage.getCredentialsForServerUrl(connection.home.serverUrl))!;
        const pluginId = 'acme.surface-source';
        const machineId = 'machine-source';
        const entryId = `surfacePlacement:${pluginId}:home`;
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'home', rendererId: 'home',
            container: 'appPage', target: { kind: 'app' } });
        if (!binding) throw new Error('Source fixture must use an admitted destination');
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'surface-source-root' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_surface_source',
            sourceRef: { machineId, pluginId, sourceCustody } });
        const project = (occurrenceId: string, generation: number, phase: 'current' | 'establishing' | 'unavailable' = 'current',
            unavailableReasonCode?: string) => {
            const model = normalizePluginUiProjection({ v: 2, generation, agentsById: {}, actionsById: {}, toolsById: {},
                commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [],
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Source surface', version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: 'surface-source-root' }, occurrenceId, sourceCustody, executionOrigin,
                    declaresContributionPoints: true,
                    executionTarget: { default: 'installation' } } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [entryId]: {
                    id: entryId, pluginId, occurrenceId, executionOrigin, contributionKind: 'surfacePlacement', descriptorId: 'home', binding: PluginUiDestinationBindingV1Schema.parse(binding), target: binding.target,
                    renderer: { kind: 'hostedHtml', contributionId: 'home', source: artifactHtmlBundleFromBodyV1('<p>Source</p>'), requiredHostMethods: [] },
                    display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
                } } }, composerControls: { family: 'composerControls', entriesById: {
                    [`${pluginId}/review`]: {
                        id: `${pluginId}/review`, pluginId, identity: { pluginId, localId: 'review' }, occurrenceId,
                        definition: { id: 'review', label: 'Review', icon: 'preview', scopes: ['discussion'],
                            interaction: { kind: 'action', action: 'review' } },
                    },
                } } },
            });
            const union = unionPluginUiProjections([{ machineId, serverId: connection.home.id, serverIdentityId: 'srv_surface_source',
                phase, interactionEnabled: phase === 'current', projection: model,
                ...(unavailableReasonCode ? { unavailableReasonCode } : {}) }]).pluginUiProjection;
            if (!union) throw new Error('Source projection failed admission');
            if (!union.surfacePlacementsById[entryId]) throw new Error('Source placement failed canonical admission');
            return union;
        };
        const initialProjection = project('occurrence-a', 1);
        const declarationProjection = normalizePluginInstalledUiDeclarations({ [entryId]: {
            id: entryId, pluginId, contributionKind: 'surfacePlacement', descriptorId: 'home',
            binding: PluginUiDestinationBindingV1Schema.parse(binding), target: binding.target,
            renderer: { kind: 'hostedHtml', contributionId: 'home',
                source: artifactHtmlBundleFromBodyV1('<p>Source</p>'), requiredHostMethods: [] },
            display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
        } }, 'web', { id: pluginId, displayName: 'Source surface', enabled: true,
            source: { kind: 'bundled', locator: 'app-bundle:acme.surface-source' },
            declaredExecution: { daemonActions: true, contributionPoints: true } });
        let committedProjection = initialProjection;
        const machine = createMachineFixture({ id: machineId, active: true, activeAt: Date.now(),
            daemonState: { status: 'running', pid: 17, runtimeId: 'surface-source-runtime', contributionRegistryProjectionRevision: 55 } });
        storage.setState({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: { [machineId]: machine }, machineListByServerId: { [connection.home.id]: [machine] },
            machineListStatusByServerId: { [connection.home.id]: 'idle', srv_surface_source: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        function Wrapper({ children }: React.PropsWithChildren) {
            return React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
                pluginUiProjection: committedProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
                machineId: null, serverId: null, platform: 'web', accountLifetime: lifetime,
                reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {},
            }, children });
        }
        function ContextPort() {
            const reader = useOptionalCurrentUiContextReader();
            React.useLayoutEffect(() => reader ? registerCurrentUiContextActionPort(() => reader) : undefined, [reader]);
            return null;
        }
        function ContextualWrapper({ children }: React.PropsWithChildren) {
            return React.createElement(InjectedAuthProvider, { credentials, children: React.createElement(MainAppTabStateProvider, null,
                React.createElement(AppPaneProvider, null, React.createElement(CurrentUiContextProvider, null,
                    React.createElement(ContextPort), children))) });
        }
        try {
            committedProjection = declarationProjection;
            let projectionForRender = declarationProjection;
            let pageEntryForRender = declarationProjection.surfacePlacementsById[entryId];
            const hook = await renderHook(() => usePluginSurfaceExecutionOrigin({ pluginId, projection: projectionForRender,
                entry: pageEntryForRender, includeMachineCandidates: false, enabled: isPluginSurfaceMachineBound({
                    pluginId, projection: projectionForRender, surface: pageEntryForRender!,
                }) }), { wrapper: Wrapper });
            // A cold app declaration precedes both the live Machine census and
            // its runtime contribution supply. It is unknown, not a refusal.
            await act(async () => storage.setState({ machines: {}, machineListByServerId: {},
                machineListStatusByServerId: { [connection.home.id]: 'loading', srv_surface_source: 'loading' } }));
            expect(Object.keys(projectionForRender.actionsById)).toHaveLength(0);
            expect(readPluginUiContributionSupplies(pageEntryForRender)).toHaveLength(0);
            expect(hook.getCurrent().selection.loading).toBe(true);
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            // A settled census does not settle this known installation's first
            // runtime describe. No contribution supply exists until it answers.
            const materialization = { serverIdentityId: 'srv_surface_source', machineId,
                materializationId: 'source-installation', pluginId, version: '1.0.0', sourceClass: 'localPath' as const,
                portableRelease: false, enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] };
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                    availabilityCursor: 1, intentReads: [], materializations: [materialization], snapshots: [],
                } });
                storage.setState({ machines: { [machineId]: machine },
                    machineListByServerId: { [connection.home.id]: [machine], srv_surface_source: [machine] },
                    machineListStatusByServerId: { [connection.home.id]: 'idle', srv_surface_source: 'idle' } });
            });
            const coldProjection = (phase: 'establishing' | 'unavailable') => mergeInstalledPluginUiProjections([declarationProjection],
                unionPluginUiProjections([{ machineId, serverId: connection.home.id, serverIdentityId: 'srv_surface_source',
                    phase, interactionEnabled: false, projection: null, materializationsByPluginId: { [pluginId]: materialization } }]).pluginUiProjection)!;
            committedProjection = projectionForRender = coldProjection('establishing');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(readPluginUiContributionSupplies(pageEntryForRender)).toHaveLength(0);
            expect(hook.getCurrent().selection.loading).toBe(true);
            expect(hook.getCurrent().selection.canExecute).toBe(false);
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference({}, pluginId, {
                    serverIdentityId: 'srv_surface_source', sourceRef: { pluginId, sourceCustody, machineId: 'explicit-other-machine' },
                }) } }));
            expect(hook.getCurrent().selection.loading).toBe(false);
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: {} } }));
            expect(hook.getCurrent().selection.loading).toBe(true);
            committedProjection = projectionForRender = coldProjection('unavailable');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(hook.getCurrent().selection.loading).toBe(false);
            committedProjection = projectionForRender = initialProjection;
            pageEntryForRender = initialProjection.surfacePlacementsById[entryId];
            // The cold HTTP fixture finishes restoration with no machine
            // inventory. Publish this test's live observation after that turn.
            await act(async () => storage.setState({ machines: { [machineId]: machine },
                machineListByServerId: { [connection.home.id]: [machine], srv_surface_source: [machine] },
                machineListStatusByServerId: { [connection.home.id]: 'idle', srv_surface_source: 'idle' } }));
            await hook.rerender();
            let mounted = hook.getCurrent();
            expect(mounted.selectedSupply, JSON.stringify(mounted.selection.state)).toMatchObject({ occurrenceId: 'occurrence-a' });
            expect(mounted.selection.machineCandidates).toHaveLength(0);
            expect(mounted.isExecutionOriginCurrent()).toBe(true);
            // Re-description preserves this exact mounted identity, never its
            // executable authority. A definitive answer with the same refusal
            // reason is not that transient refresh and must withdraw it.
            committedProjection = projectionForRender = project('occurrence-a', 1, 'establishing');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(hook.getCurrent().selectedSupply).toMatchObject({ occurrenceId: 'occurrence-a',
                phase: 'establishing', interactionEnabled: false });
            expect(hook.getCurrent().selection.canExecute).toBe(false);
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            committedProjection = projectionForRender = project('occurrence-a', 1, 'current', 'plugin_source_not_ready');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(hook.getCurrent().selectedSupply).toBeNull();
            expect(hook.getCurrent().selection.canExecute).toBe(false);
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            committedProjection = projectionForRender = initialProjection;
            pageEntryForRender = initialProjection.surfacePlacementsById[entryId];
            await hook.rerender();
            // A published content hint can advance before its opened Machine
            // row. Keep the projection source constant to isolate inventory
            // readiness from genuine registry/occurrence replacement.
            const targetedStarted = createDeferred<void>();
            const targetedReply = createDeferred<unknown>();
            const targetSignals: AbortSignal[] = [];
            const transport = vi.spyOn(machineRpcBoundary, 'machineRpcWithServerScope').mockImplementation(async request => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ || !request.signal) {
                    throw new Error('The diagnostic expects only a signal-bound targeted Machine read');
                }
                targetSignals.push(request.signal);
                targetedStarted.resolve();
                return targetedReply.promise;
            });
            // Sibling consumers share the mounted AppShell publisher. Creating
            // another provider would replace its process-wide committed reader.
            const targetHook = await renderHook(() => {
                const origin = usePluginSurfaceExecutionOrigin({ pluginId, projection: initialProjection,
                    entry: initialProjection.surfacePlacementsById[entryId], includeMachineCandidates: false, enabled: true });
                const occurrenceId = origin.selectedSupply?.occurrenceId;
                const targeted = useMountedTargetedContributions({ machineId, serverId: connection.home.id, pluginId,
                    accountLifetime: lifetime,
                    mountedOccurrenceId: occurrenceId, enabled: Boolean(occurrenceId) });
                return { origin, targeted };
            });
            try {
                await targetedStarted.promise;
                expect(targetHook.getCurrent().origin.selectedSupply).toMatchObject({ occurrenceId: 'occurrence-a' });
                expect(targetSignals[0]?.aborted).toBe(false);
                const revisionScope = { machineId, serverId: connection.home.id };
                const revisionBefore = getMachineContributionRegistryProjectionRevision(revisionScope);
                const pendingMachine = { ...machine, keyBasis: { metadataVersion: machine.metadataVersion + 1,
                    daemonStateVersion: machine.daemonStateVersion + 1, dataEncryptionKey: machine.dataEncryptionKey ?? null } };
                await act(async () => storage.getState().applyMachines([pendingMachine], false,
                    { sourceServerId: connection.home.id, sourceAccountId: scope.accountId }));
                await flushHookEffects({ cycles: 3, turns: 2 });
                expect(readMachineInventoryRowReadiness(storage.getState().machines[machineId]!)).toBe('pending');
                expect(getMachineContributionRegistryProjectionRevision(revisionScope)).toBe(revisionBefore);
                expect(targetHook.getCurrent().origin.selection.canExecute).toBe(false);
                expect(targetHook.getCurrent().origin.selection.state).toMatchObject({ kind: 'selected' });
                expect(targetHook.getCurrent().origin.selectedSupply).toMatchObject({ occurrenceId: 'occurrence-a' });
                expect(targetSignals[0]?.aborted).toBe(false);
                const openedMachine = { ...pendingMachine, metadataVersion: pendingMachine.keyBasis.metadataVersion,
                    daemonStateVersion: pendingMachine.keyBasis.daemonStateVersion };
                await act(async () => storage.getState().applyMachines([openedMachine], false,
                    { sourceServerId: connection.home.id, sourceAccountId: scope.accountId }));
                await flushHookEffects({ cycles: 3, turns: 2 });
                expect(readMachineInventoryRowReadiness(storage.getState().machines[machineId]!)).toBe('available');
                expect(getMachineContributionRegistryProjectionRevision(revisionScope)).toBe(revisionBefore);
                expect(targetHook.getCurrent().origin.selection.canExecute).toBe(true);
                expect(targetHook.getCurrent().origin.selectedSupply).toMatchObject({ occurrenceId: 'occurrence-a' });
                expect(targetSignals).toHaveLength(1);
                expect(targetSignals[0]?.aborted).toBe(false);
                targetedReply.resolve(DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'current',
                    targetedContributions: { target: { pluginId, occurrenceId: 'occurrence-a', sourceCustody }, points: [] },
                    targetedSurfaceMounts: [] }));
                await flushHookEffects({ cycles: 3, turns: 2 });
                expect(targetHook.getCurrent().targeted).toMatchObject({ phase: 'ready',
                    targetedContributions: { target: { pluginId, occurrenceId: 'occurrence-a' } } });
            } finally {
                targetedReply.resolve(undefined);
                await targetHook.unmount();
                transport.mockRestore();
                await act(async () => storage.getState().applyMachines([machine], false,
                    { sourceServerId: connection.home.id, sourceAccountId: scope.accountId }));
            }
            // The intentional inventory round-trip above may replace semantic
            // selection facts. The next checks concern unrelated rerenders of
            // the now-settled selection, not its pre-round-trip object identity.
            await hook.rerender();
            mounted = hook.getCurrent();
            const composerEntry = initialProjection.composerControlsById[`${pluginId}/review`];
            expect(composerEntry).toBeDefined();
            const composerOrigin = await renderHook(() => usePluginSurfaceExecutionOrigin({ pluginId,
                projection: initialProjection, entry: composerEntry, enabled: true, includeMachineCandidates: false,
            }));
            expect(composerOrigin.getCurrent().selectedSupply).toMatchObject({ machineId, occurrenceId: 'occurrence-a' });
            expect(composerOrigin.getCurrent().isExecutionOriginCurrent()).toBe(true);
            committedProjection = project('replacement-occurrence', 2);
            await hook.rerender();
            expect(composerOrigin.getCurrent().isExecutionOriginCurrent()).toBe(false);
            await composerOrigin.unmount();
            committedProjection = initialProjection;
            // Restore the source through the same AppShell publication owner.
            await hook.rerender();
            // Currentness is read during controller construction in render.
            // Inspecting authority must not persist a last-use hint or notify
            // other mounted Settings consumers. An actual invocation still does.
            expect(readPluginMachineExecutionLastUsedTarget(scope, pluginId)).toBeNull();
            await act(async () => { expect(mounted.selection.resolveExecutionOrigin()?.origin).toEqual(executionOrigin); });
            expect(readPluginMachineExecutionLastUsedTarget(scope, pluginId))
                .toEqual({ serverIdentityId: executionOrigin.serverIdentityId, machineId });
            // The composer replaced and restored the committed source above,
            // and this invocation deliberately wrote the last-use input. Take
            // the settled baseline after those changes, not before them.
            mounted = hook.getCurrent();
            // Route chrome can rerender while a picker opens. An equivalent
            // page snapshot is not a new plugin selection or resolving state.
            pageEntryForRender = { ...pageEntryForRender! };
            await hook.rerender();
            expect(hook.getCurrent().selection.state).toBe(mounted.selection.state);
            expect(hook.getCurrent().selection.selectedOrigin).toBe(mounted.selection.selectedOrigin);
            // Availability can be settled while this exact Machine's producer
            // is still establishing. An unavailable producer is not pending.
            await act(async () => {
                replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                    availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
                } });
            });
            committedProjection = projectionForRender = project('occurrence-a', 1, 'establishing');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(hook.getCurrent().selection.storedTarget).toBeNull();
            // The same selection feeds the page/Settings Run-on chip: an
            // establishing producer cannot be presented as an empty census.
            expect(hook.getCurrent().selection.loading).toBe(true);
            await act(async () => {
                storage.setState({ settings: { ...storage.getState().settings,
                    machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference({}, pluginId, executionOrigin) } });
            });
            for (const phase of ['establishing', 'unavailable'] as const) {
                committedProjection = projectionForRender = project('occurrence-a', 1, phase);
                pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
                await hook.rerender();
                expect(hook.getCurrent().selection.loading).toBe(phase === 'establishing');
                expect(hook.getCurrent().selection.canExecute).toBe(false);
            }
            const unavailableSupply = readPluginUiContributionSupplies(pageEntryForRender)[0]!;
            pageEntryForRender = { ...pageEntryForRender!, hostSupplies: [unavailableSupply, {
                ...unavailableSupply, machineId: 'unrelated-establishing-machine', phase: 'establishing',
                executionOrigin: PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_surface_source',
                    sourceRef: { machineId: 'unrelated-establishing-machine', pluginId, sourceCustody } }),
            }] };
            await hook.rerender();
            expect(hook.getCurrent().selection.loading).toBe(false);
            committedProjection = projectionForRender = initialProjection;
            pageEntryForRender = initialProjection.surfacePlacementsById[entryId];
            clearPluginAccountAvailabilityProjection();
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: {} } }));
            await hook.rerender();
            // A presence flap withdraws executable authority, not the exact
            // producer that already supplied this mounted page.
            const offlineMachine = { ...machine, active: false, activeAt: 0 };
            await act(async () => { storage.setState({ machines: { [machineId]: offlineMachine },
                machineListByServerId: { [connection.home.id]: [offlineMachine] } }); });
            await hook.rerender();
            expect(hook.getCurrent().selection.canExecute).toBe(false);
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(false);
            expect(hook.getCurrent().selectedSupply).toBe(mounted.selectedSupply);
            // Offline settles the Run-on chip and body even while Account
            // availability has not returned. No daemon read can finish offline.
            committedProjection = projectionForRender = project('occurrence-a', 1, 'establishing');
            pageEntryForRender = projectionForRender.surfacePlacementsById[entryId];
            await hook.rerender();
            expect(hook.getCurrent().selection.state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
            expect(hook.getCurrent().selection.loading).toBe(false);
            expect(hook.getCurrent().loading).toBe(false);
            committedProjection = projectionForRender = initialProjection;
            pageEntryForRender = initialProjection.surfacePlacementsById[entryId];
            await act(async () => { storage.setState({ machines: { [machineId]: machine },
                machineListByServerId: { [connection.home.id]: [machine] } }); });
            await hook.rerender();
            expect(hook.getCurrent().isExecutionOriginCurrent()).toBe(true);
            // Origin selection belongs to the plugin, not the currently open
            // page. Another current installation may expose a different page.
            const otherMachineId = 'machine-other-source';
            const otherMachine = createMachineFixture({ id: otherMachineId, active: true, activeAt: Date.now() });
            const otherEntryId = `surfacePlacement:${pluginId}:other`;
            const otherEntry = { ...initialProjection.surfacePlacementsById[entryId]!, id: otherEntryId,
                hostOrigin: null, hostSupplies: readPluginUiContributionSupplies(initialProjection.surfacePlacementsById[entryId]).map(supply => ({
                    ...supply, machineId: otherMachineId, executionTargetDefault: false,
                    executionOrigin: { serverIdentityId: 'srv_surface_source', sourceRef: {
                        machineId: otherMachineId, pluginId, sourceCustody: { kind: 'development' as const, registeredRootId: 'other-root' },
                    } },
                })) };
            const pageEntry = { ...initialProjection.surfacePlacementsById[entryId]!, hostSupplies:
                readPluginUiContributionSupplies(initialProjection.surfacePlacementsById[entryId]).map(supply => ({ ...supply, executionTargetDefault: false })) };
            // This page-only neighbor deliberately has no default Composer supply.
            const multiProjection = { ...initialProjection, composerControlsById: {},
                surfacePlacementsById: { [entryId]: pageEntry, [otherEntryId]: otherEntry } };
            await act(async () => { storage.setState({ machines: { [machineId]: machine, [otherMachineId]: otherMachine },
                machineListByServerId: { [connection.home.id]: [machine, otherMachine] },
                settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } }); });
            committedProjection = multiProjection;
            await hook.rerender();
            const multiHook = await renderHook(() => usePluginSurfaceExecutionOrigin({ pluginId, projection: multiProjection,
                entry: pageEntry, enabled: true }));
            expect(multiHook.getCurrent().selection.state).toMatchObject({ kind: 'selected', selectionSource: 'auto',
                origin: { sourceRef: { machineId } } });
            expect(multiHook.getCurrent().selectedSupply?.machineId).toBe(machineId);
            const savedOtherOrigin = readPluginUiContributionSupplies(otherEntry)[0]?.executionOrigin;
            if (!savedOtherOrigin || !('sourceRef' in savedOtherOrigin)) throw new Error('Other source must have an exact origin');
            // A second mounted consumer shares the incumbent Auto choice. An
            // explicit pin can still select a Machine without this page.
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference({}, pluginId, savedOtherOrigin) } }));
            expect(multiHook.getCurrent().selection.state).toMatchObject({ kind: 'selected', selectionSource: 'pinned',
                origin: savedOtherOrigin });
            expect(multiHook.getCurrent().selectedSupply).toBeNull();
            await multiHook.unmount();
            await act(async () => storage.setState({ settings: { ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: {} } }));
            const savedPreferences = { v: 1 as const, pluginExecutionOriginsByPluginId: { [pluginId]: savedOtherOrigin } };
            await act(async () => storage.setState({ settingsVersion: 1, settings: { ...storage.getState().settings,
                machineAdministrationSelectionsV1: savedPreferences } }));
            let contextualMachineId = machineId;
            const contextual = await renderHook(() => usePluginSurfaceExecutionOrigin({ pluginId, projection: multiProjection,
                entry: pageEntry, enabled: true, contextualTarget: { serverIdentityId: 'srv_surface_source', machineId: contextualMachineId } }), { wrapper: ContextualWrapper });
            expect(contextual.getCurrent().selectedSupply?.machineId).toBe(machineId);
            expect(contextual.getCurrent().isExecutionOriginCurrent()).toBe(true);
            const actionAccount = await captureLazyActionAccountContext(connection.home.id);
            const owner = createPluginExecutionOriginActionDeps(actionAccount).pluginExecutionOriginAction!;
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ pluginExecutionOriginAction: owner }));
            const invoke = async (actionId: Parameters<typeof owner>[0]['actionId'], input: unknown) => {
                const result = await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation' });
                expect(result.ok).toBe(true);
                return result.ok ? result.result : null;
            };
            const inventory = await invoke('plugins.execution_origin.list', { pluginId, contextual: true });
            expect(inventory).toMatchObject({ status: 'available', contextualTargets: [{ commandId: expect.any(String) }] });
            const target = (inventory as { contextualTargets: readonly { commandId: string }[] }).contextualTargets[0]!;
            const contextualTarget = { commandId: target.commandId };
            expect(await invoke('plugins.execution_origin.list', { pluginId, contextualTarget }))
                .toMatchObject({ status: 'available', storedOrigin: null, selectedOrigin: readPluginUiContributionSupplies(pageEntry)[0]?.executionOrigin });
            await act(async () => { expect(await invoke('plugins.execution_origin.set', { pluginId, contextualTarget, origin: savedOtherOrigin }))
                .toEqual({ status: 'applied' }); });
            expect(contextual.getCurrent().selection.resolveExecutionOrigin()?.machineTarget.target.machineId,
                JSON.stringify({ state: contextual.getCurrent().selection.state, canExecute: contextual.getCurrent().selection.canExecute,
                    lifetimeCurrent: lifetime.isCurrent(), scope, settingsScope: storage.getState().settingsScope,
                    machines: storage.getState().machines })).toBe(otherMachineId);
            expect(storage.getState().settings.machineAdministrationSelectionsV1).toBe(savedPreferences);
            expect(await invoke('plugins.execution_origin.set', { pluginId, contextualTarget,
                origin: { ...savedOtherOrigin, sourceRef: { ...savedOtherOrigin.sourceRef, machineId: 'absent' } } })).toEqual({ status: 'unavailable' });
            await act(async () => { expect(await invoke('plugins.execution_origin.clear', { pluginId, contextualTarget })).toEqual({ status: 'applied' }); });
            expect(contextual.getCurrent().selectedSupply?.machineId).toBe(machineId);
            await act(async () => { storage.setState({ machines: { [machineId]: machine, [otherMachineId]: { ...otherMachine, active: false, activeAt: 0 } },
                machineListByServerId: { [connection.home.id]: [machine, { ...otherMachine, active: false, activeAt: 0 }] } }); });
            expect(await invoke('plugins.execution_origin.set', { pluginId, contextualTarget, origin: savedOtherOrigin })).toEqual({ status: 'unavailable' });
            await act(async () => { storage.setState({ machines: { [machineId]: machine, [otherMachineId]: otherMachine },
                machineListByServerId: { [connection.home.id]: [machine, otherMachine] } }); });
            await act(async () => { expect(await contextual.getCurrent().selection.selectOrigin(savedOtherOrigin)).toMatchObject({ status: 'applied' }); });
            expect(contextual.getCurrent().selection.resolveExecutionOrigin()?.machineTarget.target.machineId).toBe(otherMachineId);
            expect(storage.getState().settings.machineAdministrationSelectionsV1).toBe(savedPreferences);
            await act(async () => { await contextual.getCurrent().selection.clearOrigin(); });
            expect(contextual.getCurrent().selectedSupply?.machineId).toBe(machineId);
            const stalePicker = contextual.getCurrent().selection.selectOrigin;
            contextualMachineId = otherMachineId;
            await contextual.rerender();
            expect(await invoke('plugins.execution_origin.clear', { pluginId, contextualTarget })).toEqual({ status: 'unavailable' });
            expect(await stalePicker(savedOtherOrigin)).toEqual({ status: 'unavailable' });
            await act(async () => { storage.setState({ settingsScope: { ...scope, accountId: 'other-account' } }); });
            expect(await invoke('plugins.execution_origin.list', { pluginId, contextual: true })).toEqual({ status: 'unavailable' });
            await act(async () => { storage.setState({ settingsScope: scope }); });
            await contextual.unmount();
            expect(await invoke('plugins.execution_origin.set', { pluginId, contextualTarget, origin: savedOtherOrigin })).toEqual({ status: 'unavailable' });
            actionAccount.dispose();
            await act(async () => {
                clearMachineAdministrationTargetObservation(scope, `plugin.lastRunOn:${pluginId}`);
                storage.setState({ settings: { ...storage.getState().settings,
                    machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
            });
            committedProjection = initialProjection;
            await hook.rerender();
            const supply = mounted.selectedSupply;
            if (!supply?.executionOrigin) throw new Error('Selected source supply must retain its exact origin');
            const action = { id: 'refresh', pluginId, occurrenceId: 'occurrence-a', title: 'Refresh', scopes: ['session'],
                surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true } satisfies PluginProjectedActionV2;
            const execute = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: { refreshed: true } } }));
            const controller = createBoundPluginSurfaceController({ facts: {
                pluginId, contributionId: 'home', surfaceId: entryId, placement: 'appSurface', platform: 'web', channel: 'internal',
                machineId: supply.machineId, serverId: supply.serverId,
                occurrenceId: supply.occurrenceId, executionOrigin: supply.executionOrigin, accountLifetime: lifetime,
                interactionEnabled: true, daemonInteractionEnabled: true,
                resolveContributedAction: createPluginUiProjectedActionResolver({ [`${pluginId}/refresh`]: action }),
            }, binding: { executeContributedAction: execute, isExecutionOriginCurrent: mounted.isExecutionOriginCurrent } });
            expect(controller.hostApi.installedMethods).toContain('executeAction');
            expect(readPluginMachineExecutionLastUsedTarget(scope, pluginId)).toBeNull();
            await act(async () => { await expect(controller.dispatchAction({ pluginId, localId: 'refresh' })).resolves.toEqual({ refreshed: true }); });
            expect(readPluginMachineExecutionLastUsedTarget(scope, pluginId))
                .toEqual({ serverIdentityId: executionOrigin.serverIdentityId, machineId });
            expect(execute).toHaveBeenCalledWith(machineId, expect.objectContaining({ serverId: connection.home.id,
                expectedContributorOccurrenceId: 'occurrence-a', qualifiedActionId: `${pluginId}/refresh`, isCurrent: expect.any(Function),
                invocation: { kind: 'mountedPluginSurface', mountedBinding: {
                    pluginId, contributionLocalId: 'home', occurrenceId: 'occurrence-a', sourceCustody,
                } } }));
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
        } finally { clearPluginAccountAvailabilityProjection(); await connection.dispose(); }
    });
    it('keeps local presentation machine-free but recognizes packaged renderer daemon methods', () => {
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['context', 'openSurface'] } } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['readResource', 'watchResource'] } } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: [] },
                runtime: { resourceCapability: { readable: false, dynamic: true } } } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['selectActionInput'] } } })).toBe(true);
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            reactNativeBundlesById: { 'reactNativeBundle:acme.panel:home': {
                id: 'reactNativeBundle:acme.panel:home', pluginId: 'acme.panel', contributionKind: 'reactNativeBundle',
                contributionId: 'home', requiredHostMethods: [],
            } },
        }, surface: { renderer: { kind: 'reactNative', contributionId: 'home' },
            runtime: { resourceCapability: { readable: true, dynamic: false } } } })).toBe(true);
    });
    it('recognizes declaration-owned Machine requirements before any runtime supplier or Action arrives', () => {
        const surface = { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['executeAction'] } };
        const installed = { id: 'acme.panel', displayName: 'Panel', enabled: true,
            source: { kind: 'bundled', locator: 'app-bundle:acme.panel' },
            declaredExecution: { daemonActions: true, contributionPoints: false } } satisfies PluginUiInstalledPackageProjection;
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, installedPackagesById: { 'acme.panel': installed } };
        expect(isPluginSurfaceMachineBound({ pluginId: installed.id, projection, surface })).toBe(true);
        expect(isPluginSurfaceMachineBound({ pluginId: installed.id,
            projection: { ...projection, installedPackagesById: { [installed.id]: { ...installed,
                declaredExecution: { daemonActions: false, contributionPoints: false } } } }, surface })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: installed.id, projection,
            surface: { renderer: { ...surface.renderer, requiredHostMethods: ['context'] } } })).toBe(false);
        expect(isPluginSurfaceMachineBound({ pluginId: installed.id,
            projection: { ...projection, installedPackagesById: { [installed.id]: { ...installed,
                declaredExecution: { daemonActions: false, contributionPoints: true } } } },
            surface: { renderer: { ...surface.renderer, requiredHostMethods: ['context'] } } })).toBe(true);
    });
    it('derives Resource execution requirements from the selected surface descriptor', () => {
        const surface = {
            renderer: { kind: 'hostedHtml', contributionId: 'settings', requiredHostMethods: [] },
            runtime: { resourceCapability: { readable: true, dynamic: false } },
        };
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface })).toBe(true);
    });
    it('leaves malformed host requirements to renderer admission without attempting execution selection', () => {
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel', projection: EMPTY_PLUGIN_UI_PROJECTION,
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['not-a-host-method'] },
                runtime: { resourceCapability: { readable: true, dynamic: true } } } })).toBe(false);
    });
    it('recognizes a header-only daemon declaration before an execution supplier is selected', () => {
        const action = { id: 'refresh', pluginId: 'acme.panel', occurrenceId: 'header-action-occurrence', title: 'Refresh', scopes: ['session'],
            surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: false } satisfies PluginProjectedActionV2;
        expect(isPluginSurfaceMachineBound({ pluginId: 'acme.panel',
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, actionsById: { 'acme.panel/refresh': action } },
            surface: { renderer: { kind: 'hostedHtml', contributionId: 'home', requiredHostMethods: ['context'] },
                headerActions: [{ command: { kind: 'executeAction', action: { pluginId: 'acme.panel', localId: 'refresh' } } }] },
        })).toBe(true);
    });
});
