import { describe, expect, it } from 'vitest';

import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
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

/**
 * The chip list the card paints for the two dynamic option sources, mirroring
 * `buildSessionActionFieldOptionsResolver`'s static-options passthrough for everything else. The
 * SETTING -> option-list half is owned (and pinned) by `sessionActionFieldOptions.test.ts`; this file
 * owns the option-list -> size-key half.
 */
function optionsResolver(params: Readonly<{
    ids: readonly string[];
    labels?: Readonly<Record<string, string>>;
    disabledIds?: readonly string[];
}>): ResolveSessionActionFieldOptions {
    return (field) => {
        const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
        if (sourceId === 'review.engines.available' || sourceId === 'execution.backends.enabled') {
            return params.ids.map((id) => ({
                value: id,
                label: params.labels?.[id] ?? id,
                ...(params.disabledIds?.includes(id) ? { disabled: true as const } : {}),
            }));
        }
        const staticOptions = Array.isArray(field?.options) ? field.options : [];
        return staticOptions.flatMap((option) => {
            const value = typeof (option as { value?: unknown })?.value === 'string' ? String((option as { value: string }).value) : '';
            if (!value) return [];
            const label = typeof (option as { label?: unknown })?.label === 'string' ? String((option as { label: string }).label) : value;
            return [{ value, label }];
        });
    };
}

const DEFAULT_FIELD_OPTIONS = optionsResolver({ ids: ['agent:codex', 'agent:claude'] });

