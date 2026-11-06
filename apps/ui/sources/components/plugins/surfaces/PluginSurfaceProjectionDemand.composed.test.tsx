import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildDeferredDaemonProjectionSections, demandedDaemonProjectionSections,
    DaemonContributionRegistryProjectionDescribeRequestSchema, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { AppShellPluginUiProjectionProvider, AppShellPluginUiProjectionValueProvider, useAppShellPluginUiProjection,
    useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useConnectedServicesAgents } from '@/components/settings/connectedServices/model/useConnectedServicesAgents';
import { PluginSurfaceProjectionDemand } from './PluginSurfaceProjectionDemand';
import { usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useHappierInputPickerPort, type HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { ModalProvider } from '@/modal';
import { PluginPresentedExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import { isPluginMachineExecutionOriginCandidateSelectable } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { readCurrentAppShellPluginUiExecutionOriginCandidates, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { usePluginUiProjectionCurrentness, PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    vi.useRealTimers();
    clearDaemonMergedProjectionCacheForTests();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    installDisconnectedServerSocketBoundary();
});

/** The measured 20-Machine cold fleet; only the Socket and HTTP transports are substituted. */
async function serveSourceFleet(options: Readonly<{ refuseProjection?: boolean; machineOnly?: boolean }> = {}) {
    const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const accountId = 'source-fleet-account';
    const serverIdentityId = 'srv_source_fleet';
    const pluginId = 'acme.triage';
    const machines = Array.from({ length: 20 }, (_, index) => createMachineFixture({ id: `fleet-${String(index).padStart(2, '0')}`, activeAt: 0, storageMode: 'plain' }));
    const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId, machine }));
    const widget = widgetProjectionEntry({ pluginId, localId: 'inbox', target: 'app' });
    const projectionsByMachineId = new Map<string, ReturnType<typeof PluginProjectionV2Schema.parse>>();
    const rememberProjection = (id: string, projection: ReturnType<typeof PluginProjectionV2Schema.parse>) => {
        projectionsByMachineId.set(id, projection);
        return projection;
    };
    // Each Machine runs its own source checkout, so its section bodies are its own (no shared digests).
    const deferredByMachineId = new Map(machines.map(machine => {
        const sourceCustody = { kind: 'development', registeredRootId: `root-${machine.id}` } as const;
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: machine.id, pluginId, sourceCustody } });
        return [machine.id, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: machine.id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a'),
            projection: rememberProjection(machine.id, PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: `Triage on ${machine.id}`, version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: `/src/${machine.id}/triage` }, occurrenceId: widget.occurrenceId, executionOrigin, sourceCustody } },
                familiesById: { ...(options.machineOnly ? { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                    [`${pluginId}/source`]: { id: 'source', serviceId: 'source', pluginId,
                        title: 'Machine-only source', provenance: 'external', sourceKind: 'installed',
                        authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', title: 'Source credentials',
                            outcomeReconciliation: 'none', fields: [] }] }, capabilities: [],
                        availability: { state: 'available', reason: 'resolved' }, diagnostics: [] },
                } } } : {}), pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: { ...widget, executionOrigin,
                    title: `Inbox on ${machine.id}` } } }, inputTypes: { family: 'inputTypes', entriesById: {
                    [`${pluginId}/comparison`]: { id: `${pluginId}/comparison`, pluginId, pluginVersion: '1.0.0',
                        occurrenceId: widget.occurrenceId, executionOrigin,
                        definition: { id: 'comparison', title: 'Pull request', semantic: 'scmPullRequestComparison',
                            valueSchema: { type: 'object' }, picker: 'browse' },
                        pickerSurface: { contribution: { pluginId, localId: 'comparison' }, occurrenceId: widget.occurrenceId,
                            projectionGeneration: 7, rendererChain: [{ pluginId, localId: 'browse' }],
                            selectedRenderer: { identity: { pluginId, localId: 'browse' },
                                renderer: { kind: 'declarative', contributionId: 'browse' },
                                availability: { state: 'available', reason: 'available', diagnostics: [] } },
                            executionOrigin, resourceCapability: { readable: false, dynamic: false },
                            contributorTargetedContributions: { target: { pluginId, occurrenceId: widget.occurrenceId, sourceCustody }, points: [] } },
                    },
                } } },
            })) })] as const;
    }));
    const sectionReadsByMachineId = new Map<string, string[]>();
    const requestsByMachineId = new Map<string, number>();
    const manifestReadsByMachineId = new Map<string, number>();
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const [machineId, method] = packet.method.split(/:(.*)/s);
            const deferred = deferredByMachineId.get(machineId!);
            if (!deferred || method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            }
            requestsByMachineId.set(machineId!, (requestsByMachineId.get(machineId!) ?? 0) + 1);
            if (options.refuseProjection) return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            if (!request.sectionRead) manifestReadsByMachineId.set(machineId!, (manifestReadsByMachineId.get(machineId!) ?? 0) + 1);
            if (request.sectionRead) {
                const reads = sectionReadsByMachineId.get(machineId!) ?? [];
                reads.push(request.sectionRead.digest);
                sectionReadsByMachineId.set(machineId!, reads);
            }
            const result = request.sectionRead ? deferred.read(request.sectionRead.digest, request.sectionRead.offset,
                request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const materializations = machines.map(machine => PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: `triage-${machine.id}`, pluginId, version: '1.0.0', sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }));
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://source-fleet.test',
        serverIdentityId, accountId, accountMode: 'plain' }], route: request => {
        if (request.path === '/v1/machines') return Response.json(rows);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            id => rows.find(row => row.id === id) ?? null);
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                snapshots: (options.machineOnly ? [] : materializations).map(materialization => ({ serverIdentityId, machineId: materialization.machineId,
                    materializations: [materialization] })) }));
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) }], failedPluginIds: [] }));
        return undefined;
    } });
    return { accountId, pluginId, machines, home, sectionReadsByMachineId, requestsByMachineId, manifestReadsByMachineId,
        projectionsByMachineId, deferredByMachineId };
}

