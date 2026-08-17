import { describe, expect, it } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import {
    appendPluginTranscriptActivityTranscriptItems,
} from '@/components/sessions/transcript/items/pluginTranscriptActivityTranscriptItem';

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
 * F-P4 (2026-08-10) — the same defect F-P2 fixed for the pending row, at a strictly HIGHER event
 * rate: the `plugin-transcript-activity` row's structural key folded in `progress.completed`,
 * `progress.total`, and the entire `checklist`.
 *
 * `PluginTranscriptActivityCard` renders progress as a fixed-width determinate rail beside a
 * bounded status row, plus one Item per checklist entry. A run ticking `1 / 10 -> 2 / 10 -> ...`
 * must preserve the measured geometry when neither text extent nor checklist membership changes,
 * through the same five consumers the pending row pays:
 *
 *   C1  Legend `getItemSizeVersion` -> `validateItemSizeVersion` (deletes `sizes` + `sizesKnown`).
 *   C2  `TranscriptRowShell` -> `resetReservationForStructuralChange`.
 *   C3  `resolveTranscriptRowShellHeight` renders that frame with no `minHeight`.
 *   C4  `isFloorShapeValid`: `pending-action` is shrink-capable, so the floor is refused.
 *   C5  `estimateTranscriptRowHeightFromCache` falls back to the flat `ESTIMATE_COMPACT_ROW_PX`.
 *
 * The directions below each kill the other's naive implementation. Keeping the counters or checklist
 * *states* fails the first group; dropping the projection's activity shape wholesale fails the
 * second, because checklist membership, `phase`, `actions`, group title and status copy can alter
 * rendered geometry.
 */

type PluginActivityItem = Extract<ChatListItem, { kind: 'plugin-transcript-activity' }>;

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

function activity(overrides: Partial<PluginActivityItem> = {}): PluginActivityItem {
    return {
        kind: 'plugin-transcript-activity',
        id: 'plugin-transcript-activity:build',
        identityKey: 'build',
        pluginId: 'acme.preview',
        contributionId: 'activity',
        generation: '7',
        sessionId: 'session-a',
        resourceId: 'live-activity',
        localActivityId: 'build',
        phase: 'running',
        title: 'Build',
        status: 'Compiling',
        progress: { completed: 1, total: 10 },
        checklist: [
            { id: 'lint', label: 'Lint', state: 'complete' },
            { id: 'build', label: 'Build', state: 'active' },
        ],
        dismissible: true,
        actions: [{ pluginId: 'acme.preview', localId: 'open', label: 'Open' }],
        freshness: 'current',
        createdAt: 0,
        ...overrides,
    } as PluginActivityItem;
}

function projectActivityWithSessionActionAdmission(
    isActionAvailable: (action: Readonly<{ pluginId: string; localId: string }>) => boolean,
): PluginActivityItem {
    // `isActionAvailable` is intentionally supplied by the existing Session Action controller at
    // the transcript-item owner. The current function type does not yet name that input, but a
    // structural source value keeps this RED case executing against today's public item builder.
    const input = {
        sessionId: 'session-a',
        activities: [activity()],
        dismissedActivityIds: new Set<string>(),
        isActionAvailable,
    };
    const row = appendPluginTranscriptActivityTranscriptItems([], input)
        .find((candidate): candidate is PluginActivityItem => candidate.kind === 'plugin-transcript-activity');
    if (!row) throw new Error('Expected the synthetic Plugin transcript Activity row.');
    return row;
}

/**
 * A live run's ticks, with the checklist changing state underneath but keeping the same bounded rows
 * and labels.
 *
 * V-2 (2026-08-11): the fixture this replaces used ticks 1, 2, 3 and 9 OF 10 only. Every one of those
 * renders `${completed} / ${total}` at the SAME character count, so the pre-V-2 key — full text
 * extent over a CLAMPED status line — held across all of them by construction. Its green was a zero
 * measured under conditions that structurally could not reach the defect. These ticks cross both
 * digit boundaries a real run crosses (`9 -> 10`, `99 -> 100`, and the total's own `10 -> 200`) and
 * change the plugin's status WORD, which is exactly where a length-based key moves while the painted
 * box does not.
 */
