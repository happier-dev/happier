import { describe, expect, it } from 'vitest';

import type { DiscardedPendingMessage, PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    buildTranscriptRowShellSignature,
    type TranscriptRowShellItem,
} from './transcriptRowShellSignature';

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
        // No `action-draft` row in this file; the option resolver is exercised in
        // `actionDraftStatusChurn.consumers.test.ts`.
        resolveActionDraftFieldOptions: () => [],
        resolveThinkingExpanded: () => false,
        sessionActive: true,
        widthBucket: 'w:400',
        fontScaleKey: 'fs:1',
    });
}

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
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

function pendingQueueItem(
    pendingMessages: PendingMessage[],
    discardedMessages: DiscardedPendingMessage[] = [],
): TranscriptRowShellItem {
    return {
        kind: 'pending-queue',
        id: 'pending-queue',
        pendingMessages,
        discardedMessages,
    };
}

/**
 * J/D2 (2026-07-30): `ChatListInternal` wires Legend's vendored `getItemSizeVersion` to this
 * signature, and the patched `validateItemSizeVersion` DELETES the row's measured size whenever the
 * version moves (`TranscriptRowShell` additionally wipes its reservation on an
 * `isStructuralSignatureDelta`). So a signature that churns on non-visual record fields destroys the
 * row's measurement on every server tick — measured on native as a ±12.70px scroll oscillation with
 * `contentLength` byte-identical while the pending row is on screen.
 */
describe('pending row signatures are presentation-scoped', () => {
    it('ignores a pending record tick that changes nothing the row paints', () => {
        const before = signatureFor(pendingQueueItem([pendingMessage()]));
        const after = signatureFor(pendingQueueItem([pendingMessage({
            updatedAt: 9_999,
            rawRecord: { v: 2, serverTouchedAt: 9_999 },
        })]));

        expect(after.structuralKey).toBe(before.structuralKey);
    });

    it('moves when the queue composition changes, so a drained queue re-seeds its floor', () => {
        const two = signatureFor(pendingQueueItem([
            pendingMessage({ id: 'p1', localId: 'l1' }),
            pendingMessage({ id: 'p2', localId: 'l2' }),
        ]));
        const one = signatureFor(pendingQueueItem([pendingMessage({ id: 'p1', localId: 'l1' })]));

        expect(one.structuralKey).not.toBe(two.structuralKey);
    });

    it('moves when the rendered text extent changes', () => {
        const short = signatureFor(pendingQueueItem([pendingMessage({ text: 'hi' })]));
        const long = signatureFor(pendingQueueItem([pendingMessage({ text: 'x'.repeat(400) })]));
        const wrapped = signatureFor(pendingQueueItem([pendingMessage({ text: 'a\nb' })]));
        const flat = signatureFor(pendingQueueItem([pendingMessage({ text: 'ab ' })]));

        expect(long.structuralKey).not.toBe(short.structuralKey);
        expect(wrapped.structuralKey).not.toBe(flat.structuralKey);
    });

    /**
     * F-P2 (2026-08-10): delivery status selects the row's status CHIP, and that chip is
     * `position: 'absolute'` (`PendingMessagesTranscriptBlock` `pendingAffordanceChip`), so it can
     * never move the row's height. In THIS repository the chip is the only thing delivery status
     * selects — the block's single in-flow status notice is `blockedDeliveryNotice`, and even the
     * `queuedReason` copy is painted inside that absolute chip. So a plain send walks
     * `saving → send_unconfirmed → queued → delivering` painting a byte-identical box.
     */
    it('holds the key across a delivery-status walk that paints an identical box', () => {
        const walk = [
            pendingMessage(),
            pendingMessage({ sendState: 'unconfirmed' }),
            pendingMessage({ deliveryStatus: 'accepted' }),
            pendingMessage({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_queued' }),
            pendingMessage({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'server_delivering' }),
            pendingMessage({ source: 'server_pending', deliveryStatus: 'queued', pendingDeliveryStatus: 'external_handoff' }),
            pendingMessage({ sendState: 'failed' }),
            pendingMessage({ pendingOutboxOperation: 'cancel' }),
        ].map((message) => signatureFor(pendingQueueItem([message])).structuralKey);

        expect(new Set(walk).size).toBe(1);
    });

    it('moves when the row switches to a state that paints extra chrome', () => {
        const queued = signatureFor(pendingQueueItem([pendingMessage({ source: 'server_pending' })]));
        const blocked = signatureFor(pendingQueueItem([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        })]));
        // Same notice box, different copy — hence a different line count at narrow widths.
        const blockedOtherReason = signatureFor(pendingQueueItem([pendingMessage({
            source: 'server_pending',
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'payload_too_large',
        })]));

        expect(blocked.structuralKey).not.toBe(queued.structuralKey);
        expect(blockedOtherReason.structuralKey).not.toBe(blocked.structuralKey);
    });

    it('sizes discarded rows by their own presentation, not by a record serialization', () => {
        const discarded = (overrides: Partial<DiscardedPendingMessage>): DiscardedPendingMessage => ({
            ...pendingMessage({ id: 'd1', localId: 'ld1' }),
            discardedAt: 5,
            ...overrides,
        } as DiscardedPendingMessage);

        const plain = signatureFor(pendingQueueItem([], [discarded({})]));
        const ticked = signatureFor(pendingQueueItem([], [discarded({ updatedAt: 7_777, rawRecord: { v: 3 } })]));
        const withReason = signatureFor(pendingQueueItem([], [discarded({ discardedReason: 'manual' })]));

        expect(ticked.structuralKey).toBe(plain.structuralKey);
        expect(withReason.structuralKey).not.toBe(plain.structuralKey);
    });

    it('keeps an unbounded permission-request payload out of the size version', () => {
        const request = (args: unknown) => ({
            kind: 'pending-user-action' as const,
            id: 'pending-user-action:r1',
            request: {
                id: 'r1',
                tool: 'Bash',
                kind: 'user_action' as const,
                arguments: args,
                createdAt: 1,
            },
            createdAt: 1,
        }) as TranscriptRowShellItem;

        const small = signatureFor(request({ command: 'ls' }));
        const huge = signatureFor(request({ command: 'x'.repeat(200_000) }));

        expect(huge.structuralKey).toBe(small.structuralKey);
        expect(huge.structuralKey.length).toBeLessThan(200);
    });

    it('keys a fork divider and a window gap on their own identity', () => {
        const divider = signatureFor({
            kind: 'fork-divider',
            id: 'fork:1',
            parentSessionId: 'parent',
            childSessionId: 'child',
            parentCutoffSeqInclusive: 12,
        });
        const gap = signatureFor({
            kind: 'transcript-window-gap',
            id: 'gap:older',
            direction: 'older',
        });

        expect(divider.structuralKey).toContain('parent');
        expect(divider.rowState).toBe('stable');
        expect(gap.structuralKey).toContain('older');
        expect(gap.rowState).toBe('stable');
    });
});