function signatureFor(
    item: TranscriptRowShellItem,
    resolveActionDraftFieldOptions: ResolveSessionActionFieldOptions = DEFAULT_FIELD_OPTIONS,
) {
    return buildTranscriptRowShellSignature({
        activeThinkingMessageId: null,
        expandedToolCallsAnchorMessageIds: new Set<string>(),
        forkMessageMetadataById: null,
        getMessageById: () => null,
        getMessageRevisionById: () => null,
        groupingMode: 'linear',
        item,
        latestCommittedActivityKey: null,
        resolveActionDraftFieldOptions,
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
        // `backendTargetKeys` is a `multiselect`, so its schema takes an ARRAY. The pre-V-4 fixture
        // passed the bare string, which `SubagentsDelegateStartInputSchema` rejects — harmless while
        // the key was blind to validation, but it means the card was painting a validation notice
        // instead of `draft.error` in every case below. Now that the key sees the painted line, the
        // fixture has to be a draft the user could actually have on screen.
        input: { backendTargetKeys: ['agent:codex'], instructions: 'Do the thing.' },
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

    it('does not re-key when the payload changes without changing the painted card', () => {
        // A same-valued rebuild of the input object paints the identical card, so the key must hold.
        const keyed = signatureFor(draftItem(draft()));
        const stillKeyed = signatureFor(draftItem(draft({ input: { backendTargetKeys: ['agent:codex'], instructions: 'Do the thing.' } })));
        expect(stillKeyed.structuralKey).toBe(keyed.structuralKey);
    });
});

/**
 * F-P6 (2026-08-11) — the CONVERSE of F-P3, in the same key, found while auditing that fix.
 *
 * Dropping `draft.status` removed the state the card does not paint. What remained was still a PROXY
 * over the raw input — top-level key count plus the summed length of top-level STRING values — and a
 * proxy is blind in the other direction: `SessionActionDraftCard` paints
 * `resolveEffectiveActionInputFields(spec, { sessionId, ...input })`, whose visible field SET is a
 * function of the input VALUES (`visibleWhen`), and every text widget paints a value the proxy cannot
 * see (nested paths and arrays both contribute zero).
 *
 * `review.start` reaches all of it with real spec bytes (`actionSpecs.ts`):
 *   - `base.baseBranch`  visibleWhen `base.kind === 'branch'`   — `base` is an OBJECT, length 0.
 *   - `base.baseCommit`  visibleWhen `base.kind === 'commit'`   — same.
 *   - `engines.coderabbit.configFiles` visibleWhen `engineIds includes 'coderabbit'` — ARRAY, length 0.
 *
 * So a whole labelled input appeared or vanished with the row's structural key byte-identical, which
 * is the stale-floor direction: the reconciler keeps the SHORTER measurement and `resolveReservation`
 * hands the taller frame a `minHeight` that is too small.
 *
 * The fix keys the row on what the card paints, resolved by the painter
 * (`resolveSessionActionDraftHeightBearingPaint`), not on a summary of the payload.
 */
describe('action-draft paint-blind key — the converse defect', () => {
    function reviewDraft(inputOverrides: Record<string, unknown> = {}, overrides: Partial<SessionActionDraft> = {}): SessionActionDraft {
        return {
            id: 'd1',
            sessionId: 's1',
            actionId: 'review.start',
            createdAt: 1_000,
            status: 'editing',
            input: {
                engineIds: ['codex'],
                instructions: 'Review this.',
                changeType: 'all',
                base: { kind: 'none' },
                ...inputOverrides,
            },
            ...overrides,
        };
    }

    function keyFor(d: SessionActionDraft): string {
        return buildTranscriptItemHeightSignatureKey(signatureFor(draftItem(d)));
    }

    it('re-keys when a select value reveals a whole new input field', () => {
        // `base.kind: 'branch'` paints the `Base branch` label + TextInput that 'none' does not.
        // `baseBranch` is filled so BOTH sides satisfy `ReviewBaseSchema` and the in-flow validation
        // line is absent on both — the field SET is the only difference.
        expect(keyFor(reviewDraft({ base: { kind: 'branch', baseBranch: 'main' } }))).not.toBe(keyFor(reviewDraft()));
    });

    it('re-keys when a select value swaps one revealed field for a different one', () => {
        // Same field COUNT, same painted extent, both schema-valid: 'Base branch' vs 'Base commit'.
        expect(keyFor(reviewDraft({ base: { kind: 'commit', baseCommit: 'main' } })))
            .not.toBe(keyFor(reviewDraft({ base: { kind: 'branch', baseBranch: 'main' } })));
    });

    it('re-keys when an engine selection reveals the CodeRabbit config field', () => {
        expect(keyFor(reviewDraft({ engineIds: ['codex', 'coderabbit'] }))).not.toBe(keyFor(reviewDraft()));
    });

    it('re-keys when a MULTILINE prompt gains a hard line break at the SAME length', () => {
        // `instructions` is `widget: 'textarea'` -> `multiline`, the one box here that grows with its
        // content. Length AND newlines, the rule the pending row has always used.
        expect(keyFor(reviewDraft({ instructions: 'Review\nthis.' })))
            .not.toBe(keyFor(reviewDraft({ instructions: 'Review this.' })));
    });

    it('re-keys when the in-flow error line grows from one line to a paragraph', () => {
        const short = reviewDraft({}, { error: 'boom' });
        const long = reviewDraft({}, { error: `boom${'\n'}${'x'.repeat(400)}` });
        expect(keyFor(long)).not.toBe(keyFor(short));
    });

    it('does NOT re-key when a chip selection changes without changing the painted field set', () => {
        // The discriminator that kills "just serialize the input": a multiselect paints one chip per
        // OPTION, so which options are SELECTED only changes a chip's background, never a box. Only
        // the `coderabbit` membership is height-bearing here, and it is unchanged.
        expect(keyFor(reviewDraft({ engineIds: ['claude'] }))).toBe(keyFor(reviewDraft({ engineIds: ['codex'] })));
    });

    it('does NOT re-key across the status walk on a spec with conditional fields either', () => {
        expect(keyFor(reviewDraft({}, { status: 'running' }))).toBe(keyFor(reviewDraft()));
    });

    /**
     * V-1 (2026-08-11) — F-P6 OVER-corrected, and these two cases were shipped as tests ASSERTING the
     * over-correction. They were wrong. `re-keys when a NESTED text field grows` (on
     * `base.baseBranch`) and `re-keys when a text_list gains an entry` (on
     * `engines.coderabbit.configFiles`) both demanded a new size version for a box whose height is
     * CONSTANT in its value: `ActionInputFields` paints `widget: 'text'` and comma-separated
     * `text_list` with `multiline={false}`, so those inputs are exactly one line tall for every
     * string they can hold. F-P6 made the key move on EVERY KEYSTROKE in them — a churn the pre-F-P6
     * key did not have — and every move deletes the row's measured size through Legend
     * `validateItemSizeVersion` plus its reservation through `resetReservationForStructuralChange`.
     *
     * The rule is per-WIDGET, not per-field: extent is keyed only where the painted box can grow.
     * The two directions below kill each other's naive implementation — keying every field's text
     * fails the first pair, dropping the extent term entirely fails the third.
     */
    it('does NOT re-key while the user types in a SINGLE-LINE text input', () => {
        const before = reviewDraft({ base: { kind: 'branch', baseBranch: 'main' } });
        const afterKeystroke = reviewDraft({ base: { kind: 'branch', baseBranch: 'maint' } });
        const afterMany = reviewDraft({ base: { kind: 'branch', baseBranch: 'release/2026-08-11-candidate-with-a-very-long-name' } });
        expect(keyFor(afterKeystroke)).toBe(keyFor(before));
        expect(keyFor(afterMany)).toBe(keyFor(before));
    });

    it('does NOT re-key when a comma text_list gains an entry', () => {
        // `listSeparator: 'comma'` paints `items.join(', ')` into a `multiline={false}` input.
        const one = reviewDraft({ engineIds: ['codex', 'coderabbit'], engines: { coderabbit: { configFiles: ['a.yml'] } } });
        const two = reviewDraft({ engineIds: ['codex', 'coderabbit'], engines: { coderabbit: { configFiles: ['a.yml', 'b-with-a-longer-name.yml'] } } });
        expect(keyFor(two)).toBe(keyFor(one));
    });

    it('re-keys while the user types in a MULTILINE textarea', () => {
        expect(keyFor(reviewDraft({ instructions: 'Review this.' })))
            .not.toBe(keyFor(reviewDraft({ instructions: 'Review this. And that too.' })));
    });

    /**
     * F-3 (2026-08-11) — the hard-break term must stay BOUNDED BY THE CLAMP, and nothing pinned that.
     * A `multiline={false}` `TextInput` renders `\n` inline: the box is one line tall whether or not
     * the value carries a break, so a key that counted breaks verbatim would move here with the
     * painted box byte-identical. Both values are the SAME LENGTH, so this fails only for the
     * newline term — a rule that dropped the bounding (`n${newlines}` at any clamp) fails it, while
     * the V-1 length rule alone cannot make it pass.
     */
    it('does NOT re-key when a SINGLE-LINE text value gains a hard line break', () => {
        const flat = reviewDraft({ base: { kind: 'branch', baseBranch: 'main-x' } });
        const broken = reviewDraft({ base: { kind: 'branch', baseBranch: 'main\nx' } });
        expect(keyFor(broken)).toBe(keyFor(flat));
    });
});

/**
 * V-4 (2026-08-11) — the in-flow VALIDATION LINE flips while the key stays frozen.
 *
 * `SessionActionDraftCard` paints `validationError ?? draft.error` as a real in-flow `<Text>`, and
 * `resolveActionInputValidationError` is a PURE function of `{ sessionId, input, spec, fields }` —
 * every one of which the descriptor already has. The F-P3/F-P6 descriptor nonetheless excluded it and
 * documented the exclusion as "card-local state that never reaches the projection", which was false
 * at the bytes.
 *
 * This is the stale-size direction, and it is reachable on the FIRST TAP of a review draft:
 * `engineIds: []` fails `z.array(...).min(1)` and paints "Review engines is required."; selecting one
 * engine removes that whole line with the field set unchanged.
 */
describe('action-draft in-flow validation line', () => {
    function reviewDraft(inputOverrides: Record<string, unknown> = {}, overrides: Partial<SessionActionDraft> = {}): SessionActionDraft {
        return {
            id: 'd1',
            sessionId: 's1',
            actionId: 'review.start',
            createdAt: 1_000,
            status: 'editing',
            input: {
                engineIds: ['codex'],
                instructions: 'Review this.',
                changeType: 'all',
                base: { kind: 'none' },
                ...inputOverrides,
            },
            ...overrides,
        };
    }

    function keyFor(d: SessionActionDraft): string {
        return buildTranscriptItemHeightSignatureKey(signatureFor(draftItem(d)));
    }

    it('re-keys when selecting the first engine removes the required-field line', () => {
        const invalid = reviewDraft({ engineIds: [] });
        const valid = reviewDraft({ engineIds: ['codex'] });
        // The painted field set is byte-identical across this step (`coderabbit` is in neither), so
        // nothing but the validation line can move the key.
        expect(signatureFor(draftItem(invalid)).kind).toBe(signatureFor(draftItem(valid)).kind);
        expect(keyFor(valid)).not.toBe(keyFor(invalid));
    });

    it('destroys the stale shorter reservation when the validation line appears', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const valid = signatureFor(draftItem(reviewDraft({ engineIds: ['codex'] })));
        reconciler.recordMeasuredHeight({ signature: valid, heightPx: 240 });

        const invalid = signatureFor(draftItem(reviewDraft({ engineIds: [] })));

        expect(isStructuralSignatureDelta(valid, invalid)).toBe(true);
        expect(reconciler.resolveReservation(invalid)).toBeUndefined();
    });

    it('does NOT re-key when the draft error the card never paints changes underneath it', () => {
        // The card paints `validationError ?? draft.error`, so while a validation error is present the
        // draft's own error is not painted at all. This kills "concatenate both errors".
        const short = reviewDraft({ engineIds: [] }, { error: 'boom' });
        const long = reviewDraft({ engineIds: [] }, { error: `boom${'\n'}${'x'.repeat(400)}` });
        expect(keyFor(long)).toBe(keyFor(short));
    });

    it('still re-keys on the draft error once the validation line is gone', () => {
        // The converse: with the input valid, `draft.error` IS the painted line again.
        const short = reviewDraft({}, { error: 'boom' });
        const long = reviewDraft({}, { error: `boom${'\n'}${'x'.repeat(400)}` });
        expect(keyFor(long)).not.toBe(keyFor(short));
    });
});

