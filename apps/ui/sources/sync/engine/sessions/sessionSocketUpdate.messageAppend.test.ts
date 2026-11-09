import { describe, expect, it, vi } from 'vitest';
import { createTranscriptStreamSegmentAssembler, interpretTranscriptStreamSegment, type TranscriptStreamSegmentAssembler } from '@happier-dev/session-core/live';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { SessionReceivedMessages } from '@happier-dev/session-core/transcript';
import type { Session } from '@/sync/domains/state/storageTypes';
import { handleMessageUpdatedSocketUpdate, handleNewMessageSocketUpdate } from './sessionSocketUpdate';

const SESSION_ID = 's1';
const LOCAL_ID = 'segment-1';
const MESSAGE_ID = 'm1';

function record(text: string, updatedAtMs: number, state: 'streaming' | 'complete' = 'streaming', binding?: Readonly<{ baseLength: number; length: number; localId?: string }>) {
    return {
        role: 'agent',
        content: { type: 'acp', provider: 'codex', data: { type: 'message', message: text } },
        meta: {
            happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: LOCAL_ID, segmentState: state, startedAtMs: 1_000, updatedAtMs },
            // The producer seals what an append extends inside the encrypted record.
            ...(binding ? { happierStreamAppendV1: { v: 1, localId: binding.localId ?? LOCAL_ID, baseLength: binding.baseLength, length: binding.length } } : {}),
        },
    };
}

function frame(params: Readonly<{
    t: 'new-message' | 'message-updated';
    text: string;
    updatedAt: number;
    base?: Readonly<{ updatedAt: number; length: number }>;
    state?: 'streaming' | 'complete';
    /** Overrides the sealed binding (a forged or misplaced fragment). */
    binding?: Readonly<{ baseLength: number; length: number; localId?: string }>;
}>) {
    return {
        id: `u-${params.updatedAt}`,
        seq: params.updatedAt,
        createdAt: params.updatedAt,
        body: {
            t: params.t,
            sid: SESSION_ID,
            delivery: params.base ? 'delta' : 'full',
            ...(params.base ? { base: params.base } : {}),
            message: {
                id: MESSAGE_ID, seq: 6, localId: LOCAL_ID, sidechainId: null, messageRole: 'agent',
                content: { t: 'plain', v: record(params.text, params.updatedAt, params.state,
                    params.base ? params.binding ?? { baseLength: params.base.length, length: params.base.length + params.text.length } : undefined) },
                createdAt: 1_000, updatedAt: params.updatedAt,
            },
        },
    };
}

const session: Session = {
    id: SESSION_ID, seq: 5, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: null, metadataVersion: 0,
    agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence: 'online', encryptionMode: 'plain',
};

function harness(assembler: TranscriptStreamSegmentAssembler | undefined) {
    const applied: NormalizedMessage[] = [];
    const reads = vi.fn();
    const sessionReceivedMessages: SessionReceivedMessages = new Map();
    const params = (updateData: unknown) => ({
        updateData,
        getSessionEncryption: () => null,
        getSession: () => session,
        applySessions: () => {},
        fetchSessions: () => {},
        applyMessages: (_sessionId: string, messages: NormalizedMessage[]) => { applied.push(...messages); },
        isMutableToolCall: () => false,
        invalidateScmStatus: () => {},
        isSessionMessagesLoaded: () => true,
        isSessionActivelyViewed: () => true,
        isSessionFullContentConsumerActive: () => true,
        getSessionMaterializedMaxSeq: () => 5,
        markSessionMaterializedMaxSeq: () => {},
        markSessionTranscriptStale: () => {},
        // The transcript owner reads the full message when a revision cannot be applied here.
        onMessageGapDetected: reads,
        sessionReceivedMessages,
        ...(assembler ? { transcriptStreamSegmentAssembler: assembler } : {}),
    });
    const textOf = (message: NormalizedMessage | undefined) => {
        const block = message?.role === 'agent' ? message.content[0] : undefined;
        return block?.type === 'text' ? block.text : undefined;
    };
    return { applied, reads, params, textOf };
}

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `${from + index} numbered line\n`).join('');