const SAME_HEIGHT_RUN_TICKS: readonly Readonly<{ name: string; item: PluginActivityItem }>[] = [
    { name: 'tick 9 / 10', item: activity({ progress: { completed: 9, total: 10 } }) },
    { name: 'tick 10 / 10 (digit boundary)', item: activity({ progress: { completed: 10, total: 10 } }) },
    {
        name: 'tick 99 / 200 + checklist advance',
        item: activity({
            progress: { completed: 99, total: 200 },
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                { id: 'build', label: 'Build', state: 'complete' },
            ],
        }),
    },
    {
        name: 'tick 100 / 200 (digit boundary) + checklist failure',
        item: activity({
            progress: { completed: 100, total: 200 },
            checklist: [
                { id: 'lint', label: 'Lint', state: 'failed' },
                { id: 'build', label: 'Build', state: 'pending' },
            ],
        }),
    },
    {
        name: 'status word change (Compiling -> Linking)',
        item: activity({ progress: { completed: 100, total: 200 }, status: 'Linking' }),
    },
];

describe('plugin activity progress churn — the five size-key consumers', () => {
    it('holds the Legend item-size version across a whole run of same-extent ticks', () => {
        const keys = SAME_HEIGHT_RUN_TICKS.map(({ item }) => (
            buildTranscriptItemHeightSignatureKey(signatureFor(item))
        ));

        // C1: `validateItemSizeVersion` never fires while the run reports progress.
        expect(new Set(keys).size).toBe(1);
    });

    it('reports no structural delta across those ticks', () => {
        for (let index = 1; index < SAME_HEIGHT_RUN_TICKS.length; index += 1) {
            const previous = signatureFor(SAME_HEIGHT_RUN_TICKS[index - 1]!.item);
            const next = signatureFor(SAME_HEIGHT_RUN_TICKS[index]!.item);
            // C2: `TranscriptRowShell` no longer calls `resetReservationForStructuralChange`.
            expect(isStructuralSignatureDelta(previous, next), SAME_HEIGHT_RUN_TICKS[index]!.name).toBe(false);
        }
    });

    it('keeps the reservation, the last measured height AND the cached estimate across a tick', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const first = signatureFor(SAME_HEIGHT_RUN_TICKS[0]!.item);
        reconciler.recordMeasuredHeight({ signature: first, heightPx: 96 });

        const later = signatureFor(SAME_HEIGHT_RUN_TICKS[3]!.item);

        // C3 + C4: the floor shape is still valid, so the row renders that frame WITH its minHeight.
        expect(reconciler.resolveReservation(later)).toEqual({ kind: 'floor', minHeight: 96 });
        expect(reconciler.resolveLastMeasuredHeight(later)).toBe(96);
        // C5: the virtualizer keeps the measured height instead of the flat compact-row estimate.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: later })).toBe(96);
    });

    it('still invalidates when the dismiss row appears', () => {
        // `canDismiss = dismissible && phase !== 'running'`, and the dismiss affordance is a whole
        // `Item`. `status` is pinned so the painted status LINE is identical across the step: the
        // only thing that changes is a row appearing.
        const running = signatureFor(activity({ phase: 'running', status: 'Working' }));
        const settled = signatureFor(activity({ phase: 'succeeded', status: 'Working' }));

        expect(buildTranscriptItemHeightSignatureKey(settled))
            .not.toBe(buildTranscriptItemHeightSignatureKey(running));
        expect(isStructuralSignatureDelta(running, settled)).toBe(true);
    });

    it('still invalidates when the projection gains or loses an Action row', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const before = signatureFor(activity());
        reconciler.recordMeasuredHeight({ signature: before, heightPx: 96 });

        const after = signatureFor(activity({
            actions: [
                { pluginId: 'acme.preview', localId: 'open', label: 'Open' },
                { pluginId: 'acme.preview', localId: 'retry', label: 'Retry' },
            ],
        }));

        // Each Action is its own `Item` row, so membership is height-bearing.
        expect(buildTranscriptItemHeightSignatureKey(after))
            .not.toBe(buildTranscriptItemHeightSignatureKey(before));
        // C4: the stale shorter floor is refused before the shell effect runs.
        expect(reconciler.resolveReservation(after)).toBeUndefined();
    });

    it('still invalidates when a bounded checklist row appears or its label gains a hard line break', () => {
        const before = signatureFor(activity());
        const addedStep = signatureFor(activity({
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                { id: 'build', label: 'Build', state: 'active' },
                { id: 'publish', label: 'Publish artifacts', state: 'pending' },
            ],
        }));
        const multilineStepLabel = signatureFor(activity({
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                { id: 'build', label: 'Build\nevery workspace package before publishing the final artifacts', state: 'active' },
            ],
        }));

        expect(buildTranscriptItemHeightSignatureKey(addedStep))
            .not.toBe(buildTranscriptItemHeightSignatureKey(before));
        expect(buildTranscriptItemHeightSignatureKey(multilineStepLabel))
            .not.toBe(buildTranscriptItemHeightSignatureKey(before));
    });

    /**
     * F-1 (2026-08-11) — V-2 dropped the length term at ANY clamp, which turned a safe over-key into
     * a real UNDER-key here. `checklistStepLabels` and `actionLabels` are clamp TWO (`Item` paints a
     * title with `numberOfLines: subtitle ? 1 : 2`, and these carry no subtitle), and a clamp-2 box
     * is NOT height-invariant in its text: one line while the label fits, two once it does not. Every
     * churn case V-2 measured lives in `statusDetail`, which is clamp ONE — so restricting the drop to
     * a clamp of one keeps all of it fixed while this direction stays keyed.
     *
     * Nothing else in this file crosses the LENGTH boundary inside a clamp of two.
     */
    it('still invalidates when a CLAMP-2 label grows long enough to take its second line', () => {
        const short = signatureFor(activity());
        const longStepLabel = signatureFor(activity({
            checklist: [
                { id: 'lint', label: 'Lint', state: 'complete' },
                {
                    id: 'build',
                    label: 'Build every workspace package before publishing the final release artifacts',
                    state: 'active',
                },
            ],
        }));
        const longActionLabel = signatureFor(activity({
            actions: [{
                pluginId: 'acme.preview',
                localId: 'open',
                label: 'Open the published preview deployment for this workspace',
            }],
        }));

        expect(buildTranscriptItemHeightSignatureKey(longStepLabel))
            .not.toBe(buildTranscriptItemHeightSignatureKey(short));
        expect(buildTranscriptItemHeightSignatureKey(longActionLabel))
            .not.toBe(buildTranscriptItemHeightSignatureKey(short));
    });

    /**
     * F-3 (2026-08-11) — the converse of F-1, and what pins the clamp as a CLAMP rather than an
     * unbounded box. Both labels are the SAME LENGTH, so only the hard-break term can move this key:
     * at a clamp of two, `'aa\nbb'` and `'a\nb\nc'` both paint two lines, and the cap
     * `min(newlines, maxLines - 1)` is what keeps the third break out of the key.
     *
     * This is the case that kills BOTH naive sides at once — dropping the cap moves the key, and so
     * does declaring these labels unbounded (the direction V-2's rule made untested in both
     * directions).
     */
    it('does NOT invalidate when a clamped label gains a hard break the clamp already swallows', () => {
        const twoLines = signatureFor(activity({
            checklist: [{ id: 'build', label: 'aa\nbb', state: 'active' }],
        }));
        const threeBreaksSameLength = signatureFor(activity({
            checklist: [{ id: 'build', label: 'a\nb\nc', state: 'active' }],
        }));

        expect(buildTranscriptItemHeightSignatureKey(threeBreaksSameLength))
            .toBe(buildTranscriptItemHeightSignatureKey(twoLines));
    });

    it('still invalidates when the fixed-width progress rail appears or disappears', () => {
        const withProgress = signatureFor(activity());
        const withoutProgress = signatureFor(activity({ progress: null }));

        // The rail narrows the status text column, which can change wrapping even if the words stay put.
        expect(buildTranscriptItemHeightSignatureKey(withProgress))
            .not.toBe(buildTranscriptItemHeightSignatureKey(withoutProgress));
    });

    it('still invalidates when an UNBOUNDED painted string can wrap to another line', () => {
        const short = signatureFor(activity());
        // `ItemGroup`'s title renders through `Eyebrow` with NO `numberOfLines`, so it grows without
        // bound and its length IS height-bearing.
        expect(buildTranscriptItemHeightSignatureKey(signatureFor(activity({ title: 'Build the entire workspace, then publish every artifact' }))))
            .not.toBe(buildTranscriptItemHeightSignatureKey(short));
    });

    it('still invalidates when the status detail gains a hard line break', () => {
        // `Item` clamps a STRING subtitle to one line unless it contains a `\n`, in which case it
        // paints unbounded (`Item.tsx`). Crossing that is a real height change, and it is the
        // width-INDEPENDENT half of extent, so the key must follow it.
        const short = signatureFor(activity({ status: 'Compiling' }));
        const wrapped = signatureFor(activity({ status: 'Compiling\nmodule' }));
        expect(buildTranscriptItemHeightSignatureKey(wrapped))
            .not.toBe(buildTranscriptItemHeightSignatureKey(short));
    });

    it('does NOT invalidate when a CLAMPED line only changes its length', () => {
        // V-2: with a detail present the status `Item` paints its title on ONE line and its string
        // subtitle on one line (`Item.tsx`). Length is the width-DEPENDENT half of extent and this
        // module has no width model to resolve it with, so folding it in produced pure churn — a run
        // ticking `9 / 10 -> 10 / 10` moved the key with the painted box byte-identical.
        const short = signatureFor(activity());
        expect(buildTranscriptItemHeightSignatureKey(signatureFor(activity({ status: 'Compiling a very long module path that will not fit on one line' }))))
            .toBe(buildTranscriptItemHeightSignatureKey(short));
        // Same reason, from the localized stale prefix in the status title.
        expect(buildTranscriptItemHeightSignatureKey(signatureFor(activity({ freshness: 'stale' }))))
            .toBe(buildTranscriptItemHeightSignatureKey(short));
    });

    it('releases the action-row reservation when Session Action admission goes offline and restores it on reconnect', () => {
        const online = projectActivityWithSessionActionAdmission(() => true);
        const interactionOffline = projectActivityWithSessionActionAdmission(() => false);
        const reconnected = projectActivityWithSessionActionAdmission(() => true);

        // The Resource identity did not change. Only the existing Session Action controller made
        // the same opaque Action reference non-interactive, so the final transcript item must be
        // the one shared input for both the painter and its size signature.
        expect(interactionOffline.identityKey).toBe(online.identityKey);
        expect(interactionOffline.actions).toEqual([]);

        const onlineSignature = signatureFor(online);
        const offlineSignature = signatureFor(interactionOffline);
        const reconnectedSignature = signatureFor(reconnected);
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: onlineSignature, heightPx: 128 });

        // Losing an Action removes a whole `Item`, so a pending-action row must shed the old floor
        // instead of leaving a self-fulfilling blank band below the now-shorter card.
        expect(isStructuralSignatureDelta(onlineSignature, offlineSignature)).toBe(true);
        expect(buildTranscriptItemHeightSignatureKey(offlineSignature))
            .not.toBe(buildTranscriptItemHeightSignatureKey(onlineSignature));
        expect(reconciler.resolveReservation(offlineSignature)).toBeUndefined();

        // The canonical controller can admit the reference again without a Resource reread; the
        // restored row must regain the same action-bearing structure that the card paints.
        expect(reconnected.actions).toEqual(online.actions);
        expect(isStructuralSignatureDelta(offlineSignature, reconnectedSignature)).toBe(true);
        expect(buildTranscriptItemHeightSignatureKey(reconnectedSignature))
            .toBe(buildTranscriptItemHeightSignatureKey(onlineSignature));
    });
});
