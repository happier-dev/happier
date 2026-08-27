import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerSessionTurnTracker } from './codexAppServerSessionTurnTracker';
import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

function createLifecycleHarness() {
    const lifecycle = {
        beginTurn: vi.fn(async () => ({ turnId: 'session-turn-1' })),
        attachProviderTurnId: vi.fn(async () => {}),
        appendTranscriptAnchors: vi.fn(async () => {}),
        touchActiveTurn: vi.fn(async () => {}),
        completeTurn: vi.fn(async () => {}),
        failTurn: vi.fn(async () => {}),
        cancelTurn: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        markRollbackEligible: vi.fn(async () => {}),
        markRolledBack: vi.fn(async () => {}),
        hasActiveTurn: vi.fn(() => false),
    };
    let metadata: Metadata = createTestMetadata({ machineId: 'machine-1' });
    const committedSeqs = new Map([
        ['prompt-local-1', 10],
        ['steer-local-1', 12],
    ]);
    const session = {
        sessionId: 'happy-session-1',
        sessionTurnLifecycle: lifecycle,
        updateMetadata: vi.fn((updater: (current: Metadata) => Metadata) => {
            metadata = updater(metadata);
        }),
        getMetadataSnapshot: vi.fn(() => metadata),
        waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => committedSeqs.get(localId) ?? null),
        getCommittedUserMessageSeq: vi.fn((localId: string) => committedSeqs.get(localId) ?? null),
    };
    return { lifecycle, session };
}

