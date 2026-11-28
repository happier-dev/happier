import { sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { InputFieldHint, InputOptionsConsumerV1 } from '@happier-dev/protocol/inputs';
import type {
    WidgetBindingResolutionV1,
    WidgetInputBindingV1,
    WidgetInputBindingsV1,
    WidgetGroupWidthV1,
    WidgetInputIssueV1,
    WidgetSizeV1,
    WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import type { IconName } from '@/components/ui/icons/Icon';
import { describeHostInputTypePickerValue } from '@/components/sessions/actions/hostInputTypePickerForm';
import { describeBuiltinInputOptionValue } from '@/text/builtinInputPrompts';

import type { WidgetBindingValueSource } from '../surface/widgetBindingValueLabel';

/**
 * The Set up / Edit inputs step's model (lab `dashboards` dadd A/Ab/IN, dbind E/X). It only presents
 * bindings and admitted sizes: what each input is bound to, which choices the person has, and whether the step can
 * finish. Admission belongs to the binder (`resolveConfiguredWidgetInputs`) and to the
 * `widgets.item.*` Actions behind `submit`; this file never decides that a value is valid.
 */

/** A value a person can pin (or a surface offers), named for people. */
export type WidgetSetupValue = Readonly<{
    value: JsonValue;
    label: string;
    description?: string;
    icon?: IconName;
    /** Listed but not choosable (the resolver can name it, the viewer cannot read it). */
    disabled?: boolean;
}>;

/** What the hosting surface fills on its own: one named slot ("This session") and its current value(s). */
export type WidgetSetupContextOffer = Readonly<{
    slot: string;
    /** "This session", "This page", "The checkout you're on". */
    label: string;
    group?: true;
    /** One value follows quietly; two or three are shown in place; none leaves the field needed. */
    values: readonly WidgetSetupValue[];
}>;

/** One input as the step draws it: the neutral field plus what this surface can offer for it. */
export type WidgetSetupInheritedReading = Readonly<(
    | { kind: 'single'; valueLabel: string; pageSlot?: string }
    | { kind: 'several' }
) & { source?: WidgetBindingValueSource }>;

export type WidgetSetupField = Readonly<{
    field: InputFieldHint;
    follow?: WidgetSetupContextOffer;
    /** What the children inherit in the current group draft. This never supplies a draft value. */
    inherited?: WidgetSetupInheritedReading;
    /**
     * The value is each viewer's own (a connected account on a shared surface): every viewer reads
     * with their own connection for this purpose, so the step shows it and never asks for it.
     */
    viewer?: Readonly<{ purpose: string }>;
    /** Said under the input only while it is still needed ("Asked once. The 3 widgets follow it."). */
    neededHint?: string;
}>;

/**
 * Discovery-demand classification only. Literal drafts without a declared source need the public
 * parser/picker; references and collections retain their normal options discovery. Every field's
 * value control is presented by the same public typed-field owner.
 */
export function isLiteralWidgetSetupField(field: InputFieldHint): boolean {
    if (field.widget === 'multiselect') return false;
    if (field.optionsSourceId !== undefined || field.connectedAccountOptions === true) return false;
    return field.inputType === undefined || field.widget !== 'select';
}

/** What Add submits atomically: this copy's bindings and its chosen presentation size. */
export type WidgetSetupDraft = Readonly<{
    bindings: WidgetInputBindingsV1;
    size?: WidgetSizeV1;
    /** A group's width (a saved group asks only its inputs and its width). */
    width?: WidgetGroupWidthV1;
}>;

export type WidgetSetupSubmitResult = Readonly<{ ok: true; approvalPending?: true }> | Readonly<{ ok: false; message: string; details?: unknown }>;
/** A settled preview may be unavailable without providing an admission decision. */
export type WidgetSetupAdmissionResult = WidgetSetupSubmitResult | null;

type WidgetSetupPresentation = Readonly<{
    /** "Set up Checks" or "Checks · inputs". */
    title: string;
    /** One line under the title: what it shows, or what an edit changes. */
    hint?: string;
    /** Who made it and where it comes from ("Built in", a plugin's name, "Your widget"). */
    provenance?: string;
    /** Says where it goes ("Add to Home") or "Save". */
    submitLabel: string;
    /** The widget being set up, for the preview card's header (its mark and name). */
    widget?: Readonly<{ title: string; mark: IconName; source?: string }>;
    fields: readonly WidgetSetupField[];
    /** Actual host slot declarations, including slots whose current value is unavailable. */
    contextSlots?: readonly string[];
    initial: WidgetSetupDraft;
    /** Resolved once from the declaration and host surface; linear surfaces omit it. */
    sizeChoices?: Readonly<{ surface: WidgetSurfaceRefV1['owner']['kind']; sizes: readonly WidgetSizeV1[] }>;
    /** A group's widths instead of a size; an unavailable one names the widget that prevents it. */
    widthChoices?: ReadonlyArray<Readonly<{ width: WidgetGroupWidthV1; unavailableReason?: string }>>;
    /** Presentation-only readings for group fields, from the children's binder and the opening page snapshot. */
    readInherited?: (bindings: WidgetInputBindingsV1) => ReadonlyMap<string, WidgetSetupInheritedReading>;
    /**
     * The real widget at the draft's bindings; mounted only while the step is open and the draft
     * resolves. It returns nothing when it cannot read with the bound target's own authority.
     */
    renderPreview?: (preview: Readonly<{
        input: Readonly<Record<string, JsonValue>>;
        draft: WidgetSetupDraft;
        refusal?: Extract<WidgetSetupSubmitResult, { ok: false }>;
    }>) => React.ReactNode;
    /**
     * A setup whose preview is its own frame (a saved group is a group, not a card): the step does not
     * wrap it in a widget card, and while inputs are still needed it draws that frame itself with
     * `waiting` in each body ("Choose the project to see it here").
     */
    renderWaitingPreview?: (preview: Readonly<{ draft: WidgetSetupDraft; waiting: string }>) => React.ReactNode;
    /** What the button will do once nothing is needed, as named by the setup owner. */
    describeOutcome?: (draft: WidgetSetupDraft) => string;
    /** Which widget on which surface consumes the options, so option reads are admitted for exactly it. */
    optionsContext?: (draft: WidgetSetupDraft, field?: InputFieldHint) => Readonly<{
        draftInput: Readonly<Record<string, JsonValue>>;
        consumer?: InputOptionsConsumerV1;
    }>;
    /** The canonical Action behind the button (`widgets.item.add` / `.inputs.set`). */
    submit: (draft: WidgetSetupDraft) => Promise<WidgetSetupSubmitResult>;
}>;

/** A draft gets its readiness from one owner: the local binder or the placement Action. */
export type WidgetSetup = WidgetSetupPresentation & Readonly<{
    resolve: (draft: WidgetSetupDraft) => WidgetBindingResolutionV1;
    readAdmission?: never;
}>;
export type WidgetSetupStepModel = WidgetSetup | (WidgetSetupPresentation & Readonly<{
    resolve?: never;
    readAdmission: (draft: WidgetSetupDraft, signal: AbortSignal) => Promise<WidgetSetupAdmissionResult>;
}>);

/**
 * The bindings a fresh copy starts with: a field the surface fills with exactly one value follows it,
 * a per-viewer field is each viewer's own, and two or three surface values pin the likeliest (the
 * first) while the step shows the others in place. Anything else waits for a choice.
 */
export function proposeWidgetSetupDraft(fields: readonly WidgetSetupField[]): WidgetSetupDraft {
    const bindings: Record<string, WidgetInputBindingV1> = {};
    for (const entry of fields) {
        const path = entry.field.path;
        if (entry.viewer) {
            bindings[path] = { kind: 'viewer', purpose: entry.viewer.purpose };
            continue;
        }
        const values = entry.follow?.values ?? [];
        if (entry.follow && values.length === 1) bindings[path] = { kind: 'context', slot: entry.follow.slot };
        else if (values.length > 1) bindings[path] = { kind: 'value', value: values[0]!.value };
    }
    return { bindings };
}

/**
 * What still stops the step from finishing. A per-viewer input is complete once it is bound to the
 * viewer: each viewer's own connection fills it when the widget reads, so its missing value is
 * never something this person can (or may) choose here.
 */
export function widgetSetupBlockingIssues(
    fields: readonly WidgetSetupField[],
    resolution: WidgetBindingResolutionV1,
): readonly WidgetInputIssueV1[] {
    if (resolution.status === 'ready') return NO_ISSUES;
    const perViewer = new Set(fields.flatMap((entry) => (entry.viewer ? [entry.field.path] : [])));
    return resolution.fields.filter((issue) => !(issue.status === 'selection_required' && perViewer.has(issue.path)));
}

const NO_ISSUES: readonly WidgetInputIssueV1[] = Object.freeze([]);

/** How one input row reads. Follows and pinned never mix: the follow glyph, or the thing's own mark. */
export type WidgetSetupRow =
    | Readonly<{ kind: 'follows'; label: string; valueLabel: string | null; implicit?: true }>
    | Readonly<{ kind: 'pinned'; value: WidgetSetupValue | null; label: string }>
    | Readonly<{ kind: 'choices'; choices: readonly WidgetSetupValue[]; selectedIndex: number }>
    /** Each viewer's own connection; nothing to choose here. */
    | Readonly<{ kind: 'viewer' }>
    | Readonly<{ kind: 'needed' }>
    /** `follows` when what stopped resolving is the surface value the input follows, not its own value. */
    | Readonly<{ kind: 'invalid'; label: string | null; issue: WidgetInputIssueV1; follows?: true }>;

function issueFor(resolution: WidgetBindingResolutionV1, path: string): WidgetInputIssueV1 | null {
    return resolution.status === 'ready' ? null : resolution.fields.find((issue) => issue.path === path) ?? null;
}

function findValue(values: readonly WidgetSetupValue[], value: JsonValue | undefined): WidgetSetupValue | null {
    if (value === undefined) return null;
    return values.find((candidate) => sameStrictJsonValue(candidate.value, value)) ?? null;
}

/** A pin people can still read when its option list does not hold it (plain strings and numbers). */
function plainLabel(value: JsonValue | undefined, field: InputFieldHint, options: readonly WidgetSetupValue[] = []): string | null {
    const choiceLabel = describeBuiltinInputOptionValue(field.optionsSourceId, value);
    if (choiceLabel !== null) return choiceLabel;
    // A list names its choices; a one-choice field an older save kept as a list ([id]) names it too, not "1 selected".
    if (Array.isArray(value) && (field.widget === 'multiselect' || (value.length > 0 && value.every(selected => findValue(options, selected) !== null)))) {
        if (!value.length) return field.placeholder ?? null;
        return value.map(selected => findValue(options, selected)?.label ?? plainLabel(selected, field)).filter(Boolean).join(' · ');
    }
    if (field.inputType && 'hostType' in field.inputType) {
        const typedLabel = describeHostInputTypePickerValue(field.inputType, value);
        if (typedLabel !== null) return typedLabel;
    }
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * One row's presentation from its binding and the binder's issue for it. `options` are the pinnable
 * values the one options resolver produced (static or dynamic); the row never invents a value.
 */
export function describeWidgetSetupRow(input: Readonly<{
    entry: WidgetSetupField;
    draft: WidgetSetupDraft;
    resolution: WidgetBindingResolutionV1;
    options: readonly WidgetSetupValue[];
    /** Names captured from the person's pick; presentation only, never option admission. */
    pickedOptions?: readonly WidgetSetupValue[];
}>): WidgetSetupRow {
    const { entry, draft, resolution } = input;
    const path = entry.field.path;
    const binding = draft.bindings[path];
    const issue = issueFor(resolution, path);
    const offered = entry.follow?.values ?? [];
    const summaryOptions = [...input.options, ...(input.pickedOptions ?? [])];

    if (binding?.kind === 'viewer') {
        if (issue && issue.status !== 'selection_required') return { kind: 'invalid', label: null, issue };
        return { kind: 'viewer' };
    }
    const implicitPageFollow = binding === undefined && entry.follow !== undefined && entry.follow.group !== true
        && entry.inherited?.kind === 'single' && entry.inherited.pageSlot === entry.follow.slot;
    if (binding?.kind === 'context' || implicitPageFollow) {
        if (issue) return issue.status === 'selection_required' ? { kind: 'needed' } : { kind: 'invalid', label: entry.follow?.label ?? null, issue, follows: true };
        return { kind: 'follows', label: entry.follow?.label ?? entry.field.title, valueLabel: offered[0]?.label ?? null,
            ...(implicitPageFollow ? { implicit: true } : {}) };
    }
    if (binding?.kind === 'value') {
        if (issue && issue.status !== 'selection_required') {
            return { kind: 'invalid', label: findValue([...offered, ...summaryOptions], binding.value)?.label ?? plainLabel(binding.value, entry.field, summaryOptions), issue };
        }
        if (offered.length > 1) {
            const selectedIndex = offered.findIndex((candidate) => sameStrictJsonValue(candidate.value, binding.value));
            if (selectedIndex >= 0 && offered.length <= AMBIGUOUS_INLINE_LIMIT) return { kind: 'choices', choices: offered, selectedIndex };
        }
        const value = findValue([...offered, ...input.options], binding.value);
        return { kind: 'pinned', value, label: value?.label ?? findValue(summaryOptions, binding.value)?.label ?? plainLabel(binding.value, entry.field, summaryOptions) ?? '' };
    }
    return { kind: 'needed' };
}

/**
 * The compact binding summary can name up to three ambiguous surface candidates (lab IN, Q1).
 * This is not an options limit: the public typed field receives every discovered choice.
 */
export const AMBIGUOUS_INLINE_LIMIT = 3;

/** Why the button cannot finish yet: the first input the binder still needs, by its own title. */
export function describeWidgetSetupBlocker(
    fields: readonly WidgetSetupField[],
    resolution: WidgetBindingResolutionV1,
    decidingPath?: string,
): Readonly<{ path: string; title: string; status: WidgetInputIssueV1['status'] }> | null {
    const blocking = widgetSetupBlockingIssues(fields, resolution);
    if (blocking.length === 0) return null;
    const deciding = blocking.find(issue => issue.path === decidingPath);
    if (deciding) return { path: deciding.path, title: fields.find(entry => entry.field.path === deciding.path)?.field.title ?? deciding.path, status: deciding.status };
    for (const entry of fields) {
        const issue = blocking.find((candidate) => candidate.path === entry.field.path);
        if (issue) return { path: issue.path, title: entry.field.title, status: issue.status };
    }
    const first = blocking[0]!;
    return { path: first.path, title: first.path, status: first.status };
}

/** Edits one input of a draft: a follow or a pin. */
export function setWidgetSetupBinding(
    draft: WidgetSetupDraft,
    path: string,
    next: Readonly<{ kind: 'follow'; slot: string }> | Readonly<{ kind: 'pin'; value: JsonValue }> | Readonly<{ kind: 'clear' }>,
): WidgetSetupDraft {
    const bindings: Record<string, WidgetInputBindingV1> = { ...draft.bindings };
    switch (next.kind) {
        case 'follow': bindings[path] = { kind: 'context', slot: next.slot }; break;
        case 'pin': bindings[path] = { kind: 'value', value: next.value }; break;
        case 'clear': delete bindings[path]; break;
    }
    return { ...draft, bindings };
}
