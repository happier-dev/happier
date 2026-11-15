import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveAllProfileMachineInventorySnapshots } from '../machineInventorySnapshots';
import { t } from '@/text';
import {
    captureMachinePresenceObservation,
    clearMachineRequestReachabilityForTest,
    recordMachineRequestFailed,
    withdrawMachinePresenceForScope,
} from '@/sync/domains/machines/reachability/machineReachability';
import { resolveMachineAdministrationTargetState } from './targetSelection';
import { publishMachineActivities } from '../machineActivity';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';

import {
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationCandidatesFromSnapshots,
} from './targetState';

function machine(input: Readonly<{
    id: string;
    active?: boolean;
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    locked?: boolean;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: input.active ?? false,
        activeAt: input.active ? 100 : 0,
        revokedAt: input.revokedAt ?? null,
        replacedByMachineId: input.replacedByMachineId ?? null,
        // Narrow owner fixture: the projection reads only displayName.
        metadata: { displayName: input.id } as Machine['metadata'],
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        ...(input.locked ? { availability: { kind: 'locked' as const, reason: 'decryption_failed' as const } } : {}),
    };
}

let profile: ServerProfile;
beforeEach(async () => {
    clearMachineRequestReachabilityForTest();
    const url = 'https://b.example.test';
    profile = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_server_b', canonicalServerUrl: url,
        revision: 1, endpoints: [{ kind: 'https', url }],
    }, source: 'manual', suggestedName: 'Server B' });
});

