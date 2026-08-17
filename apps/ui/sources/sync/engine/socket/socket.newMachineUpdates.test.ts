import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import {
    markSessionSurfaceVisible,
    resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import * as executionRunActivityBus from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { resetTranscriptStreamSegmentAssemblyForTests } from '@/sync/engine/sessions/transcriptStreamSegmentAssembly';
import type { NormalizedMessage } from '@/sync/typesRaw';
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
        artifactDataKeys: new Map(),
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

function buildSession(sessionId: string, encryptionMode: 'e2ee' | 'plain' = 'plain'): Session {
    return {
        id: sessionId,
        seq: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        encryptionMode,
    };
}

function buildTranscriptStreamSegmentUpdate(sessionId: string, content: unknown, localId = 'segment-1') {
    return {
        type: 'transcript-stream-segment',
        sessionId,
        message: {
            localId,
            content,
            createdAt: 1_000,
            updatedAt: 1_010,
        },
    };
}

function buildPlainTranscriptStreamSegmentContent(text: string, localId = 'segment-1') {
    return {
        t: 'plain',
        v: buildRawTranscriptStreamSegmentRecord(text, localId),
    };
}

function buildRawTranscriptStreamSegmentRecord(text: string, localId = 'segment-1') {
    return {
        role: 'agent',
        content: {
            type: 'acp',
            agentId: 'codex',
            data: { type: 'message', message: text },
        },
        meta: {
            happierStreamSegmentV1: {
                v: 1,
                segmentKind: 'assistant',
                segmentLocalId: localId,
                segmentState: 'streaming',
                startedAtMs: 1_000,
                updatedAtMs: 1_010,
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffInput() {
    return {
        files: [],
        _happier: {
            sessionChangeScope: 'turn',
            workspaceMutationSignal: 'turn-change-set',
            turnId: 'turn-stream-1',
            sessionId: 'stream-session-1',
            provider: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            canonicalToolName: 'Diff',
            source: 'scm_checkpoint',
            confidence: 'exact',
            turnStatus: 'completed',
            seqRange: {
                startSeqInclusive: 1,
                endSeqInclusive: 1,
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffCallContent(callId: string) {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                    type: 'tool-call',
                    callId,
                    name: 'Diff',
                    input: JSON.stringify(buildEmptyCanonicalTurnDiffInput()),
                    id: `${callId}-call`,
                },
            },
        },
    };
}

function buildEmptyCanonicalTurnDiffResultContent(callId: string) {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: {
                type: 'acp',
                agentId: 'codex',
                data: {
                    type: 'tool-result',
                    callId,
                    output: JSON.stringify({ status: 'completed', files: [] }),
                    id: `${callId}-result`,
                },
            },
        },
    };
}

function enableTranscriptStreamingCoalescingForTest(): void {
    storage.setState((prev) => ({
        ...prev,
        settings: {
            ...prev.settings,
            transcriptStreamingCoalesceEnabled: true,
            transcriptStreamingCoalesceWindowMs: 50,
            transcriptStreamingCoalesceMaxBatchSize: 1_000,
        },
    }));
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
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        storage.setState((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: false,
            },
        }));
        resetSessionSurfaceVisibilityForTests();
    });

    afterEach(() => {
        resetSessionSurfaceVisibilityForTests();
        vi.useRealTimers();
    });

    it('normalizes and applies live transcript stream snapshots', async () => {
        const applyMessages = vi.fn();
        markSessionSurfaceVisible('s1');

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
                                agentId: 'codex',
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

    it('applies transcript stream segment deltas by reconstructing text for live-consumed sessions', async () => {
        resetTranscriptStreamSegmentAssemblyForTests();
        const sessionId = 's-dispatch-delta';
        const applyMessages = vi.fn();
        markSessionSurfaceVisible(sessionId);
        const params = buildEphemeralParams({
            getSession: () => buildSession(sessionId, 'plain'),
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 1,
                    content: buildPlainTranscriptStreamSegmentContent('Hello'),
                    createdAt: 1_000,
                    updatedAt: 1_010,
                },
            },
        });
        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment-delta',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 2,
                    baseLength: 5,
                    content: buildPlainTranscriptStreamSegmentContent(' world'),
                    createdAt: 1_000,
                    updatedAt: 1_040,
                },
            },
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[1]?.[1]).toEqual([
            expect.objectContaining({
                localId: 'segment-1',
                content: [expect.objectContaining({ type: 'text', text: 'Hello world' })],
            }),
        ]);
        resetTranscriptStreamSegmentAssemblyForTests();
    });

    it('drops transcript stream segment deltas for sessions without a live transcript consumer', async () => {
        resetTranscriptStreamSegmentAssemblyForTests();
        vi.useFakeTimers();
        const sessionId = 's-dispatch-delta-hidden';
        const applyMessages = vi.fn();
        const params = buildEphemeralParams({
            getSession: () => buildSession(sessionId, 'plain'),
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...params,
            update: {
                type: 'transcript-stream-segment-delta',
                sessionId,
                message: {
                    localId: 'segment-1',
                    messageRole: 'agent',
                    tick: 2,
                    baseLength: 5,
                    content: buildPlainTranscriptStreamSegmentContent(' world'),
                    createdAt: 1_000,
                    updatedAt: 1_040,
                },
            },
        });

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
        resetTranscriptStreamSegmentAssemblyForTests();
    });

    it('shares empty canonical turn diff suppression across transcript stream segment updates', async () => {
        const sessionId = 'stream_empty_diff_session';
        const callId = 'stream-empty-diff-call';
        const applyMessages = vi.fn();
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildEmptyCanonicalTurnDiffCallContent(callId),
                'stream-empty-diff-call-message',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildEmptyCanonicalTurnDiffResultContent(callId),
                'stream-empty-diff-result-message',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops off-screen transcript stream segment applies when the coalescing window flushes while hidden', async () => {
        vi.useFakeTimers();
        const sessionId = 'offscreen_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('off-screen live', 'segment-offscreen'),
                'segment-offscreen',
            ),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops hidden encrypted transcript stream segments at flush time without decrypting', async () => {
        vi.useFakeTimers();
        const sessionId = 'hidden_encrypted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'e2ee')]);

        const decryptPayloads = vi.fn(async () => [
            decryptPayloads.mock.calls.length === 1
                ? buildRawTranscriptStreamSegmentRecord('hidden encrypted live', 'segment-hidden-encrypted')
                : buildRawTranscriptStreamSegmentRecord('visible encrypted live', 'segment-visible-encrypted'),
        ]);
        const sessionEncryption = new SessionEncryption(
            sessionId,
            {
                encrypt: async () => [],
                decrypt: decryptPayloads,
            },
            new EncryptionCache(),
        );
        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const baseParams = buildEphemeralParams({
            getSessionEncryption: () => sessionEncryption,
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                { t: 'encrypted', c: 'AA==' },
                'segment-hidden-encrypted',
            ),
        });

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(decryptPayloads).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('applies transcript stream segments immediately when the queued session becomes visible', async () => {
        vi.useFakeTimers();
        const sessionId = 'promoted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const baseParams = buildEphemeralParams({
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        });

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('queued while hidden', 'segment-hidden'),
                'segment-hidden',
            ),
        });

        expect(applyMessages).not.toHaveBeenCalled();

        markSessionSurfaceVisible(sessionId);

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('visible live', 'segment-visible'),
                'segment-visible',
            ),
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'segment-hidden',
            content: [{ type: 'text', text: 'queued while hidden' }],
        });
        expect(applyMessages.mock.calls[1]?.[1]?.[0]).toMatchObject({
            localId: 'segment-visible',
            content: [{ type: 'text', text: 'visible live' }],
        });

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
    });

    it('coalesces stream segment applies behind an in-flight durable message window', async () => {
        vi.useFakeTimers();
        const sessionId = 'coalesced_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        markSessionSurfaceVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn<(appliedSessionId: string, messages: NormalizedMessage[]) => void>();
        const markSessionMaterializedMaxSeq = vi.fn();
        const baseParams = buildBaseParams({
            applyMessages,
            isSessionMessagesLoaded: vi.fn(() => true),
            markSessionMaterializedMaxSeq,
        });

        await handleUpdateContainer({
            ...baseParams,
            updateData: {
                id: 'durable_update_1',
                seq: 10,
                createdAt: 1_000,
                body: {
                    t: 'new-message',
                    sid: sessionId,
                    message: {
                        id: 'durable-message-1',
                        seq: 2,
                        localId: null,
                        createdAt: 1_000,
                        updatedAt: 1_000,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'durable' } } },
                    },
                },
            } as ApiUpdateContainer,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith(sessionId, 2);

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: buildTranscriptStreamSegmentUpdate(sessionId, {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        agentId: 'codex',
                        data: { type: 'message', message: 'live' },
                    },
                    meta: {
                        happierStreamSegmentV1: {
                            v: 1,
                            segmentKind: 'assistant',
                            segmentLocalId: 'segment-1',
                            segmentState: 'streaming',
                            updatedAtMs: 1_010,
                        },
                    },
                },
            }),
            getSession: (id) => storage.getState().sessions[id],
            applyMessages,
        }));

        expect(applyMessages).toHaveBeenCalledTimes(1);

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(applyMessages.mock.calls[1]?.[1]?.[0]).toMatchObject({
            localId: 'segment-1',
            role: 'agent',
            content: [{ type: 'text', text: 'live' }],
        });
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith(sessionId, 2);
    });

});

