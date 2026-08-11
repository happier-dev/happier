import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/runtime/syncTuning', () => ({
    loadSyncTuning: () => ({
        sessionSocketApplyCoalescingEnabled: false,
        sessionSocketApplyCoalescingWindowMs: 0,
        sessionSocketApplyCoalescingMaxBatchSize: 64,
        sessionRealtimeProjectionMode: 'enabled',
    }),
}));

function resolveTestServerScopeId(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (value === 'profile-a' || value === 'legacy-a') return 'identity-a';
    return value;
}

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        resolveServerProfileScopeIdForIdentifier: (id: string | null | undefined) => resolveTestServerScopeId(id),
        areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => {
            const resolvedLeft = resolveTestServerScopeId(left);
            const resolvedRight = resolveTestServerScopeId(right);
            return Boolean(resolvedLeft && resolvedRight && resolvedLeft === resolvedRight);
        },
    };
});

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { clearActiveViewingSessionsForServerScopeReset } from '@/sync/domains/session/activeViewingSession';
import { markSessionVisible } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import {
    clearSessionRealtimeTranscriptSuppression,
    enableSessionRealtimeTranscriptSuppression,
} from '@/sync/runtime/sessionRealtimeTranscriptSuppression';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getState();
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];

function buildSession(id: string): Session {
    return {
        id,
        seq: 1,
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
        encryptionMode: 'plain',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 900,
    };
}

function buildPlainNewMessageUpdate(sessionId: string): ApiUpdateContainer {
    return {
        id: 'update-transcript-consumer',
        seq: 2,
        createdAt: 2_000,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: {
                id: 'message-transcript-consumer',
                seq: 2,
                localId: null,
                createdAt: 2_000,
                updatedAt: 2_000,
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'acp',
                            provider: 'codex',
                            data: { type: 'message', message: 'streaming detail pane output' },
                        },
                    },
                },
            },
        },
    } satisfies ApiUpdateContainer;
}

function buildBaseParams(overrides: Partial<Omit<HandleUpdateContainerParams, 'updateData'>> = {}) {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
            decryptEncryptionKey: vi.fn(async () => null as Uint8Array | null),
            initializeMachines: vi.fn(async () => {}),
        } as unknown as HandleUpdateContainerParams['encryption'],
        artifactDataKeys: new Map(),
        applySessions: vi.fn((sessions: Parameters<HandleUpdateContainerParams['applySessions']>[0]) => {
            const normalizedSessions: Session[] = sessions.map((session) => ({
                ...session,
                presence: session.presence ?? 'online',
            }));
            storage.getState().applySessions(normalizedSessions);
        }),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => true),
        getSessionMaterializedMaxSeq: vi.fn(() => 1),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        markSessionKnownRemoteSeq: vi.fn(),
        markSessionTranscriptDeferred: vi.fn(),
        markSessionTranscriptStale: vi.fn(),
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

