import { describe, expect, it } from 'vitest';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { canAttemptMachineSpawn, resolveMachineSpawnReadiness } from './resolveMachineSpawnReadiness';

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
    it('does not treat broad online state as spawn-ready when exact probe state is required', () => {
        expect(resolveMachineSpawnReadiness({
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            requireExactSpawnReadiness: true,
        })).toEqual({
            status: 'unknown',
            machineId: 'machine-1',
        });
    });

    it('returns ready for exact spawn semantics only when rpc and key probes are known ready', () => {
        expect(resolveMachineSpawnReadiness({
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            requireExactSpawnReadiness: true,
            rpcAvailable: true,
            keyAvailable: true,
        })).toEqual({
            status: 'ready',
            machineId: 'machine-1',
        });
    });

    it('allows an online machine attempt while exact readiness is unknown or probing', () => {
        expect(canAttemptMachineSpawn({ selectedMachineId: 'machine-1', machine: onlineMachine })).toBe(true);
        expect(canAttemptMachineSpawn({
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            spawnReadiness: { status: 'probing', machineId: 'machine-1' },
        })).toBe(true);
    });

    it('rejects an attempt when the owner has established that the target is unavailable', () => {
        expect(canAttemptMachineSpawn({
            selectedMachineId: 'machine-1',
            machine: onlineMachine,
            spawnReadiness: { status: 'rpcUnavailable', machineId: 'machine-1' },
        })).toBe(false);
        expect(canAttemptMachineSpawn({
            selectedMachineId: 'machine-1',
            machine: { ...onlineMachine, active: false, activeAt: 0 },
        })).toBe(false);
    });
});
