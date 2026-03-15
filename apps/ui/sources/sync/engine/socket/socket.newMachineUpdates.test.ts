import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { flushMachineActivityUpdates, handleEphemeralSocketUpdate, handleUpdateContainer } from './socket';

const initialStorageState = storage.getState();

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    const decryptEncryptionKey = vi.fn(async () => null as Uint8Array | null);
    const initializeMachines = vi.fn(async () => {});
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
            decryptEncryptionKey,
            initializeMachines,
        } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        artifactDataKeys: new Map<string, Uint8Array>(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket update handling: new-machine', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('applies a placeholder machine and invalidates machines sync', async () => {
        const invalidateMachines = vi.fn();
        const params = buildBaseParams({ invalidateMachines });
        const updateData: ApiUpdateContainer = {
            id: 'u_machine_1',
            seq: 42,
            createdAt: 123,
            body: {
                t: 'new-machine',
                machineId: 'm1',
                seq: 7,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: false,
                activeAt: 120,
                createdAt: 100,
                updatedAt: 110,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(invalidateMachines).toHaveBeenCalledTimes(1);

        const machine = storage.getState().machines['m1'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(false);
        expect(machine?.activeAt).toBe(120);
        expect(machine?.seq).toBe(7);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });

    it('initializes machine encryption when a data encryption key is present', async () => {
        const invalidateMachines = vi.fn();
        const decryptEncryptionKey = vi.fn(async () => new Uint8Array([1, 2, 3]));
        const initializeMachines = vi.fn(async () => {});
        const params = buildBaseParams({
            invalidateMachines,
            encryption: {
                getSessionEncryption: () => null,
                getMachineEncryption: () => null,
                removeSessionEncryption: () => {},
                decryptEncryptionKey,
                initializeMachines,
            } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_2',
            seq: 43,
            createdAt: 124,
            body: {
                t: 'new-machine',
                machineId: 'm2',
                seq: 8,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: 'base64-envelope',
                active: true,
                activeAt: 121,
                createdAt: 101,
                updatedAt: 111,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(initializeMachines).toHaveBeenCalledTimes(1);
        expect(invalidateMachines).toHaveBeenCalledTimes(1);
    });
});

describe('socket update handling: update-machine (missing encryption)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('invalidates machines sync instead of attempting to decrypt', async () => {
        const invalidateMachines = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const params = buildBaseParams({ invalidateMachines });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_up_1',
            seq: 99,
            createdAt: 200,
            body: {
                t: 'update-machine',
                machineId: 'm_missing_enc',
                metadata: { version: 2, value: 'cipher' },
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(invalidateMachines).toHaveBeenCalledTimes(1);
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});

describe('socket update handling: machine-activity for unknown machine', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('routes update to addMachineActivityUpdate callback without directly writing to storage', () => {
        const addMachineActivityUpdate = vi.fn();
        expect(storage.getState().machines['m_unknown']).toBeUndefined();

        handleEphemeralSocketUpdate({
            update: { type: 'machine-activity', id: 'm_unknown', active: true, activeAt: 999 },
            addActivityUpdate: () => {},
            addMachineActivityUpdate,
        });

        expect(addMachineActivityUpdate).toHaveBeenCalledWith({ id: 'm_unknown', active: true, activeAt: 999 });
        expect(storage.getState().machines['m_unknown']).toBeUndefined();
    });
});

describe('flushMachineActivityUpdates', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('applies a placeholder machine so active status is not dropped', () => {
        const updates = new Map<string, { id: string; active: boolean; activeAt: number }>([
            ['m_unknown', { id: 'm_unknown', active: true, activeAt: 999 }],
        ]);
        const applyMachines = vi.fn((machines: Machine[]) => storage.getState().applyMachines(machines));

        flushMachineActivityUpdates({ updates, applyMachines });

        expect(applyMachines).toHaveBeenCalledTimes(1);
        const machine = storage.getState().machines['m_unknown'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(999);
    });
});
