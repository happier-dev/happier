import { describe, expect, it } from 'vitest';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { buildTranscriptItemHeightSignatureKey } from './transcriptItemHeightCache';
import { estimateTranscriptRowHeightFromCache } from './estimateTranscriptRowHeightFromCache';
import {
    createTestTranscriptMeasurementReconciler,
    isStructuralSignatureDelta,
} from './transcriptMeasurementReconciler';
import {
    buildTranscriptRowShellSignature,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

/**
 * F-P2 (2026-08-10) — the pending-queue row's structural key reaches FIVE consumers, and a plain
 * send used to move it two or three times while the row painted a byte-identical box:
 *
 *   C1  Legend `getItemSizeVersion` -> vendored `validateItemSizeVersion`: deletes `sizes` +
 *       `sizesKnown`, reverses the per-type size average, `addTotalSize(-size)`.
 *   C2  `TranscriptRowShell` layout effect -> `resetReservationForStructuralChange`: nulls
 *       `minHeight` AND `lastMeasuredHeight`.
 *   C3  `resolveTranscriptRowShellHeight`: renders that frame with no `minHeight`.
 *   C4  `isFloorShapeValid`: `pending-action` is shrink-capable, so the floor is refused.
 *   C5  `estimateTranscriptRowHeightFromCache`: with C2 done, falls through to the synthetic
 *       `estimatePendingQueueRowPx`.
 *
 * This file drives all five from ONE signature pair per direction, so the fix is proven where the
 * cost was paid rather than only at the key. The two directions each kill the other's naive
 * implementation: keeping `visualState.kind` fails the first, dropping delivery state from the key
 * entirely fails the second.
 */

function signatureFor(item: TranscriptRowShellItem) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => null,
        groupingMode: 'linear',
        item,
        latestCommittedActivityKey: null,
        // No `action-draft` row in this file, so the resolver is never called.
        resolveActionDraftFieldOptions: () => [],
        resolveThinkingExpanded: () => false,
        sessionActive: true,
        widthBucket: 'w:400',
        fontScaleKey: 'fs:1',
    });
}

function pendingQueueItem(pendingMessages: PendingMessage[]): TranscriptRowShellItem {
    return {
        kind: 'pending-queue',
        id: 'pending-queue',
        pendingMessages,
        discardedMessages: [],
    };
}

function base(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'l1',
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound',
        text: 'hello',
        rawRecord: { v: 1 },
        ...overrides,
    } as PendingMessage;
}

/**
 * The projection shapes ONE send passes through, taken from the shapes the store writers actually
 * publish (`sync/store/domains/pending.sendLifecycleCrossover.test.ts#SEND_LIFECYCLE_SHAPES` for the
 * local leg, `pendingQueueV2` server projections for the durable leg). None of them changes the
 * chrome the row paints: the status chip is `position: 'absolute'` and the three in-flow notices
 * (blocked / send-failed / queued-reason) are absent in every one of them.
 */