describe('socket realtime explicit transcript consumers', () => {
    let unregisterConsumer: (() => void) | null = null;

    beforeEach(() => {
        unregisterConsumer?.();
        unregisterConsumer = null;
        storage.setState(initialStorageState, true);
        projectManager.clear();
        clearActiveViewingSessionsForServerScopeReset();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    afterEach(() => {
        unregisterConsumer?.();
        unregisterConsumer = null;
        storage.setState(initialStorageState, true);
        projectManager.clear();
        clearActiveViewingSessionsForServerScopeReset();
        clearSessionRealtimeTranscriptSuppression(undefined, { isDevOrTest: true });
    });

    it('defers transcript for a hidden session with no explicit transcript consumer', async () => {
        const hiddenSessionId = 'hidden-detail-producer';
        storage.getState().applySessions([buildSession(hiddenSessionId)]);

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            updateData: buildPlainNewMessageUpdate(hiddenSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
    });

    it('materializes hidden durable messages while an explicit transcript consumer is mounted', async () => {
        const hiddenSessionId = 'hidden-detail-producer';
        storage.getState().applySessions([buildSession(hiddenSessionId)]);
        unregisterConsumer = registerSessionRealtimeTranscriptConsumer(hiddenSessionId);

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            updateData: buildPlainNewMessageUpdate(hiddenSessionId),
        });

        expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
        const [appliedSessionId, messages] = applyMessages.mock.calls[0] as [string, NormalizedMessage[]];
        expect(appliedSessionId).toBe(hiddenSessionId);
        expect(messages[0]).toMatchObject({
            id: 'message-transcript-consumer',
            seq: 2,
            role: 'agent',
            content: [{ type: 'text', text: 'streaming detail pane output' }],
        });
    });

    it('materializes explicit transcript consumers registered with an equivalent server alias', async () => {
        const hiddenSessionId = 'hidden-detail-producer-alias';
        storage.getState().applySessions([{ ...buildSession(hiddenSessionId), serverId: 'profile-a' }]);
        unregisterConsumer = registerSessionRealtimeTranscriptConsumer(hiddenSessionId, 'profile-a');

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            sourceServerId: 'identity-a',
            updateData: buildPlainNewMessageUpdate(hiddenSessionId),
        });

        expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
    });

    it('does not materialize when the explicit transcript consumer belongs to another server with the same session id', async () => {
        const sharedSessionId = 'shared-session';
        storage.getState().applySessions([{
            ...buildSession(sharedSessionId),
            serverId: 'server-b',
        }]);
        unregisterConsumer = registerSessionRealtimeTranscriptConsumer(sharedSessionId);

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            sourceServerId: 'server-a',
            updateData: buildPlainNewMessageUpdate(sharedSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
    });

    it('does not materialize when a pre-hydration explicit consumer hydrates onto another server later', async () => {
        const sharedSessionId = 'shared-session';
        unregisterConsumer = registerSessionRealtimeTranscriptConsumer(sharedSessionId);
        storage.getState().applySessions([{
            ...buildSession(sharedSessionId),
            serverId: 'server-b',
        }]);

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            sourceServerId: 'server-a',
            updateData: buildPlainNewMessageUpdate(sharedSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
    });

    it('does not materialize when only another server marks the same session id visible', async () => {
        const sharedSessionId = 'shared-session';
        storage.getState().applySessions([{
            ...buildSession(sharedSessionId),
            serverId: 'server-b',
        }]);
        markSessionVisible(sharedSessionId);

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            sourceServerId: 'server-a',
            updateData: buildPlainNewMessageUpdate(sharedSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
    });

    it('keeps visible unsuppressed new-message updates on the materialized transcript route', async () => {
        const visibleSessionId = 'visible-unsuppressed-session';
        storage.getState().applySessions([{
            ...buildSession(visibleSessionId),
            serverId: 'profile-a',
        }]);
        markSessionVisible(visibleSessionId, 'profile-a');

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            sourceServerId: 'identity-a',
            updateData: buildPlainNewMessageUpdate(visibleSessionId),
        });

        expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
        expect(applyMessages).toHaveBeenCalledTimes(1);
    });

    it('routes a visible suppressed new-message through projection-only deferred transcript state', async () => {
        const visibleSessionId = 'visible-suppressed-session';
        storage.getState().applySessions([{
            ...buildSession(visibleSessionId),
            serverId: 'profile-a',
            lastViewedSessionSeq: 1,
        }]);
        markSessionVisible(visibleSessionId, 'profile-a');
        enableSessionRealtimeTranscriptSuppression({
            sessionId: visibleSessionId,
            sourceServerId: 'profile-a',
        }, { isDevOrTest: true });

        const applyMessages = vi.fn();
        const markSessionKnownRemoteSeq = vi.fn();
        const markSessionMaterializedMaxSeq = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({
                applyMessages,
                markSessionKnownRemoteSeq,
                markSessionMaterializedMaxSeq,
                markSessionTranscriptDeferred,
            }),
            sourceServerId: 'identity-a',
            updateData: buildPlainNewMessageUpdate(visibleSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionMaterializedMaxSeq).not.toHaveBeenCalled();
        expect(markSessionKnownRemoteSeq).toHaveBeenCalledWith(visibleSessionId, 2);
        expect(markSessionTranscriptDeferred).toHaveBeenCalledWith(visibleSessionId, expect.objectContaining({
            updateType: 'new-message',
            seq: 2,
        }));
    });

    it('stops materializing once the explicit transcript consumer unmounts', async () => {
        const hiddenSessionId = 'hidden-detail-producer';
        storage.getState().applySessions([buildSession(hiddenSessionId)]);
        const unregister = registerSessionRealtimeTranscriptConsumer(hiddenSessionId);
        unregister();

        const applyMessages = vi.fn();
        const markSessionTranscriptDeferred = vi.fn();

        await handleUpdateContainer({
            ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
            updateData: buildPlainNewMessageUpdate(hiddenSessionId),
        });

        expect(applyMessages).not.toHaveBeenCalled();
        expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
    });
});
