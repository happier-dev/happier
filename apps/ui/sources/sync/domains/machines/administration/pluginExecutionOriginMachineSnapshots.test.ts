import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import { createSessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import * as inventory from '@/sync/domains/machines/machineInventorySnapshots';
import * as origins from './pluginExecutionOrigin';
import * as fleet from './fleetUnion';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed,
    recordMachineRequestSucceeded, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { createExecutionOriginMachineSnapshotPublication, type ExecutionOriginMachineSnapshotInputs } from './pluginExecutionOriginMachineSnapshots';

const originalState = storage.getState();
const connections: Array<{ dispose(): void }> = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.dispose();
    clearMachineRequestReachabilityForTest();
    storage.setState(originalState, true);
    vi.restoreAllMocks();
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
        subscribeState: listener => storage.subscribe(listener), subscribeMachineUpdates: subscribeRegisteredStorageMachineUpdates,
        clock: createSessionListRuntimeClock() });
    const connect = (next = inputs) => {
        const connection = publication.connect(next, () => {});
        connections.push(connection);
        return connection;
    };
    return { now, machine, home, source, inputs, connect };
}

describe('execution-origin Machine publication', () => {
    it('invalidates retained facts on scoped request/withdrawal changes and absent-row census settlement', () => {
        const { inputs, home, machine, connect } = fixture();
        const scope = inputs.accountScopesByServerId.get(home.serverIdentityId)!;
        const connection = connect();
        const target = { serverIdentityId: home.serverIdentityId, machineId: machine.id };
        const fact = () => connection.readCurrent().readMachineFact(target);
        expect(fact()).toMatchObject({ eligible: true, rejection: null });
        withdrawMachinePresenceForScope(scope);
        expect(fact()).toMatchObject({ eligible: false, rejection: 'unknown' });
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

    it('publishes suppressed heartbeat ordering, expiry and refusal while retaining unchanged eligibility', () => {
        vi.useFakeTimers();
        const { now, machine, home, source, inputs, connect } = fixture();
        const second = createMachineFixture({ id: 'second-origin-machine', activeAt: now + 1 });
        storage.setState({ machineListByServerId: { [home.id]: [machine, second] } });
        storage.getState().applyMachines([machine, second], false, { sourceServerId: home.id });
        const pair = { ...inputs, sources: [source, { ...source, source: { ...source.source,
            origin: { ...source.source.origin, sourceRef: { ...source.source.origin.sourceRef, machineId: second.id } } } }] };
        const serialize = vi.spyOn(origins, 'createPluginMachineExecutionOriginMachineFacts');
        const connection = connect(pair);
        const update = vi.spyOn(serialize.mock.results[0]!.value, 'update');
        const first = connection.getSnapshot();
        const state = storage.getState();
        const project = vi.spyOn(inventory, 'resolveAllProfileMachineInventorySnapshots');
        for (let index = 0; index < 100; index += 1) {
            storage.getState().applyMachines([{ ...machine }], false, { sourceServerId: home.id });
            expect(storage.getState()).toBe(state);
            expect(connection.getSnapshot()).toBe(first);
            connection.readCurrent();
        }
        expect(project).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        storage.getState().applyMachines([{ ...machine, activeAt: now + 2 }], false, { sourceServerId: home.id });
        expect(storage.getState()).toBe(state);
        expect(project).toHaveBeenCalledTimes(1);
        expect(serialize).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledTimes(1);
        expect(connection.getSnapshot().key).not.toBe(first.key);
        expect(connection.getSnapshot().eligibilityKey).toBe(first.eligibilityKey);
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).activeAt).toBe(now + 2);
        const deadline = readMachineStatusNextRefreshAtMs({ ...machine, activeAt: now + 2 }, now)!;
        vi.advanceTimersByTime(deadline - Date.now());
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('offline');
        storage.setState({ machineListByServerId: { [home.id]: [{ ...machine, activeAt: Date.now(), revokedAt: Date.now() }] } });
        expect(connection.readCurrent().readMachineFact({ serverIdentityId: home.serverIdentityId, machineId: machine.id }).rejection).toBe('revoked');
    });
});
