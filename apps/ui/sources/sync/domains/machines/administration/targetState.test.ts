import { describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => left === right,
}));

import {
    buildMachineAdministrationCandidateInventoryRows,
    buildMachineAdministrationCandidateInventoryRowsFromSnapshots,
    buildMachineAdministrationCandidates,
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

const profile = {
    id: 'local-profile-b',
    name: 'Server B',
    serverUrl: 'https://b.example.test',
    serverIdentityId: 'srv_server_b',
    legacyServerIds: ['legacy-b'],
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
};

describe('buildMachineAdministrationCandidates', () => {
    it('keeps the device-local routing row attached to its portable candidate without exposing it as preference data', () => {
        const rawMachine = machine({ id: 'machine-b', active: true });

        expect(buildMachineAdministrationCandidateInventoryRows({
            profiles: [profile],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [rawMachine],
            },
            nowMs: 100,
        })).toEqual([{
            candidate: expect.objectContaining({
                target: {
                    serverIdentityId: 'srv_server_b',
                    machineId: 'machine-b',
                },
            }),
            serverId: 'local-profile-b',
            serverName: 'Server B',
            machine: rawMachine,
        }]);
    });

    it('uses raw canonical-scope inventory and retains revoked, replaced, offline, and locked facts', () => {
        const candidates = buildMachineAdministrationCandidates({
            profiles: [profile],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [
                    machine({ id: 'online', active: true }),
                    machine({ id: 'offline' }),
                    machine({ id: 'revoked', revokedAt: 30 }),
                    machine({ id: 'replaced', replacedByMachineId: 'replacement' }),
                    machine({ id: 'locked', active: true, locked: true }),
                ],
            },
            nowMs: 100,
        });

        expect(candidates.map((candidate) => [candidate.target.machineId, candidate.availability])).toEqual([
            ['locked', 'locked'],
            ['offline', 'offline'],
            ['online', 'online'],
            ['replaced', 'replaced'],
            ['revoked', 'revoked'],
        ]);
        expect(candidates.every((candidate) => candidate.target.serverIdentityId === 'srv_server_b')).toBe(true);
    });

    it('never promotes a device-local profile without canonical server identity into Account candidates', () => {
        expect(buildMachineAdministrationCandidates({
            profiles: [{ ...profile, id: 'local-only', serverIdentityId: null }],
            activeServerId: 'local-only',
            activeMachineRecords: [machine({ id: 'machine-a', active: true })],
            machineRecordListsByServerId: {},
            nowMs: 100,
        })).toEqual([]);
    });

    it('does not project an ambiguous portable identity or merge duplicate machine ids across servers', () => {
        const otherProfile = {
            ...profile,
            id: 'local-profile-c',
            name: 'Server C',
            serverIdentityId: 'srv_server_c',
            legacyServerIds: [],
        };
        const candidates = buildMachineAdministrationCandidates({
            profiles: [profile, { ...profile, id: 'local-profile-b-duplicate' }, otherProfile],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [machine({ id: 'machine-shared', active: true })],
                srv_server_c: [machine({ id: 'machine-shared', active: true })],
            },
            nowMs: 100,
        });

        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.target).toEqual({
            serverIdentityId: 'srv_server_c',
            machineId: 'machine-shared',
        });
    });

    it('treats a canonical identity claimed by another profile legacy alias as ambiguous', () => {
        const candidates = buildMachineAdministrationCandidates({
            profiles: [
                profile,
                {
                    ...profile,
                    id: 'local-profile-c',
                    name: 'Server C',
                    serverIdentityId: 'srv_server_c',
                    legacyServerIds: ['srv_server_b'],
                },
            ],
            activeServerId: 'local-profile-a',
            activeMachineRecords: [],
            machineRecordListsByServerId: {
                srv_server_b: [machine({ id: 'machine-b', active: true })],
                srv_server_c: [machine({ id: 'machine-c', active: true })],
            },
            nowMs: 100,
        });

        expect(candidates.map((candidate) => candidate.target.serverIdentityId)).toEqual(['srv_server_c']);
    });

    it('projects stale all-profile snapshots as non-authoritative tombstones with exact replacement identity', () => {
        const rows = buildMachineAdministrationCandidateInventoryRowsFromSnapshots({
            snapshots: [{
                kind: 'resolved',
                profileId: 'local-profile-b',
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