describe('socket update handling: external-session transcript invalidations', () => {
    it('forwards only the content-free qualified invalidation', async () => {
        const updateExternalSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                v: 1,
                type: 'external-session-transcript-invalidated',
                binding: {
                    v: 1,
                    machineId: 'm1',
                    sessionId: 's1',
                    link: { generation: 'link-1', remoteSessionId: 'remote-1' },
                    source: {
                        qualifiedIdentity: {
                            v: 1,
                            agent: { pluginId: 'happier.claude', localId: 'claude' },
                            source: { kind: 'claudeConfig', contractVersion: 1 },
                        },
                        generation: 'source-1',
                    },
                    contributionGeneration: 'contribution-1',
                    cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
                },
            },
            updateExternalSessionTranscript,
        }));

        expect(updateExternalSessionTranscript).toHaveBeenCalledTimes(1);
        expect(updateExternalSessionTranscript).toHaveBeenCalledWith(expect.objectContaining({
            type: 'external-session-transcript-invalidated',
            binding: expect.objectContaining({ sessionId: 's1' }),
        }));
    });

    it('ignores stale legacy direct-session transcript ephemeral names', async () => {
        const updateExternalSessionTranscript = vi.fn();

        await handleEphemeralSocketUpdate(buildEphemeralParams({
            update: {
                type: 'direct-session-transcript-updated',
                sessionId: 's1',
                items: [],
            },
            updateExternalSessionTranscript,
        }));

        expect(updateExternalSessionTranscript).not.toHaveBeenCalled();
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

    it('passes source server ids through to machine application', () => {
        const updates = new Map<string, { id: string; active: boolean; activeAt: number }>([
            ['m_scoped', { id: 'm_scoped', active: true, activeAt: 999 }],
        ]);
        const applyMachines = vi.fn();

        flushMachineActivityUpdates({ updates, applyMachines, sourceServerId: 'server-a' });

        expect(applyMachines).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'm_scoped' })],
            { sourceServerId: 'server-a' },
        );
    });
});
