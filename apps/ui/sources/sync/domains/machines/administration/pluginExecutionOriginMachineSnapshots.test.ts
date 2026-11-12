import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import * as inventory from '@/sync/domains/machines/machineInventorySnapshots';
import { publishMachineActivities } from '@/sync/domains/machines/machineActivity';
import * as origins from './pluginExecutionOrigin';
import * as fleet from './fleetUnion';
import * as originIdentity from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed,
    recordMachineRequestSucceeded, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { createExecutionOriginMachineSnapshotPublication, type ExecutionOriginMachineSnapshotInputs } from './pluginExecutionOriginMachineSnapshots';
import { PluginPortableReleaseManifestV1Schema, type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { GH_DEP_ID } from '@happier-dev/protocol/installables';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';

// Keep real cache admission/publication; Machine RPC is the process boundary.
const capabilityBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(capabilityBoundary.rpc);
});

const originalState = storage.getState();
const connections: Array<{ dispose(): void }> = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.dispose();
    clearMachineRequestReachabilityForTest();
    storage.setState(originalState, true);
    vi.restoreAllMocks();
    capabilityBoundary.rpc.mockReset();
    vi.useRealTimers();
});

function fixture() {
    const now = Date.now();
    const machine = createMachineFixture({ id: 'origin-count-machine', activeAt: now });
    const home = { id: 'origin-count-home', serverIdentityId: 'srv_origin_count', name: 'Home',
        serverUrl: 'https://origin-count.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
    const source = { source: { origin: { serverIdentityId: home.serverIdentityId,
        sourceRef: { machineId: machine.id, pluginId: 'acme.count',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'root' } } },
        version: '1.0.0', occurrenceId: 'occurrence', serverId: home.id },
        releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } };
    storage.setState({ machines: {}, machineListByServerId: { [home.id]: [machine] },
        machineListStatusByServerId: { [home.id]: 'idle' } });
    const inputs: ExecutionOriginMachineSnapshotInputs = { pluginId: 'acme.count', profiles: [home], activeServerId: home.id,
        readinessServerIdentityId: home.serverIdentityId,
        accountScopesByServerId: new Map([[home.serverIdentityId, { serverId: home.serverIdentityId, accountId: 'account-count' }]]),
        materializations: [], sources: [source] };
    const publication = createExecutionOriginMachineSnapshotPublication({ readState: storage.getState,
        subscribeState: listener => storage.subscribe(listener), subscribeMachineUpdates: subscribeRegisteredStorageMachineUpdates });
    const connect = (next = inputs, listener = () => {}) => {
        const connection = publication.connect(next, listener);
        connections.push(connection);
        return connection;
    };
    return { now, machine, home, source, inputs, connect };
}

