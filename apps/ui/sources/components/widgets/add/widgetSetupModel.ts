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
    /** One value follows quietly; two or three are shown in place; none leaves the field needed. */
    values: readonly WidgetSetupValue[];
}>;

/** One input as the step draws it: the neutral field plus what this surface can offer for it. */
export type WidgetSetupField = Readonly<{
    field: InputFieldHint;
    follow?: WidgetSetupContextOffer;
    /**
     * The value is each viewer's own (a connected account on a shared surface): every viewer reads
     * with their own connection for this purpose, so the step shows it and never asks for it.
     */
    viewer?: Readonly<{ purpose: string }>;
    /** Said under the input only while it is still needed ("Asked once. The 3 widgets follow it."). */
    neededHint?: string;
}>;

/** Literal controls share the public field/parser; discovered references use binding choices. */
export function isLiteralWidgetSetupField(field: InputFieldHint): boolean {
    if (field.widget === 'multiselect') return true;
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

export type WidgetSetupSubmitResult = Readonly<{ ok: true; approvalPending?: true }> | Readonly<{ ok: false; message: string }>;

/** The one step a surface hands the add panel (or an Edit inputs / repair entry point). */
export type WidgetSetup = Readonly<{
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
    initial: WidgetSetupDraft;
    /** Resolved once from the declaration and host surface; linear surfaces omit it. */
    sizeChoices?: Readonly<{ surface: WidgetSurfaceRefV1['owner']['kind']; sizes: readonly WidgetSizeV1[] }>;
    /** A group's widths instead of a size; an unavailable one names the widget that prevents it. */
    widthChoices?: ReadonlyArray<Readonly<{ width: WidgetGroupWidthV1; unavailableReason?: string }>>;
    /** The binder's answer for a draft (pure; re-run on every change). */
    resolve: (draft: WidgetSetupDraft) => WidgetBindingResolutionV1;
    /**
     * The real widget at the draft's bindings; mounted only while the step is open and the draft
     * resolves. It returns nothing when it cannot read with the bound target's own authority.
     */
    renderPreview?: (preview: Readonly<{ input: Readonly<Record<string, JsonValue>>; draft: WidgetSetupDraft }>) => React.ReactNode;
    /**
     * A setup whose preview is its own frame (a saved group is a group, not a card): the step does not
     * wrap it in a widget card, and while inputs are still needed it draws that frame itself with
     * `waiting` in each body ("Choose the project to see it here").
     */
    renderWaitingPreview?: (preview: Readonly<{ draft: WidgetSetupDraft; waiting: string }>) => React.ReactNode;
    /** What the button will do once nothing is needed, with the values the draft is bound to. */
    describeOutcome?: (outcome: Readonly<{ draft: WidgetSetupDraft; values: readonly string[] }>) => string;
    /** Which widget on which surface consumes the options, so option reads are admitted for exactly it. */
    optionsContext?: (draft: WidgetSetupDraft, field?: InputFieldHint) => Readonly<{
        draftInput: Readonly<Record<string, JsonValue>>;
        consumer?: InputOptionsConsumerV1;
    }>;
    /** The canonical Action behind the button (`widgets.item.add` / `.inputs.set`). */
    submit: (draft: WidgetSetupDraft) => Promise<WidgetSetupSubmitResult>;
}>;

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
    | Readonly<{ kind: 'follows'; label: string; valueLabel: string | null }>
    | Readonly<{ kind: 'pinned'; value: WidgetSetupValue | null; label: string }>
    | Readonly<{ kind: 'choices'; choices: readonly WidgetSetupValue[]; selectedIndex: number }>
    /** Each viewer's own connection; nothing to choose here. */
    | Readonly<{ kind: 'viewer' }>
    | Readonly<{ kind: 'needed' }>
    | Readonly<{ kind: 'invalid'; label: string | null; issue: WidgetInputIssueV1 }>;

function issueFor(resolution: WidgetBindingResolutionV1, path: string): WidgetInputIssueV1 | null {
    return resolution.status === 'ready' ? null : resolution.fields.find((issue) => issue.path === path) ?? null;
}

function findValue(values: readonly WidgetSetupValue[], value: JsonValue | undefined): WidgetSetupValue | null {
    if (value === undefined) return null;
    return values.find((candidate) => sameStrictJsonValue(candidate.value, value)) ?? null;
}

/** A pin people can still read when its option list does not hold it (plain strings and numbers). */
function plainLabel(value: JsonValue | undefined, field: InputFieldHint): string | null {
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
}>): WidgetSetupRow {
    const { entry, draft, resolution } = input;
    const path = entry.field.path;
    const binding = draft.bindings[path];
    const issue = issueFor(resolution, path);
    const offered = entry.follow?.values ?? [];

    if (binding?.kind === 'viewer') {
        if (issue && issue.status !== 'selection_required') return { kind: 'invalid', label: null, issue };
        return { kind: 'viewer' };
    }
    if (binding?.kind === 'context') {
        if (issue) return issue.status === 'selection_required' ? { kind: 'needed' } : { kind: 'invalid', label: entry.follow?.label ?? null, issue };
        return { kind: 'follows', label: entry.follow?.label ?? binding.slot, valueLabel: offered[0]?.label ?? null };
    }
    if (binding?.kind === 'value') {
        if (issue && issue.status !== 'selection_required') {
            return { kind: 'invalid', label: findValue([...offered, ...input.options], binding.value)?.label ?? plainLabel(binding.value, entry.field), issue };
        }
        if (offered.length > 1) {
            const selectedIndex = offered.findIndex((candidate) => sameStrictJsonValue(candidate.value, binding.value));
            if (selectedIndex >= 0 && offered.length <= AMBIGUOUS_INLINE_LIMIT) return { kind: 'choices', choices: offered, selectedIndex };
        }
        const value = findValue([...offered, ...input.options], binding.value);
        return { kind: 'pinned', value, label: value?.label ?? plainLabel(binding.value, entry.field) ?? '' };
    }
    return { kind: 'needed' };
}

/**
 * Up to three surface candidates read better as choices in place than behind a menu (lab IN, Q1).
 * This is the lab's presentation rule for a compact step, not a limit on what can be chosen: more go
 * to the field's searchable menu.
 */
export const AMBIGUOUS_INLINE_LIMIT = 3;

/** Why the button cannot finish yet: the first input the binder still needs, by its own title. */
export function describeWidgetSetupBlocker(
    fields: readonly WidgetSetupField[],
    resolution: WidgetBindingResolutionV1,
): Readonly<{ path: string; title: string; status: WidgetInputIssueV1['status'] }> | null {
    const blocking = widgetSetupBlockingIssues(fields, resolution);
    if (blocking.length === 0) return null;
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
