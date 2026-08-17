import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    decodePlainMachineStoredContent,
} from '@happier-dev/protocol';

const emitWithAckMock = vi.hoisted(() => vi.fn());
const getMachineEncryptionMock = vi.hoisted(() => vi.fn());
const encryptRawMock = vi.hoisted(() => vi.fn());
const getSyncSingletonMock = vi.hoisted(() => vi.fn());
const getServerFeaturesSnapshotMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: getServerFeaturesSnapshotMock,
}));

const initialStorageState = storage.getInitialState();

function buildMachine(params: Readonly<{
    id: string;
    metadataVersion: number;
    metadata: MachineMetadata | null;
    storageMode?: 'plain' | 'e2ee';
}>): Machine {
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
        ...(params.storageMode ? { storageMode: params.storageMode } : {}),
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
        getServerFeaturesSnapshotMock.mockReset();
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    accountStoredContentCompatibility: {
                        v: 1,
                        minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        declarationTransport: 'http-header-and-socket-auth-v1',
                    },
                },
            },
        });

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

    it('writes plaintext Machine metadata without constructing or consulting Machine encryption', async () => {
        storage.getState().applyMachines([buildMachine({
            id: 'm-plain',
            metadataVersion: 4,
            metadata: { host: 'plain-host' } as any,
            storageMode: 'plain',
        })]);
        emitWithAckMock.mockResolvedValueOnce({
            result: 'success',
            version: 5,
            metadata: 'server-plain',
        });

        const { machineUpdateMetadata } = await machinesModulePromise;
        const nextMetadata: MachineMetadata = {
            host: 'plain-host',
            displayName: 'Plain Machine',
        } as any;
        await machineUpdateMetadata('m-plain', nextMetadata, 4);

        expect(getMachineEncryptionMock).not.toHaveBeenCalled();
        const sent = emitWithAckMock.mock.calls[0]?.[1];
        expect(sent).toMatchObject({
            machineId: 'm-plain',
            expectedVersion: 4,
        });
        expect(decodePlainMachineStoredContent(sent.metadata)).toEqual(nextMetadata);
    });

    it('preserves a typed stored-content upgrade requirement returned by the metadata socket operation', async () => {
        storage.getState().applyMachines([buildMachine({
            id: 'm-plain-upgrade',
            metadataVersion: 4,
            metadata: { host: 'plain-host' } as any,
            storageMode: 'plain',
        })]);
        emitWithAckMock.mockResolvedValueOnce({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });

        const { machineUpdateMetadata } = await machinesModulePromise;
        await expect(machineUpdateMetadata(
            'm-plain-upgrade',
            { host: 'plain-host', displayName: 'Plain Machine' } as any,
            4,
        )).rejects.toMatchObject({
            code: 'client-upgrade-required',
            retryable: false,
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });
    });

    it('refuses a plain Machine metadata marker update before socket emission on an old server snapshot', async () => {
        storage.getState().applyMachines([buildMachine({
            id: 'm-plain-old-server',
            metadataVersion: 4,
            metadata: { host: 'plain-host' } as any,
            storageMode: 'plain',
        })]);
        getServerFeaturesSnapshotMock.mockResolvedValue({
            status: 'ready',
            features: {
                capabilities: {
                    encryption: {
                        storagePolicy: 'optional',
                    },
                },
            },
        });

        const { machineUpdateMetadata } = await machinesModulePromise;
        await expect(machineUpdateMetadata(
            'm-plain-old-server',
            { host: 'plain-host', displayName: 'Do not send' } as any,
            4,
        )).rejects.toMatchObject({
            code: 'client-upgrade-required',
            retryable: false,
        });

        expect(emitWithAckMock).not.toHaveBeenCalled();
        expect(getMachineEncryptionMock).not.toHaveBeenCalled();
    });
});