describe('snapshot Administration candidates', () => {
    it('retains unchanged rows across snapshot refreshes while publishing presence, disambiguation and Account changes', () => {
        const first = { ...machine({ id: 'aaaa-first', active: true }), metadata: { displayName: 'Studio' } as Machine['metadata'] };
        const second = { ...machine({ id: 'bbbb-second', active: true }), metadata: { displayName: 'Studio' } as Machine['metadata'] };
        const third = machine({ id: 'third', active: true });
        const snapshots = [{ kind: 'resolved', profileId: profile.id, accountId: 'account-b',
            serverIdentityId: profile.serverIdentityId!, serverName: 'Server B', observation: 'live',
            machines: [first, second, third] }] as const;
        const initial = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots, nowMs: 100 });
        recordMachineRequestFailed({ serverId: profile.serverIdentityId!, accountId: 'account-b', machineId: first.id, observedAtMs: 100 });
        const withdrawn = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [...snapshots], nowMs: 100,
            previous: { snapshots, rows: initial } });
        expect(withdrawn[0]?.candidate.availability).toBe('offline');
        expect(withdrawn[0]).not.toBe(initial[0]);
        expect(withdrawn[1]).toBe(initial[1]);
        expect(withdrawn[2]).toBe(initial[2]);

        const renamedSnapshots = [{ ...snapshots[0], machines: [{ ...first, metadata: { ...first.metadata!, displayName: 'Renamed' } }, second, third] }];
        const renamed = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: renamedSnapshots, nowMs: 100,
            previous: { snapshots, rows: withdrawn } });
        expect(renamed[1]?.candidate.displayNameParts).toEqual({ name: 'Studio', hint: null });
        expect(renamed[1]).not.toBe(withdrawn[1]);
        expect(renamed[2]).toBe(withdrawn[2]);
        expect(buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [...renamedSnapshots], nowMs: 100,
            previous: { snapshots: renamedSnapshots, rows: renamed } })).toBe(renamed);
        const otherAccount = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: renamedSnapshots.map(snapshot => ({ ...snapshot, accountId: 'another-account' })), nowMs: 100,
            previous: { snapshots: renamedSnapshots, rows: renamed } });
        expect(otherAccount[2]).not.toBe(renamed[2]);
    });

    it('does not read profile storage for empty inventories or locked-only rows', async () => {
        const { MMKV } = await import('react-native-mmkv');
        const reads = vi.spyOn(MMKV.prototype, 'getString');
        try {
            expect(buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [] })).toEqual([]);
            const read = (machines: readonly Machine[]) => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
                snapshots: [{ kind: 'resolved', profileId: profile.id, accountId: 'account-b',
                    serverIdentityId: profile.serverIdentityId!, serverName: 'Server B', observation: 'live', machines }],
            });
            expect(read([])).toEqual([]);
            expect(read([machine({ id: 'locked-only', locked: true })]).map(row => row.candidate.availability)).toEqual(['locked']);
            expect(reads.mock.calls.filter(([key]) => key === 'server-state-v1')).toHaveLength(0);
        } finally { reads.mockRestore(); }
    });
    it('reads profile identity once for the full candidate inventory without retaining reachability', async () => {
        const { MMKV } = await import('react-native-mmkv');
        const machines = Array.from({ length: 138 }, (_, index) => machine({ id: `bulk-candidate-${index}`, active: true }));
        publishMachineActivityForTest(machines);
        const read = (rows: readonly Machine[]) => buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{ kind: 'resolved', profileId: profile.id, accountId: 'account-b',
                serverIdentityId: profile.serverIdentityId!, serverName: 'Server B', observation: 'live', machines: rows }],
            nowMs: 100,
        });
        // Count only persisted profile reads through the native storage boundary.
        const reads = vi.spyOn(MMKV.prototype, 'getString');
        try {
            expect(read(machines.slice(0, 1)).map(row => row.candidate.availability)).toEqual(['online']);
            const oneMachineReads = reads.mock.calls.filter(([key]) => key === 'server-state-v1').length;
            reads.mockClear();
            const candidates = read(machines);
            expect(candidates).toHaveLength(138);
            expect(candidates.every(row => row.candidate.availability === 'online')).toBe(true);
            expect(candidates.map(row => row.machine.id).sort()).toEqual(machines.map(row => row.id).sort());
            const fleetReads = reads.mock.calls.filter(([key]) => key === 'server-state-v1').length;
            expect({ oneMachineReads, fleetReads }).toEqual({ oneMachineReads: 1, fleetReads: 1 });
            recordMachineRequestFailed({ serverId: profile.serverIdentityId!, accountId: 'account-b', machineId: machines[0]!.id, observedAtMs: 100 });
            reads.mockClear();
            const next = read(machines);
            expect(next.find(row => row.machine.id === machines[0]!.id)?.candidate.availability).toBe('offline');
            expect(next.filter(row => row.candidate.availability === 'online')).toHaveLength(137);
            expect(reads.mock.calls.filter(([key]) => key === 'server-state-v1')).toHaveLength(1);
        } finally { reads.mockRestore(); }
    });
    it('uses the canonical inventory names in snapshot candidate projections', () => {
        const machines = [
            { ...machine({ id: 'aaaa-machine' }), metadata: { ...machine({ id: 'aaaa-machine' }).metadata!, displayName: 'Studio' } },
            { ...machine({ id: 'bbbb-machine' }), metadata: { ...machine({ id: 'bbbb-machine' }).metadata!, displayName: 'Studio' } },
            machine({ id: 'locked-machine', locked: true }),
            { ...machine({ id: 'unnamed-machine' }), metadata: null, availability: { kind: 'available' as const } },
        ];
        const snapshots = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots: [{
            kind: 'resolved', profileId: profile.id, accountId: 'account-b', serverIdentityId: profile.serverIdentityId!, serverName: 'Server B',
            observation: 'live', machines,
        }], nowMs: 100 });
        expect(snapshots.map(row => row.candidate.displayName)).toEqual([
            'Studio · aaaa', 'Studio · bbbb', t('machine.lockedMachine'), t('machine.unnamedMachine'),
        ]);
        // The two parts a one-line chip needs: the name may shorten, the telling suffix is what separates the twins.
        expect(snapshots.map(row => row.candidate.displayNameParts)).toEqual([
            { name: 'Studio', hint: 'aaaa' }, { name: 'Studio', hint: 'bbbb' },
            { name: t('machine.lockedMachine'), hint: null }, { name: t('machine.unnamedMachine'), hint: null },
        ]);
    });
    it('projects a failed server-scoped request as unreachable despite fresh pushed presence', () => {
        recordMachineRequestFailed({ serverId: 'srv_server_b', accountId: 'account-b', machineId: 'machine-b', observedAtMs: 100 });

        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
                accountId: 'account-b',
                serverIdentityId: 'srv_server_b',
                serverName: 'Server B',
                observation: 'live',
                machines: [machine({ id: 'machine-b', active: true })],
            }],
            nowMs: 100,
        });

        expect(rows[0]?.candidate.availability).toBe('offline');
    });
    it('keeps the selected Machine online through transport withdrawal and a fresh observation', () => {
        const scope = { serverId: profile.serverIdentityId!, accountId: 'account-b' };
        const selectedMachine = machine({ id: 'machine-b', active: true });
        publishMachineActivityForTest([selectedMachine]);
        const readCandidate = () => buildMachineAdministrationCandidatesFromSnapshots({
            snapshots: [{ kind: 'resolved', profileId: profile.id, accountId: scope.accountId,
                serverIdentityId: scope.serverId, serverName: 'Server B', observation: 'live', machines: [selectedMachine] }],
            nowMs: 100,
        })[0]!;
        const initial = readCandidate();
        expect(initial.availability).toBe('online');

        withdrawMachinePresenceForScope(scope);
        const withdrawn = readCandidate();
        expect(withdrawn.availability).toBe('online');
        expect(resolveMachineAdministrationTargetState({ storedTarget: initial.target, candidates: [withdrawn] }))
            .toEqual({ kind: 'online', target: initial.target, machine: withdrawn });
        expect(resolveMachineAdministrationTargetState({ storedTarget: null, candidates: [withdrawn] }))
            .toEqual({ kind: 'online', target: withdrawn.target, machine: withdrawn });

        captureMachinePresenceObservation(scope)([selectedMachine.id]);
        const restored = readCandidate();
        expect(resolveMachineAdministrationTargetState({ storedTarget: initial.target, candidates: [restored] }))
            .toEqual({ kind: 'online', target: initial.target, machine: restored });
    });

    it('keeps routing and tombstone facts from the canonical snapshot producer', () => {
        const machines = [
            machine({ id: 'online', active: true }),
            machine({ id: 'offline' }),
            machine({ id: 'revoked', revokedAt: 30 }),
            machine({ id: 'replaced', replacedByMachineId: 'replacement' }),
            machine({ id: 'locked', active: true, locked: true }),
        ];
        publishMachineActivities(machines.map(machine => ({ machine, activity: machine, projections: [] })));
        const snapshots = resolveAllProfileMachineInventorySnapshots({
            profiles: [profile], activeServerId: 'local-profile-a', activeMachines: [],
            machineListByServerId: { [profile.serverIdentityId!]: machines },
            machineListStatusByServerId: { [profile.serverIdentityId!]: 'idle' },
            accountScopesByServerId: new Map([[profile.serverIdentityId!, {
                serverId: profile.serverIdentityId!, accountId: 'account-b',
            }]]),
            loadWarmEntries: () => ({}),
        });
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({ snapshots, nowMs: 100 });
        const candidates = buildMachineAdministrationCandidatesFromSnapshots({ snapshots, nowMs: 100 });
        expect(candidates).toEqual(rows.map(row => row.candidate));
        expect(candidates.map(candidate => [candidate.target.machineId, candidate.availability])).toEqual([
            ['locked', 'locked'], ['offline', 'offline'], ['online', 'online'],
            ['replaced', 'replaced'], ['revoked', 'revoked'],
        ]);
        expect(rows.every(row => row.serverId === profile.id
            && row.serverName === 'Server B'
            && row.candidate.target.serverIdentityId === 'srv_server_b'
            && row.machine.id === row.candidate.target.machineId)).toBe(true);
    });

    it('projects stale all-profile snapshots as non-authoritative tombstones with exact replacement identity', () => {
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
                accountId: 'account-b',
                serverIdentityId: 'srv_server_b',
                serverName: 'Server B',
                observation: 'stale',
                machines: [{
                    id: 'machine-old',
                    updatedAt: 50,
                    active: true,
                    activeAt: 50,
                    revokedAt: null,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 51,
                    metadataVersion: 1,
                    metadata: { displayName: 'Old machine' },
                }],
            }],
            nowMs: 50,
        });

        expect(rows).toEqual([expect.objectContaining({
            candidate: {
                target: { serverIdentityId: 'srv_server_b', machineId: 'machine-old' },
                displayName: 'Old machine',
                displayNameParts: { name: 'Old machine', hint: null },
                serverLabel: 'Server B',
                availability: 'replaced',
                observation: 'stale',
                observedAt: 50,
                replacementTarget: { serverIdentityId: 'srv_server_b', machineId: 'machine-new' },
            },
            serverId: 'local-profile-b',
        })]);
    });
});