describe('durable message revisions sent as appends', () => {
    it('applies N streamed revisions from appends with zero full-message reads, and reads once when the base is missing', async () => {
        const liveAssembler = createTranscriptStreamSegmentAssembler();
        const { applied, reads, params, textOf } = harness(liveAssembler);
        const sessionReceivedMessagesOf = (build: typeof params) => (build(null) as { sessionReceivedMessages: SessionReceivedMessages }).sessionReceivedMessages;

        // Commit 1 arrives whole; every later revision carries only what it appends to the held one.
        let text = lines(0, 20);
        let updatedAt = 2_000;
        await handleNewMessageSocketUpdate(params(frame({ t: 'new-message', text, updatedAt })) as never);
        const frameBytes: number[] = [];
        for (let commit = 1; commit <= 10; commit += 1) {
            const appended = lines(commit * 40, commit * 40 + 40);
            const update = frame({ t: 'message-updated', text: appended, updatedAt: updatedAt + 2_000, base: { updatedAt, length: text.length } });
            frameBytes.push(JSON.stringify(update).length);
            await handleMessageUpdatedSocketUpdate(params(update) as never);
            text += appended;
            updatedAt += 2_000;
            expect(textOf(applied.at(-1))).toBe(text);
        }
        expect(reads).toHaveBeenCalledTimes(0);
        expect(Math.max(...frameBytes) - Math.min(...frameBytes)).toBeLessThan(64);

        // A revision whose base this consumer does not hold is never guessed at: one read.
        const appliedBeforeGap = applied.length;
        await handleMessageUpdatedSocketUpdate(params(frame({
            t: 'message-updated', text: 'lost', updatedAt: updatedAt + 4_000, base: { updatedAt: updatedAt + 2_000, length: text.length + 9 },
        })) as never);
        expect(reads).toHaveBeenCalledTimes(1);
        expect(applied).toHaveLength(appliedBeforeGap);

        // A fragment whose sealed binding names another base/result (Home splicing or replaying an
        // authentic fragment) is never applied and is read in full; the hint skip cannot hide it.
        const forgedAt = applied.length;
        await handleMessageUpdatedSocketUpdate(params(frame({
            t: 'message-updated', text: lines(0, 3), updatedAt: updatedAt + 3_000, base: { updatedAt, length: text.length },
            binding: { baseLength: 20, length: 20 + lines(0, 3).length },
        })) as never);
        expect(reads).toHaveBeenCalledTimes(2);
        expect(applied).toHaveLength(forgedAt);
        expect(sessionReceivedMessagesOf(params).get(SESSION_ID)?.get(MESSAGE_ID)).toBe(updatedAt);

        // The read's full row re-establishes the base. In the CLI's order the terminal live frame
        // arrives first, then the terminal durable revision as an append: zero further reads.
        const recovered = `${text}gap line\nlost`;
        await handleMessageUpdatedSocketUpdate(params(frame({ t: 'message-updated', text: recovered, updatedAt: updatedAt + 4_000 })) as never);
        interpretTranscriptStreamSegment({
            assembler: liveAssembler, sessionId: SESSION_ID, type: 'transcript-stream-segment-delta', tick: 99, baseLength: recovered.length,
            record: record(' end\n', updatedAt + 5_000, 'complete') as never, message: { localId: LOCAL_ID, createdAt: 1_000 },
        });
        await handleMessageUpdatedSocketUpdate(params(frame({
            t: 'message-updated', text: ' end\n', updatedAt: updatedAt + 6_000, base: { updatedAt: updatedAt + 4_000, length: recovered.length }, state: 'complete',
        })) as never);
        expect(textOf(applied.at(-1))).toBe(`${recovered} end\n`);
        expect(reads).toHaveBeenCalledTimes(2);
    });

    it('refuses an append whose opened row identity does not match, rather than applying the fragment as the whole message', async () => {
        const assembler = createTranscriptStreamSegmentAssembler();
        const { applied, reads, params } = harness(assembler);
        await handleNewMessageSocketUpdate(params(frame({ t: 'new-message', text: lines(0, 20), updatedAt: 2_000 })) as never);
        const appliedBefore = applied.length;
        // The opened (decrypted) row loses its localId: the append must fail closed.
        const plainUpdate = frame({ t: 'message-updated', text: lines(20, 30), updatedAt: 4_000, base: { updatedAt: 2_000, length: lines(0, 20).length } });
        const sealedRecord = plainUpdate.body.message.content.v;
        const update = { ...plainUpdate, body: { ...plainUpdate.body, message: { ...plainUpdate.body.message, content: { t: 'encrypted', c: 'sealed' } } } };
        await handleMessageUpdatedSocketUpdate({
            ...params(update),
            getSession: () => ({ ...session, encryptionMode: 'e2ee' as const }),
            getSessionEncryption: () => ({ decryptMessage: async (message: { id: string }) => ({
                id: message.id, seq: 6, localId: null, createdAt: 1_000, updatedAt: 4_000, messageRole: 'agent', content: sealedRecord,
            }) }),
        } as never);
        expect(applied).toHaveLength(appliedBefore);
        expect(reads).toHaveBeenCalledTimes(1);
    });
});