/**
 * F-4 (2026-08-11) — the OPTION LIST of a chip widget, the last height-bearing input this row had
 * outside its key, closed PRODUCER-SIDE.
 *
 * `ActionInputFields` paints one `ActionFieldChip` per option into a
 * `flexDirection: 'row', flexWrap: 'wrap'` container, so the painted list decides how many wrapped
 * chip lines the card has. That list is a function of the SYNCED `backendEnabledByTargetKey` setting
 * (`useEnabledAgentIds` -> `useSetting`), so a push from ANOTHER DEVICE can change it while this row
 * is OFFSCREEN — where there is no `onLayout` at all, and where the reconciler's floor is monotonic
 * within one `structuralKey` (recording 120 then 96 under a frozen key leaves `minHeight: 120`). So
 * `onLayout` cannot be the authority for this, and the key has to move.
 *
 * The four directions below are mutually discriminating:
 *   - dropping the option term entirely fails `re-keys when a synced settings push removes a chip`,
 *     `re-keys when an option LABEL grows`, `re-keys when the chip ORDER changes` and the consumer leg;
 *   - keying option VALUES instead of labels fails only `re-keys when an option LABEL grows`;
 *   - keying the option COUNT alone fails `re-keys when an option LABEL grows` and `... ORDER changes`;
 *   - folding `disabled` in fails `does NOT re-key when only an option's disabled flag flips`, which
 *     is also the leg that keeps the async machine-capabilities snapshot out of the transcript.
 */
