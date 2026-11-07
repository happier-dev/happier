import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptHomeProfile, setActiveServerId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import { listMachinesForVoiceTool } from '@/voice/tools/actionImpl/machinesList';
import { readMachineDaemonCliVersionForServerScope } from './readMachineDaemonCliVersionForServerScope';
import {
    readLiveMachineInventoryRows,
    resolveExactServerScopedMachine,
    resolvePortableMachineAdministrationTarget,
    resolveServerScopedMachines,
} from './resolveServerScopedMachines';

type TestMachine = Readonly<{ id: string; activeAt: number; revokedAt: number | null }>;
const identity = 'srv_machine_inventory_owner';
let profile: ServerProfile;

function createMachine(id: string, activeAt: number): TestMachine {
    return { id, activeAt, revokedAt: null };
}

describe('resolveServerScopedMachines', () => {
    beforeEach(async () => {
        profile = await adoptHomeProfile({ descriptor: {
            v: 1, homeServerIdentityId: identity,
            canonicalServerUrl: 'https://machine-inventory-owner.example.test',
            revision: 1, endpoints: [{ kind: 'https', url: 'https://machine-inventory-owner.example.test' }],
        }, source: 'manual' });
        expect(profile.id).not.toBe(identity);
        await setActiveServerId(profile.id);
    });
    afterEach(() => standardCleanup());

    it('reuses admitted membership for unchanged rows while rechecking current content and scoped list state', () => {
        const rows = Array.from({ length: 138 }, (_, index) => createMachineFixture({
            id: `incremental-${index}`, availability: { kind: 'available' },
        }));
        const context = { profile, serverIdentityId: identity, activeServerId: profile.id,
            activeMachines: rows, machineListByServerId: { [identity]: rows },
            machineListStatusByServerId: { [identity]: 'idle' as const } };
        const admitted = readLiveMachineInventoryRows(context);
        expect(admitted.size).toBe(138);
        for (let index = 0; index < 10; index++) {
            expect(readLiveMachineInventoryRows({ ...context }) === admitted).toBe(true);
        }
        const first = rows[0];
        first.keyBasis = { dataEncryptionKey: 'new-key', metadataVersion: first.metadataVersion + 1,
            daemonStateVersion: first.daemonStateVersion };
        const pending = readLiveMachineInventoryRows(context);
        expect(pending).not.toBe(admitted);
        expect(pending.has(first)).toBe(false);
        expect(readLiveMachineInventoryRows({ ...context, retainOpenedContent: true }).has(first)).toBe(true);
        first.metadataVersion += 1;
        expect(readLiveMachineInventoryRows(context).has(first)).toBe(true);
        expect(readLiveMachineInventoryRows({ ...context,
            machineListStatusByServerId: { [identity]: 'signedOut' } }).size).toBe(0);
        expect(readLiveMachineInventoryRows({ ...context,
            machineListByServerId: { [identity]: [], [profile.id]: rows } }).size).toBe(0);
    });

    it.each(['idle', 'loading'] as const)('qualifies only admitted current scoped rows while %s, never an active fallback or stale alias', (status) => {
        const ready = createMachineFixture({ id: 'ready', availability: { kind: 'available' } });
        const pending = createMachineFixture({ id: 'pending', metadata: null });
        const locked = createMachineFixture({ id: 'locked', availability: { kind: 'locked', reason: 'decryption_failed' } });
        const fallback = createMachineFixture({ id: 'fallback', availability: { kind: 'available' } });
        const context = { profile, serverIdentityId: identity, activeServerId: profile.id,
            activeMachines: [ready, pending, locked, fallback],
            machineListByServerId: { [identity]: [ready, pending, locked], [profile.id]: [fallback] },
            machineListStatusByServerId: { [identity]: status, [profile.id]: 'idle' as const } };
        expect([...readLiveMachineInventoryRows(context)]).toEqual([ready]);
        expect(readLiveMachineInventoryRows({ ...context, machineListByServerId: {} }).size).toBe(0);
        expect(readLiveMachineInventoryRows({ ...context,
            machineListByServerId: { [identity]: [], [profile.id]: [fallback] } }).size).toBe(0);
        for (const status of [undefined, 'signedOut'] as const) {
            expect(readLiveMachineInventoryRows({ ...context, machineListStatusByServerId: { [identity]: status } }).size).toBe(0);
        }
        // A failed list read never proves the admitted row gone.
        expect([...readLiveMachineInventoryRows({ ...context, machineListStatusByServerId: { [identity]: 'error' } })]).toEqual([ready]);
    });

    it('lists Voice inventory through equivalent Home keys without disclosing settled stale or foreign rows', async () => {
        const original = storage.getState();
        const machine = createMachineFixture({ id: 'machine-voice' });
        const sharingSettings = { ...original.settings, voice: { ...original.settings.voice,
            privacy: { ...original.settings.voice.privacy, shareDeviceInventory: true },
        } };
        try {
            storage.setState({ settings: sharingSettings, machines: { [machine.id]: machine },
                machineListByServerId: {}, machineListStatusByServerId: {},
            });
            expect(await listMachinesForVoiceTool({ serverId: profile.id })).toMatchObject({
                items: [{ serverId: profile.id, machineId: machine.id }],
            });
            expect(await listMachinesForVoiceTool({ serverId: 'foreign-home' })).toEqual({ items: [] });
            storage.setState({ machineListByServerId: { [identity]: [], [profile.id]: [machine] },
                machineListStatusByServerId: { [identity]: 'idle' },
            });
            expect(await listMachinesForVoiceTool({ serverId: profile.id })).toEqual({ items: [] });
            storage.setState({ settings: { ...sharingSettings, voice: { ...sharingSettings.voice,
                privacy: { ...sharingSettings.voice.privacy, shareDeviceInventory: false },
            } } });
            expect(await listMachinesForVoiceTool({ serverId: identity })).toMatchObject({ ok: false, errorCode: 'privacy_disabled' });
        } finally {
            storage.setState({ settings: original.settings, machines: original.machines,
                machineListByServerId: original.machineListByServerId,
                machineListStatusByServerId: original.machineListStatusByServerId,
            });
        }
    });

    it('reads daemon versions through the same equivalent Home inventory and settled absence rule', () => {
        const active = createMachineFixture({ id: 'machine-version', daemonState: { cliVersion: '0.3.1' } });
        const foreign = createMachineFixture({ id: active.id, daemonState: { cliVersion: '0.2.9' } });
        const state = { machines: { [active.id]: active }, machineListByServerId: { 'foreign-home': [foreign] } };
        expect(readMachineDaemonCliVersionForServerScope({ state, machineId: active.id,
            serverId: identity, activeServerId: profile.id })).toBe('0.3.1');
        expect(readMachineDaemonCliVersionForServerScope({ state, machineId: active.id,
            serverId: 'foreign-home', activeServerId: profile.id })).toBe('0.2.9');
        expect(readMachineDaemonCliVersionForServerScope({ machineId: active.id, serverId: profile.id, activeServerId: profile.id,
            state: { ...state, machineListByServerId: { [identity]: [] }, machineListStatusByServerId: { [identity]: 'idle' } },
        })).toBeNull();
    });

    it('prefers live active-server machines over a stale scoped cache when the requested server id is an active-server alias', () => {
        const freshMachine = createMachine('machine-live', 200);
        const staleMachine = createMachine('machine-stale', 100);
        expect(resolveServerScopedMachines({
            serverId: identity, activeServerId: profile.id, activeMachines: [freshMachine],
            machineListByServerId: { [identity]: [staleMachine] },
        })).toEqual([freshMachine]);
    });

    it.each([true, false])('uses canonical settled inventory for both equivalent routes, canonical contains machine = %s', (containsMachine) => {
        const machine = createMachine('machine-review', 100);
        const canonicalRows = containsMachine ? [machine] : [];
        const machineListByServerId = {
            [identity]: canonicalRows, [profile.id]: containsMachine ? [] : [machine],
        };
        const machineListStatusByServerId = { [identity]: 'idle' as const, [profile.id]: 'idle' as const };
        for (const serverId of [identity, profile.id]) {
            const context = { serverId, activeServerId: 'foreign-home', activeMachines: [], machineListByServerId, machineListStatusByServerId };
            expect(resolveServerScopedMachines(context)).toBe(canonicalRows);
            expect(resolveExactServerScopedMachine({ ...context, machineId: machine.id })).toBe(containsMachine ? machine : null);
        }
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: machine.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId, machineListStatusByServerId,
        })).toMatchObject({ kind: containsMachine ? 'resolved' : 'missingMachine' });
    });

    it('retains canonical presence while refreshing instead of switching to an older settled alias', () => {
        const fresh = createMachine('machine-live', 200);
        const stale = createMachine(fresh.id, 100);
        for (const serverId of [identity, profile.id]) {
            const context = { serverId, activeServerId: 'foreign-home', activeMachines: [],
                machineListByServerId: { [identity]: [fresh], [profile.id]: [stale] },
                machineListStatusByServerId: { [identity]: 'loading' as const, [profile.id]: 'idle' as const } };
            expect(resolveServerScopedMachines(context)).toEqual([fresh]);
            expect(resolveExactServerScopedMachine({ ...context, machineId: fresh.id })).toBe(fresh);
        }
    });

    it('retains scoped rows after a failed reread instead of the active display fallback', () => {
        const retained = createMachine('machine-retained', 200);
        const other = createMachine('machine-other', 200);
        const stale = createMachine(retained.id, 100);
        const scopedRows = [retained, other];
        for (const serverId of [identity, profile.id]) {
            const context = { serverId, activeServerId: profile.id, activeMachines: [stale],
                machineListByServerId: { [identity]: scopedRows },
                machineListStatusByServerId: { [identity]: 'error' as const } };
            expect(resolveServerScopedMachines(context)).toBe(scopedRows);
            expect(resolveExactServerScopedMachine({ ...context, machineId: other.id })).toBe(other);
        }
    });

    it('keeps canonical priority without list-status evidence instead of selecting a nonempty alias', () => {
        const machine = createMachine('machine-stale', 100);
        for (const serverId of [identity, profile.id]) {
            expect(resolveExactServerScopedMachine({
                machineId: machine.id, serverId, activeServerId: 'foreign-home', activeMachines: [],
                machineListByServerId: { [identity]: [], [profile.id]: [machine] },
            })).toBeNull();
        }
    });

    it('retains active hydration fallback for an unqualified empty scoped snapshot', () => {
        const machine = createMachine('machine-active', 100);
        expect(resolveServerScopedMachines({
            serverId: identity, activeServerId: profile.id, activeMachines: [machine],
            machineListByServerId: { [identity]: [] },
        })).toEqual([machine]);
    });

    it('preserves active fallback while canonical inventory is loading, but settled absence wins', () => {
        const machine = createMachine('machine-live', 100);
        for (const serverId of [identity, profile.id]) {
            const context = { machineId: machine.id, serverId, activeServerId: profile.id, activeMachines: [machine] };
            for (const loadingRows of [null, []]) {
                expect(resolveExactServerScopedMachine({ ...context,
                    machineListByServerId: { [identity]: loadingRows }, machineListStatusByServerId: { [identity]: 'loading' },
                })).toBe(machine);
            }
            expect(resolveExactServerScopedMachine({ ...context,
                machineListByServerId: { [identity]: [] }, machineListStatusByServerId: { [identity]: 'idle' },
            })).toBeNull();
        }
    });

    it('uses settled inventory to reject a portable target missing from the list despite a stale active row', () => {
        const stale = createMachine('machine-gone', 200);
        const other = createMachine('machine-other', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: stale.id },
            activeServerId: profile.id, activeMachines: [stale],
            machineListByServerId: { [identity]: [other] }, machineListStatusByServerId: { [identity]: 'idle' },
        })).toMatchObject({ kind: 'missingMachine' });
    });

    it('returns only the requested machine from the resolved server scope when machine ids repeat across servers', () => {
        const activeMachine = createMachine('machine-shared', 200);
        const remoteMachine = createMachine('machine-shared', 100);
        const context = { serverId: 'server-b', activeServerId: profile.id,
            activeMachines: [activeMachine], machineListByServerId: { 'server-b': [remoteMachine] } };
        expect(resolveExactServerScopedMachine({ ...context, machineId: 'machine-shared' })).toBe(remoteMachine);
        expect(resolveExactServerScopedMachine({ ...context, machineId: 'missing' })).toBeNull();
    });

    it('routes a portable administration target through this device local profile without falling back to an active duplicate machine id', () => {
        const activeDuplicate = createMachine('machine-shared', 200);
        const remoteDuplicate = createMachine('machine-shared', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: 'machine-shared' },
            activeServerId: 'foreign-home', activeMachines: [activeDuplicate],
            machineListByServerId: { [profile.id]: [remoteDuplicate] },
        })).toMatchObject({
            kind: 'resolved', target: { serverIdentityId: identity, machineId: 'machine-shared' },
            serverId: profile.id, profile: { id: profile.id, serverIdentityId: identity }, machine: remoteDuplicate,
        });
    });

    it('resolves a non-active portable target from the canonical identity cache key instead of falsely reporting it missing', () => {
        const exactMachine = createMachine('machine-b', 100);
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: exactMachine.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId: { [identity]: [exactMachine] },
        })).toMatchObject({ kind: 'resolved', serverId: profile.id, machine: exactMachine });
    });

    it('returns an exact revoked row to Administration instead of applying the visible-machine filter', () => {
        const revoked = { id: 'machine-revoked', activeAt: 50, revokedAt: 90 };
        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: identity, machineId: revoked.id },
            activeServerId: 'foreign-home', activeMachines: [], machineListByServerId: { [identity]: [revoked] },
        })).toMatchObject({ kind: 'resolved', machine: revoked });
    });
});
