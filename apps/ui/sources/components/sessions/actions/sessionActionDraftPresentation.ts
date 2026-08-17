import { getActionSpec, resolveEffectiveActionInputFields, type ActionSpec, type EffectiveActionInputField } from '@happier-dev/protocol';

import { resolveActionInputValidationError } from '@/sync/domains/actions/resolveActionInputValidationError';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';

import { resolveActionFieldPresentationForInput } from './ActionInputFields';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';

/** A painted text box: exactly the string it displays, and how many lines it can paint. */
export type SessionActionDraftTextBoxPaint = Readonly<{
    text: string;
    /** `null` when the box grows with its content; a number when it is clamped to that many lines. */
    maxLines: number | null;
}>;

/**
 * One painted option row of a `select` / `multiselect`.
 *
 * `value` is identity, not paint, and `disabled` reaches the row's `opacity` and its press handler
 * and nothing else — the same exclusion `draft.status` gets in F-P3. The shared select also paints
 * a non-empty `description` as a caption line, so it is part of the height-bearing descriptor.
 */
export type SessionActionDraftOptionPaint = Readonly<{ label: string; description?: string }>;

export type SessionActionDraftFieldPaint = Readonly<{
    /** The effective field hint `SessionActionDraftCard` hands to `ActionInputFields`. */
    field: EffectiveActionInputField;
    /**
     * The text box this field paints, or `null` for the widgets whose box is option-driven
     * (`select` / `multiselect` / `toggle`) and holds no text — changing the selection only changes
     * which option reads as selected.
     *
     * V-1 (2026-08-11): `maxLines` is the whole point, and F-P6 shipped without it.
     * `resolveHappierActionFieldPresentation` reports `multiline: false` for every text widget except
     * `textarea`, `json` and a newline-separated `text_list`, and `HappierTextField` paints exactly
     * that — a box one line tall for every string it can hold. Keying its value made the row's size
     * version move on every KEYSTROKE, deleting the row's measured height (Legend
     * `validateItemSizeVersion`) and its reservation (`resetReservationForStructuralChange`) each
     * time. The clamp is read from the SAME presentation the field renders from.
     */
    textBox: SessionActionDraftTextBoxPaint | null;
    /**
     * The option rows this field paints, in paint order, or `null` for a field that paints no option
     * list.
     *
     * F-4 (2026-08-11) — this is what closes V-3, and this repo is the MORE exposed of the two.
     * `ActionInputFields` hands the option list to `HappierSelect`, which maps it into a
     * `gap`-stacked `View` — one `HappierPressable` ROW per option, each at least
     * `minimumTouchTarget` tall. Gaining or losing an option therefore adds or removes a whole row
     * plus its gap, where remote-dev's chip row only re-wraps.
     *
     * `toggle` paints a `HappierToggle` from the field's own value rather than an option list, so it
     * reports `null`: nothing about it can move with data.
     */
    options: readonly SessionActionDraftOptionPaint[] | null;
}>;

/**
 * What `SessionActionDraftCard` actually PAINTS, and therefore the only part of a draft that can move
 * the transcript row's height.
 *
 * F-P6 (2026-08-11). Counterpart of `resolvePluginTranscriptActivityHeightBearingPaint` (F-P4) and
 * `resolvePendingMessageHeightBearingChrome` (F-P2) for the action-draft row: the painter owns the
 * height-bearing description, the card renders from it, and `transcriptRowShellSignature` keys from
 * it — one decision-maker instead of a rule restated in the renderer and approximated in the key.
 *
 * The card's form is `resolveEffectiveActionInputFields(spec, { sessionId, ...input })`, so the
 * visible field SET is a function of the input VALUES (`visibleWhen`). Any key built as a summary of
 * the raw payload is blind to that: `review.start` reveals `base.baseBranch` on
 * `base.kind === 'branch'` and `engines.coderabbit.configFiles` on `engineIds` including
 * `coderabbit`, and both driving values are an object / an array, which a "sum the top-level string
 * lengths" proxy scores as zero.
 */