describe('createCodexAppServerSessionTurnTracker', () => {
    it('attaches a late Codex provider turn id to the active session-owned turn', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const tracker = createCodexAppServerSessionTurnTracker({
            session,
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: null,
            startUserMessageLocalId: 'prompt-local-1',
            startSeqInclusive: 10,
        });
        await tracker.updateActiveTurnId('provider-turn-1');

        expect(lifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                userMessageSeqs: [10],
                startSeqInclusive: 10,
            }),
        }));
        expect(lifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'provider-turn-1',
        });
        expect(session.updateMetadata).not.toHaveBeenCalled();
    });

    it('starts the provider turn without waiting on the provider-acceptance commit, then backfills rollback anchors', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        let resolveCommittedSeq!: (seq: number | null) => void;
        const waitForCommittedUserMessageSeq = vi.fn(async () => await new Promise<number | null>((resolve) => {
            resolveCommittedSeq = resolve;
        }));
        const tracker = createCodexAppServerSessionTurnTracker({
            session: {
                ...session,
                getCommittedUserMessageSeq: vi.fn(() => null),
                waitForCommittedUserMessageSeq,
            },
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        const beginPromise = tracker.beginTurn({
            turnId: null,
            startUserMessageLocalId: 'prompt-local-slow',
            startSeqInclusive: null,
        });
        await expect(beginPromise).resolves.toBeUndefined();

        expect(waitForCommittedUserMessageSeq).toHaveBeenCalledWith('prompt-local-slow', {
            timeoutMs: 10_000,
        });
        expect(lifecycle.beginTurn).toHaveBeenCalledWith({ provider: 'codex' });
        expect(lifecycle.appendTranscriptAnchors).not.toHaveBeenCalled();

        resolveCommittedSeq(10);
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.appendTranscriptAnchors).toHaveBeenCalledWith({
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({ startUserMessageSeq: 10 }),
        });
        expect(lifecycle.markRollbackEligible).toHaveBeenCalledWith(expect.objectContaining({
            turnId: 'session-turn-1',
            transcriptAnchors: expect.objectContaining({ startUserMessageSeq: 10, endSeqInclusive: 15 }),
        }));
    });

    it('uses the already committed prompt seq when no pending local id is available', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const tracker = createCodexAppServerSessionTurnTracker({
            session: {
                ...session,
                getCommittedUserMessageSeq: vi.fn(() => null),
                waitForCommittedUserMessageSeq: vi.fn(async () => null),
            },
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: 'provider-turn-1',
            startUserMessageLocalId: null,
            startUserMessageSeq: 10,
            startSeqInclusive: 9,
        });
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.beginTurn).toHaveBeenCalledWith(expect.objectContaining({
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                userMessageSeqs: [10],
                startSeqInclusive: 9,
            }),
        }));
        expect(lifecycle.markRollbackEligible).toHaveBeenCalledWith({
            turnId: 'session-turn-1',
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                endSeqInclusive: 15,
            }),
        });
    });

    it('adds prompt anchors to a generic lifecycle begin without starting another turn', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const tracker = createCodexAppServerSessionTurnTracker({
            session,
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: null,
            startUserMessageLocalId: null,
            startSeqInclusive: 9,
        });
        await tracker.beginTurn({
            turnId: null,
            startUserMessageLocalId: 'prompt-local-1',
            startSeqInclusive: 10,
        });
        await tracker.updateActiveTurnId('provider-turn-1');
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.beginTurn).toHaveBeenCalledTimes(1);
        expect(lifecycle.beginTurn).toHaveBeenCalledWith({ provider: 'codex' });
        expect(lifecycle.appendTranscriptAnchors).toHaveBeenCalledWith({
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                userMessageSeqs: [10],
                startSeqInclusive: 10,
            }),
        });
        expect(lifecycle.attachProviderTurnId).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'provider-turn-1',
        });
        expect(lifecycle.markRollbackEligible).toHaveBeenCalledWith({
            turnId: 'session-turn-1',
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                userMessageSeqs: [10],
                startSeqInclusive: 10,
                endSeqInclusive: 15,
            }),
        });
        expect(tracker.resolveRollbackPlan({ type: 'latest_turn' })).toMatchObject({
            numTurns: 1,
            targetUserMessageSeq: 10,
            range: { startSeqInclusive: 10, endSeqInclusive: 15 },
        });
    });

    it('appends Codex steer anchors to the same turn without creating rollback evidence', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const tracker = createCodexAppServerSessionTurnTracker({
            session,
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: 'provider-turn-1',
            startUserMessageLocalId: 'prompt-local-1',
            startSeqInclusive: 10,
        });
        await tracker.appendSteerMessage({ localId: 'steer-local-1' });
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.appendTranscriptAnchors).toHaveBeenCalledWith({
            provider: 'codex',
            transcriptAnchors: { userMessageSeqs: [12] },
        });
        expect(lifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        expect(lifecycle.markRollbackEligible).toHaveBeenCalledWith({
            turnId: 'session-turn-1',
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                userMessageSeqs: [10, 12],
                startSeqInclusive: 10,
                endSeqInclusive: 15,
            }),
        });
        expect(tracker.resolveRollbackPlan({ type: 'before_user_message', userMessageSeq: 12 })).toBeNull();
        expect(tracker.resolveRollbackPlan({ type: 'before_user_message', userMessageSeq: 10 })).toMatchObject({
            numTurns: 1,
            targetUserMessageSeq: 10,
            range: { startSeqInclusive: 10, endSeqInclusive: 15 },
        });
    });

    it('keeps local rollback evidence without authoring legacy metadata when lifecycle is unavailable', async () => {
        const updateMetadata = vi.fn();
        const session = {
            updateMetadata,
            getMetadataSnapshot: vi.fn(() => createTestMetadata({ machineId: 'machine-1' })),
            getCommittedUserMessageSeq: vi.fn((localId: string) => (localId === 'prompt-local-1' ? 10 : null)),
            waitForCommittedUserMessageSeq: vi.fn(async (localId: string) => (localId === 'prompt-local-1' ? 10 : null)),
        };
        const tracker = createCodexAppServerSessionTurnTracker({
            session,
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: 'provider-turn-1',
            startUserMessageLocalId: 'prompt-local-1',
            startSeqInclusive: 10,
        });
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(updateMetadata).not.toHaveBeenCalled();
        expect(tracker.resolveRollbackPlan({ type: 'latest_turn' })).toMatchObject({
            numTurns: 1,
            targetUserMessageSeq: 10,
            range: { startSeqInclusive: 10, endSeqInclusive: 15 },
        });
    });

    it('authors lifecycle status without rollback evidence when committed user seq is unavailable', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const tracker = createCodexAppServerSessionTurnTracker({
            session: {
                ...session,
                getCommittedUserMessageSeq: vi.fn(() => null),
                waitForCommittedUserMessageSeq: vi.fn(async () => null),
            },
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
        });

        await tracker.beginTurn({
            turnId: 'provider-turn-1',
            startUserMessageLocalId: null,
            startSeqInclusive: null,
        });
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.beginTurn).toHaveBeenCalledWith({
            provider: 'codex',
            providerTurnId: 'provider-turn-1',
        });
        expect(lifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        expect(lifecycle.markRollbackEligible).not.toHaveBeenCalled();
        expect(tracker.resolveRollbackPlan({ type: 'latest_turn' })).toBeNull();
    });

    it('degrades rollback planning closed when rollback eligibility write fails', async () => {
        const { lifecycle, session } = createLifecycleHarness();
        const writeError = new Error('session turn write failed');
        lifecycle.markRollbackEligible.mockRejectedValue(writeError);
        const onMetadataWriteError = vi.fn();
        const tracker = createCodexAppServerSessionTurnTracker({
            session,
            getProviderThreadId: () => 'thread-1',
            now: () => 100,
            onMetadataWriteError,
        });

        await tracker.beginTurn({
            turnId: 'provider-turn-1',
            startUserMessageLocalId: 'prompt-local-1',
            startSeqInclusive: 10,
        });
        await tracker.completeActiveTurn({ endSeqInclusive: 15 });

        expect(lifecycle.completeTurn).toHaveBeenCalledWith({
            provider: 'codex',
        });
        expect(lifecycle.markRollbackEligible).toHaveBeenCalledWith({
            turnId: 'session-turn-1',
            provider: 'codex',
            transcriptAnchors: expect.objectContaining({
                startUserMessageSeq: 10,
                endSeqInclusive: 15,
            }),
        });
        expect(onMetadataWriteError).toHaveBeenCalledWith(writeError);
        expect(tracker.resolveRollbackPlan({ type: 'latest_turn' })).toBeNull();
    });
});
