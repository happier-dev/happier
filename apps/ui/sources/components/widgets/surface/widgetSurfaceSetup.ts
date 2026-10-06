import { VoiceTrackedSessionAddressV1Schema, type JsonValue } from '@happier-dev/protocol';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { projectWidgetBindingInputV1, resolveConfiguredWidgetInputs, widgetCandidateDefinitionV1, isSameWidgetDefinitionV1, countWidgetInstancesV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import type { SessionBoardCommandOutcome } from '@/components/sessions/board/useSessionBoardController';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import {
    proposeWidgetSetupDraft,
    isLiteralWidgetSetupField,
    type WidgetSetup,
    type WidgetSetupDraft,
    type WidgetSetupField,
    type WidgetSetupSubmitResult,
} from '@/components/widgets/add/widgetSetupModel';
import { t } from '@/text';

/**
 * One named slot a page or area fills (lab `dashboards` PG, P1): "This page" (a plugin page's
 * filter), "This project" or "This checkout". `value` is its current value for people, or `null`
 * while the host cannot supply one; a null slot is never followed, so its input is asked for.
 */
export type WidgetSurfaceContextSlot = Readonly<{
    /** The follow label: "This page", "This project", "The checkout you're on". */
    label: string;
    value: Readonly<{ value: JsonValue; label: string; description?: string }> | null;
}>;

/**
 * What a hosting surface fills on its own (WidgetSurface `providedContext`). A Session Board or
 * Companion offers its Session ("This session"); Home offers none, so a Session input there is
 * chosen. A plugin page area or a Project aside offers named `slots`: an input follows the slot its
 * path names (the area's declared context, `filter` → `filter`). The binder
 * (`resolveConfiguredWidgetInputs`) re-resolves every slot on every read; this description only
 * names them for people.
 */
export type WidgetSurfaceContext = Readonly<{
    session?: Readonly<{ ref: Readonly<{ serverId: string; sessionId: string }>; label: string; description?: string }>;
    slots?: Readonly<Record<string, WidgetSurfaceContextSlot>>;
}>;

const NO_VIEWER_VALUES: Readonly<Record<string, JsonValue>> = Object.freeze({});

/** The binder's slot for a widget's declared Session input (`sessionInputPath`). */
export const WIDGET_SESSION_CONTEXT_SLOT = 'session';

/** The binder's provided context for a surface: its named slots and their current values. */
export function widgetProvidedContext(context: WidgetSurfaceContext): Readonly<Record<string, readonly JsonValue[]>> {
    const provided: Record<string, readonly JsonValue[]> = {};
    for (const [slot, entry] of Object.entries(context.slots ?? {})) if (entry.value) provided[slot] = [entry.value.value];
    if (context.session) provided[WIDGET_SESSION_CONTEXT_SLOT] = [context.session.ref];
    return provided;
}

/** Whether a candidate declares inputs at all: only then does it have a step, a count and copies. */
export function isConfigurableWidgetCandidate(candidate: Pick<WidgetCandidate, 'inputs'>): boolean {
    return (candidate.inputs?.fields.length ?? 0) > 0;
}

export const widgetDefinitionOfCandidate = widgetCandidateDefinitionV1;

/**
 * The gallery's sources, by where a widget's definition comes from (lab `dashboards` dbind G):
 * Built in (Happier's own native widgets) and From plugins (installed surfaces). Account
 * definitions — Your widgets — are a third kind of definition and arrive with their own candidates.
 */
export function partitionWidgetCandidatesBySource<T extends Pick<WidgetCandidate, 'definition'>>(
    candidates: readonly T[],
): Readonly<{ builtIn: readonly T[]; fromPlugins: readonly T[]; yours: readonly T[] }> {
    const builtIn: T[] = [];
    const fromPlugins: T[] = [];
    // The Account's own definitions (made by the person or their agents): the gallery's "Your widgets".
    const yours: T[] = [];
    for (const candidate of candidates) {
        const kind = candidate.definition?.kind;
        (kind === 'builtin' ? builtIn : kind === 'artifact' ? yours : fromPlugins).push(candidate);
    }
    return { builtIn, fromPlugins, yours };
}

/** Same widget definition: the gallery counts copies by it, never by title. */
export const isSameWidgetDefinition = isSameWidgetDefinitionV1;

export const countWidgetInstances = countWidgetInstancesV1;

/** The step's rows for a candidate on a surface: the Session input follows "This session" when offered. */
export function widgetSetupFieldsForCandidate(
    candidate: Pick<WidgetCandidate, 'inputs' | 'sessionInputPath' | 'connectedAccountPurposeBindings'>,
    context: WidgetSurfaceContext,
    audience: 'personal' | 'shared',
): readonly WidgetSetupField[] {
    return (candidate.inputs?.fields ?? []).map((field): WidgetSetupField => {
        if (field.path === candidate.sessionInputPath && context.session) {
            const session = context.session;
            return {
                field,
                follow: {
                    slot: WIDGET_SESSION_CONTEXT_SLOT,
                    label: t('widgetAdd.thisSession'),
                    values: [{ value: session.ref, label: session.label, ...(session.description ? { description: session.description } : {}) }],
                },
            };
        }
        const slot = context.slots && Object.hasOwn(context.slots, field.path) ? context.slots[field.path] : undefined;
        if (slot?.value) return { field, follow: { slot: field.path, label: slot.label, values: [slot.value] } };
        // On a shared surface a connection is each viewer's own; it is never stored in shared content.
        const purpose = candidate.connectedAccountPurposeBindings?.find(binding => binding.path === field.path)?.purpose;
        if (audience === 'shared' && field.connectedAccountOptions === true && purpose) return { field, viewer: { purpose } };
        return { field };
    });
}

/**
 * One Set up (add) or Edit inputs step for a widget on any surface. The surface supplies
 * where it goes (`submit`, its canonical Action/command) and how it previews; this owner supplies the
 * rows, the starting bindings and the binder's answer, so Home, Board and Companion share one step.
 */
export function buildWidgetCandidateSetup(input: Readonly<{
    candidate: WidgetCandidate;
    context: WidgetSurfaceContext;
    audience: 'personal' | 'shared';
    mode: Readonly<{ kind: 'add'; submitLabel: string }> | Readonly<{ kind: 'edit'; instance: WidgetInstanceV1 }>;
    submit: (draft: WidgetSetupDraft) => Promise<WidgetSetupSubmitResult>;
    renderPreview?: WidgetSetup['renderPreview'];
    /** The qualified surface: option reads are admitted for this widget on this surface only. */
    scope?: WidgetSurfaceRefV1 | null;
}>): WidgetSetup {
    const { candidate, mode } = input;
    const fields = widgetSetupFieldsForCandidate(candidate, input.context, input.audience);
    const initial: WidgetSetupDraft = mode.kind === 'edit'
        ? { bindings: mode.instance.bindings }
        : proposeWidgetCandidateSetupDraft(candidate, fields);
    const definition = mode.kind === 'edit' ? mode.instance.definition : widgetDefinitionOfCandidate(candidate);
    const instanceId = mode.kind === 'edit' ? mode.instance.id : 'draft';
    const providedContext = widgetProvidedContext(input.context);
    return {
        title: mode.kind === 'edit' ? t('widgetAdd.editTitle', { widget: candidate.title }) : t('widgetAdd.setupTitle', { widget: candidate.title }),
        hint: mode.kind === 'edit' ? t('widgetAdd.editHint') : candidate.pluginName,
        submitLabel: mode.kind === 'edit' ? t('common.save') : mode.submitLabel,
        widget: { title: (mode.kind === 'edit' ? mode.instance.displayName : undefined) ?? candidate.title, mark: candidate.icon },
        fields,
        initial,
        resolve: (draft) => resolveConfiguredWidgetInputs({
            instance: { v: 1, id: instanceId, definition, bindings: draft.bindings },
            descriptor: candidate,
            providedContext,
            // Per-viewer inputs resolve for each viewer when the widget reads, never from this step.
            viewerValues: NO_VIEWER_VALUES,
        }),
        ...(input.renderPreview ? { renderPreview: input.renderPreview } : {}),
        optionsContext: (draft) => {
            // Discovery needs the readable bound dependencies even before every required input is
            // chosen. The canonical binder projects intent; the Action still admits every read.
            const draftInput = projectWidgetBindingInputV1({ instance: { v: 1, id: instanceId, definition, bindings: draft.bindings },
                fields: candidate.inputs?.fields ?? [], context: providedContext, viewerValues: NO_VIEWER_VALUES });
            const selected = candidate.sessionInputPath
                ? VoiceTrackedSessionAddressV1Schema.safeParse(readInputPath(draftInput, candidate.sessionInputPath)) : null;
            return { draftInput, ...(input.scope ? { consumer: { kind: 'widget' as const, surface: input.scope, definition,
                ...(selected?.success ? { selectedSession: selected.data } : {}) } } : {}) };
        },
        submit: input.submit,
    };
}

/** Schema defaults are proposals only; the same binder still validates every proposed value. */
function proposeWidgetCandidateSetupDraft(candidate: WidgetCandidate, fields: readonly WidgetSetupField[]): WidgetSetupDraft {
    const proposed = proposeWidgetSetupDraft(fields);
    const bindings = { ...proposed.bindings };
    for (const entry of fields) {
        if (Object.hasOwn(bindings, entry.field.path) || entry.follow || entry.viewer || !isLiteralWidgetSetupField(entry.field)) continue;
        let schema = candidate.inputSchema;
        for (const segment of entry.field.path.split('.')) schema = schema?.properties?.[segment];
        if (schema?.default !== undefined) bindings[entry.field.path] = { kind: 'value', value: schema.default };
    }
    return { bindings };
}

/** An acknowledged step result, or a write that resolves only after success and throws on refusal. */
export type WidgetSetupCommandResult = void | WidgetSetupSubmitResult;

export async function runWidgetSetupCommand(run: () => Promise<WidgetSetupCommandResult> | WidgetSetupCommandResult, failure: string): Promise<WidgetSetupSubmitResult> {
    try {
        const result = await run();
        return result ?? { ok: true };
    } catch {
        return { ok: false, message: failure };
    }
}

/**
 * A Board or widget-area command as a step result. Applied (or waiting for someone's approval) finishes the step;
 * anything else keeps it open with the reason, so nothing reads as saved when it was not. The Board
 * controller has already said what happened in its own notice.
 */
export async function runAcknowledgedWidgetSetupCommand(
    run: () => Promise<Pick<SessionBoardCommandOutcome, 'kind'> | Readonly<{ kind: 'refused' }> | null | void> | void,
    failure: string,
): Promise<WidgetSetupSubmitResult> {
    try {
        const outcome = await run();
        return outcome && (outcome.kind === 'applied' || outcome.kind === 'approvalPending')
            ? { ok: true, ...(outcome.kind === 'approvalPending' ? { approvalPending: true } : {}) } : { ok: false, message: failure };
    } catch {
        return { ok: false, message: failure };
    }
}