it('discovers a Machine-only source from the presented Connect target with no Account installation census', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId, manifestReadsByMachineId } = await serveSourceFleet({ machineOnly: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        expect(readPluginAccountAvailability(captureActiveServerAccountScopeLifetime()!.scope)?.readInstalledPlugins())
            .toMatchObject({ kind: 'available', plugins: [] });
        const target = { serverIdentityId: 'srv_source_fleet', machineId: machines[0]!.id };
        let current: ReturnType<typeof useAppShellPluginUiProjection> | undefined;
        let registry: ReturnType<typeof useProjectedConnectedServicesRegistry> | undefined;
        function PresentedConnect() {
            useConnectedServicesAgents({ agents: 'load', initialMachineTarget: target });
            current = useAppShellPluginUiProjection();
            registry = useProjectedConnectedServicesRegistry();
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><PresentedConnect /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: target.machineId, serverId, sections: [] })
                ?.deferredProjection?.loadedSections).toContain('familiesById.connectedAccounts');
        });
        expect([...requestsByMachineId.keys()]).toEqual([target.machineId]);
        expect(manifestReadsByMachineId.get(target.machineId)).toBe(1);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(registry?.entries).toContainEqual(expect.objectContaining({ service: { pluginId, localId: 'source' } }));
            expect(readWidgetDescriptor(current?.pluginUiProjection, { pluginId, localId: 'inbox' })).not.toBeNull();
            expect(current?.pluginUiProjection?.inputTypesById[`${pluginId}/comparison`]).toBeDefined();
        });
        expect([...requestsByMachineId.keys()]).toEqual([target.machineId]);
        expect(manifestReadsByMachineId.get(target.machineId)).toBe(1);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('asks only the presented origin for packages and UI in a cold 20-Machine source fleet', async () => {
    const { accountId, pluginId, machines, home, sectionReadsByMachineId, requestsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const uiSectionsLoaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections.includes('familiesById.pluginUi'));
        const packagesLoaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections.includes('installedPackagesById'));
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} enabled />
        </AppShellPluginUiProjectionProvider>);
        // Account descriptors rank placement intent before exact runtime admission.
        // Unopened alternative origins do not acquire Machine projections.
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(packagesLoaded()).toHaveLength(1);
            expect(uiSectionsLoaded().length).toBeGreaterThan(0);
        });
        await flushHookEffects({ cycles: 3 });
        const selected = uiSectionsLoaded().map(machine => machine.id);
        const reads = [...sectionReadsByMachineId].map(([id, digests]) => [id, digests.length] as const);
        expect({ selected: selected.length, reads: Object.fromEntries(reads) }).toMatchObject({ selected: 1 });
        // Non-selected installations remain entirely cold.
        for (const machine of machines) if (machine.id !== selected[0]) {
            expect(sectionReadsByMachineId.get(machine.id)?.length ?? 0).toBe(0);
            expect(requestsByMachineId.get(machine.id) ?? 0).toBe(0);
        }
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('keeps a closed comparison picker cold and discovers its current contributed picker when opened', async () => {
    const { accountId, machines, home, requestsByMachineId, manifestReadsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const machineId = machines[0]!.id;
        tree = await renderWithAppProviders(<InputTypePickerHostProvider enabled requiresPluginTypes={false}
            machineId={machineId} serverId={serverId}>
            <ScmComparisonScopePicker current={{ kind: 'workingTree' }} currentLabel="Working tree" fileCount={null}
                options={[{ comparison: null, sourceKind: 'pullRequest', group: 'explainOnly', label: 'Pull request',
                    subtitle: 'Select source evidence', fileCount: null }]} onSelect={() => {}} />
        </InputTypePickerHostProvider>);
        await flushHookEffects({ cycles: 3 });
        expect([...requestsByMachineId.values()]).toHaveLength(0);
        const menu = () => tree!.tree.root.findByType(DropdownMenu);
        await act(async () => menu().props.onOpenChange(true));
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'pullRequest' }));
        });
        expect(requestsByMachineId.get(machineId)).toBeGreaterThan(0);
        expect(manifestReadsByMachineId.get(machineId)).toBe(1);
        expect(requestsByMachineId.size).toBe(1);
        await act(async () => menu().props.onOpenChange(false));
        await flushHookEffects({ cycles: 3 });
        expect(menu().props.items).toContainEqual(expect.objectContaining({ id: 'pullRequest' }));
        const settled = requestsByMachineId.get(machineId);
        await flushHookEffects({ cycles: 3 });
        expect(requestsByMachineId.get(machineId)).toBe(settled);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('describes a supplied cold picker and opens its exact producer with current data', async () => {
    const { accountId, pluginId, machines, home, projectionsByMachineId, deferredByMachineId, requestsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    const controller = new AbortController();
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const machineId = machines[0]!.id;
        const supplied = normalizePluginUiProjection(projectionsByMachineId.get(machineId)!);
        let port: HappierInputPickerPort | null = null;
        function PickerProbe() { port = useHappierInputPickerPort(); return null; }
        const field = { path: 'comparison', title: 'Pull request', inputType: { pluginId, localId: 'comparison' } };
        tree = await renderWithAppProviders(<ModalProvider><InputTypePickerHostProvider enabled
            machineId={machineId} serverId={serverId} pluginUiProjection={supplied} pluginUiMachineId={machineId}>
            <PickerProbe />
        </InputTypePickerHostProvider></ModalProvider>);
        expect(port!.describe(field)).not.toBeNull();
        expect(requestsByMachineId.size).toBe(0);
        const old = projectionsByMachineId.get(machineId)!;
        const oldType = old.familiesById.inputTypes!.entriesById[`${pluginId}/comparison`]!;
        const fresh = PluginProjectionV2Schema.parse({ ...old, generation: 8, familiesById: { ...old.familiesById,
            inputTypes: { family: 'inputTypes', entriesById: { [oldType.id]: { ...oldType,
                pickerSurface: { ...oldType.pickerSurface!, projectionGeneration: 8 } } } } } });
        deferredByMachineId.set(machineId, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: 'b'.repeat(64), projection: fresh }));
        const result = port!.pick({ field, value: undefined, signal: controller.signal });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(tree!.tree.root.findAll(node => node.props.surface?.projectionGeneration === 8
                && typeof node.props.onSettle === 'function')).toHaveLength(1);
        });
        expect(requestsByMachineId.size).toBe(1);
        const modal = tree.tree.root.find(node => node.props.surface?.projectionGeneration === 8
            && typeof node.props.onSettle === 'function');
        await act(async () => modal.props.onSettle({ kind: 'completed', input: { pullRequest: 17 } }));
        await expect(result).resolves.toEqual({ status: 'selected', value: { pullRequest: 17 } });
    } finally {
        controller.abort();
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('keeps a refused target visible in a cold 20-Machine fleet without discovering unopened origins', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId } = await serveSourceFleet({ refuseProjection: true });
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        let current: ReturnType<typeof usePluginSurfaceExecutionOrigin> | undefined;
        function PresentedSource() {
            current = usePluginSurfaceExecutionOrigin({ pluginId, projection: null, enabled: true, includeMachineCandidates: false });
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider><PresentedSource /></AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(requestsByMachineId.size).toBe(1);
            expect(current?.selection.state).toMatchObject({ kind: 'unavailable', reasons: expect.arrayContaining(['daemon_unsupported']) });
        });
        await flushHookEffects({ cycles: 3 });
        expect(requestsByMachineId.size).toBe(1);
        expect(current?.selection.selectedOrigin).toBeNull();
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('admits opened origin rows in a cold 20-Machine fleet without acquiring their unopened UI families', async () => {
    const { accountId, pluginId, machines, home, requestsByMachineId } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        let facts: ReturnType<typeof readCurrentAppShellPluginUiExecutionOriginCandidates> | undefined;
        function PublishedCandidates() {
            const read = React.useCallback(() => readCurrentAppShellPluginUiExecutionOriginCandidates(pluginId), []);
            facts = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, read, read);
            return null;
        }
        const targets = machines.slice(0, 2).map(machine => ({ serverIdentityId: 'srv_source_fleet', machineId: machine.id }));
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PublishedCandidates />
            <PluginPresentedExecutionOriginProjectionDemand targets={targets} />
        </AppShellPluginUiProjectionProvider>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(facts?.sourceCandidates.filter(isPluginMachineExecutionOriginCandidateSelectable)).toHaveLength(targets.length);
        });
        expect(requestsByMachineId.size).toBe(targets.length);
        for (const target of targets) {
            const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId: target.machineId, serverId, sections: [] });
            expect(cached?.deferredProjection?.loadedSections).toContain('installedPackagesById');
            expect(cached?.deferredProjection?.loadedSections).not.toContain('familiesById.pluginUi');
            expect(cached?.deferredProjection?.loadedSections).not.toContain('familiesById.inputTypes');
        }
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it('wakes no per-Machine demand while its acquisition settles', async () => {
    const { accountId, machines, home } = await serveSourceFleet();
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const loaded = () => machines.filter(machine => readCachedDaemonMergedProjectionCacheEntry({
            machineId: machine.id, serverId, sections: [] })?.deferredProjection?.loadedSections.includes('familiesById.pluginUi'));
        let updates = 0;
        tree = await renderWithAppProviders(<React.Profiler id="demand" onRender={(_id, phase) => { if (phase === 'update') updates += 1; }}>
            <PluginSurfaceProjectionDemand accountScope={lifetime.scope} enabled />
        </React.Profiler>);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(loaded()).toHaveLength(machines.length);
        });
        await flushHookEffects({ cycles: 3 });
        // Machine facts the demand does not gate on (a renamed Machine) wake nothing; losing a Machine does.
        updates = 0;
        await act(async () => { storage.getState().applyMachines(machines.map(machine => ({ ...machine, metadataVersion: machine.metadataVersion + 1,
            metadata: { ...machine.metadata!, displayName: `Renamed ${machine.id}` } })), false, { sourceServerId: serverId }); });
        await flushHookEffects({ cycles: 2 });
        expect(updates).toBe(0);
        await act(async () => { storage.getState().applyMachines([{ ...machines[0]!, metadataVersion: machines[0]!.metadataVersion + 2,
            revokedAt: Date.now() }], false, { sourceServerId: serverId }); });
        await flushHookEffects({ cycles: 2 });
        expect(updates).toBeGreaterThan(0);
    } finally {
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});

