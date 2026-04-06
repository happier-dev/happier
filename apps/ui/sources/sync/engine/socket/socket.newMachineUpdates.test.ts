import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import * as executionRunActivityBus from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { flushMachineActivityUpdates, handleEphemeralSocketUpdate, handleUpdateContainer } from './socket';

const initialStorageState = storage.getState();

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    const decryptEncryptionKey = vi.fn(async () => null as Uint8Array | null);
    const initializeMachines = vi.fn(async (_machineKeysMap: Map<string, Uint8Array | null>) => {});
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

function buildEphemeralParams(overrides: Partial<Parameters<typeof handleEphemeralSocketUpdate>[0]> = {}): Parameters<typeof handleEphemeralSocketUpdate>[0] {
    return {
        update: null,
        addActivityUpdate: () => {},
        addMachineActivityUpdate: () => {},
        getSessionEncryption: () => null,
        getSession: () => undefined,
        applyMessages: () => {},
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
        const initializeMachines = vi.fn(async (_machineKeysMap: Map<string, Uint8Array | null>) => {});
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

    it('falls back to the legacy machine encryption path when decrypting the data encryption key fails', async () => {
        const invalidateMachines = vi.fn();
        const decryptEncryptionKey = vi.fn(async () => {
            throw new Error('bad envelope');
        });
        const initializeMachines = vi.fn(async (_machineKeysMap: Map<string, Uint8Array | null>) => {});
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
            id: 'u_machine_3',
            seq: 44,
            createdAt: 125,
            body: {
                t: 'new-machine',
                machineId: 'm3',
                seq: 9,
                metadata: 'AA==',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: 'broken-envelope',
                active: true,
                activeAt: 122,
                createdAt: 102,
                updatedAt: 112,
            },
        } as ApiUpdateContainer;

        await expect(handleUpdateContainer({ ...params, updateData })).resolves.toBeUndefined();

        expect(decryptEncryptionKey).toHaveBeenCalledTimes(1);
        expect(initializeMachines).toHaveBeenCalledTimes(1);
        expect(initializeMachines.mock.calls[0]?.[0]).toEqual(new Map([['m3', null]]));
        expect(invalidateMachines).toHaveBeenCalledTimes(1);

        const machine = storage.getState().machines['m3'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(122);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });
});

describe('socket update handling: update-machine (missing encryption)', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('still applies freshness fields before invalidating machines sync', async () => {
        const invalidateMachines = vi.fn();
        const params = buildBaseParams({ invalidateMachines });

        const updateData: ApiUpdateContainer = {
            id: 'u_machine_up_1',
            seq: 99,
            createdAt: 200,
            body: {
                t: 'update-machine',
                machineId: 'm_missing_enc',
                active: true,
                activeAt: 200,
                metadata: { version: 2, value: 'cipher' },
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData });

        expect(invalidateMachines).toHaveBeenCalledTimes(1);
        const machine = storage.getState().machines['m_missing_enc'] as Machine | undefined;
        expect(machine).toBeTruthy();
        expect(machine?.active).toBe(true);
        expect(machine?.activeAt).toBe(200);
        expect(machine?.metadata).toBeNull();
        expect(machine?.daemonState).toBeNull();
    });
});

describe('socket update handling: machine-activity for unknown machine', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
    });

    it('routes update to addMachineActivityUpdate callback without directly writing to storage', () => {
        const addMachineActivityUpdate = vi.fn();
        expect(storage.getState().machines['m_unknown']).toBeUndefined();

        handleEphemeralSocketUpdate(buildEphemeralParams({
            update: { type: 'machine-activity', id: 'm_unknown', active: true, activeAt: 999 },
            addActivityUpdate: () => {},
            addMachineActivityUpdate,
        }));

        expect(addMachineActivityUpdate).toHaveBeenCalledWith({ id: 'm_unknown', active: true, activeAt: 999 });
        expect(storage.getState().machines['m_unknown']).toBeUndefined();
    });
});

describe('socket update handling: execution-run-updated ephemerals', () => {
    it('notifies execution run activity so polling can recheck quickly', () => {
        const listener = vi.fn();
        const unsubscribe = executionRunActivityBus.subscribeExecutionRunActivity('s1', listener);

        handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'execution-run-updated',
                sessionId: 's1',
                run: {
                    runId: 'run_1',
                    callId: 'call_1',
                    sidechainId: 'call_1',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    status: 'running',
                    startedAtMs: 123,
                },
            },
            addActivityUpdate: () => {},
            addMachineActivityUpdate: () => {},
        }));

        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});

describe('socket update handling: transcript-stream-segment ephemerals', () => {
    it('normalizes and applies live transcript stream snapshots', async () => {
        const applyMessages = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'transcript-stream-segment',
                sessionId: 's1',
                message: {
                    localId: 'segment-1',
                    content: {
                        t: 'plain',
                        v: {
                            role: 'agent',
                            content: {
                                type: 'acp',
                                provider: 'codex',
                                data: { type: 'message', message: 'Hello there' },
                            },
                            meta: {
                                happierStreamSegmentV1: {
                                    v: 1,
                                    segmentKind: 'assistant',
                                    segmentLocalId: 'segment-1',
                                    segmentState: 'streaming',
                                    startedAtMs: 1_000,
                                    updatedAtMs: 1_025,
                                },
                            },
                        },
                    },
                    createdAt: 1_000,
                    updatedAt: 1_025,
                },
            },
            getSession: () => ({ id: 's1', encryptionMode: 'plain' } as any),
            applyMessages,
        }));

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledWith(
            's1',
            [
                expect.objectContaining({
                    id: 'segment-1',
                    localId: 'segment-1',
                    role: 'agent',
                    content: [expect.objectContaining({ type: 'text', text: 'Hello there' })],
                }),
            ],
        );
    });
});

describe('socket update handling: direct-session transcript delta ephemerals', () => {
    it('forwards only the canonical direct-session transcript delta update', async () => {
        const updateDirectSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'direct-session-transcript-delta',
                sessionId: 's1',
                items: [
                    {
                        id: 'direct-msg-1',
                        createdAtMs: 1,
                        raw: { role: 'user', content: { type: 'text', text: 'hello direct' } },
                    },
                ],
                nextCursor: 'tail-1',
                truncated: false,
            },
            updateDirectSessionTranscript,
        }));

        expect(updateDirectSessionTranscript).toHaveBeenCalledTimes(1);
        expect(updateDirectSessionTranscript).toHaveBeenCalledWith(expect.objectContaining({
            type: 'direct-session-transcript-delta',
            sessionId: 's1',
            nextCursor: 'tail-1',
        }));
    });

    it('ignores stale legacy direct-session transcript ephemeral names', async () => {
        const updateDirectSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'direct-session-transcript-updated',
                sessionId: 's1',
                items: [],
            },
            updateDirectSessionTranscript,
        }));

        expect(updateDirectSessionTranscript).not.toHaveBeenCalled();
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