export type SessionActionDraftHeightBearingPaint = Readonly<{
    /**
     * Visible fields in paint order. Empty means the card paints its single no-input-hints line.
     *
     * F-4 (2026-08-11) — CLOSED PRODUCER-SIDE. V-3 left the option list out of this descriptor and
     * justified it as "the count can only change across a Settings round-trip, during which the row
     * is mounted and its own `onLayout` is the measurement authority". Both halves were false,
     * MEASURED:
     *
     * 1. `backendEnabledByTargetKey` is read with `useSetting`, i.e. the SYNCED settings domain, so a
     *    push from ANOTHER DEVICE changes the option list with this row OFFSCREEN.
     * 2. `onLayout` is not the authority for a SHRINK even when the row is mounted:
     *    `transcriptMeasurementReconciler`'s floor is monotonic within one `structuralKey`
     *    (`isFloorShapeValid` -> `Math.max(carriedPeak, measured)`), so re-measuring 120 -> 96 under a
     *    frozen key leaves `minHeight: 120` — a blank band under the shorter card that persists until
     *    the key moves for some other reason. Only moving the key releases it.
     *
     * F-4 ALSO CORRECTS THIS COMMENT'S OWN CLAIM ABOUT THE SNAPSHOT. It used to say the painted
     * option set is "a pure function of the `backendEnabledByTargetKey` SETTING over the static
     * `AGENT_IDS` list plus the native review engines; the async machine-capabilities snapshot only
     * flips an option's `disabled` flag". Both halves are wrong at this repo's bytes.
     * `reviewEngineCatalog.ts` here has NO native-review-engine leg at all — the protocol's
     * native-review-engine listing is imported and composed by remote-dev's catalog and by no module
     * of this repo, prose included — and its `discoveredReviewOptions` block
     * ADDS one option per machine-reported review-capable backend that is not already an enabled
     * agent, while `resolveReviewEngineLabel` prefers the snapshot's own `title` / `label` /
     * `displayName` over the agent label. So the snapshot can add, remove AND rename a painted row,
     * which is why the transcript here feeds it in (`useSessionActionFieldOptionsForRowHeight`) and
     * remote-dev's — whose catalog really does compose enabled agents with static native engines —
     * deliberately does not.
     *
     * The option list is therefore resolved HERE, by the painter, from the same
     * {@link ResolveSessionActionFieldOptions} the card hands to `ActionInputFields`. Guessing a count
     * instead of reading the paint would repeat the payload-proxy mistake F-P6 removed, and papering
     * over it at the reconciler would be a corrector for a key defect: the monotonic floor is correct
     * behaviour for a correctly-keyed row.
     */
    fields: readonly SessionActionDraftFieldPaint[];
    /**
     * The validation message the card paints INSTEAD of `draft.error`, or `null` when the input
     * satisfies the spec. The card's `Start` button reads the same value for its `disabled` state.
     *
     * V-4 (2026-08-11): F-P6 excluded this and justified the exclusion as "card-local state that never
     * reaches the projection". That was false at the bytes — `resolveActionInputValidationError` is a
     * PURE function of `{ sessionId, input, spec, fields }`, and this descriptor already holds all
     * four. The consequence was the stale-size direction, reachable on the first tap of a review
     * draft: an empty `engineIds` fails the schema's `min(1)` and paints "Review engines is
     * required."; choosing an engine removes that whole line with the structural key byte-identical,
     * so the reconciler handed the shorter frame the taller row's floor.
     */
    validationError: string | null;
    /** Exactly the in-flow notice the card paints: `validationError ?? draft.error`, or `''`. */
    errorLine: string;
}>;

const EMPTY_FIELDS: readonly SessionActionDraftFieldPaint[] = Object.freeze([]);

