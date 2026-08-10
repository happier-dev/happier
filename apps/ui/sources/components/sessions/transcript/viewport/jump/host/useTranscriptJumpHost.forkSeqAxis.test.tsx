/**
 * `seq` counts from each session's own origin. A forked transcript renders its read-only
 * ancestor context in the same list as its own rows, so two rows there can carry the same seq
 * while belonging to different histories — and an ancestor's numbering can run far above this
 * session's (observed live: ancestor max seq 417_565 against a fork's 15_038).
 *
 * The target window is a seq RANGE over the viewed session's history. These tests pin the rule
 * that makes that range meaningful in a mixed list: only rows this session numbered sit on its
 * seq axis. Everything downstream — window slicing, gap detection, loaded-range checks — reads
 * the axis through these two facts.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';

import { useTranscriptJumpWindowFacts } from './useTranscriptJumpHost';

// One frozen snapshot: `useSyncExternalStore` re-renders while `getSnapshot` keeps returning a
// new object, so a fresh literal per call would spin rather than test anything.
const INACTIVE_WINDOW_STATE = Object.freeze({
    isWindowMode: false,
    windowId: null,
    windowMinSeq: null,
    windowMaxSeq: null,
    targetSeq: null,
    hasMoreOlder: false,
    hasMoreNewer: false,
    olderCursor: null,
    newerCursor: null,
});

vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionTargetWindowState: () => INACTIVE_WINDOW_STATE,
        subscribeSessionTargetWindowState: () => () => undefined,
    },
}));

const SESSION_ID = 'fork-session';
const ANCESTOR_SESSION_ID = 'ancestor-session';

function message(id: string, seq: number): Message {
    return { id, localId: null, seq, createdAt: seq * 1000, kind: 'user-text', text: id } as unknown as Message;
}

function messageItem(id: string, messageId: string, seq: number): ChatTranscriptListItem {
    return { id, kind: 'message', messageId, seq } as unknown as ChatTranscriptListItem;
}

/** Own row at seq 40; ancestor row carrying the SAME seq, which must not be confusable. */
const OWN = message('own-40', 40);
const ANCESTOR = message('ancestor-40', 40);
const ANCESTOR_HIGH = message('ancestor-9000', 9_000);

const FORK_METADATA = {
    'own-40': { originSessionId: SESSION_ID, isReadOnlyContext: false },
    'ancestor-40': { originSessionId: ANCESTOR_SESSION_ID, isReadOnlyContext: true },
    'ancestor-9000': { originSessionId: ANCESTOR_SESSION_ID, isReadOnlyContext: true },
} as const;

async function renderFacts(forkMessageMetadataById: Record<string, { originSessionId: string; isReadOnlyContext: boolean }> | null) {
    return renderHook(() => useTranscriptJumpWindowFacts({
        forkMessageMetadataById,
        getMessageById: (messageId: string) => ({
            'own-40': OWN,
            'ancestor-40': ANCESTOR,
            'ancestor-9000': ANCESTOR_HIGH,
        } as Record<string, Message>)[messageId] ?? null,
        messagesById: { 'own-40': OWN, 'ancestor-40': ANCESTOR, 'ancestor-9000': ANCESTOR_HIGH },
        sessionId: SESSION_ID,
    }));
}

describe('useTranscriptJumpWindowFacts fork seq axis', () => {
    it('places this session’s rows on the seq axis and leaves ancestor rows off it', async () => {
        const rendered = await renderFacts({ ...FORK_METADATA });
        const facts = rendered.getCurrent();

        expect(facts.resolveTargetWindowItemSeq(messageItem('i1', 'own-40', 40))).toBe(40);
        // Same seq, different history: admitting it would put a row from hours away inside a
        // window band built around this session's seq 40.
        expect(facts.resolveTargetWindowItemSeq(messageItem('i2', 'ancestor-40', 40))).toBeNull();

        await rendered.unmount();
    });

    it('reports only this session’s seqs as loaded', async () => {
        const rendered = await renderFacts({ ...FORK_METADATA });
        const facts = rendered.getCurrent();

        expect(facts.isSeqLoaded(40)).toBe(true);
        // Claiming 9000 is loaded would tell gap detection this session holds a seq it has
        // never fetched, silently suppressing the gap that should page it in.
        expect(facts.isSeqLoaded(9_000)).toBe(false);

        await rendered.unmount();
    });

    it('leaves an ordinary transcript unchanged, where every row is this session’s', async () => {
        const rendered = await renderFacts(null);
        const facts = rendered.getCurrent();

        expect(facts.resolveTargetWindowItemSeq(messageItem('i2', 'ancestor-40', 40))).toBe(40);
        expect(facts.isSeqLoaded(9_000)).toBe(true);

        await rendered.unmount();
    });
});
