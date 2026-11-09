import { describe, expect, it } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { canAttemptMachineSpawn, resolveMachineSpawnReadiness } from './resolveMachineSpawnReadiness';
import { recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';

const scope = { serverId: 'readiness-home', accountId: 'readiness-account' };
const onlineMachine: Machine = {
    id: 'machine-1',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: Date.now(),
    metadata: {
        host: 'machine-1.local',
        platform: 'darwin',
        happyCliVersion: '1.0.0',
        happyHomeDir: '/Users/test/.happier',
        homeDir: '/Users/test',
    },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    revokedAt: null,
};

describe('resolveMachineSpawnReadiness', () => {
    it('uses current roster reachability after an offline readiness snapshot, retaining exact probe refusals', () => {
        const machine = { ...onlineMachine, activeAt: Date.now() };
        expect(resolveMachinePickerPresence(machine, undefined, scope)).toEqual({ status: 'online', selectable: true });
        expect(canAttemptMachineSpawn({ scope, selectedMachineId: machine.id, machine,
            spawnReadiness: { status: 'offline', machineId: machine.id } })).toBe(true);
        expect(canAttemptMachineSpawn({ scope, selectedMachineId: machine.id, machine,
            spawnReadiness: { status: 'rpcUnavailable', machineId: machine.id } })).toBe(false);
        expect(canAttemptMachineSpawn({ scope, selectedMachineId: machine.id, machine,
            spawnReadiness: { status: 'keyUnavailable', machineId: machine.id } })).toBe(false);
    });
    it('does not admit a scoped failed machine from a fresh heartbeat', () => {
        const scope = { serverId: 'spawn-home', accountId: 'spawn-account' };
        recordMachineRequestFailed({ ...scope, machineId: onlineMachine.id });
        expect(resolveMachineSpawnReadiness({ selectedMachineId: onlineMachine.id, machine: onlineMachine, scope }))
            .toEqual({ status: 'offline', machineId: onlineMachine.id });
        expect(canAttemptMachineSpawn({ selectedMachineId: onlineMachine.id, machine: onlineMachine, scope,
            spawnReadiness: { status: 'unknown', machineId: onlineMachine.id } })).toBe(false);
        expect(canAttemptMachineSpawn({ selectedMachineId: onlineMachine.id, machine: onlineMachine, scope,
            spawnReadiness: { status: 'ready', machineId: onlineMachine.id } })).toBe(false);
        expect(canAttemptMachineSpawn({ selectedMachineId: onlineMachine.id, machine: onlineMachine, scope,
            machineReachable: true, spawnReadiness: { status: 'ready', machineId: onlineMachine.id } })).toBe(false);
    });
    it('keeps exact readiness unknown when probe evidence is absent', () => {
        expect(resolveMachineSpawnReadiness({
            scope,
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            requireExactSpawnReadiness: true,
        })).toEqual({ status: 'unknown', machineId: 'machine-1' });
    });

    it('distinguishes a reachable locked Machine from an offline Machine', () => {
        const lockedMachine = {
            ...onlineMachine,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } as const,
        };
        expect(resolveMachineSpawnReadiness({
            scope,
            selectedMachineId: lockedMachine.id,
            machine: lockedMachine,
            machineReachable: true,
        })).toEqual({ status: 'keyUnavailable', machineId: lockedMachine.id });
        expect(resolveMachineSpawnReadiness({
            scope,
            selectedMachineId: lockedMachine.id,
            machine: lockedMachine,
            machineReachable: false,
        })).toEqual({ status: 'offline', machineId: lockedMachine.id });
    });

    it('allows an online machine attempt while exact readiness is unknown', () => {
        expect(canAttemptMachineSpawn({
            scope,
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            spawnReadiness: { status: 'unknown', machineId: 'machine-1' },
        })).toBe(true);
    });

    it('rejects attempts that are structurally or exactly unavailable', () => {
        expect(resolveMachineSpawnReadiness({
            scope,
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            machineReachable: false,
        })).toEqual({ status: 'offline', machineId: 'machine-1' });
        expect(canAttemptMachineSpawn({
            scope,
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            machineReachable: false,
            spawnReadiness: { status: 'unknown', machineId: 'machine-1' },
        })).toBe(false);
        expect(canAttemptMachineSpawn({
            scope,
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            spawnReadiness: { status: 'rpcUnavailable', machineId: 'machine-1' },
        })).toBe(false);
        expect(canAttemptMachineSpawn({
            scope,
            selectedMachineId: 'machine-1',
            machine: { ...onlineMachine, active: false, activeAt: 0 },
        })).toBe(false);
    });
});
