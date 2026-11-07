import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptHomeProfile, removeServerProfile, setActiveServerId, upsertServerProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';

const {
    advanceMachineAdministrationSelectionRevision,
    resolveFreshMachineAdministrationExecutionTarget,
    doesMachineAdministrationTargetMatchActiveAccount,
} = await import('./useTargetSelection');

type TestMachine = ReturnType<typeof createMachineFixture>;

let profileA: ServerProfile;
let profileB: ServerProfile;
let previousState: ReturnType<typeof storage.getState>;
let previousServerId: string;
beforeEach(async () => {
    await selectActiveTestHomeForTests();
    previousState = storage.getState();
    previousServerId = getActiveServerSnapshot().serverId;
    profileA = await upsertServerProfile({ serverUrl: 'https://administration-inventory-other.example.test' });
    const url = 'https://administration-inventory-owner.example.test';
    profileB = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_server_b', canonicalServerUrl: url,
        revision: 1, endpoints: [{ kind: 'https', url }],
    }, source: 'manual' });
    expect(profileB.id).not.toBe('srv_server_b');
    await setActiveServerId(profileA.id);
});

afterEach(async () => {
    storage.setState(previousState, true);
    await setActiveServerId(previousServerId);
    await removeServerProfile(profileA.id);
    await removeServerProfile(profileB.id);
});

function machine(id: string, active: boolean): TestMachine {
    return createMachineFixture({
        id,
        createdAt: 1,
        updatedAt: 100,
        active,
        activeAt: active ? Date.now() : 0,
        revokedAt: null,
    });
}

describe('machine administration selection revision', () => {
    it('advances monotonically across A-to-B-to-A', async () => {
        const targetA = { serverIdentityId: 'server-a', machineId: 'machine-a' };
        const targetB = { serverIdentityId: 'server-b', machineId: 'machine-b' };
        const initial = { selectionKey: 'relay', target: targetA, revision: 0 };
        const selectedB = advanceMachineAdministrationSelectionRevision(initial, 'relay', targetB);
        const selectedAAgain = advanceMachineAdministrationSelectionRevision(selectedB, 'relay', targetA);

        expect(selectedB.revision).toBe(1);
        expect(selectedAAgain.revision).toBe(2);
    });
});

