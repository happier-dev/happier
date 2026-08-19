import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
    estimateTranscriptRowHeightFromCache,
    estimateTranscriptRowHeightFromContent,
    resolveCommittedUtteranceIdentityForEstimate,
} from './estimateTranscriptRowHeightFromCache';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import type { TranscriptRowShellItem } from './transcriptRowShellSignature';

const WIDTH = 'w:402';
const FONT = 'f:1';
/** `userMessageWrapper.paddingBottom` (`MessageView.tsx`) — the committed row's only extra chrome. */
const COMMITTED_WRAPPER_PADDING_BOTTOM_PX = 22;

function committedRowSignature(messageId: string): TranscriptItemHeightValiditySignature {
    return {
        itemId: `msg:${messageId}`,
        kind: 'message:user',
        rowState: 'stable',
        structuralKey: 'user-text',
        widthBucket: WIDTH,
        fontScaleKey: FONT,
        groupingMode: 'turns',
        forkContextKey: 'none',
        expansionKey: 'none',
    } satisfies TranscriptItemHeightValiditySignature;
}

function userMessage(overrides: Partial<Message> = {}): Message {
    return {
        id: 'm1',
        localId: 'utt-1',
        kind: 'user-text',
        text: 'x'.repeat(569),
        createdAt: 1,
    } as unknown as Message;
}

function messageItem(messageId = 'm1'): TranscriptRowShellItem {
    return { kind: 'message', id: `msg:${messageId}`, messageId } as TranscriptRowShellItem;
}

/**
 * The send crossover, measured on device (iPhone 17 Pro / iOS 26.5, 2026-08-18,
 * `.project/reviews/2026-08-18-send-crossover-native/DEVICE-MEASUREMENT.md`): the committed row
 * enters Legend under a brand-new key with no measurement, so it was placed from the flat wrap
 * heuristic (72 modelled chars per painted line against ~43 really painted). The transcript is
 * bottom-pinned, so the deficit moved the whole list DOWN by 163px for a 236-char send and 379px
 * for a 569-char one, and back UP a frame or more later. The pending block painted and measured
 * that exact bubble milliseconds earlier; this carries THAT measurement instead.
 */
describe('committed row inherits the pending bubble measurement across the send crossover', () => {
    it('serves the carried bubble height plus exactly the committed wrapper padding', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordPaintedUtteranceBubbleHeight({
            identity: 'utterance:utt-1',
            bubbleHeightPx: 304,
            widthBucket: WIDTH,
            fontScaleKey: FONT,
        });

        expect(estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: committedRowSignature('m1'),
            committedUtteranceIdentity: 'utterance:utt-1',
        })).toBe(304 + COMMITTED_WRAPPER_PADDING_BOTTOM_PX);
    });

    /**
     * The discriminating case: without the handoff the same row is sized from the wrap heuristic,
     * and for this text that answer is materially SHORTER than the painted height — which is the
     * defect, expressed as a number.
     */
    it('is materially taller than the wrap heuristic it replaces, for a real multi-line send', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const painted = 304;
        reconciler.recordPaintedUtteranceBubbleHeight({
            identity: 'utterance:utt-1',
            bubbleHeightPx: painted,
            widthBucket: WIDTH,
            fontScaleKey: FONT,
        });

        const carried = estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: committedRowSignature('m1'),
            committedUtteranceIdentity: 'utterance:utt-1',
        }) as number;
        const heuristic = estimateTranscriptRowHeightFromContent({
            getMessageById: () => userMessage(),
            item: messageItem(),
            toolCallsGroupChromeVariant: 'feed_background',
            platformIsWeb: false,
        }) as number;

        // 569 chars: the heuristic wraps at 72/line ⇒ 8 lines; the device painted 12 (bubble 304 =
        // paddingVertical 16 + 12 × 24). The gap between them is the four unmodelled painted lines
        // the viewport used to travel down and back on this exact send.
        expect(heuristic).toBe(38 + 8 * 24);
        expect(carried).toBe(painted + COMMITTED_WRAPPER_PADDING_BOTTOM_PX);
        expect(carried - heuristic).toBe(4 * 24);
    });

    it('never overrides the row own measurement', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = committedRowSignature('m1');
        reconciler.recordPaintedUtteranceBubbleHeight({
            identity: 'utterance:utt-1',
            bubbleHeightPx: 304,
            widthBucket: WIDTH,
            fontScaleKey: FONT,
        });
        reconciler.recordMeasuredHeight({ signature, heightPx: 411 });

        expect(estimateTranscriptRowHeightFromCache({
            reconciler,
            signature,
            committedUtteranceIdentity: 'utterance:utt-1',
        })).toBe(411);
    });

    it('refuses a measurement taken at a different width or font scale', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordPaintedUtteranceBubbleHeight({
            identity: 'utterance:utt-1',
            bubbleHeightPx: 304,
            widthBucket: 'w:1024',
            fontScaleKey: FONT,
        });

        expect(estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: committedRowSignature('m1'),
            committedUtteranceIdentity: 'utterance:utt-1',
        })).toBeUndefined();
    });

    it('drops carried heights on session change', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordPaintedUtteranceBubbleHeight({
            identity: 'utterance:utt-1',
            bubbleHeightPx: 304,
            widthBucket: WIDTH,
            fontScaleKey: FONT,
        });
        reconciler.resetForSession('other-session');

        expect(estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: committedRowSignature('m1'),
            committedUtteranceIdentity: 'utterance:utt-1',
        })).toBeUndefined();
    });
});

describe('which rows may inherit a carried utterance height', () => {
    it('selects a committed user-text row by its localId', () => {
        expect(resolveCommittedUtteranceIdentityForEstimate(messageItem(), () => userMessage()))
            .toBe('utterance:utt-1');
    });

    it('selects nothing for an agent row, a localId-less user row, or a non-message row', () => {
        expect(resolveCommittedUtteranceIdentityForEstimate(
            messageItem(),
            () => ({ ...userMessage(), kind: 'agent-text' } as unknown as Message),
        )).toBeNull();
        expect(resolveCommittedUtteranceIdentityForEstimate(
            messageItem(),
            () => ({ ...userMessage(), localId: null } as unknown as Message),
        )).toBeNull();
        expect(resolveCommittedUtteranceIdentityForEstimate(
            { kind: 'pending-queue', id: 'pending-queue', pendingMessages: [], discardedMessages: [] } as TranscriptRowShellItem,
            () => userMessage(),
        )).toBeNull();
    });
});

/**
 * The carry is only valid while the two chains paint the same box. `MessageView`'s user-text branch
 * can add a structured card, inline images, unavailable-media items, an attachments row and a
 * structured references row inside the same bubble; the pending block renders none of them, so a
 * carried bubble would undershoot by the whole block (~30-170px each). Those rows fall back to the
 * content heuristic instead of being served a measurement of a different shape.
 */
describe('rows whose committed bubble paints more than the pending one did', () => {
    function withMeta(meta: unknown): Message {
        return { ...userMessage(), meta } as unknown as Message;
    }

    it('excludes a structured-only send, which paints a card and no bubble at all', () => {
        expect(resolveCommittedUtteranceIdentityForEstimate(
            messageItem(),
            () => withMeta({ happier: { kind: 'participant_message.v1', payload: { text: 'hi', participant: { id: 'p', displayName: 'P' } } } }),
        )).toBeNull();
    });

    it('still carries a plain text send', () => {
        expect(resolveCommittedUtteranceIdentityForEstimate(messageItem(), () => withMeta(null)))
            .toBe('utterance:utt-1');
    });
});
