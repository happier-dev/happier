import { describe, expect, it } from 'vitest';

import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';

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
 * F-P3 (2026-08-10) — the SAME defect F-P2 fixed for the pending row, in the `action-draft` branch
 * twenty lines below it: the row's structural key folded in `draft.status`, and that status decides
 * nothing about the card's height.
 *
 * `SessionActionDraftCard` reads `props.draft.status` in exactly three places — `editable`
 * (`ActionInputFields`, which only forwards it to `TextInput.editable` / `Pressable.disabled`),
 * `disabled`, and `opacity`. None of them adds, removes, or reflows a box. The one height-bearing
 * fact in that key is `draft.error`, which gates a real in-flow `<Text>` line.
 *
 * So `editing -> running` (every action start) moved the key with the painted box byte-identical,
 * and paid it through all five consumers the pending row pays it through:
 *
 *   C1  Legend `getItemSizeVersion` -> vendored `validateItemSizeVersion`: deletes `sizes` +
 *       `sizesKnown` and reverses the per-type average.
 *   C2  `TranscriptRowShell` layout effect -> `resetReservationForStructuralChange`.
 *   C3  `resolveTranscriptRowShellHeight`: renders that frame with no `minHeight`.
 *   C4  `isFloorShapeValid`: `pending-action` is shrink-capable, so the floor is refused.
 *   C5  `estimateTranscriptRowHeightFromCache`: falls through to the flat `ESTIMATE_COMPACT_ROW_PX`.
 *
 * The two directions below each kill the other's naive implementation: keeping `draft.status` fails
 * the first, dropping the draft's delivery-shaped state from the key ENTIRELY fails the second.
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
        resolveThinkingExpanded: () => false,
        sessionActive: true,
        widthBucket: 'w:400',
        fontScaleKey: 'fs:1',
    });
}

function draftItem(draft: SessionActionDraft): TranscriptRowShellItem {
    return { kind: 'action-draft', id: `draft:${draft.id}`, draft };
}

function draft(overrides: Partial<SessionActionDraft> = {}): SessionActionDraft {
    return {
        id: 'd1',
        sessionId: 's1',
        actionId: 'subagents.delegate.start',
        createdAt: 1_000,
        status: 'editing',
        input: { backendTargetKeys: 'agent:codex', instructions: 'Do the thing.' },
        ...overrides,
    };
}

/**
 * The status walk one draft actually performs, from `SessionActionDraftCard`'s own writers:
 * `setStatus('running', null)` on submit, then either `setStatus('succeeded')` + `cancel()` (the row
 * is removed, so it never re-keys) or `setStatus('editing', message)` on failure (which is the
 * height-CHANGING direction below, because it also sets `error`). `cancelled` is written by the
 * transcript's own cancel affordance. None of these paints a different box.
 */
const SAME_HEIGHT_DRAFT_STATUS_WALK: readonly Readonly<{ name: string; draft: SessionActionDraft }>[] = [
    { name: 'editing', draft: draft() },
    { name: 'running (start pressed)', draft: draft({ status: 'running' }) },
    { name: 'cancelled', draft: draft({ status: 'cancelled' }) },
    { name: 'succeeded (pre-removal frame)', draft: draft({ status: 'succeeded' }) },
    { name: 'failed', draft: draft({ status: 'failed' }) },
];

/** The one thing in this row that genuinely grows it: the in-flow error line at the card's `:195`. */
const GAINS_IN_FLOW_ERROR_LINE = {
    from: draft({ status: 'running' }),
    to: draft({ status: 'editing', error: 'RPC method not available' }),
} as const;

describe('action-draft status churn — the five size-key consumers', () => {
    it('holds the Legend item-size version across the whole draft status walk', () => {
        const keys = SAME_HEIGHT_DRAFT_STATUS_WALK.map(({ draft: d }) => (
            buildTranscriptItemHeightSignatureKey(signatureFor(draftItem(d)))
        ));

        // C1: `validateItemSizeVersion` never fires, so `sizes`/`sizesKnown` survive an action start.
        expect(new Set(keys).size).toBe(1);
    });

    it('reports no structural delta across the draft status walk', () => {
        for (let index = 1; index < SAME_HEIGHT_DRAFT_STATUS_WALK.length; index += 1) {
            const previous = signatureFor(draftItem(SAME_HEIGHT_DRAFT_STATUS_WALK[index - 1]!.draft));
            const next = signatureFor(draftItem(SAME_HEIGHT_DRAFT_STATUS_WALK[index]!.draft));
            // C2: `TranscriptRowShell` no longer calls `resetReservationForStructuralChange`.
            expect(isStructuralSignatureDelta(previous, next), SAME_HEIGHT_DRAFT_STATUS_WALK[index]!.name).toBe(false);
        }
    });

    it('keeps the reservation, the last measured height AND the cached estimate across a status step', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const editing = signatureFor(draftItem(draft()));
        reconciler.recordMeasuredHeight({ signature: editing, heightPx: 214 });

        const running = signatureFor(draftItem(draft({ status: 'running' })));

        // C3 + C4: the floor shape is still valid, so the row renders that frame WITH its minHeight.
        expect(reconciler.resolveReservation(running)).toEqual({ kind: 'floor', minHeight: 214 });
        expect(reconciler.resolveLastMeasuredHeight(running)).toBe(214);
        // C5: the virtualizer keeps the measured height instead of the flat compact-row estimate.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: running })).toBe(214);
    });

    it('still destroys the stale reservation when the draft gains its in-flow error line', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const before = signatureFor(draftItem(GAINS_IN_FLOW_ERROR_LINE.from));
        reconciler.recordMeasuredHeight({ signature: before, heightPx: 214 });

        const after = signatureFor(draftItem(GAINS_IN_FLOW_ERROR_LINE.to));

        // C1 + C2: a row that is about to paint taller must not keep the shorter measurement.
        expect(buildTranscriptItemHeightSignatureKey(after))
            .not.toBe(buildTranscriptItemHeightSignatureKey(before));
        expect(isStructuralSignatureDelta(before, after)).toBe(true);
        // C4: the floor is refused immediately, before the shell effect runs.
        expect(reconciler.resolveReservation(after)).toBeUndefined();
    });

    it('still invalidates when the error line disappears again', () => {
        const withError = signatureFor(draftItem(draft({ error: 'boom' })));
        const cleared = signatureFor(draftItem(draft({ error: null })));

        // The shrink direction: `clears stale draft errors when the user edits an input` writes
        // `error: null`, and the row loses a line.
        expect(buildTranscriptItemHeightSignatureKey(cleared))
            .not.toBe(buildTranscriptItemHeightSignatureKey(withError));
    });

    it('cannot see the card-local validation error, which is the row height it does not own', () => {
        // KNOWN RESIDUAL, same shape as the pending row's `queued <-> queued_behind_turn`: the card
        // paints `validationError ?? draft.error`, and `validationError` is card-local state derived
        // from the spec's required fields. It never reaches the projection, so the row's own
        // `onLayout` stays the measurement authority for it. Do not buy it back by lifting local
        // component state into the transcript item.
        const keyed = signatureFor(draftItem(draft()));
        const stillKeyed = signatureFor(draftItem(draft({ input: { backendTargetKeys: 'agent:codex', instructions: 'Do the thing.' } })));
        expect(stillKeyed.structuralKey).toBe(keyed.structuralKey);
    });
});