describe('resolveFreshMachineAdministrationExecutionTarget', () => {
    beforeEach(() => {
        storage.setState({
            isDataReady: true,
            machines: { duplicate: machine('machine-b', true) },
            machineListByServerId: {
                'srv_server_b': [machine('machine-b', true)],
            },
            machineListStatusByServerId: { 'srv_server_b': 'idle' },
            settings: {
                ...storage.getState().settings,
                machineAdministrationTargetsLocalV1: {},
            },
        });
    });

    it('resolves only the exact fresh non-active server row', async () => {

        const result = resolveFreshMachineAdministrationExecutionTarget({
            serverIdentityId: 'srv_server_b',
            machineId: 'machine-b',
        }, { accountScope: { serverId: profileB.id, accountId: 'account-b' } });

        expect(result).toEqual(expect.objectContaining({
            kind: 'resolved',
            serverId: profileB.id,
            machine: storage.getState().machineListByServerId['srv_server_b']![0],
        }));
    });

    it('fails closed when the exact row is stale, offline, or replaced', async () => {
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-b' };

        storage.setState({ machineListStatusByServerId: { 'srv_server_b': 'signedOut' } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: { serverId: profileB.id, accountId: 'account-b' } })).toBeNull();
        // A failed list read never proves the admitted, presence-fresh row gone.
        storage.setState({ machineListStatusByServerId: { 'srv_server_b': 'error' } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: { serverId: profileB.id, accountId: 'account-b' } })).not.toBeNull();

        storage.setState({
            machineListStatusByServerId: { 'srv_server_b': 'idle' },
            machineListByServerId: { 'srv_server_b': [machine('machine-b', false)] },
        });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: { serverId: profileB.id, accountId: 'account-b' } })).toBeNull();

        storage.setState({ machineListByServerId: { 'srv_server_b': [{
            ...machine('machine-b', true), replacedByMachineId: 'machine-c',
        }] } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: { serverId: profileB.id, accountId: 'account-b' } })).toBeNull();
    });

    it('uses the admitted Home row during refresh instead of the active display copy', async () => {
        await setActiveServerId(profileB.id);
        const admitted = machine('machine-b', true);
        storage.setState({
            machines: { [admitted.id]: { ...admitted } },
            machineListByServerId: { 'srv_server_b': [admitted] },
            machineListStatusByServerId: { 'srv_server_b': 'loading' },
        });
        const target = { serverIdentityId: 'srv_server_b', machineId: admitted.id };
        const accountScope = { serverId: profileB.id, accountId: 'account-b' };
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })?.machine).toBe(admitted);
        expect(resolveFreshMachineAdministrationExecutionTarget(target, {
            accountScope: { ...accountScope, serverId: profileA.id },
        })).toBeNull();
        // The display copy cannot confer membership or override content admission.
        for (const rows of [[], [{ ...admitted, metadata: null }], [{ ...admitted, active: false, activeAt: 0 }]]) {
            storage.setState({ machineListByServerId: { 'srv_server_b': rows } });
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
        }
    });

    it('does not revive a retained scoped row when the Home is signed out and the active inventory is empty', async () => {
        await setActiveServerId(profileB.id);
        storage.setState({
            machines: {},
            machineListByServerId: { 'srv_server_b': [machine('machine-b', true)] },
            machineListStatusByServerId: { 'srv_server_b': 'signedOut' },
        });

        expect(resolveFreshMachineAdministrationExecutionTarget({
            serverIdentityId: 'srv_server_b',
            machineId: 'machine-b',
        }, { accountScope: { serverId: profileB.id, accountId: 'account-b' } })).toBeNull();
    });

    it('re-checks only the requested row while the inventory is unchanged, and still fails closed on presence or inventory changes', async () => {
        // Host currentness checks call this once per candidate on every context read.
        // Count the inventory rows each check reads, excluding the requested one.
        const touched = new Set<string>();
        const tracked = (row: TestMachine): TestMachine => new Proxy(row, {
            get(target, key, receiver) { touched.add(target.id); return Reflect.get(target, key, receiver); },
        });
        const rows = Array.from({ length: 60 }, (_, index) => tracked(machine(`machine-${index}`, true)));
        storage.setState({
            machines: Object.fromEntries(rows.map(row => [row.id, row])),
            machineListByServerId: { 'srv_server_b': rows },
            machineListStatusByServerId: { 'srv_server_b': 'idle' },
        });
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-7' };
        const accountScope = { serverId: profileB.id, accountId: 'account-b' };
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })?.machine).toBe(rows[7]);
        const otherRowsRead: number[] = [];
        for (let check = 0; check < 3; check += 1) {
            touched.clear();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })?.machine).toBe(rows[7]);
            otherRowsRead.push([...touched].filter(id => id !== target.machineId).length);
        }
        expect(otherRowsRead).toEqual([0, 0, 0]);

        // Presence lapses with no inventory publication: the same check refuses.
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        try {
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
        } finally {
            clock.mockRestore();
        }
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })?.machine).toBe(rows[7]);
        // A real inventory change re-resolves: the revoked row is refused, a new row is admitted.
        const revoked = { ...machine('machine-7', true), revokedAt: 5 };
        storage.setState({ machineListByServerId: { 'srv_server_b': rows.map((row, index) => index === 7 ? revoked : row) } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
        const replacement = machine('machine-7', true);
        storage.setState({ machineListByServerId: { 'srv_server_b': rows.map((row, index) => index === 7 ? replacement : row) } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })?.machine).toBe(replacement);
        // The list status withdrawing membership also re-resolves.
        storage.setState({ machineListStatusByServerId: { 'srv_server_b': 'signedOut' } });
        expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
    }, 180_000);
});

describe('doesMachineAdministrationTargetMatchActiveAccount', () => {
    it('uses real profile equivalence for portable and device-local identifiers', async () => {
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-b' };

        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: profileB.id,
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'srv_server_b',
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'local-a',
        })).toBe(false);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target: null,
            activeAccountServerId: profileB.id,
        })).toBe(false);
    });
});
