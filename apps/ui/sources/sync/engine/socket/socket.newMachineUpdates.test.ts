import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiMessage, ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { storage } from '@/sync/domains/state/storage';
import {
    clearActiveViewingSessionsForServerScopeReset,
    markSessionVisible,
    setActiveViewingSessionId,
} from '@/sync/domains/session/activeViewingSession';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import * as executionRunActivityBus from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { resetTranscriptStreamSegmentAssemblyForTests } from '@/sync/engine/sessions/transcriptStreamSegmentAssembly';
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

function buildTranscriptStreamSegmentDeltaUpdate(
    sessionId: string,
    content: unknown,
    opts: { localId?: string; tick: number; baseLength: number },
) {
    return {
        type: 'transcript-stream-segment-delta',
        sessionId,
        message: {
            localId: opts.localId ?? 'segment-1',
            tick: opts.tick,
            baseLength: opts.baseLength,
            content,
            createdAt: 1_000,
            updatedAt: 1_040,
        },
    };
}

function buildPlainTranscriptStreamSegmentContent(text: string, localId = 'segment-1') {
    return {
        t: 'plain',
        v: {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'codex',
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
        },
    };
}

function buildPlainNewMessageUpdate(params: { sessionId: string; messageId: string; messageSeq: number; text: string }): ApiUpdateContainer {
    return {
        id: `${params.messageId}-update`,
        seq: params.messageSeq,
        createdAt: 1_000 + params.messageSeq,
        body: {
            t: 'new-message',
            sid: params.sessionId,
            message: {
                id: params.messageId,
                seq: params.messageSeq,
                localId: null,
                createdAt: 1_000 + params.messageSeq,
                updatedAt: 1_000 + params.messageSeq,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: params.text } } },
            },
        },
    } satisfies ApiUpdateContainer;
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

    it('drops new-machine updates when the captured socket scope is stale', async () => {
        const invalidateMachines = vi.fn();
        const params = buildBaseParams({ invalidateMachines });
        const updateData: ApiUpdateContainer = {
            id: 'u_machine_stale',
            seq: 44,
            createdAt: 125,
            body: {
                t: 'new-machine',
                machineId: 'm_stale',
                seq: 8,
                metadata: '',
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                active: true,
                activeAt: 121,
                createdAt: 101,
                updatedAt: 111,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({ ...params, updateData, shouldContinue: () => false });

        expect(invalidateMachines).not.toHaveBeenCalled();
        expect(storage.getState().machines['m_stale']).toBeUndefined();
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
            getSessionEncryption: () => null,
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages: vi.fn(),
        });

        expect(addMachineActivityUpdate).toHaveBeenCalledWith({ id: 'm_unknown', active: true, activeAt: 999 });
        expect(storage.getState().machines['m_unknown']).toBeUndefined();
    });

    it('drops machine activity ephemerals when the captured socket scope is stale', () => {
        const addMachineActivityUpdate = vi.fn();

        handleEphemeralSocketUpdate({
            update: { type: 'machine-activity', id: 'm_stale_ephemeral', active: true, activeAt: 1_000 },
            shouldContinue: () => false,
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate,
            getSessionEncryption: () => null,
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages: vi.fn(),
        });

        expect(addMachineActivityUpdate).not.toHaveBeenCalled();
    });
});