const SAME_HEIGHT_SEND_LIFECYCLE: readonly Readonly<{ name: string; message: PendingMessage }>[] = [
    { name: 'pre-ack optimistic (saving)', message: base() },
    { name: 'ack-timeout (send_unconfirmed)', message: base({ deliveryStatus: 'queued', sendState: 'unconfirmed' }) },
    { name: 'accepted local projection (queued)', message: base({ deliveryStatus: 'accepted' }) },
    {
        name: 'server pending (queued)',
        message: base({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_queued' }),
    },
    {
        name: 'server delivering (delivering)',
        message: base({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_delivering' }),
    },
];

/**
 * The row grows a real in-flow notice here: every consumer must still be invalidated. Deliberately
 * the SEND-FAILED notice (+36px, notice plus an inline retry `Pressable`), because it is the growth
 * that carries NO `deliveryBlockedPresentation` — so a key that simply dropped delivery state would
 * hold here, and this case is what refutes it.
 */
const GAINS_IN_FLOW_NOTICE = {
    from: base(),
    to: base({ sendState: 'failed' }),
} as const;

/** The +26px blocked notice, the other growth direction. */
const GAINS_BLOCKED_NOTICE = {
    from: base({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_queued' }),
    to: base({
        source: 'server_pending',
        deliveryStatus: 'queued',
        pendingDeliveryStatus: 'blocked',
        pendingDeliveryBlockedReason: 'terminal_composer_draft',
    }),
} as const;

describe('pending row delivery-status churn — the five size-key consumers', () => {
    it('holds the Legend item-size version across the whole same-height send lifecycle', () => {
        const keys = SAME_HEIGHT_SEND_LIFECYCLE.map(({ message }) => (
            buildTranscriptItemHeightSignatureKey(signatureFor(pendingQueueItem([message])))
        ));

        // C1: `validateItemSizeVersion` never fires, so `sizes`/`sizesKnown` survive the send.
        expect(new Set(keys).size).toBe(1);
    });

    it('reports no structural delta across the same-height send lifecycle', () => {
        for (let index = 1; index < SAME_HEIGHT_SEND_LIFECYCLE.length; index += 1) {
            const previous = signatureFor(pendingQueueItem([SAME_HEIGHT_SEND_LIFECYCLE[index - 1]!.message]));
            const next = signatureFor(pendingQueueItem([SAME_HEIGHT_SEND_LIFECYCLE[index]!.message]));
            // C2: `TranscriptRowShell` no longer calls `resetReservationForStructuralChange`.
            expect(isStructuralSignatureDelta(previous, next), SAME_HEIGHT_SEND_LIFECYCLE[index]!.name).toBe(false);
        }
    });

    it('keeps the reservation, the last measured height AND the cached estimate across a status step', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const saving = signatureFor(pendingQueueItem([SAME_HEIGHT_SEND_LIFECYCLE[0]!.message]));
        reconciler.recordMeasuredHeight({ signature: saving, heightPx: 88 });

        const delivering = signatureFor(pendingQueueItem([SAME_HEIGHT_SEND_LIFECYCLE[4]!.message]));

        // C3 + C4: the floor shape is still valid, so the row renders that frame WITH its minHeight.
        expect(reconciler.resolveReservation(delivering)).toEqual({ kind: 'floor', minHeight: 88 });
        expect(reconciler.resolveLastMeasuredHeight(delivering)).toBe(88);
        // C5: the virtualizer keeps a measured height and never falls back to the synthetic estimate.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: delivering })).toBe(88);
    });

    it.each([
        ['send-failed retry notice', GAINS_IN_FLOW_NOTICE],
        ['blocked notice', GAINS_BLOCKED_NOTICE],
    ] as const)('still destroys the stale reservation when the row gains a %s', (_name, step) => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const before = signatureFor(pendingQueueItem([step.from]));
        reconciler.recordMeasuredHeight({ signature: before, heightPx: 88 });

        const after = signatureFor(pendingQueueItem([step.to]));

        // C1 + C2: a row that is about to paint taller must not keep the shorter measurement.
        expect(buildTranscriptItemHeightSignatureKey(after))
            .not.toBe(buildTranscriptItemHeightSignatureKey(before));
        expect(isStructuralSignatureDelta(before, after)).toBe(true);
        // C4: the floor is refused immediately, before the shell effect runs.
        expect(reconciler.resolveReservation(after)).toBeUndefined();
        reconciler.resetReservationForStructuralChange({ itemId: 'pending-queue', signature: after });
        expect(reconciler.resolveLastMeasuredHeight(after)).toBeUndefined();
    });

    it('cannot see the one runtime-derived status that changes the row height', () => {
        // KNOWN RESIDUAL, unchanged by this fix and deliberately not bought back: the signature calls
        // `getPendingMessageVisualState` without `sessionRuntime`, so the runtime-driven
        // `queued ↔ queued_behind_turn` flip (a real ±26px in-flow notice, record byte-identical) does
        // not move the key. The row's own `onLayout` stays the measurement authority for it.
        const message = base({ source: 'server_pending', deliveryStatus: 'queued' });
        const keyed = signatureFor(pendingQueueItem([message]));
        const alsoKeyed = signatureFor(pendingQueueItem([{ ...message, updatedAt: 9_999 }]));
        expect(alsoKeyed.structuralKey).toBe(keyed.structuralKey);
    });
});