it.each(['automatic', 'pinned'] as const)('advances the selected Machine to current or a settled refusal through every candidate transition (%s selection)', async choice => {
    const { PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const { usePluginSurfaceExecutionOrigin } = await import('./pluginSurfaceExecutionOrigin');
    const { readCurrentAppShellPluginUiProjection, subscribeCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
    const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
    const { getPluginMachineExecutionOriginRef } = await import('@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1');
    const accountId = `seam-avail-${choice}`;
    const serverIdentityId = `srv_seam_avail_${choice}`;
    const pluginId = 'acme.triage';
    const machines = ['seam-a', 'seam-b'].map(id => createMachineFixture({ id, activeAt: 0, storageMode: 'plain' }));
    const rows = machines.map(machine => createPlainMachineRowFixture({ id: machine.id, accountId, machine }));
    const widget = widgetProjectionEntry({ pluginId, localId: 'inbox', target: 'app' });
    const originsByMachineId = new Map(machines.map(machine => [machine.id, PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
        sourceRef: { machineId: machine.id, pluginId, sourceCustody: { kind: 'development', registeredRootId: `root-${machine.id}` } } })]));
    const deferredByMachineId = new Map(machines.map(machine => {
        const sourceCustody = { kind: 'development', registeredRootId: `root-${machine.id}` } as const;
        const executionOrigin = originsByMachineId.get(machine.id)!;
        return [machine.id, buildDeferredDaemonProjectionSections({ protocolVersion: 1,
            projectionDigest: machine.id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'b'),
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: `Triage on ${machine.id}`, version: '1.0.0',
                    enabled: true, source: { kind: 'localPath', locator: `/src/${machine.id}/triage` }, occurrenceId: widget.occurrenceId, executionOrigin, sourceCustody } },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { [widget.id]: { ...widget, executionOrigin,
                    title: `Inbox on ${machine.id}` } } } },
            }) })] as const;
    }));
    // Socket boundary only. A Machine's daemon can be held (answer ordering) or refuse (invalid answer).
    const gates = new Map<string, Promise<void>>();
    const releases = new Map<string, () => void>();
    const hold = (machineId: string) => { gates.set(machineId, new Promise(resolve => releases.set(machineId, resolve))); };
    const release = (machineId: string) => { releases.get(machineId)?.(); gates.delete(machineId); };
    const refusing = new Set<string>();
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'timeout').mockReturnValue(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, packet) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet)
                || typeof packet.method !== 'string' || !('params' in packet)) throw new Error('Invalid fixture RPC');
            const [machineId, method] = packet.method.split(/:(.*)/s);
            const deferred = deferredByMachineId.get(machineId!);
            if (!deferred || method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Daemon method unavailable', errorCode: 'RPC_METHOD_NOT_FOUND' };
            }
            await gates.get(machineId!);
            const content = { mode: 'plain' as const };
            const decoded = await socketRpcCodec.decodeRequestParams(content, packet.params, packet.method);
            const request = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(decoded.params);
            const result = refusing.has(machineId!) ? { unexpected: true } : request.sectionRead
                ? deferred.read(request.sectionRead.digest, request.sectionRead.offset, request.sectionRead.includeDigests) : deferred.manifest;
            return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
        });
    });
    const materializations = machines.map(machine => PluginMachineMaterializationV1Schema.parse({ serverIdentityId, machineId: machine.id,
        materializationId: `triage-${machine.id}`, pluginId, version: '1.0.0', sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }));
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://seam-avail-${choice}.test`,
        serverIdentityId, accountId, accountMode: 'plain' }], route: request => {
        if (request.path === '/v1/machines') return Response.json(rows);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            id => rows.find(row => row.id === id) ?? null);
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'])
            return Response.json(PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                snapshots: materializations.map(materialization => ({ serverIdentityId, machineId: materialization.machineId,
                    materializations: [materialization] })) }));
        if (request.path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'])
            return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [],
                intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
                    hostingCapability: { enabled: false }, intent: null, release: null, packageAssets: [], uiArtifacts: [] }) }], failedPluginIds: [] }));
        return undefined;
    } });
    const priorTargets = storage.getState().settings.machineAdministrationTargetsLocalV1;
    const pin = (machineId: string) => storage.setState({ settings: { ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference(priorTargets, pluginId, originsByMachineId.get(machineId)!) } });
    type Observed = Readonly<{ state: string; reasons: string; loading: boolean; machine: string | null; supply: string | null; supplyReason: string | null }>;
    let observed: Observed | undefined;
    let tree: Awaited<ReturnType<typeof renderWithAppProviders>> | undefined;
    try {
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const serverId = home.homes.home!.id;
        storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
        observeMachinePresenceForTest({ serverId, accountId }, machines.map(machine => machine.id));
        const { sync } = await import('@/sync/sync');
        await sync.refreshPluginAccountAvailability();
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        // Pinned: the selection is known before the Machine's candidate-only answer arrives.
        if (choice === 'pinned') { pin('seam-b'); hold('seam-b'); }
        function SelectedSurface() {
            const read = React.useCallback(() => readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true }), []);
            const projection = React.useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection, read, read);
            const entry = projection?.surfacePlacementsById[widget.id] ?? null;
            const execution = usePluginSurfaceExecutionOrigin({ pluginId, projection, entry, enabled: true });
            const state = execution.selection.state;
            observed = { state: state.kind, reasons: state.kind === 'unavailable' || state.kind === 'conflict' ? state.reasons.join(',') : '',
                loading: execution.loading,
                machine: execution.selection.selectedOrigin ? getPluginMachineExecutionOriginRef(execution.selection.selectedOrigin).machineId : null,
                supply: execution.selectedSupply?.phase ?? null, supplyReason: execution.selectedSupply?.unavailableReasonCode ?? null };
            return null;
        }
        tree = await renderWithAppProviders(<AppShellPluginUiProjectionProvider>
            <PluginSurfaceProjectionDemand pluginId={pluginId} accountScope={lifetime.scope} enabled />
            <SelectedSurface />
        </AppShellPluginUiProjectionProvider>);
        // Presentation always advances: to the selected Machine's current supply, or a settled typed refusal.
        const settles = async (step: string, expected: (value: Observed) => boolean) => {
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                const actual = { step, ...observed, ok: observed !== undefined && !observed.loading && expected(observed) };
                expect(actual).toEqual({ ...actual, ok: true });
            });
        };
        const currentOn = (machineId?: string) => (value: Observed) => value.state === 'selected' && value.supply === 'current'
            && (machineId === undefined || value.machine === machineId);
        if (choice === 'pinned') {
            await flushHookEffects({ cycles: 3 });
            release('seam-b');
        }
        await settles('initial', currentOn(choice === 'pinned' ? 'seam-b' : undefined));
        let selected = observed!.machine!;
        let other = machines.map(machine => machine.id).find(id => id !== selected)!;
        // A same-authority refresh re-reads while the supply stays current.
        publishMachineContributionRegistryProjectionInvalidation({ machineId: selected, serverId }, 'refresh');
        await settles('refresh', currentOn(selected));
        // An authority invalidation re-establishes, then becomes current again.
        // Auto may re-rank to another current installation while the incumbent re-establishes.
        publishMachineContributionRegistryProjectionInvalidation({ machineId: selected, serverId }, 'authority');
        await settles('authority', currentOn(choice === 'pinned' ? selected : undefined));
        selected = observed!.machine!;
        other = machines.map(machine => machine.id).find(id => id !== selected)!;
        // The selected Machine changes: the new selection hydrates its UI sections and becomes current.
        pin(other);
        await settles('reselect', currentOn(other));
        // The selected candidate becomes invalid: its daemon now refuses the projection.
        refusing.add(other);
        publishMachineContributionRegistryProjectionInvalidation({ machineId: other, serverId }, 'authority');
        // A failed re-read settles (the held answer or a typed refusal); it never stays establishing.
        await settles('refusal', () => true);
        // Inventory ineligibility: the pinned Machine leaves the Home's Machine inventory.
        refusing.delete(other);
        storage.getState().applyMachines(machines.filter(machine => machine.id === selected), true, { sourceServerId: serverId });
        await settles('ineligible', value => !(value.machine === other && value.supply === 'current'));
        // Unpinned again, Auto falls back to the remaining eligible Machine and it becomes current.
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: priorTargets } });
        await settles('fallback', currentOn(selected));
    } finally {
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: priorTargets } });
        for (const id of releases.keys()) release(id);
        if (tree) await act(async () => tree.unmount());
        await home.dispose();
    }
});