describe('socket update handling: execution-run-updated ephemerals', () => {
    it('notifies execution run activity so polling can recheck quickly', () => {
        const listener = vi.fn();
        const unsubscribe = executionRunActivityBus.subscribeExecutionRunActivity('s1', listener);

        handleEphemeralSocketUpdate({
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
            getSessionEncryption: () => null,
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages: vi.fn(),
        });

        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});

describe('socket update handling: transcript stream segment ephemerals', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        });
        storage.setState((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                transcriptStreamingCoalesceEnabled: false,
            },
        }));
        clearActiveViewingSessionsForServerScopeReset();
    });

    afterEach(() => {
        clearActiveViewingSessionsForServerScopeReset();
        useVoiceTargetStore.setState({
            scope: 'global',
            primaryActionSessionId: null,
            trackedSessionIds: [],
            lastFocusedSessionId: null,
        });
        vi.useRealTimers();
    });

    it('normalizes plaintext stream segments through the message apply path', async () => {
        const sessionId = 'plain_stream_session';
        markSessionVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);
        const applyMessages = vi.fn();
        const params = {
            update: buildTranscriptStreamSegmentUpdate(sessionId, {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'codex',
                        data: { type: 'message', message: 'Hello live' },
                    },
                    meta: {
                        happierStreamSegmentV1: {
                            v: 1,
                            segmentKind: 'assistant',
                            segmentLocalId: 'segment-1',
                            segmentState: 'streaming',
                            startedAtMs: 1_000,
                            updatedAtMs: 1_010,
                        },
                    },
                },
            }),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        };

        await handleEphemeralSocketUpdate(params);

        expect(applyMessages).toHaveBeenCalledTimes(1);
        const [appliedSessionId, messages] = applyMessages.mock.calls[0] as [string, NormalizedMessage[]];
        expect(appliedSessionId).toBe(sessionId);
        expect(messages[0]).toMatchObject({
            localId: 'segment-1',
            role: 'agent',
            content: [{ type: 'text', text: 'Hello live' }],
        });
    });

    it('applies transcript stream segment deltas by reconstructing text for live-consumed sessions', async () => {
        resetTranscriptStreamSegmentAssemblyForTests();
        const sessionId = 'plain_stream_delta_session';
        markSessionVisible(sessionId);
        setActiveViewingSessionId(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);
        const applyMessages = vi.fn();
        const baseParams = {
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        };

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('Hello'),
            ),
        });
        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentDeltaUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent(' live'),
                { tick: 2, baseLength: 5 },
            ),
        });

        expect(applyMessages).toHaveBeenCalledTimes(2);
        const [, messages] = applyMessages.mock.calls[1] as [string, NormalizedMessage[]];
        expect(messages[0]).toMatchObject({
            localId: 'segment-1',
            role: 'agent',
            content: [{ type: 'text', text: 'Hello live' }],
        });
    });

    it('drops transcript stream segment deltas for sessions without a live transcript consumer', async () => {
        resetTranscriptStreamSegmentAssemblyForTests();
        const sessionId = 'hidden_stream_delta_session';
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);
        const applyMessages = vi.fn();

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentDeltaUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent(' hidden'),
                { tick: 2, baseLength: 5 },
            ),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops hidden non-coalesced encrypted stream segments before decrypting', async () => {
        const sessionId = 'hidden_non_coalesced_stream_session';
        storage.getState().applySessions([buildSession(sessionId, 'e2ee')]);
        const applyMessages = vi.fn();
        const decryptMessage = vi.fn(async () => ({
            id: 'segment-1',
            seq: 0,
            localId: 'segment-1',
            createdAt: 1_000,
            content: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: 'Encrypted hidden live' },
                },
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        startedAtMs: 1_000,
                        updatedAtMs: 1_010,
                    },
                },
            },
        }));

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(sessionId, { t: 'encrypted', c: 'ciphertext' }),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => ({ decryptMessage })),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('drops off-screen transcript stream segment applies when the coalescing window flushes while hidden', async () => {
        vi.useFakeTimers();
        const sessionId = 'offscreen_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn();

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('off-screen live', 'segment-offscreen'),
                'segment-offscreen',
            ),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('applies queued hidden stream segments when a voice consumer becomes active before the coalescing window flushes', async () => {
        vi.useFakeTimers();
        const sessionId = 'voice_live_consumer_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn();

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('queued for voice', 'segment-voice-live'),
                'segment-voice-live',
            ),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();

        useVoiceTargetStore.getState().setPrimaryActionSessionId(sessionId);
        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'segment-voice-live',
            content: [{ type: 'text', text: 'queued for voice' }],
        });
    });

    it('applies queued hidden stream segments when the voice readback target is last focused', async () => {
        vi.useFakeTimers();
        const sessionId = 'voice_readback_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn();

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('queued for readback', 'segment-voice-readback'),
                'segment-voice-readback',
            ),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();

        useVoiceTargetStore.getState().setLastFocusedSessionId(sessionId);
        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'segment-voice-readback',
            content: [{ type: 'text', text: 'queued for readback' }],
        });
    });

    it('applies queued hidden stream segments before applying newly visible segments', async () => {
        vi.useFakeTimers();
        const sessionId = 'promoted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn();
        const baseParams = {
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        };

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('queued while hidden', 'segment-hidden'),
                'segment-hidden',
            ),
        });

        expect(applyMessages).not.toHaveBeenCalled();

        setActiveViewingSessionId(sessionId, 1);
        markSessionVisible(sessionId);

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

    it('keeps hidden durable message projection deferred when queued hidden stream segments are applied on reveal', async () => {
        vi.useFakeTimers();
        const sessionId = 'durable_stream_handler_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const durableApplyMessages = vi.fn();
        const streamApplyMessages = vi.fn();
        const baseUpdateParams = buildBaseParams({
            applyMessages: durableApplyMessages,
            isSessionMessagesLoaded: vi.fn(() => true),
        });
        const baseStreamParams = {
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages: streamApplyMessages,
        };

        await handleUpdateContainer({
            ...baseUpdateParams,
            updateData: buildPlainNewMessageUpdate({
                sessionId,
                messageId: 'durable-message',
                messageSeq: 2,
                text: 'durable queued',
            }),
        });

        expect(durableApplyMessages).not.toHaveBeenCalled();

        await handleEphemeralSocketUpdate({
            ...baseStreamParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('hidden live', 'hidden-segment'),
                'hidden-segment',
            ),
        });

        expect(streamApplyMessages).not.toHaveBeenCalled();

        markSessionVisible(sessionId);

        await handleEphemeralSocketUpdate({
            ...baseStreamParams,
            update: buildTranscriptStreamSegmentUpdate(
                sessionId,
                buildPlainTranscriptStreamSegmentContent('visible live', 'visible-segment'),
                'visible-segment',
            ),
        });

        expect(durableApplyMessages).not.toHaveBeenCalled();
        expect(streamApplyMessages).toHaveBeenCalledTimes(2);
        expect(streamApplyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'hidden-segment',
            content: [{ type: 'text', text: 'hidden live' }],
        });
        expect(streamApplyMessages.mock.calls[1]?.[1]?.[0]).toMatchObject({
            localId: 'visible-segment',
            content: [{ type: 'text', text: 'visible live' }],
        });

        await vi.runAllTimersAsync();
    });

    it('requires encryption before applying encrypted stream segments', async () => {
        const sessionId = 'encrypted_stream_session';
        markSessionVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'e2ee')]);
        const applyMessages = vi.fn();
        const encryptedUpdate = buildTranscriptStreamSegmentUpdate(sessionId, { t: 'encrypted', c: 'ciphertext' });

        await handleEphemeralSocketUpdate({
            update: encryptedUpdate,
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).not.toHaveBeenCalled();

        const decryptMessage = vi.fn(async () => ({
            id: 'segment-1',
            seq: 0,
            localId: 'segment-1',
            createdAt: 1_000,
            content: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: 'Encrypted live' },
                },
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        startedAtMs: 1_000,
                        updatedAtMs: 1_010,
                    },
                },
            },
        }));

        await handleEphemeralSocketUpdate({
            update: encryptedUpdate,
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => ({ decryptMessage })),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        const [, messages] = applyMessages.mock.calls[0] as [string, NormalizedMessage[]];
        expect(messages[0]).toMatchObject({
            localId: 'segment-1',
            role: 'agent',
            content: [{ type: 'text', text: 'Encrypted live' }],
        });
    });

    it('applies visible scoped stream segments using the source server when the local session cache has a stale alias', async () => {
        const sessionId = 'source_scoped_visible_stream_session';
        const sourceServerId = 'srv_actual_visible_scope';
        const staleLocalServerId = 'stack_route_alias_for_same_server';
        markSessionVisible(sessionId, sourceServerId);
        storage.getState().applySessions([{
            ...buildSession(sessionId, 'e2ee'),
            serverId: staleLocalServerId,
        }]);
        const decryptMessage = vi.fn(async () => ({
            id: 'segment-1',
            seq: 0,
            localId: 'segment-1',
            createdAt: 1_000,
            content: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: 'Visible scoped live' },
                },
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        startedAtMs: 1_000,
                        updatedAtMs: 1_010,
                    },
                },
            },
        }));
        const applyMessages = vi.fn();
        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(sessionId, { t: 'encrypted', c: 'ciphertext' }),
            sourceServerId,
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => ({ decryptMessage })),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
    });

    it('drops hidden encrypted transcript stream segments at flush time without decrypting', async () => {
        vi.useFakeTimers();
        const sessionId = 'hidden_encrypted_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        storage.getState().applySessions([buildSession(sessionId, 'e2ee')]);
        const applyMessages = vi.fn();
        const decryptMessage = vi.fn(async () => ({
            id: 'segment-1',
            seq: 0,
            localId: 'segment-1',
            createdAt: 1_000,
            content: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: 'Encrypted hidden live' },
                },
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: 'segment-1',
                        segmentState: 'streaming',
                        startedAtMs: 1_000,
                        updatedAtMs: 1_010,
                    },
                },
            },
        }));

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(sessionId, { t: 'encrypted', c: 'ciphertext' }),
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => ({ decryptMessage })),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();

        await vi.runAllTimersAsync();

        expect(decryptMessage).not.toHaveBeenCalled();
        expect(applyMessages).not.toHaveBeenCalled();
    });

    it('keeps multi-session hidden stream segments off the hot path while one session is viewed', async () => {
        vi.useFakeTimers();
        enableTranscriptStreamingCoalescingForTest();
        const visibleSessionId = 'visible_stream_session';
        const hiddenSessionIds = Array.from({ length: 10 }, (_, index) => `hidden_stream_session_${index + 1}`);
        storage.getState().applySessions([
            buildSession(visibleSessionId, 'e2ee'),
            ...hiddenSessionIds.map((sessionId) => buildSession(sessionId, 'e2ee')),
        ]);
        setActiveViewingSessionId(visibleSessionId, 1);
        markSessionVisible(visibleSessionId);

        const decryptMessage = vi.fn(async (message: ApiMessage) => ({
            id: message.id,
            seq: 0,
            localId: message.localId ?? message.id,
            createdAt: 1_000,
            content: {
                role: 'agent',
                content: {
                    type: 'acp',
                    provider: 'codex',
                    data: { type: 'message', message: `decrypted ${message.localId ?? message.id}` },
                },
                meta: {
                    happierStreamSegmentV1: {
                        v: 1,
                        segmentKind: 'assistant',
                        segmentLocalId: message.localId ?? message.id,
                        segmentState: 'streaming',
                        startedAtMs: 1_000,
                        updatedAtMs: 1_010,
                    },
                },
            },
        }));
        const applyMessages = vi.fn();
        const baseParams = {
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => ({ decryptMessage })),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        };

        for (const sessionId of hiddenSessionIds) {
            for (let index = 0; index < 5; index += 1) {
                await handleEphemeralSocketUpdate({
                    ...baseParams,
                    update: buildTranscriptStreamSegmentUpdate(
                        sessionId,
                        { t: 'encrypted', c: `ciphertext-${sessionId}-${index}` },
                        `hidden-segment-${sessionId}`,
                    ),
                });
            }
        }

        await handleEphemeralSocketUpdate({
            ...baseParams,
            update: buildTranscriptStreamSegmentUpdate(
                visibleSessionId,
                { t: 'encrypted', c: 'visible-ciphertext' },
                'visible-segment',
            ),
        });

        await vi.runAllTimersAsync();

        expect(decryptMessage).toHaveBeenCalledTimes(1);
        expect(applyMessages).toHaveBeenCalledTimes(1);
        expect(applyMessages.mock.calls[0]?.[1]?.[0]).toMatchObject({
            localId: 'visible-segment',
            content: [{ type: 'text', text: 'decrypted visible-segment' }],
        });
    });

    it('preserves queued durable message materialization tracking when stream segments interleave', async () => {
        vi.useFakeTimers();
        const sessionId = 'coalesced_stream_session';
        enableTranscriptStreamingCoalescingForTest();
        setActiveViewingSessionId(sessionId, 1);
        markSessionVisible(sessionId);
        storage.getState().applySessions([buildSession(sessionId, 'plain')]);

        const applyMessages = vi.fn();
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

        await handleEphemeralSocketUpdate({
            update: buildTranscriptStreamSegmentUpdate(sessionId, {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'acp',
                        provider: 'codex',
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
            addActivityUpdate: vi.fn(),
            addMachineActivityUpdate: vi.fn(),
            getSessionEncryption: vi.fn(() => null),
            getSession: (id: string) => storage.getState().sessions[id],
            applyMessages,
        });

        expect(applyMessages).toHaveBeenCalledTimes(1);

        await vi.runAllTimersAsync();

        expect(applyMessages).toHaveBeenCalledTimes(2);
        expect(markSessionMaterializedMaxSeq).toHaveBeenCalledWith(sessionId, 2);
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

    it('drops machine activity flushes when the captured socket scope is stale', () => {
        const updates = new Map<string, { id: string; active: boolean; activeAt: number }>([
            ['m_unknown_stale', { id: 'm_unknown_stale', active: true, activeAt: 1_000 }],
        ]);
        const applyMachines = vi.fn((machines: Machine[]) => storage.getState().applyMachines(machines));

        flushMachineActivityUpdates({ updates, applyMachines, shouldContinue: () => false });

        expect(applyMachines).not.toHaveBeenCalled();
        expect(storage.getState().machines['m_unknown_stale']).toBeUndefined();
    });
});
