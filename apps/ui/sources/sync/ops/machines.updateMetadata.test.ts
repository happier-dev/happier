import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

const emitWithAckMock = vi.hoisted(() => vi.fn());
const getMachineEncryptionMock = vi.hoisted(() => vi.fn());
const encryptRawMock = vi.hoisted(() => vi.fn());
const getSyncSingletonMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        emitWithAck: (...args: any[]) => emitWithAckMock(...args),
        machineRPC: vi.fn(),
    },
}));

vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getMachineEncryption: (machineId: string) => getMachineEncryptionMock(machineId),
        },
    },
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: getSyncSingletonMock,
}));

const initialStorageState = storage.getInitialState();

function buildMachine(params: Readonly<{ id: string; metadataVersion: number; metadata: MachineMetadata | null }>): Machine {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        revokedAt: null,
        metadata: params.metadata,
        metadataVersion: params.metadataVersion,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

const machinesModulePromise = import('./machines');

function findTelemetryEvent(name: string) {
    return syncPerformanceTelemetry.snapshot().events.find((event) => event.name === name);
}

describe('machineUpdateMetadata', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        emitWithAckMock.mockReset();
        getMachineEncryptionMock.mockReset();
        encryptRawMock.mockReset();
        getSyncSingletonMock.mockReset();

        getSyncSingletonMock.mockReturnValue({
            encryption: {
                getMachineEncryption: (machineId: string) => getMachineEncryptionMock(machineId),
            },
        });
        getMachineEncryptionMock.mockReturnValue({
            encryptRaw: (...args: any[]) => encryptRawMock(...args),
            decryptRaw: vi.fn(),
        });
        encryptRawMock.mockResolvedValue('enc_local');
    });

    afterEach(() => {
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
    });

    it('applies the updated metadata locally on success', async () => {
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 1_000_000,
        });
        syncPerformanceTelemetry.reset();

        storage.getState().applyMachines([buildMachine({
            id: 'm1',
            metadataVersion: 1,
            metadata: { host: 'h1' } as any,
        })]);

        emitWithAckMock.mockResolvedValueOnce({
            result: 'success',
            version: 2,
            metadata: 'enc_server',
        });

        const { machineUpdateMetadata } = await machinesModulePromise;
        const updatedMetadata: MachineMetadata = { host: 'h1', displayName: 'New Name' } as any;
        const res = await machineUpdateMetadata('m1', updatedMetadata, 1);

        expect(res).toEqual({ version: 2, metadata: 'enc_server' });
        expect(getSyncSingletonMock).toHaveBeenCalledTimes(1);
        expect(emitWithAckMock).toHaveBeenCalledWith('machine-update-metadata', {
            machineId: 'm1',
            metadata: 'enc_local',
            expectedVersion: 1,
        });

        const updated = storage.getState().machines['m1'];
        expect(updated?.metadataVersion).toBe(2);
        expect((updated?.metadata as any)?.displayName).toBe('New Name');
        expect(findTelemetryEvent('sync.encryption.machine.encryptRaw.metadataWrite')).toMatchObject({
            count: 1,
            fields: { items: 1 },
        });
    });
});