/**
 * F-P5 (2026-08-10) — the OPPOSITE direction of F-P2/F-P4 in the same corridor: this row's key must
 * also not be BLIND to a change that repaints the whole card.
 *
 * `useTranscriptRowHost` selects the card from `item.progress`: null renders
 * `ExternalSessionOperationSharedCard` (group title + one status `Item` + an optional dismiss
 * `Item`), non-null renders `ExternalImportProgressCard` (group title + a status `Item` WITH a
 * subtitle + an N-step `ProgressChecklist` + an optional import row + an optional published row +
 * one `Item` per action). `appendExternalSessionOperationTranscriptItem` adopts `progress` only when
 * `matchesExternalSessionOperationPresentation` holds, and that identity is
 * `(v, operationId, revision, kind, status, phase)` — so at the owner-hydration transition
 * `progress.status === presentation.status` and `progress.phase === presentation.phase` BY
 * CONSTRUCTION, and every other keyed leg (`error.code`, `retryTargetPhase`, `publication`) is empty
 * on the healthy path. The card swap was therefore invisible to the size version.
 */
describe('the external-session-operation row keys the card it actually paints', () => {
    // Narrow boundary fixture: the signature reads a handful of fields off two large protocol
    // records, and constructing valid whole records here would test the schema, not the key.
    function externalOperationItem(progress: unknown): TranscriptRowShellItem {
        return {
            kind: 'external-session-operation',
            id: 'external-session-operation:op-1',
            presentation: {
                v: 1,
                operationId: 'op-1',
                revision: 3,
                kind: 'import',
                status: 'running',
                phase: 'importing',
            },
            progress,
            createdAt: 0,
        } as unknown as TranscriptRowShellItem;
    }

    const hydratedProgress = {
        operationId: 'op-1',
        revision: 3,
        kind: 'import',
        status: 'running',
        phase: 'importing',
        timeline: ['queued', 'importing'],
        fence: { kind: 'complete' },
    };

    it('moves when owner hydration swaps the shared card for the progress card', () => {
        const beforeHydration = signatureFor(externalOperationItem(null));
        const afterHydration = signatureFor(externalOperationItem(hydratedProgress));

        expect(afterHydration.structuralKey).not.toBe(beforeHydration.structuralKey);
    });

    it('still ignores the live import counters that only change text inside a line', () => {
        const early = signatureFor(externalOperationItem({
            ...hydratedProgress,
            updatedAtMs: 1_000,
            import: { importedItemCount: 4, totalItemEstimate: 900 },
        }));
        const later = signatureFor(externalOperationItem({
            ...hydratedProgress,
            updatedAtMs: 9_000,
            import: { importedItemCount: 812, totalItemEstimate: 900 },
        }));

        expect(later.structuralKey).toBe(early.structuralKey);
    });
});