/** A non-`multiline` `HappierTextField` is one line tall for every value it can hold. */
const SINGLE_LINE_TEXT_FIELD_MAX_LINES = 1;

export function resolveSessionActionDraftHeightBearingPaint(
    params: Readonly<{
        /** The row's draft. `sessionId` is passed separately because the card holds the row's own. */
        draft: Pick<SessionActionDraft, 'actionId' | 'input' | 'error'>;
        sessionId: string;
        /**
         * The option list each field paints. REQUIRED rather than optional on purpose: a caller that
         * silently got no options would produce a key blind to the option rows the card paints, which
         * is exactly the under-key F-4 closes, and the compiler is the only thing that catches it.
         */
        resolveFieldOptions: ResolveSessionActionFieldOptions;
    }>,
): SessionActionDraftHeightBearingPaint {
    const input = params.draft.input ?? {};
    const draftError = params.draft.error ? String(params.draft.error) : '';
    const form = resolveVisibleForm(params.draft.actionId, input, params.sessionId);
    if (!form) return { fields: EMPTY_FIELDS, validationError: null, errorLine: draftError };

    const validationError = resolveValidationError({
        fields: form.fields,
        input,
        sessionId: params.sessionId,
        spec: form.spec,
    });
    return {
        fields: form.fields.map((field) => ({
            field,
            textBox: resolveFieldTextBoxPaint(field, input),
            options: resolveFieldOptionPaints(field, input, params.resolveFieldOptions),
        })),
        validationError,
        errorLine: validationError ?? draftError,
    };
}

function resolveFieldTextBoxPaint(
    field: EffectiveActionInputField,
    input: Record<string, unknown>,
): SessionActionDraftTextBoxPaint | null {
    const presentation = resolveActionFieldPresentationForInput(field, input);
    if (presentation?.kind !== 'text') return null;
    return {
        text: presentation.value,
        maxLines: presentation.multiline ? null : SINGLE_LINE_TEXT_FIELD_MAX_LINES,
    };
}

function resolveFieldOptionPaints(
    field: EffectiveActionInputField,
    input: Record<string, unknown>,
    resolveFieldOptions: ResolveSessionActionFieldOptions,
): readonly SessionActionDraftOptionPaint[] | null {
    // `presentation.kind === 'select'` is exactly the branch that renders a `HappierSelect` from
    // `resolveFieldOptions`, read from the same resolution the field renders from rather than from
    // the widget name in a second place.
    if (resolveActionFieldPresentationForInput(field, input)?.kind !== 'select') return null;
    // Same defensive posture as `resolveVisibleForm`: this runs on the per-row-per-render size-key
    // path, where a throwing resolver would take the whole transcript down.
    try {
        return resolveFieldOptions(field).map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
        }));
    } catch {
        return null;
    }
}

function resolveVisibleForm(
    actionId: string,
    input: Record<string, unknown>,
    sessionId: string,
): Readonly<{ spec: ActionSpec; fields: readonly EffectiveActionInputField[] }> | null {
    // `getActionSpec` THROWS on an unknown id. The card can afford that (it is a programmer error at
    // one mount); this descriptor is also read from the per-row-per-render size-key path, where a
    // throw would take the whole transcript down, so an unresolvable spec degrades to "no form".
    try {
        const spec = getActionSpec(actionId as never) as ActionSpec;
        return { spec, fields: resolveEffectiveActionInputFields(spec as never, { sessionId, ...input }) };
    } catch {
        return null;
    }
}

function resolveValidationError(args: Readonly<{
    fields: readonly EffectiveActionInputField[];
    input: Record<string, unknown>;
    sessionId: string;
    spec: ActionSpec;
}>): string | null {
    // Same reason as above: a malformed spec must degrade to "no notice", never take the transcript
    // down from the size-key path.
    try {
        return resolveActionInputValidationError(args);
    } catch {
        return null;
    }
}
