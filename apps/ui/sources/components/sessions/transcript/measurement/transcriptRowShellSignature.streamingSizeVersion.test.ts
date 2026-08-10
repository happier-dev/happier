import { describe, expect, it } from 'vitest';

import type { AgentTextMessage, Message } from '@/sync/domains/messages/messageTypes';

import { buildTranscriptItemHeightSignatureKey } from './transcriptItemHeightCache';
import {
    buildTranscriptRowShellSignature,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

/**
 * R2 (2026-08-10) · a row that is still growing must not have its own MEASUREMENT thrown away by
 * every write that made it grow.
 *
 * `ChatListInternal` wires the vendored Legend `getItemSizeVersion` to
 * `buildTranscriptItemHeightSignatureKey(buildTranscriptRowShellSignature(item))`, and the patch's
 * `validateItemSizeVersion` responds to a MOVED version by deleting the row's `sizesKnown` AND
 * `sizes` entries (`patches/@legendapp+list+3.3.3.patch`), after which the row is positioned from
 * `getEstimatedItemSize` until it measures again. A message row's structural key is
 * `messageId:r<revision>` and the store bumps that revision on EVERY write, so a streaming reply
 * discarded its real measured height on every chunk and the whole transcript was laid out against a
 * guess for the entire time the user was watching it — the reported down-then-up excursion.
 *
 * The key these cases assert on is therefore literally the renderer's size version: equal key ⇒ the
 * measurement survives, moved key ⇒ Legend deletes it. The cases below pin both directions, because
 * the version is load-bearing for every row that CANNOT re-measure itself (an offscreen row has no
 * mounted container and no onLayout), and an implementation that simply stopped invalidating would
 * reinstate the stale-size bug those cases describe.
 */

const STREAMED_MESSAGE_ID = 'm1';

function agentText(overrides: Partial<AgentTextMessage> = {}): Message {
    return {
        kind: 'agent-text',
        id: STREAMED_MESSAGE_ID,
        localId: null,
        createdAt: 1,
        text: 'partial reply',
        ...overrides,
    } as Message;
}

function messageRow(): TranscriptRowShellItem {
    return { kind: 'message', id: 'i1', messageId: STREAMED_MESSAGE_ID } as TranscriptRowShellItem;
}

function sizeVersionFor(params: Readonly<{
    activeThinkingMessageId?: string | null;
    message?: Message;
    revision: number;
    /** `sessionActive && isLatestCommittedActivity` is what makes the tail row `streaming`. */
    isLatestCommittedActivity?: boolean;
    sessionActive?: boolean;
    thinkingExpanded?: boolean;
    widthBucket?: string;
}>): string {
    const signature = buildTranscriptRowShellSignature({
        activeThinkingMessageId: params.activeThinkingMessageId ?? null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null,
        getMessageById: () => params.message ?? agentText(),
        getMessageRevisionById: () => params.revision,
        groupingMode: 'linear',
        item: messageRow(),
        latestCommittedActivityKey: (params.isLatestCommittedActivity ?? true) ? STREAMED_MESSAGE_ID : null,
        resolveThinkingExpanded: () => params.thinkingExpanded ?? false,
        sessionActive: params.sessionActive ?? true,
        widthBucket: params.widthBucket ?? 'w:400',
        fontScaleKey: 'fs:1',
    });
    return buildTranscriptItemHeightSignatureKey(signature);
}

describe('R2 · a streaming row keeps its measured size across the writes that grow it', () => {
    it('holds the size version steady while the streamed message revision advances', () => {
        // The defect, stated as its contract. Every chunk bumps the revision; none of them may
        // delete the row's measured height, because the mounted row re-measures itself through
        // its own onLayout and the deleted size is replaced by an ESTIMATE in the meantime.
        const first = sizeVersionFor({ revision: 1, message: agentText({ text: 'a' }) });
        const later = sizeVersionFor({ revision: 2, message: agentText({ text: 'a longer body' }) });
        const laterStill = sizeVersionFor({ revision: 37, message: agentText({ text: 'a longer body still' }) });

        expect(later).toBe(first);
        expect(laterStill).toBe(first);
    });

    it('holds it steady for a LIVE thinking block too, the other growing shape', () => {
        const first = sizeVersionFor({
            activeThinkingMessageId: STREAMED_MESSAGE_ID,
            message: agentText({ isThinking: true, text: 'thought' }),
            revision: 1,
        });
        const later = sizeVersionFor({
            activeThinkingMessageId: STREAMED_MESSAGE_ID,
            message: agentText({ isThinking: true, text: 'thought, continued' }),
            revision: 2,
        });

        expect(later).toBe(first);
    });

    /**
     * The other half of the contract. Each case below is a shape change that a row will NOT
     * re-measure on its own — it can happen while the row is scrolled out of the render window,
     * where there is no mounted container and therefore no onLayout — so the version MUST move and
     * Legend MUST drop the stale measurement. Together they kill an implementation that stops
     * invalidating, or that drops the revision for every row rather than only a growing one.
     */
    describe('while still invalidating every size change a row cannot re-measure itself', () => {
        it('moves when a SETTLED message is rewritten (server reconciliation of a past turn)', () => {
            // Not the tail, so not streaming: a replaced body is exactly the case the version owns.
            const before = sizeVersionFor({
                isLatestCommittedActivity: false,
                message: agentText({ text: 'first delivery' }),
                revision: 1,
            });
            const after = sizeVersionFor({
                isLatestCommittedActivity: false,
                message: agentText({ text: 'reconciled, much shorter' }),
                revision: 2,
            });

            expect(after).not.toBe(before);
        });

        it('moves when the row stops streaming, so the finalized shape re-measures', () => {
            const streaming = sizeVersionFor({ revision: 5 });
            const settled = sizeVersionFor({ isLatestCommittedActivity: false, revision: 5 });

            expect(settled).not.toBe(streaming);
        });

        it('moves when a live thinking block is expanded or collapsed', () => {
            // The sharpest case for a GROWING row: a collapse shrinks it to a header, and nothing
            // about the message record changes. If growth-scoping swallowed this, a collapsed
            // thinking block would keep reserving its expanded height.
            const collapsed = sizeVersionFor({
                activeThinkingMessageId: STREAMED_MESSAGE_ID,
                message: agentText({ isThinking: true }),
                revision: 3,
                thinkingExpanded: false,
            });
            const expanded = sizeVersionFor({
                activeThinkingMessageId: STREAMED_MESSAGE_ID,
                message: agentText({ isThinking: true }),
                revision: 3,
                thinkingExpanded: true,
            });

            expect(expanded).not.toBe(collapsed);
        });

        it('moves when a growing row changes rendered kind', () => {
            const thinking = sizeVersionFor({
                activeThinkingMessageId: STREAMED_MESSAGE_ID,
                message: agentText({ isThinking: true }),
                revision: 4,
            });
            const reply = sizeVersionFor({ message: agentText({ isThinking: false }), revision: 4 });

            expect(reply).not.toBe(thinking);
        });

        it('moves when the pane width bucket changes under a streaming row', () => {
            const narrow = sizeVersionFor({ revision: 6, widthBucket: 'w:400' });
            const wide = sizeVersionFor({ revision: 6, widthBucket: 'w:832' });

            expect(wide).not.toBe(narrow);
        });
    });
});