describe('execution-origin Machine publication', () => {
    it('uses Availability declarations for thin census rows, retains unknown coverage, and switches only for proven improvement', () => {
        const { inputs, home, machine, source, connect } = fixture();
        const second = createMachineFixture({ id: 'z-thin-machine', activeAt: machine.activeAt });
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.thin-source', version: '1.0.0',
            displayName: 'Source', runtime: { apiVersion: 1 }, contributes: {
                actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    dangerLevel: 'safe', execution: { target: 'daemon' } }],
                targetedPluginContributions: [{ id: 'source', target: { pluginId: inputs.pluginId, pointId: 'sources' },
                    protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
            } });
        const presentation = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, id: 'acme.unknown', contributes: {} });
        const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: [{ pluginId: manifest.id,
            pluginVersion: manifest.version, displayName: 'Source', packageName: '@acme/thin-source',
            normalizedManifest: manifest, entriesById: {} }, { pluginId: presentation.id,
            pluginVersion: presentation.version, displayName: 'Pending source', packageName: '@acme/pending-source',
            presentationManifest: presentation, entriesById: {} }] });
        const scope = { serverId: home.id, accountId: 'account-count' };
        const row: PluginMachineMaterializationV1 = { serverIdentityId: home.serverIdentityId, machineId: second.id,
            materializationId: 'thin-source', pluginId: manifest.id, version: manifest.version, sourceClass: 'bundledFirstParty',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: Date.now(), uiArtifacts: [] };
        const publish = (rows: readonly PluginMachineMaterializationV1[], inventoryComplete = true) => {
            store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: rows,
                inventoryComplete,
                snapshots: [machine, second].map(host => ({ serverIdentityId: home.serverIdentityId, machineId: host.id,
                    materializations: rows.filter(row => row.machineId === host.id) })) } });
            return store.bind(scope).readInstalledPlugins();
        };
        const next = { ...inputs, sources: [source, { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }],
            selection: { availabilityRevision: {}, storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
                installedPlugins: publish([]),
                classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) } };
        const connection = connect(next);
        const expectMachine = (id: string) => expect(connection.getSnapshot().selection?.state)
            .toMatchObject({ kind: 'selected', origin: { sourceRef: { machineId: id } } });
        expectMachine(machine.id);
        connection.updateInputs({ ...next, materializations: [row], selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish([row], false) } });
        expectMachine(machine.id);
        // First-paint bundled declarations are partial, even when a peer supplies a source.
        const unknown = { ...row, machineId: machine.id, pluginId: presentation.id };
        connection.updateInputs({ ...next, materializations: [unknown, row], selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish([unknown, row]) } });
        expectMachine(machine.id);
        connection.updateInputs({ ...next, materializations: [row], selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish([row]) } });
        expectMachine(second.id);
        const stable = connection.getSnapshot();
        for (let read = 0; read < 100; read++) expect(connection.getSnapshot()).toBe(stable);
        // Equal proven coverage and then absent evidence preserve the incumbent.
        const equalRows = [row, { ...row, machineId: machine.id }];
        connection.updateInputs({ ...next, materializations: equalRows, selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish(equalRows) } });
        expectMachine(second.id);
        connection.updateInputs({ ...next, materializations: [unknown], selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish([unknown]) } });
        expectMachine(second.id);
        const extra = { ...row, machineId: machine.id, pluginId: 'acme.extra', materializationId: 'extra',
            declaredManifest: PluginPortableReleaseManifestV1Schema.parse({ ...manifest, id: 'acme.extra' }) };
        const supersetRows = [...equalRows, extra, unknown,
            { ...unknown, machineId: second.id, materializationId: 'unknown-second' }];
        connection.updateInputs({ ...next, materializations: supersetRows, selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish(supersetRows, false) } });
        expectMachine(second.id);
        connection.updateInputs({ ...next, materializations: supersetRows, selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish(supersetRows) } });
        expectMachine(machine.id);
        const improved = connection.getSnapshot();
        for (let read = 0; read < 100; read++) expect(connection.getSnapshot()).toBe(improved);
        connection.dispose();
        const cold = connect({ ...next, materializations: [row], selection: { ...next.selection,
            availabilityRevision: {}, installedPlugins: publish([row]) } });
        expect(cold.getSnapshot().selection?.state).toMatchObject({ kind: 'selected',
            origin: { sourceRef: { machineId: second.id } } });
    });
    it('retains Auto across published native authentication changes without probes or unnecessary notifications', async () => {
        const { inputs, home, machine, source, connect, now } = fixture();
        const second = createMachineFixture({ id: 'native-auth-other', activeAt: now + 1 });
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.native-source', version: '1.0.0',
            displayName: 'Source', runtime: { apiVersion: 1 }, contributes: {
                actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    dangerLevel: 'safe', execution: { target: 'daemon' } }],
                targetedPluginContributions: [{ id: 'source', target: { pluginId: inputs.pluginId, pointId: 'sources' },
                    protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
                connectedAccountDescriptors: [{ id: 'account', title: 'Account', authentication: {
                    native: { systemTool: 'gh' }, defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
                        outcomeReconciliation: 'none', fields: [{ id: 'credential', title: 'Credential', schema: { type: 'string' }, secret: true }] }],
                } }],
            } });
        const materializations: PluginMachineMaterializationV1[] = [machine, second].map(host => ({
            serverIdentityId: home.serverIdentityId, machineId: host.id, materializationId: `native-${host.id}`,
            pluginId: manifest.id, version: manifest.version, sourceClass: 'registryPackage', portableRelease: true,
            enabled: true, trustState: 'trusted', observedAt: now, uiArtifacts: [], declaredManifest: manifest,
        }));
        const accountLifetime = { scope: { serverId: home.id, accountId: 'account-count' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const notifications = vi.fn();
        const connection = connect({ ...inputs, accountLifetime, materializations,
            sources: [source, { ...source, source: { ...source.source,
                origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }],
            selection: { availabilityRevision: {}, storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
                classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) },
        }, notifications);
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: { sourceRef: { machineId: second.id } } });
        expect(capabilityBoundary.rpc).toHaveBeenCalledTimes(0);
        notifications.mockClear();
        const publish = async (machineId: string, authenticated: boolean) => {
            capabilityBoundary.rpc.mockResolvedValue({ protocolVersion: 1, results: {
                [GH_DEP_ID]: { ok: true, checkedAt: now, data: { installed: true, authenticated } },
            } });
            await prefetchMachineCapabilities({ machineId, serverId: home.id, accountLifetime,
                request: { requests: [{ id: GH_DEP_ID }] } });
        };
        await publish(machine.id, true);
        const selected = connection.getSnapshot();
        expect(selected.selection?.state).toMatchObject({ kind: 'selected', origin: { sourceRef: { machineId: second.id } } });
        expect(notifications).toHaveBeenCalledTimes(0);
        const afterChange = notifications.mock.calls.length;
        for (let read = 0; read < 100; read++) expect(connection.getSnapshot()).toBe(selected);
        await publish('unrelated-native-machine', true);
        expect(notifications).toHaveBeenCalledTimes(afterChange);
        await publish(second.id, true);
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: { sourceRef: { machineId: second.id } } });
        expect(notifications).toHaveBeenCalledTimes(afterChange);
        await publish(machine.id, false);
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: { sourceRef: { machineId: second.id } } });
        expect(capabilityBoundary.rpc).toHaveBeenCalledTimes(4);
    });

    it('retains Auto on better contributor republish, fails over when its Machine disappears, and keeps reads free of scans', () => {
        const { inputs, home, machine, source, connect } = fixture();
        const second = createMachineFixture({ id: 'z-second-machine', activeAt: machine.activeAt });
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        const next = { ...inputs, sources: [source, { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }],
            selection: { availabilityRevision: {}, storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
                classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) } };
        const connection = connect(next);
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected',
            origin: { sourceRef: { machineId: machine.id } } });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.source',
            version: '1.0.0', displayName: 'Source', runtime: { apiVersion: 1 }, contributes: {
                actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                    execution: { target: 'daemon' } }],
                targetedPluginContributions: [{ id: 'source', target: { pluginId: inputs.pluginId, pointId: 'sources' },
                    protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
            } });
        let declarationReads = 0;
        const contributor: PluginMachineMaterializationV1 = { serverIdentityId: home.serverIdentityId, machineId: second.id,
            materializationId: 'source', pluginId: manifest.id, version: manifest.version, sourceClass: 'registryPackage',
            portableRelease: true, enabled: true, trustState: 'trusted', observedAt: Date.now(), uiArtifacts: [],
            get declaredManifest() { declarationReads += 1; return manifest; } };
        connection.updateInputs({ ...next, materializations: [contributor] });
        const selected = connection.getSnapshot();
        expect(selected.selection?.state).toMatchObject({ kind: 'selected',
            origin: { sourceRef: { machineId: machine.id } } });
        declarationReads = 0;
        for (let render = 0; render < 100; render += 1) expect(connection.getSnapshot()).toBe(selected);
        expect(declarationReads).toBe(0);
        storage.setState({ machineListByServerId: { [home.id]: [second] } });
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected',
            origin: { sourceRef: { machineId: second.id } } });
        connection.updateInputs({ ...next, materializations: [{ ...contributor, machineId: machine.id }] });
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected',
            origin: { sourceRef: { machineId: second.id } } });
    });
    it('rebuilds retired requester facts from the current census before a same-scope successor selects', () => {
        const { inputs, home, machine, connect } = fixture();
        let current = true;
        const retirements = new Set<() => void>();
        const scope = inputs.accountScopesByServerId.get(home.serverIdentityId)!;
        const lifetime = { scope, isCurrent: () => current, onRetire(cancel: () => void) {
            retirements.add(cancel); return { dispose: () => { retirements.delete(cancel); } };
        } };
        const selection = { availabilityRevision: {}, storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
            classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) };
        const next = { ...inputs, selection, accountLifetime: lifetime };
        const connection = connect(next);
        expect(connection.getSnapshot().selection?.state.kind).toBe('selected');
        current = false;
        for (const cancel of [...retirements]) cancel();
        expect(connection.getSnapshot().selection).toBeNull();
        const revoked = { ...machine, revokedAt: Date.now() };
        storage.setState({ machineListByServerId: { [home.id]: [revoked] } });
        storage.setState({ machineListByServerId: { [home.id]: [{ ...revoked,
            metadata: { ...revoked.metadata!, displayName: 'Changed while retired' } }] } });
        connection.updateInputs({ ...next, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } });
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'unavailable', reasons: ['revoked'] });
        expect(connection.getSnapshot().key).toContain('revoked');
    });
    it('builds only changed Machine candidates across 170 Machines and shares them across selection consumers', () => {
        const { inputs, home, machine, connect } = fixture();
        const machines = [machine, ...Array.from({ length: 169 }, (_, index) => createMachineFixture({
            id: `origin-scale-${index}`, activeAt: Date.now(),
        }))];
        storage.setState({ machineListByServerId: { [home.id]: machines } });
        const build = vi.spyOn(origins, 'buildPluginMachineExecutionOriginCandidates');
        const equal = vi.spyOn(originIdentity, 'arePluginMachineExecutionOriginsEqual');
        const classifyRelease = vi.fn(() => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }));
        const plugins = Array.from({ length: 4 }, (_, index) => {
            const pluginId = `acme.scale-${index}`;
            const materializations = machines.map(row => ({ serverIdentityId: home.serverIdentityId, machineId: row.id, pluginId,
                materializationId: `portable-${row.id}`, version: '1.0.0', sourceClass: 'registryPackage' as const,
                portableRelease: true, enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] }));
            const selection = { availabilityRevision: {}, classifyRelease, storedOrigin: null, homeServerIdentityId: home.serverIdentityId };
            const next = { ...inputs, pluginId, sources: [], materializations, selection };
            const first = connect(next);
            const contextual = connect({ ...next, selection: { ...selection,
                contextualTarget: { serverIdentityId: home.serverIdentityId, machineId: machine.id } } });
            const initial = first.getSnapshot().selection!.candidates;
            return { first, contextual, next, initial, initialOrigins: initial.map(origins.getPluginExecutionOriginCandidateOrigin) };
        });
        expect.soft(classifyRelease).toHaveBeenCalledTimes(170 * plugins.length);
        for (const plugin of plugins) expect.soft(plugin.contextual.getSnapshot().selection!.candidates).toBe(plugin.initial);
        build.mockClear(); classifyRelease.mockClear(); equal.mockClear();
        for (let index = 0; index < 30; index += 1) storage.setState({ settingsVersion: index });
        expect(build).not.toHaveBeenCalled();
        expect(classifyRelease).not.toHaveBeenCalled();
        expect(equal).not.toHaveBeenCalled();
        storage.setState({ machineListByServerId: { [home.id]: machines.map(row => row.id === machine.id
            ? { ...row, revokedAt: Date.now() } : row) } });
        expect(build.mock.calls.flatMap(([params]) => params.materializations).map(row => row.machineId))
            .toEqual(plugins.map(() => machine.id));
        for (const plugin of plugins) {
            const candidates = plugin.first.getSnapshot().selection!.candidates;
            expect(plugin.contextual.getSnapshot().selection!.candidates).toBe(candidates);
            expect(candidates.filter(row => !plugin.initial.includes(row))).toHaveLength(1);
            expect(candidates.find(row => 'materialization' in row && row.materialization.machineId === machine.id)?.validation)
                .toEqual({ kind: 'rejected', reason: 'revoked' });
            for (const [index, row] of candidates.entries()) if (row === plugin.initial[index]) {
                expect(origins.getPluginExecutionOriginCandidateOrigin(row)).toBe(plugin.initialOrigins[index]);
            }
            const materializations = [{ ...plugin.next.materializations[0]!, materializationId: 'new-first-origin' },
                ...plugin.next.materializations];
            plugin.first.updateInputs({ ...plugin.next, materializations });
            const extended = plugin.first.getSnapshot().selection!.candidates;
            expect(extended).toHaveLength(candidates.length + 1);
            expect(extended.filter(row => !candidates.includes(row))).toHaveLength(1);
        }
    });
    it('visits independent demands linearly on a Machine fact publication', () => {
        const { inputs, home, machine, source, now, connect } = fixture();
        let demandReads = 0;
        const demands = Array.from({ length: 138 }, (_, index) => {
            const pluginId = `acme.count-${index}`;
            const next: ExecutionOriginMachineSnapshotInputs = {
                ...inputs,
                get pluginId() { demandReads += 1; return pluginId; },
                sources: [{ ...source, source: { ...source.source, origin: { ...source.source.origin,
                    sourceRef: { ...source.source.origin.sourceRef, pluginId } } } }],
            };
            return connect(next);
        });
        demandReads = 0;
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, activeAt: now + 1 }] } });
        // Each demand reads its own identity for preference/readiness resolution;
        // no publication searches every sibling demand for reusable projections.
        expect(demandReads).toBeLessThanOrEqual(demands.length * 4);
        for (const demand of demands) expect(demand.readCurrent().readMachineFact({
            serverIdentityId: home.serverIdentityId, machineId: machine.id,
        }).activeAt).toBe(now + 1);
    });

    it('keeps equivalent consumers independent when one changes its inputs or disposes', () => {
        const { inputs, home, machine, connect } = fixture();
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        const first = connect(inputs, firstListener);
        const second = connect(inputs, secondListener);
        expect(first.getSnapshot()).toBe(second.getSnapshot());
        firstListener.mockClear();
        secondListener.mockClear();
        first.updateInputs({ ...inputs, sources: [] });
        expect(firstListener).toHaveBeenCalledTimes(1);
        expect(secondListener).not.toHaveBeenCalled();
        first.dispose();
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, revokedAt: Date.now() }] } });
        expect(secondListener).toHaveBeenCalledTimes(1);
        expect(second.getSnapshot().key).toContain('revoked');
    });

    it('resolves newly available Auto choices without scanning unrelated plugin demands', () => {
        const { inputs, home, machine, source, now, connect } = fixture();
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, active: false, activeAt: 0 }] } });
        let demandReads = 0;
        const selection = { availabilityRevision: {}, storedOrigin: null,
            homeServerIdentityId: home.serverIdentityId,
            classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) };
        const demands = Array.from({ length: 138 }, (_, index) => {
            const pluginId = `acme.recovery-${index}`;
            return connect({ ...inputs, get pluginId() { demandReads += 1; return pluginId; }, selection,
                sources: [{ ...source, source: { ...source.source, origin: { ...source.source.origin,
                    sourceRef: { ...source.source.origin.sourceRef, pluginId } } } }] });
        });
        for (const demand of demands) expect(demand.getSnapshot().selection?.state.kind).toBe('unavailable');
        demandReads = 0;
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, activeAt: now + 1 }] } });
        // Two identity reads prepare the shared view; the remaining reads are
        // each demand's own preference, candidate and election inputs.
        expect(demandReads).toBeLessThanOrEqual(demands.length * 16);
        for (const demand of demands) expect(demand.getSnapshot().selection?.state.kind).toBe('selected');
    });

    it('retains facts through withdrawal and invalidates on scoped request failures or absent-row census settlement', () => {
        const { inputs, home, machine, connect } = fixture();
        const scope = inputs.accountScopesByServerId.get(home.serverIdentityId)!;
        const connection = connect();
        const target = { serverIdentityId: home.serverIdentityId, machineId: machine.id };
        const fact = () => connection.readCurrent().readMachineFact(target);
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        withdrawMachinePresenceForScope(scope);
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        captureMachinePresenceObservation(scope)([machine.id]);
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: 10 });
        expect(fact()).toMatchObject({ eligible: false, rejection: 'home_unreachable' });
        recordMachineRequestSucceeded({ ...scope, machineId: machine.id, observedAtMs: 11 });
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        storage.setState({ machineListByServerId: { [home.id]: [] }, machineListStatusByServerId: { [home.id]: 'loading' } });
        expect(fact().rejection).toBe('unknown');
        storage.setState({ machineListStatusByServerId: { [home.id]: 'idle' } });
        expect(fact().rejection).toBe('missing');
        expect(connection.getSnapshot().key).toContain('missing');
        storage.setState({ machineListByServerId: { [home.id]: [machine] } });
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        // A profile correspondence rebuild replaces the whole inventory basis;
        // previously selected targets can disappear without a changed row.
        connection.updateInputs({ ...inputs, profilesGeneration: 2,
            profiles: [{ ...home, serverIdentityId: undefined }] });
        expect(fact()).toMatchObject({ eligible: false, rejection: 'unknown' });
        expect(connection.getSnapshot().key).toContain('unknown');
    });
    it('retains unchanged Machine facts and reads only the changed target across a fleet publication', () => {
        const { inputs, home, source, machine, connect } = fixture();
        const machines = [machine, ...Array.from({ length: 137 }, (_, index) => createMachineFixture({
            id: `unrelated-${index}`, activeAt: Date.now() - index - 1,
        }))];
        storage.setState({ machineListByServerId: { [home.id]: machines } });
        const sources = machines.map(row => ({ ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: row.id } } } }));
        const connection = connect({ ...inputs, sources });
        const untouchedTarget = { serverIdentityId: home.serverIdentityId, machineId: machine.id };
        const untouched = connection.readCurrent().readMachineFact(untouchedTarget);
        const originalRead = connection.readCurrent().readMachineFact;
        const initial = connection.getSnapshot();
        const rejectionReads = vi.spyOn(fleet, 'resolveFleetSnapshotMachineRejection');
        for (let index = 1; index <= 5; index += 1) {
            const next = [...machines];
            next[1] = { ...next[1]!, metadata: { ...next[1]!.metadata!, displayName: `renamed-${index}` } };
            storage.setState({ machineListByServerId: { [home.id]: next } });
            expect(connection.readCurrent().readMachineFact(untouchedTarget)).toBe(untouched);
            expect(connection.getSnapshot()).toBe(initial);
            // The current raw accessor remains usable, but does not stand in for
            // fresh invocation admission or change when another row changes.
            expect(originalRead(untouchedTarget)).toBe(untouched);
        }
        expect(rejectionReads).toHaveBeenCalledTimes(5);
        const scope = inputs.accountScopesByServerId.get(home.serverIdentityId)!;
        recordMachineRequestFailed({ ...scope, machineId: machines[2]!.id });
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId,
            machineId: machines[2]!.id }).rejection).toBe('home_unreachable');
        expect(connection.readCurrent().readMachineFact(untouchedTarget)).toBe(untouched);
        expect(rejectionReads).toHaveBeenCalledTimes(6);
        recordMachineRequestSucceeded({ ...scope, machineId: machines[2]!.id });
        expect(rejectionReads).toHaveBeenCalledTimes(7);
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, revokedAt: Date.now() }, ...machines.slice(1)] } });
        expect(connection.readCurrent().readMachineFact(untouchedTarget)).toMatchObject({ rejection: 'revoked', eligible: false });
        expect(connection.getSnapshot().eligibilityKey).not.toBe(initial.eligibilityKey);
    });
    it('retains Auto across heartbeat elections, shares it with a new consumer and gives explicit pins precedence', () => {
        const { inputs, connect, home, machine, source, now } = fixture();
        const second = createMachineFixture({ id: 'second-origin-machine', activeAt: now - 1 });
        const secondSource = { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } };
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        const current = { ...inputs, sources: [source, secondSource], selection: { availabilityRevision: {},
            storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
            classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) } };
        const first = connect(current);
        const initial = first.getSnapshot().selection;
        expect(initial?.state).toMatchObject({ kind: 'selected', origin: source.source.origin, selectionSource: 'auto' });
        first.updateInputs({ ...current, sources: current.sources.map(candidate => ({ ...candidate,
            source: { ...candidate.source, origin: { ...candidate.source.origin,
                sourceRef: { ...candidate.source.origin.sourceRef } } } })) });
        expect(first.getSnapshot().selection).toBe(initial);
        storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, activeAt: now + 1 }] } });
        expect(first.getSnapshot().selection).toBe(initial);
        const page = connect({ ...current, selection: { ...current.selection } });
        expect(page.getSnapshot().selection).toBe(initial);
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {
            [`plugin.runOn:${inputs.pluginId}`]: { serverIdentityId: home.serverIdentityId, machineId: second.id },
        } } });
        const pinned = first.getSnapshot().selection;
        expect(pinned?.state).toMatchObject({ kind: 'selected', origin: secondSource.source.origin, selectionSource: 'pinned' });
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, activeAt: now + 2 }, second] } });
        expect(first.getSnapshot().selection).toBe(pinned);
        expect(page.getSnapshot().selection).toBe(pinned);
        storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, active: false, activeAt: 0 }] } });
        expect(first.getSnapshot().selection?.state).toMatchObject({ kind: 'unavailable', storedTarget: { machineId: second.id } });
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } });
        expect(first.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: source.source.origin, selectionSource: 'auto' });
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, active: false, activeAt: 0 }, second] } });
        expect(first.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: secondSource.source.origin, selectionSource: 'auto' });
    });

    it('retains Auto on the same Machine after compatible source custody replacement', () => {
        const { inputs, connect, home, machine, source, now } = fixture();
        const second = createMachineFixture({ id: 'replacement-other-machine', activeAt: now - 1 });
        const secondSource = { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } };
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        const current = { ...inputs, sources: [source, secondSource], selection: { availabilityRevision: {},
            storedOrigin: null, homeServerIdentityId: home.serverIdentityId,
            classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }) } };
        const connection = connect(current);
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: source.source.origin });
        storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, activeAt: now + 1 }] } });
        const replacementSource = { ...source, source: { ...source.source, occurrenceId: 'replacement',
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'replacement-root' } } } } };
        connection.updateInputs({ ...current, sources: [replacementSource, secondSource] });
        expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', origin: replacementSource.source.origin });
    });

    it('marks the selected Machine pending until its newer content opens without waiting for another Machine', () => {
        vi.useFakeTimers();
        const { inputs, connect, home, machine, source, now } = fixture();
        const other = createMachineFixture({ id: 'other-pending-machine', activeAt: now - 1 });
        storage.setState({ machineListByServerId: { [home.id]: [machine, other] } });
        storage.getState().applyMachines([machine, other], false, { sourceServerId: home.id });
        const connection = connect({ ...inputs, selection: { availabilityRevision: {}, storedOrigin: null,
            homeServerIdentityId: home.serverIdentityId,
            classifyRelease: () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }),
        } });
        const selected = { kind: 'selected', origin: source.source.origin };
        expect(connection.getSnapshot().selection).toMatchObject({ state: selected, loading: false });

        const otherPending = { ...other, keyBasis: { metadataVersion: other.metadataVersion + 1,
            daemonStateVersion: other.daemonStateVersion + 1, dataEncryptionKey: other.dataEncryptionKey ?? null } };
        storage.getState().applyMachines([otherPending], false, { sourceServerId: home.id });
        expect(connection.readCurrent().snapshots).toContainEqual(expect.objectContaining({
            executionPendingMachineIds: [other.id],
        }));
        expect(connection.getSnapshot().selection).toMatchObject({ state: selected, loading: false });

        const selectedPending = { ...machine, keyBasis: { metadataVersion: machine.metadataVersion + 1,
            daemonStateVersion: machine.daemonStateVersion + 1, dataEncryptionKey: machine.dataEncryptionKey ?? null } };
        storage.getState().applyMachines([selectedPending], false, { sourceServerId: home.id });
        expect(connection.readCurrent().snapshots).toContainEqual(expect.objectContaining({
            executionPendingMachineIds: expect.arrayContaining([machine.id, other.id]),
        }));
        expect(connection.getSnapshot().selection).toMatchObject({ state: selected, loading: true });

        storage.getState().applyMachines([{ ...selectedPending, metadataVersion: selectedPending.keyBasis.metadataVersion,
            daemonStateVersion: selectedPending.keyBasis.daemonStateVersion }], false, { sourceServerId: home.id });
        expect(connection.readCurrent().snapshots).toContainEqual(expect.objectContaining({
            executionPendingMachineIds: [other.id],
        }));
        expect(connection.getSnapshot().selection).toMatchObject({ state: selected, loading: false });
    });

    it('retains equal descriptive output when a custom classifier callback changes and publishes actual classification changes', () => {
        const { inputs, connect, home, machine } = fixture();
        const materialization = { serverIdentityId: home.serverIdentityId, machineId: machine.id, pluginId: inputs.pluginId,
            materializationId: 'portable', version: '1.0.0', sourceClass: 'registryPackage' as const, portableRelease: true,
            enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] };
        const classifyRelease = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        const selection = { availabilityRevision: {}, classifyRelease, storedOrigin: null, homeServerIdentityId: home.serverIdentityId };
        const current = { ...inputs, sources: [], materializations: [materialization], selection };
        const connection = connect(current);
        const admitted = connection.getSnapshot();
        expect(admitted).toMatchObject({ selection: { state: { kind: 'selected' } } });
        connection.updateInputs({ ...current, selection: { ...selection, classifyRelease: () => classifyRelease() } });
        expect(connection.getSnapshot()).toBe(admitted);
        connection.updateInputs({ ...current, selection: { ...selection, classifyRelease: () => ({ releaseContent: 'conflict' as const,
            validation: { kind: 'rejected' as const, reason: 'content_conflict' as const } }) } });
        const refused = connection.getSnapshot();
        expect(refused).toMatchObject({ selection: { state: { kind: 'unavailable', reasons: ['content_conflict'] } } });
        connection.updateInputs({ ...current, selection: { ...selection, classifyRelease: () => ({ releaseContent: 'conflict' as const,
            validation: { kind: 'rejected' as const, reason: 'content_conflict' as const } }) } });
        expect(connection.getSnapshot()).toBe(refused);
        const emptyInputs = { ...current, materializations: [] };
        const empty = connect(emptyInputs);
        const emptySnapshot = empty.getSnapshot();
        empty.updateInputs({ ...emptyInputs, selection: { ...selection, classifyRelease: () => classifyRelease() } });
        expect(empty.getSnapshot()).toBe(emptySnapshot);
    });

    it('publishes shared descriptive candidates and election once, outside snapshot reads', () => {
        const { inputs, connect, source, home, machine } = fixture();
        const build = vi.spyOn(origins, 'buildPluginMachineExecutionOriginCandidates');
        const elect = vi.spyOn(origins, 'resolvePluginMachineExecutionOriginState');
        const selection = { availabilityRevision: {}, classifyRelease: () => ({ releaseContent: 'matched' as const,
            validation: { kind: 'admitted' as const } }), homeServerIdentityId: source.source.origin.serverIdentityId,
            storedOrigin: null, contextualTarget: undefined };
        const first = connect({ ...inputs, selection });
        const second = connect({ ...inputs, selection });
        expect(first.getSnapshot()).toMatchObject({ selection: { state: { kind: 'selected', origin: source.source.origin } } });
        expect(second.getSnapshot()).toBe(first.getSnapshot());
        expect(build).toHaveBeenCalledTimes(1);
        expect(elect).toHaveBeenCalledTimes(1);
        const before = [build.mock.calls.length, elect.mock.calls.length];
        for (let index = 0; index < 100; index += 1) {
            first.getSnapshot(); second.getSnapshot();
            storage.setState({ settingsVersion: index });
        }
        expect([build.mock.calls.length, elect.mock.calls.length]).toEqual(before);
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, revokedAt: Date.now() }] } });
        expect(first.getSnapshot()).toMatchObject({ selection: { state: { kind: 'unavailable', reasons: ['revoked'] } } });
        expect(second.getSnapshot()).toBe(first.getSnapshot());
        expect([build.mock.calls.length, elect.mock.calls.length]).toEqual(before.map(count => count + 1));
    });

    it('does no derivation on unchanged reads or unrelated publications across independent consumers', () => {
        const serialize = vi.spyOn(origins, 'createPluginMachineExecutionOriginMachineFacts');
        const targets = vi.spyOn(origins, 'readPluginExecutionOriginMachineTargets');
        const project = vi.spyOn(inventory, 'resolveAllProfileMachineInventorySnapshots');
        const { inputs, source, home, machine, connect } = fixture();
        const shell = connect();
        const page = connect({ ...inputs, sources: [{ ...source, source: { ...source.source } }] });
        const first = shell.getSnapshot();
        const before = [serialize.mock.calls.length, targets.mock.calls.length, project.mock.calls.length];
        for (let index = 0; index < 100; index += 1) {
            expect(shell.getSnapshot()).toBe(first);
            expect(page.getSnapshot()).toBe(first);
            expect(shell.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }))
                .toMatchObject({ rejection: null, eligible: true });
            storage.setState({ settingsVersion: index });
        }
        expect([serialize.mock.calls.length, targets.mock.calls.length, project.mock.calls.length]).toEqual(before);
        shell.updateInputs({ ...inputs, sources: [{ ...source, source: { ...source.source } }] });
        expect(shell.getSnapshot()).toBe(first);
        expect(serialize.mock.calls.length).toBe(before[0]);
        const changed = { ...inputs, sources: [{ ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: 'missing-machine' } } } }] };
        shell.updateInputs(changed);
        expect(shell.getSnapshot().key).not.toBe(first.key);
        expect(shell.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: 'missing-machine' }).rejection).toBe('missing');
    });

    it('keeps alternating Home-scope publications alive without evicting or rebuilding one another', () => {
        const { inputs, connect } = fixture();
        const project = vi.spyOn(inventory, 'resolveAllProfileMachineInventorySnapshots');
        const targets = vi.spyOn(origins, 'readPluginExecutionOriginMachineTargets');
        const a = connect();
        const b = connect({ ...inputs, accountScopesByServerId: new Map(), pluginId: 'other.plugin' });
        const aSnapshot = a.getSnapshot();
        const bSnapshot = b.getSnapshot();
        expect(aSnapshot.key).not.toBe(bSnapshot.key);
        const before = [project.mock.calls.length, targets.mock.calls.length];
        for (let index = 0; index < 100; index += 1) {
            storage.setState({ settingsVersion: index });
            expect(a.getSnapshot()).toBe(aSnapshot);
            expect(b.getSnapshot()).toBe(bSnapshot);
        }
        expect([project.mock.calls.length, targets.mock.calls.length]).toEqual(before);
    });

    describe('across many plugin demands', () => {
        const classify = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        function manyPlugins(count: number) {
            const ctx = fixture();
            const second = createMachineFixture({ id: 'origin-count-machine-b', activeAt: ctx.now });
            storage.setState({ machineListByServerId: { [ctx.home.id]: [ctx.machine, second] } });
            const sourceFor = (pluginId: string, machineId: string) => ({ ...ctx.source, source: { ...ctx.source.source,
                origin: { ...ctx.source.source.origin, sourceRef: { ...ctx.source.source.origin.sourceRef, pluginId, machineId } } } });
            const plugins = Array.from({ length: count }, (_, index) => {
                const pluginId = `acme.many-${index}`;
                const machineId = index % 2 === 0 ? ctx.machine.id : second.id;
                const listener = vi.fn();
                const inputsFor = (sources = [sourceFor(pluginId, machineId)]): ExecutionOriginMachineSnapshotInputs => ({
                    ...ctx.inputs, pluginId, sources,
                    accountScopesByServerId: new Map(ctx.inputs.accountScopesByServerId), bindings: [], profiles: [...ctx.inputs.profiles],
                    selection: { availabilityRevision: null, classifyRelease: classify, storedOrigin: null,
                        machineRejections: [], establishingTargets: [] } });
                const connection = ctx.connect(inputsFor(), listener);
                return { pluginId, machineId, listener, inputsFor, connection };
            });
            return { ...ctx, second, plugins, sourceFor };
        }

        it('does not republish when a parent rebuilds semantically unchanged inputs', () => {
            const { plugins } = manyPlugins(20);
            const before = plugins.map(plugin => plugin.connection.getSnapshot());
            for (const plugin of plugins) plugin.listener.mockClear();
            for (const plugin of plugins) plugin.connection.updateInputs(plugin.inputsFor());
            plugins.forEach((plugin, index) => {
                expect(plugin.listener).not.toHaveBeenCalled();
                expect(plugin.connection.getSnapshot()).toBe(before[index]);
            });
        });

        it('wakes only demands supplied by the Machine whose eligibility changed', () => {
            const { plugins, home, machine, second } = manyPlugins(20);
            for (const plugin of plugins) plugin.listener.mockClear();
            storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, revokedAt: Date.now() }] } });
            for (const plugin of plugins) {
                expect(plugin.listener).toHaveBeenCalledTimes(plugin.machineId === second.id ? 1 : 0);
            }
        });

        it('keeps demands on other Machines quiet while one Machine opens newer content', () => {
            const { plugins, home, machine, second } = manyPlugins(20);
            const elect = vi.spyOn(origins, 'resolvePluginMachineExecutionOriginState');
            const onFirst = plugins.filter(plugin => plugin.machineId === machine.id);
            const before = onFirst.map(plugin => plugin.connection.getSnapshot());
            const version = (second.daemonStateVersion ?? 0) + 1;
            const keyBasis = { metadataVersion: second.metadataVersion ?? 0, daemonStateVersion: version };
            for (const plugin of plugins) plugin.listener.mockClear();
            // Machine B announces newer daemon content, then opens it.
            storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, keyBasis }] } });
            storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, daemonStateVersion: version, keyBasis }] } });
            const wakes = onFirst.reduce((sum, plugin) => sum + plugin.listener.mock.calls.length, 0);
            const elections = elect.mock.calls.filter(([input]) => input.pluginId && onFirst.some(plugin => plugin.pluginId === input.pluginId)).length;
            expect({ wakes, elections }).toEqual({ wakes: 0, elections: 0 });
            onFirst.forEach((plugin, index) => expect(plugin.connection.getSnapshot()).toBe(before[index]));
            // Demands supplied by B still follow its content.
            expect(plugins.filter(plugin => plugin.machineId === second.id)
                .every(plugin => plugin.connection.getSnapshot().selection?.state.kind === 'selected')).toBe(true);
        });

        it('does not wake a demand selected elsewhere while another of its Machines opens newer content', () => {
            const { plugins, home, machine, second, sourceFor } = manyPlugins(10);
            // Every plugin is supplied by both Machines (the busy Account's shape).
            for (const plugin of plugins) {
                plugin.connection.updateInputs(plugin.inputsFor([sourceFor(plugin.pluginId, machine.id), sourceFor(plugin.pluginId, second.id)]));
            }
            const onFirst = plugins.filter(plugin => {
                const state = plugin.connection.getSnapshot().selection?.state;
                return state?.kind === 'selected' && originIdentity.getPluginMachineExecutionOriginRef(state.origin).machineId === machine.id;
            });
            expect(onFirst.length).toBeGreaterThan(0);
            const before = onFirst.map(plugin => plugin.connection.getSnapshot().selection);
            const version = (second.daemonStateVersion ?? 0) + 1;
            const keyBasis = { metadataVersion: second.metadataVersion ?? 0, daemonStateVersion: version };
            for (const plugin of plugins) plugin.listener.mockClear();
            storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, keyBasis }] } });
            storage.setState({ machineListByServerId: { [home.id]: [machine, { ...second, daemonStateVersion: version, keyBasis }] } });
            expect(onFirst.reduce((sum, plugin) => sum + plugin.listener.mock.calls.length, 0)).toBe(0);
            onFirst.forEach((plugin, index) => expect(plugin.connection.getSnapshot().selection).toBe(before[index]));
        });

        it('publishes each plugin once per real input arrival and never for an equal re-arrival', () => {
            const { plugins } = manyPlugins(20);
            for (const plugin of plugins) {
                plugin.listener.mockClear();
                plugin.connection.updateInputs(plugin.inputsFor([]));
                expect(plugin.listener).toHaveBeenCalledTimes(1);
                plugin.connection.updateInputs(plugin.inputsFor([]));
                plugin.connection.updateInputs(plugin.inputsFor([]));
                expect(plugin.listener).toHaveBeenCalledTimes(1);
            }
        });
    });

    describe('work per transition across plugins × Machines', () => {
        const classify = () => ({ releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } });
        // Every plugin holds an installation on every Machine and declares one
        // contribution to the next plugin: the busy Account's real shape.
        function account(pluginCount: number, machineCount: number, includeSources = false, declarationCount?: number) {
            const ctx = fixture();
            const machines = [ctx.machine, ...Array.from({ length: machineCount - 1 }, (_, index) =>
                createMachineFixture({ id: `origin-work-${index}`, activeAt: ctx.now }))];
            storage.setState({ machineListByServerId: { [ctx.home.id]: machines } });
            if (includeSources || declarationCount) publishMachineActivities(machines.map(machine => ({ machine, activity: machine, projections: [] })));
            const pluginIds = Array.from({ length: pluginCount }, (_, index) => `acme.work-${index}`);
            const counts = { declarationReads: 0, rowPluginIdReads: 0 };
            const manifests = pluginIds.map((id, index) => {
                const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id, version: '1.0.0', displayName: id,
                    runtime: { apiVersion: 1 }, contributes: {
                        actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                            dangerLevel: 'safe', execution: { target: 'daemon' } }],
                        targetedPluginContributions: [{ id: 'source', target: { pluginId: pluginIds[(index + 1) % pluginCount]!, pointId: 'sources' },
                            protocol: { id: 'sources', version: 1 }, operations: { read: 'read' } }],
                    } });
                const contributes = manifest.contributes;
                Object.defineProperty(manifest, 'contributes', { enumerable: true, get() { counts.declarationReads += 1; return contributes; } });
                return manifest;
            });
            const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: manifests.map(manifest => ({ pluginId: manifest.id,
                pluginVersion: manifest.version, displayName: manifest.id, packageName: `@acme/${manifest.id}`,
                normalizedManifest: manifest, entriesById: {} })) });
            const scope = { serverId: ctx.home.id, accountId: 'account-count' };
            const rowsFor = () => pluginIds.flatMap(pluginId => machines.map((host): PluginMachineMaterializationV1 => ({
                serverIdentityId: ctx.home.serverIdentityId, machineId: host.id, materializationId: `${pluginId}-${host.id}`, pluginId,
                version: '1.0.0', sourceClass: 'bundledFirstParty', portableRelease: true, enabled: true, trustState: 'trusted',
                observedAt: 1, uiArtifacts: [] })));
            const publish = (cursor: number, rows: readonly PluginMachineMaterializationV1[]) => {
                store.replace({ scope, snapshot: { availabilityCursor: cursor, intentReads: [], materializations: rows, inventoryComplete: true,
                    snapshots: machines.map(host => ({ serverIdentityId: ctx.home.serverIdentityId, machineId: host.id,
                        materializations: rows.filter(row => row.machineId === host.id) })) } });
                return store.bind(scope).readInstalledPlugins();
            };
            const rows = rowsFor().filter((_, index) => declarationCount === undefined || index % machineCount < Math.ceil(declarationCount / pluginCount)).slice(0, declarationCount);
            const materializations = rows.map(row => {
                const counted = { ...row };
                Object.defineProperty(counted, 'pluginId', { enumerable: true, get() { counts.rowPluginIdReads += 1; return row.pluginId; } });
                return counted;
            });
            const installedPlugins = publish(1, rows);
            const sourcesByPlugin = new Map(pluginIds.map(pluginId => [pluginId, includeSources ? machines.map(host => ({
                ...ctx.source, source: { ...ctx.source.source, origin: { ...ctx.source.source.origin,
                    sourceRef: { ...ctx.source.source.origin.sourceRef, pluginId, machineId: host.id } } },
            })) : []]));
            const inputsFor = (pluginId: string, selection: Partial<NonNullable<ExecutionOriginMachineSnapshotInputs['selection']>> = {}): ExecutionOriginMachineSnapshotInputs => ({
                ...ctx.inputs, pluginId, sources: sourcesByPlugin.get(pluginId)!, materializations,
                selection: { availabilityRevision: store.bind(scope).getObservationSnapshot(pluginId), classifyRelease: classify, storedOrigin: null,
                    homeServerIdentityId: ctx.home.serverIdentityId, installedPlugins, ...selection } });
            const connections = pluginIds.map(pluginId => ctx.connect(inputsFor(pluginId)));
            const measure = (transition: () => void) => {
                const stringify = vi.spyOn(JSON, 'stringify');
                const mapGet = vi.spyOn(Map.prototype, 'get');
                counts.declarationReads = 0;
                counts.rowPluginIdReads = 0;
                transition();
                const result = { stringify: stringify.mock.calls.length, mapGet: mapGet.mock.calls.length, ...counts };
                stringify.mockRestore();
                mapGet.mockRestore();
                return result;
            };
            return { ...ctx, machines, pluginIds, connections, inputsFor, measure, scope, rowsFor, publish, revisionFor: (pluginId: string) => store.bind(scope).getObservationSnapshot(pluginId) };
        }
        const revokeMachine = ({ home, machines }: ReturnType<typeof account>, machineId: string) =>
            storage.setState({ machineListByServerId: { [home.id]: machines.map(row => row.id === machineId ? { ...row, revokedAt: Date.now() } : row) } });

        it('publishes only changed candidates and collects superseded generations at reload151 scale', async () => {
            const allocated: WeakRef<object>[] = [];
            const originalSet = Map.prototype.set;
            const observe = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
                if (value && typeof value === 'object' && 'target' in value && 'rejection' in value
                    && 'materializations' in value && 'sources' in value) allocated.push(new WeakRef(value));
                return originalSet.call(this, key, value);
            });
            const work = account(107, 344, false, 9925);
            let rows = work.inputsFor(work.pluginIds[0]!).materializations;
            expect(rows).toHaveLength(9925);
            expect(work.connections).toHaveLength(107);
            expect(work.machines).toHaveLength(344);
            const initialAllocations = allocated.length;
            expect(initialAllocations).toBe(9925);
            expect(work.connections.every(connection => connection.getSnapshot().selection!.candidates.length > 0)).toBe(true);
            const generations: WeakRef<object>[] = [];
            const changedPublications: number[] = [];
            for (let round = 0; round < 6; round++) {
                // Availability retains unchanged rows, advances its cursor, and changes one declaration.
                rows = rows.map((row, index) => index === 0 ? { ...row, version: `1.0.${round + 1}` } : row);
                const installedPlugins = work.publish(round + 2, rows);
                let changed = 0;
                work.connections.forEach((connection, index) => {
                    const before = connection.getSnapshot().selection!.candidates;
                    connection.updateInputs({ ...work.inputsFor(work.pluginIds[index]!, { availabilityRevision: work.revisionFor(work.pluginIds[index]!), installedPlugins }), materializations: rows });
                    if (connection.getSnapshot().selection!.candidates !== before) {
                        changed++;
                        generations.push(new WeakRef(before));
                    }
                });
                changedPublications.push(changed);
                observe.mockClear(); // instrumentation must not retain arguments
            }
            const inventories: WeakRef<object>[] = [];
            for (let round = 0; round < 6; round++) {
                inventories.push(new WeakRef(work.connections[0]!.getSnapshot().snapshots));
                revokeMachine(work, work.machines[round + 1]!.id);
                observe.mockClear();
            }
            observe.mockRestore();
            setFlagsFromString('--expose-gc');
            const collect: () => void = runInNewContext('gc');
            setFlagsFromString('--no-expose-gc');
            await setImmediate();
            collect();
            expect(changedPublications).toEqual([1, 1, 1, 1, 1, 1]);
            expect(generations.filter(ref => ref.deref())).toHaveLength(0);
            expect(inventories.filter(ref => ref.deref())).toHaveLength(0);
            expect(allocated).toHaveLength(initialAllocations); // existing target indexes survive declaration churn
            expect(allocated.filter(ref => ref.deref())).toHaveLength(initialAllocations);
            expect(work.connections[0]!.getSnapshot().selection!.candidates.some(candidate =>
                'materialization' in candidate && candidate.materialization.version === '1.0.6')).toBe(true);
        });

        it('derives per-installation facts once, not per demand, when one Machine flips', () => {
            const work = account(12, 6);
            const counted = work.measure(() => revokeMachine(work, work.machines[1]!.id));
            for (const connection of work.connections) expect(connection.getSnapshot().key).toContain('revoked');
            expect(counted.declarationReads).toBe(0);
            // One changed row serialized per demand, whatever the Account's installation count.
            expect(counted.stringify).toBeLessThanOrEqual(12 * 2);
        });

        it('reuses shared facts across equal Availability republications with a new cursor', () => {
            const work = account(8, 4);
            const installedPlugins = work.publish(2, work.rowsFor());
            const counted = work.measure(() => work.connections.forEach((connection, index) => {
                connection.updateInputs(work.inputsFor(work.pluginIds[index]!, { installedPlugins }));
            }));
            expect(counted.declarationReads).toBe(0);
            expect(counted.stringify).toBeLessThanOrEqual(8 * 2);
        });

        it('rebinds a plugin without rescanning other plugins\' installations', () => {
            const work = account(12, 6);
            const counted = work.measure(() => work.connections.forEach((connection, index) => {
                connection.updateInputs(work.inputsFor(work.pluginIds[index]!, { machineRejections: [{ serverIdentityId: work.home.serverIdentityId,
                    machineId: work.machines[1]!.id, reason: 'daemon_unavailable' }] }));
            }));
            expect(counted.declarationReads).toBe(0);
            // Only each plugin's own rows are revisited; the 72-row Account is never walked per demand.
            expect(counted.rowPluginIdReads).toBeLessThanOrEqual(12 * 6 * 4);
        });

        it('grows linearly in demands on a census transition', () => {
            const cost = (pluginCount: number) => {
                clearMachineRequestReachabilityForTest();
                const work = account(pluginCount, 6);
                const scopeOf = work.inputs.accountScopesByServerId.get(work.home.serverIdentityId)!;
                captureMachinePresenceObservation(scopeOf)(work.machines.map(row => row.id));
                for (const connection of work.connections) expect(connection.getSnapshot().key).not.toContain('unknown');
                const counted = work.measure(() => storage.setState({ machineListStatusByServerId: { [work.home.id]: 'loading' } }));
                for (const connection of work.connections) connection.dispose();
                return counted.mapGet;
            };
            const small = cost(10);
            const large = cost(20);
            expect(large / small).toBeLessThan(2.4);
        });

        it('keeps the elected origin when shared facts serve several plugins, and follows a changed declaration', () => {
            const work = account(6, 3);
            for (const connection of work.connections) {
                expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected', selectionSource: 'auto' });
            }
            const pluginId = work.pluginIds[1]!;
            const before = work.connections[1]!.getSnapshot().selection!.state;
            expect(before).toMatchObject({ origin: { materializationRef: { pluginId } } });
            // Contributor plugin 0 targets plugin 1. Removing it from all but the last Machine moves the coverage there.
            const last = work.machines[2]!.id;
            const narrowed = work.rowsFor().filter(row => row.pluginId !== work.pluginIds[0] || row.machineId === last);
            const installedPlugins = work.publish(3, narrowed);
            const connection = work.connections[1]!;
            connection.updateInputs(work.inputsFor(pluginId, { installedPlugins }));
            expect(connection.getSnapshot().selection?.state).toMatchObject({ kind: 'selected',
                origin: { materializationRef: { machineId: last, pluginId } } });
        });
    });

    it('publishes suppressed heartbeat ordering, expiry and refusal while retaining unchanged eligibility', () => {
        vi.useFakeTimers();
        const { now, machine, home, source, inputs, connect } = fixture();
        const second = createMachineFixture({ id: 'second-origin-machine', activeAt: now + 1 });
        const machines = [machine, second, ...Array.from({ length: 136 }, (_, index) => createMachineFixture({
            id: `heartbeat-unrelated-${index}`, activeAt: now,
        }))];
        storage.setState({ machineListByServerId: { [home.id]: machines } });
        storage.getState().applyMachines(machines, false, { sourceServerId: home.id });
        const pair = { ...inputs, sources: [source, { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }] };
        const serialize = vi.spyOn(origins, 'createPluginMachineExecutionOriginMachineFacts');
        const connection = connect(pair);
        const update = vi.spyOn(serialize.mock.results[0]!.value, 'update');
        const first = connection.getSnapshot();
        const state = storage.getState();
        const project = vi.spyOn(inventory, 'resolveAllProfileMachineInventorySnapshots');
        const storedMachine = state.machineListByServerId[home.id]!.find(row => row.id === machine.id)!;
        const metadata = storedMachine.metadata;
        if (!metadata) throw new Error('Machine metadata fixture is required');
        const host = metadata.host;
        let metadataReads = 0;
        // Observe content conversion, not the pointer copy required by immutable publication.
        Object.defineProperty(metadata, 'host', { configurable: true,
            get() { metadataReads += 1; return host; } });
        for (let index = 0; index < 100; index += 1) {
            storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: now }], { sourceServerId: home.id });
            expect(storage.getState()).toBe(state);
            expect(connection.getSnapshot()).toBe(first);
            connection.readCurrent();
        }
        expect(project).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(metadataReads).toBe(0);
        storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: now + 2 }], { sourceServerId: home.id });
        expect(storage.getState()).toBe(state);
        expect(storedMachine.activeAt).toBe(now);
        expect(project).not.toHaveBeenCalled();
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
        expect(metadataReads).toBe(0);
        expect(connection.getSnapshot().key).not.toBe(first.key);
        expect(connection.getSnapshot().eligibilityKey).toBe(first.eligibilityKey);
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).activeAt).toBe(now + 2);
        expect(connection.readCurrent().snapshots.find(snapshot => snapshot.kind === 'resolved')?.machines
            .find(row => row.id === machine.id)?.activeAt).toBe(now + 2);
        vi.advanceTimersByTime(120_000);
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBeNull();
        storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: now + 2 }], { sourceServerId: home.id });
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('offline');
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, activeAt: Date.now(), revokedAt: Date.now() }] } });
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('revoked');
    });
});