describe('action-draft option chips — the synced option list', () => {
    function reviewDraft(inputOverrides: Record<string, unknown> = {}): SessionActionDraft {
        return {
            id: 'd1',
            sessionId: 's1',
            actionId: 'review.start',
            createdAt: 1_000,
            status: 'editing',
            input: {
                engineIds: ['codex'],
                instructions: 'Review this.',
                changeType: 'all',
                base: { kind: 'none' },
                ...inputOverrides,
            },
        };
    }

    function keyFor(resolve: ResolveSessionActionFieldOptions, d: SessionActionDraft = reviewDraft()): string {
        return buildTranscriptItemHeightSignatureKey(signatureFor(draftItem(d), resolve));
    }

    const TWO_CHIPS = optionsResolver({ ids: ['codex', 'claude'], labels: { codex: 'Codex', claude: 'Claude' } });

    it('re-keys when a synced settings push removes a chip', () => {
        const oneChip = optionsResolver({ ids: ['codex'], labels: { codex: 'Codex' } });
        expect(keyFor(oneChip)).not.toBe(keyFor(TWO_CHIPS));
    });

    it('re-keys when an option LABEL grows at an unchanged option count', () => {
        // Kills "key the count" and "key the option values": same two ids, same order, one longer
        // label — which is exactly what re-wraps a `flexWrap` chip row.
        const renamed = optionsResolver({ ids: ['codex', 'claude'], labels: { codex: 'Codex', claude: 'Claude Code (subscription)' } });
        expect(keyFor(renamed)).not.toBe(keyFor(TWO_CHIPS));
    });

    it('re-keys when the chip ORDER changes at an unchanged option set', () => {
        // Kills "key a sorted set of option values": chips are packed in paint order, so reordering
        // two labels of different widths can move where the row wraps.
        const reordered = optionsResolver({ ids: ['claude', 'codex'], labels: { codex: 'Codex', claude: 'Claude' } });
        expect(keyFor(reordered)).not.toBe(keyFor(TWO_CHIPS));
    });

    it('does NOT re-key when only an option\'s disabled flag flips', () => {
        // `disabled` reaches `ActionFieldChip`'s `opacity` and its press handler and nothing else —
        // the same exclusion `draft.status` gets in F-P3. This is also what lets the transcript resolve
        // the option list WITHOUT the async machine-capabilities snapshot, the only input that flips it.
        const withDisabled = optionsResolver({ ids: ['codex', 'claude'], labels: { codex: 'Codex', claude: 'Claude' }, disabledIds: ['claude'] });
        expect(keyFor(withDisabled)).toBe(keyFor(TWO_CHIPS));
    });

    it('does NOT re-key when the SELECTION changes under an unchanged option list', () => {
        // The converse of the four above, and the reason this keys the option LIST and not the value:
        // selecting a different chip only swaps its background.
        expect(keyFor(TWO_CHIPS, reviewDraft({ engineIds: ['claude'] })))
            .toBe(keyFor(TWO_CHIPS, reviewDraft({ engineIds: ['codex'] })));
    });

    it('releases the stale taller floor when a chip disappears while the row is offscreen', () => {
        // The whole point of moving the key: `isFloorShapeValid` is `floor.structuralKey === signature
        // .structuralKey` for a non-growing `pending-action` row, so the monotonic peak is only
        // released by a key move. Without it the shorter card keeps a 214px reservation.
        const reconciler = createTestTranscriptMeasurementReconciler();
        const twoChips = signatureFor(draftItem(reviewDraft()), TWO_CHIPS);
        reconciler.recordMeasuredHeight({ signature: twoChips, heightPx: 214 });

        const oneChip = signatureFor(draftItem(reviewDraft()), optionsResolver({ ids: ['codex'], labels: { codex: 'Codex' } }));

        expect(isStructuralSignatureDelta(twoChips, oneChip)).toBe(true);
        expect(reconciler.resolveReservation(oneChip)).toBeUndefined();
    });
});
