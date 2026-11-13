import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import { createMachineFixture, createRenderCommitCounter, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { preloadTranslationsForSettings, setPreferredLanguageFromSettings, getPreferredLanguage, t } from '@/text';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import type { MachineCollection, MachineCollectionRow } from './machineCollectionModel';

installDisconnectedServerSocketBoundary();
const { machineCollectionRowKey } = await import('./machineCollectionModel');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useMachineCollection, useMachineCollectionRowPresence, useMachineCollectionPresenceRows, useMachineFleetPresence } = await import('./useMachineCollection');
const { useMachineListByServerId } = await import('@/sync/domains/state/storage');
const { useMachinePresenceSummary } = await import('@/sync/domains/machines/reachability/useMachinePresenceSummary');
const { flushMachineActivityUpdates } = await import('@/sync/engine/socket/socket');

it('renews retained native presence words when the ready locale changes with the same inventory', async () => {
    const previousLanguage = getPreferredLanguage();
    await preloadTranslationsForSettings('en');
    setPreferredLanguageFromSettings('en');
    const machine = createMachineFixture({ id: 'locale-machine', active: false, activeAt: 1, presenceProtocolVersion: 1 });
    const managed = ManagedMachineV1Schema.parse({ id: 'locale-created', homeId: 'locale-home', custodianAccountId: 'owner',
        enrolledMachineId: machine.id, launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
        allocation: 'bound', creationState: 'active', resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' } });
    const input = { groups: [{ serverId: 'locale-home', serverName: 'Home', accountScope: { serverId: 'locale-home', accountId: 'owner' },
        status: 'idle' as const, machines: [machine] }], groupedByHome: false, managedByServerId: { 'locale-home': [managed] } };
    const hook = await renderHook(() => useMachineCollection(input));
    try {
        const english = hook.getCurrent().sections[0]!.rows[0]!.presence;
        expect(english).toBe(t('managedPower.asleep'));
        await act(async () => { await preloadTranslationsForSettings('es'); setPreferredLanguageFromSettings('es'); });
        expect(t('managedPower.asleep')).not.toBe(english);
        expect(hook.getCurrent().sections[0]!.rows[0]!.presence).toBe(t('managedPower.asleep'));
    } finally { await hook.unmount(); setPreferredLanguageFromSettings(previousLanguage); }
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = 'srv_collection-identity';
const SCOPE = { serverId: HOME, accountId: 'account-a' };
const EMPTY_MACHINES: readonly ReturnType<typeof createMachineFixture>[] = [];
const counters = new Map<string, ReturnType<typeof createRenderCommitCounter>>();
let collection: MachineCollection;
let fleetRenders = 0;

const Row = React.memo(function Row({ row: source }: Readonly<{ row: MachineCollectionRow }>) {
    const row = useMachineCollectionRowPresence(source);
    const key = machineCollectionRowKey(row);
    let counter = counters.get(key);
    if (!counter) { counter = createRenderCommitCounter(); counters.set(key, counter); }
    useRenderCommitCounter(counter);
    return React.createElement(row.hydrating ? 'skeleton' : 'row', { title: row.title, rowKey: key, online: row.online });
});

function Fleet() {
    fleetRenders++;
    const readMachines = React.useCallback(() => storage.getState().machineListByServerId[HOME] ?? EMPTY_MACHINES, []);
    const machines = React.useSyncExternalStore(storage.subscribe, readMachines, readMachines);
    const groups = React.useMemo((): readonly ActiveSelectionMachineGroup[] => [{
        serverId: HOME, serverName: 'Home', accountScope: SCOPE, status: 'idle', machines,
    }], [machines]);
    collection = useMachineCollection({ groups, groupedByHome: false });
    return collection.sections.flatMap(section => section.rows.map(row => <Row key={machineCollectionRowKey(row)} row={row} />));
}

afterEach(() => { standardCleanup(); counters.clear(); });

it('keeps the sidebar and header on one presence fact after Create and a facts-equal inventory refresh', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-identity.test', serverIdentityId: HOME });
    const base = Date.now();
    const controller = createMachineFixture({ id: 'create-controller', active: true, activeAt: base, presenceProtocolVersion: 1 });
    const created = createMachineFixture({ id: 'created-machine', active: false, activeAt: base, presenceProtocolVersion: 1 });
    const options = { sourceServerId: HOME };
    storage.getState().applyMachines([controller], true, options);
    const read = await renderHook(() => {
        const lists = useMachineListByServerId();
        const groups = React.useMemo((): readonly ActiveSelectionMachineGroup[] => [{
            serverId: HOME, serverName: 'Home', accountScope: SCOPE, status: 'idle', machines: lists[HOME] ?? EMPTY_MACHINES,
        }], [lists]);
        const inventory = useMachineCollection({ groups, groupedByHome: false });
        const rows = React.useMemo(() => inventory.sections.flatMap(section => section.rows), [inventory]);
        return { inventory, counts: useMachineFleetPresence(groups), rows: useMachineCollectionPresenceRows(rows),
            header: useMachinePresenceSummary(HOME, created.id) };
    });
    try {
        await act(async () => storage.getState().applyMachines([created], false, options));
        const retained = read.getCurrent().inventory;
        expect(read.getCurrent().rows.find(row => row.machineId === controller.id)?.online).toBe(true);
        expect(read.getCurrent().header.presenceOnline).toBe(false);
        expect(read.getCurrent().counts).toEqual({ online: 1, offline: 1, unknown: 0 });
        // A reconnect census or daemon-state publication can replace content
        // while the canonical presentation owner retains every displayed fact.
        await act(async () => storage.getState().applyMachines([controller, created].map(machine => ({
            ...machine, daemonStateVersion: machine.daemonStateVersion + 1,
        })), true, options));
        expect(read.getCurrent().inventory).toBe(retained);
        await act(async () => flushMachineActivityUpdates({ sourceServerId: HOME, updates: new Map([
            [created.id, { id: created.id, active: true, activeAt: base + 1 }],
        ]) }));
        expect(read.getCurrent().header.presenceOnline).toBe(true);
        expect(read.getCurrent().header.reachability).toBe('reachable');
        expect(read.getCurrent().rows.find(row => row.machineId === created.id)?.online).toBe(true);
        expect(read.getCurrent().rows.find(row => row.machineId === controller.id)?.online).toBe(true);
        await act(async () => flushMachineActivityUpdates({ sourceServerId: HOME, updates: new Map([
            [created.id, { id: created.id, active: false, activeAt: base + 1 }],
        ]) }));
        expect(read.getCurrent().header.presenceOnline).toBe(false);
        expect(read.getCurrent().header.reachability).toBe('unreachable');
        expect(read.getCurrent().rows.find(row => row.machineId === created.id)?.online).toBe(false);
        expect(read.getCurrent().rows.find(row => row.machineId === controller.id)?.online).toBe(true);
    } finally { await read.unmount(); await connection.dispose(); }
});

it('keeps the collection parent quiet when one Machine goes offline', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-identity.test', serverIdentityId: HOME });
    const machines = Array.from({ length: 128 }, (_, index) => createMachineFixture({ id: `presence-${index}`, active: true, activeAt: Date.now(), presenceProtocolVersion: 1 }));
    storage.getState().applyMachines(machines, true, { sourceServerId: HOME });
    observeMachinePresenceForTest(SCOPE, machines.map(machine => machine.id));
    try {
        const screen = await renderScreen(<Fleet />);
        for (const counter of counters.values()) counter.reset();
        const before = fleetRenders;
        const previous = collection;
        await act(async () => storage.getState().applyMachineActivityUpdates([
            { id: 'presence-0', active: false, activeAt: Date.now() },
        ], { sourceServerId: HOME }));
        expect(fleetRenders - before).toBe(0);
        expect(collection).toBe(previous);
        expect(counters.get(`machine:${HOME}:presence-0`)!.read().renders).toBe(1);
        expect([...counters.entries()].filter(([key]) => key !== `machine:${HOME}:presence-0`)
            .reduce((total, [, counter]) => total + counter.read().renders, 0)).toBe(0);
        expect(screen.findByProps({ rowKey: `machine:${HOME}:presence-0` }).props.online).toBe(false);
    } finally { await connection.dispose(); }
});

it('keeps a retained collection row subscribed after an unrelated Machine content publication', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-identity.test', serverIdentityId: HOME });
    const base = Date.now();
    const machines = Array.from({ length: 128 }, (_, index) => createMachineFixture({
        id: `retained-${index}`, active: true, activeAt: base, updatedAt: base, presenceProtocolVersion: 1,
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: HOME });
    observeMachinePresenceForTest(SCOPE, machines.map(machine => machine.id));
    try {
        const screen = await renderScreen(<Fleet />);
        const original = collection.sections.flatMap(section => section.rows).find(row => row.machineId === 'retained-0');
        const changed = { ...machines[0]!, updatedAt: base + 1, metadataVersion: machines[0]!.metadataVersion + 1,
            metadata: { ...machines[0]!.metadata!, happyCliVersion: '0.3.1' } };
        await act(async () => storage.getState().applyMachines([changed], false, { sourceServerId: HOME }));
        expect(storage.getState().machineListByServerId[HOME]!.find(machine => machine.id === changed.id)).not.toBe(machines[0]);
        expect(collection.sections.flatMap(section => section.rows).find(row => row.machineId === changed.id)).toBe(original);
        for (const counter of counters.values()) counter.reset();
        const before = fleetRenders;
        await act(async () => storage.getState().applyMachineActivityUpdates([
            { id: changed.id, active: false, activeAt: base + 60_000 },
        ], { sourceServerId: HOME }));
        expect(fleetRenders - before).toBe(0);
        expect(counters.get(`machine:${HOME}:retained-0`)!.read().renders).toBe(1);
        expect([...counters.entries()].filter(([key]) => key !== `machine:${HOME}:retained-0`)
            .reduce((total, [, counter]) => total + counter.read().renders, 0)).toBe(0);
        expect(screen.findByProps({ rowKey: `machine:${HOME}:retained-0` }).props.online).toBe(false);
    } finally { await connection.dispose(); }
});

it('keeps 113 hydrated rows with zero skeleton re-entries when one unread Machine arrives', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-identity.test', serverIdentityId: HOME });
    // UI-ACCEPT R7 observed a real Account grow from 113 to 114 Machines.
    const machines = Array.from({ length: 113 }, (_, index) => createMachineFixture({ id: `ready-${index}` }));
    storage.getState().applyMachines(machines, true, { sourceServerId: HOME });
    observeMachinePresenceForTest(SCOPE, machines.map(machine => machine.id));
    try {
        const screen = await renderScreen(<Fleet />);
        expect(collection!.firstAnswerPending).toBe(false);
        for (const counter of counters.values()) counter.reset();
        const arriving = createMachineFixture({ id: 'arriving', metadata: null, availability: undefined });
        await act(async () => { storage.getState().applyMachines([arriving], false, { sourceServerId: HOME }); });
        expect(collection!.firstAnswerPending).toBe(false);
        expect(screen.tree.findAll(node => node.type === 'row')).toHaveLength(113);
        expect(screen.tree.findAll(node => node.type === 'skeleton')).toHaveLength(1);
        expect([...counters.entries()].filter(([key]) => key !== `machine:${HOME}:arriving`)
            .reduce((sum, [, counter]) => sum + counter.read().renders, 0)).toBe(0);
        const ready = createMachineFixture({ id: 'arriving', metadataVersion: arriving.metadataVersion + 1 });
        await act(async () => { storage.getState().applyMachines([ready], false, { sourceServerId: HOME }); });
        expect(screen.tree.findAll(node => node.type === 'row')).toHaveLength(114);
        expect(screen.tree.findAll(node => node.type === 'skeleton')).toHaveLength(0);
    } finally { await connection.dispose(); }
});

it('replaces only the changed row across a 128-machine store publication, reorder and equal refresh', async () => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://collection-identity.test', serverIdentityId: HOME });
    const machines = Array.from({ length: 128 }, (_, index) => createMachineFixture({
        id: `machine-${index}`, active: true, activeAt: 0,
        metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${String(index).padStart(3, '0')}` },
    }));
    storage.getState().applyMachines(machines, true, { sourceServerId: HOME });
    observeMachinePresenceForTest(SCOPE, machines.map(machine => machine.id));
    try {
        await renderScreen(<Fleet />);
        expect(counters.size).toBe(128);
        for (const counter of counters.values()) counter.reset();
        const initialRows = new Map(collection!.sections.flatMap(section => section.rows.map(row => [machineCollectionRowKey(row), row] as const)));
        const changed = { ...machines[0]!, metadataVersion: machines[0]!.metadataVersion + 1,
            metadata: { ...machines[0]!.metadata!, displayName: 'Zebra' } };
        await act(async () => { storage.getState().applyMachines([changed], false, { sourceServerId: HOME }); });
        expect([...counters.entries()].filter(([, counter]) => counter.read().renders > 0).map(([key]) => key))
            .toEqual([`machine:${HOME}:machine-0`]);
        expect([...counters.values()].reduce((sum, counter) => sum + counter.read().renders, 0)).toBe(1);
        for (const row of collection!.sections.flatMap(section => section.rows)) {
            if (row.machineId !== changed.id) expect(row).toBe(initialRows.get(machineCollectionRowKey(row)));
        }
        expect(collection!.sections[0]!.rows.at(-1)?.title).toBe('Zebra');

        const settled = collection!;
        for (const counter of counters.values()) counter.reset();
        await act(async () => {
            storage.getState().applyMachines([...machines.slice(1).reverse(), changed], true, { sourceServerId: HOME });
        });
        expect(collection!).toBe(settled);
        expect([...counters.values()].reduce((sum, counter) => sum + counter.read().renders, 0)).toBe(0);
    } finally { await connection.dispose(); }
});
