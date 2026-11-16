import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import { isRecord } from '@happier-dev/protocol/common/records';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { TriggerTargetV1} from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { AutomationRunPluginEventTriggerEvidenceV1 } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { FIELD_BOX_METRICS } from '@/components/ui/forms/fieldBox';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { PhoneSheetPushContext, usePhoneSheetPush, type PhoneSheetPushStack } from '@/components/ui/popover/phoneSheetPush';
import { Text } from '@/components/ui/text/Text';
import { resolveWorkflowProblemPresentation, type WorkflowProblemPresentation } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useActiveServerAccountScope, useSessionReferenceTarget } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import { resolveWorkflowStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { withWorkflowAuthoringEngineFields } from '@/sync/domains/workflows/workflowAuthoringEngineSelection';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import { useWorkflowExistingSessionOptions } from '@/components/workflows/screens/useWorkflowExistingSessionOptions';
import { resolveWorkflowSessionChoice, WORKFLOW_SESSION_RETRY_ITEM_ID, workflowSessionMenuState, workflowSessionOptionState } from '@/components/workflows/presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '@/components/workflows/presentation/workflowSessionOptionRow';
import { useSessionDisplayNameSource } from '@/sync/store/hooks';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { WorkflowRunInputs } from '@/components/workflows/run/WorkflowRunComposer';
import { type WorkflowRunInputFieldState } from '@/sync/domains/workflows/workflowAuthoring';

import { formatNextScheduledRunTime, readNextScheduledRunRefreshAtMs, formatTriggerInterval, formatTriggerSummary, weekdayName } from './formatTriggerSummary';
import {
    NOTIFY_ME_ACTION_ID,
    TRIGGER_THEN_KINDS,
    buildTriggerDefinition,
    buildInitialTriggerDefinition,
    buildTriggerTarget,
    readTriggerThen,
    readScheduleWhen,
    projectSessionTriggerWorkflowInputFields,
    buildSessionTriggerWorkflowInputs,
    createDefaultThen,
    createDefaultWhen,
    type SessionTriggerWhenKind,
    type ExecutableTriggerFormValue,
    type TriggerFormValue,
    type TriggerRunsIn,
    type TriggerThenValue,
    type TriggerWhenValue,
} from './sessionTriggerForm';
import { buildSimpleScheduleCron, formatScheduleTimeInput, resolveOnceSchedule, SIMPLE_SCHEDULE_REPEATS as REPEATS } from './triggerSchedule';
import { LocalDateTimeEditor } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { parseHappierLocalDateTime } from '@happier-dev/plugin-ui/presentation';
import { useTriggerScheduleCommands } from './useTriggerScheduleCommands';
import { useProposedScheduleOccurrence } from './useProposedScheduleOccurrence';
import { useNotifyMeChannelOptions, useTriggerWorkflowDefinition } from './useTriggerThenOptions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { SessionTriggerPullRequestPicker } from './SessionTriggerPullRequestPicker';
import { WorkflowExamplesSection } from '../library/WorkflowExamplesSection';
import { resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import type { WorkflowReferenceOption } from '../presentation/workflowReferenceOptions';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import { WorkflowRequesterDisclosure } from '../presentation/WorkflowRequesterDisclosure';

/** A choice the popover lists but cannot offer here, with the reason it says instead. */
export type TriggerKindAvailability = Readonly<Partial<Record<SessionTriggerWhenKind, string>>>;

export type TriggerWorkflowOption = WorkflowReferenceOption;

type TriggerPopoverBaseProps = Readonly<{
    /** Lends this editor's controls to the currently mounted page. */
    currentUiContextCommandScope?: string;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    testID: string;
    /** The kinds **When** offers, in order; an entry in `unavailableKinds` is listed with its reason. */
    whenKinds: readonly SessionTriggerWhenKind[];
    unavailableKinds?: TriggerKindAvailability;
    /** The contextual Session a new lifecycle kind listens to; placement can remain Account-scoped. */
    sessionId: string | null;
    /** The trigger set's placement, independent of its lifecycle source Session. Defaults to the context. */
    scope?: 'session' | 'account';
    pullRequestLinks?: readonly Readonly<{ repository: string; number: number }>[];
    /** `null` adds a new trigger. */
    initial: TriggerFormValue | null;
    workflowOptions: readonly TriggerWorkflowOption[];
    /** False when this Account's library cannot supply the trigger's target Home. Built-ins stay local. */
    libraryWorkflowsAvailable?: boolean;
    /**
     * Whether **Then** is offered. A workflow's own trigger always runs that workflow, so its popover
     * has none (07 S4) and its write carries no target.
     */
    showThen?: boolean;
    /** The title of a new trigger's popover; defaults to "New trigger". */
    newTitle?: string;
    /** The line under the title (a saved trigger's next occurrence), when its owner knows it. */
    subtitle?: string;
    /** A saved occurrence from the scheduler. Hidden as soon as this schedule draft differs. */
    savedNextRunAt?: number | null;
    /** A retained Automation that cannot be edited remains visible with its owner's refusal. */
    submitRefusal?: string;
    /** A pushed host editor shares this shell and preserves the trigger draft underneath it. */
    pushedPage?: TriggerPopoverPushedPage;
    /** Reviewed legacy edit: opening never writes; the disclosure stays above the rows. */
    submitNotice?: string;
    /** Explicit consent uses Save rather than the usual Done; a new one that creates a Workflow says Create. */
    submitLabel?: string;
    /** A retained manual Automation has no firing definition; saving must not invent one, and Delete removes the whole set. */
    manual?: boolean;
    onRunNow?: () => Promise<void>;
    /**
     * Turn a saved trigger on or off from its settings, where a Workflow's other settings live (Q7: a
     * Library row carries no switch). The owner writes it and closes the popover.
     */
    onToggleEnabled?: Readonly<{ enabled: boolean; onPress: () => void }>;
    onHistory?: () => void;
    /** A new trigger's starting When (the "When this turn finishes…" entry binds it to that turn). */
    initialWhen?: TriggerWhenValue;
    /** Contextual Action targets prefill the existing Action fields without creating a trigger. */
    initialActionTargets?: readonly TriggerTargetV1[];
    initialEventSeed?: PluginUiOpenAutomationEventRequestV1;
    initialEventEditSeed?: PluginEventAutomationEditSeed;
    onEditSeedApplied?: React.ComponentProps<typeof TriggerPluginEventRows>['onEditSeedApplied'];
    /**
     * The Machine whose options an Action's fields and "A session…" read: the session's own Machine,
     * or the trigger set's Runs on Machine.
     */
    machineId?: string | null;
    directory?: string | null;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** The exact saved row, whose private source configuration is read only when editing it. */
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    /** Route-local retained observation for a non-executing draft test. Never re-admitted. */
    activityEvent?: AutomationRunPluginEventTriggerEvidenceV1;
    /** Host rows under When (the set's Runs on), and after Then (a workflow's Inputs and Roles). */
    setRows?: React.ReactNode;
    afterRows?: React.ReactNode;
    /** False while a host row the write needs (Runs on) is unresolved. */
    hostComplete?: boolean;
    /**
     * Save as workflow (F1; 07 S16b): opens these steps as a new workflow to review. Offered for a
     * saved trigger whose Then holds its own steps; nothing changes until that workflow is saved.
     */
    onSaveAsWorkflow?: (target: TriggerTargetV1) => void;
    /** Writes the trigger through its owner; a rejection keeps the popover and its edits. */
    onDelete?: () => Promise<void>;
    /**
     * The popover frame the editor opens in. Defaults to a popover hanging from the launching row;
     * a host with its own popover owner (the composer's chip pickers) passes that owner's shell.
     */
    shell?: React.ComponentType<TriggerPopoverShellProps>;
}>;

export type TriggerPopoverShellProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    open: true;
    autoFocusOnOpen: true;
    phonePresentation: 'sheet';
    sheetHeaderAction?: React.ReactNode;
    sheetSubtitle?: string;
    accessibilityLabel?: string;
    maxWidthCap: number;
    maxHeightCap: number;
    /** `placement` is reported only by a shell whose side can vary; it points the surface's arrow. */
    children: (args: Readonly<{
        maxHeight: number;
        placement?: 'top' | 'bottom' | 'left' | 'right';
        presentation: 'popover' | 'sheet';
    }>) => React.ReactNode;
}>;

export function TriggerAnchoredPopoverShell(props: TriggerPopoverShellProps): React.ReactElement {
    return (
        <Popover
            {...props}
            placement="bottom"
            // Keep both steps on the launching row's edge. Side-auto placement put the event
            // step over the document when the settings pane had no room to its right.
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            // T1 is a designed panel wider than the column or pane it is opened from: it floats over the
            // page at its own width (hanging from the row's start edge when its end edge leaves no room)
            // rather than being squeezed into the scope's width, which clipped "Runs on" and the Session.
            boundaryRef={null}
        >
            {({ maxHeight, placement, presentation }) => props.children({
                maxHeight,
                placement,
                presentation: presentation === 'sheet' ? 'sheet' : 'popover',
            })}
        </Popover>
    );
}

type TriggerPopoverWrite<Trigger> = Readonly<{
    trigger: Trigger;
    target: ReturnType<typeof buildTriggerTarget>;
    inputs: Readonly<Record<string, JsonValue>>;
    observationOnly?: Readonly<{ kind: 'observationOnly' }>;
}>;

export type TriggerPopoverProps = TriggerPopoverBaseProps & (
    | Readonly<{ creatingSession?: false;
        onSubmit: (value: ExecutableTriggerFormValue, write: TriggerPopoverWrite<ReturnType<typeof buildTriggerDefinition>>, context?: ActionExecutorContext) => Promise<void> }>
    | Readonly<{ creatingSession: true; sessionId: null;
        onSubmit: (value: ExecutableTriggerFormValue, write: TriggerPopoverWrite<ReturnType<typeof buildInitialTriggerDefinition>>, context?: ActionExecutorContext) => Promise<void> }>
);

/** The popover is exactly as wide as its content, so no empty band sits beside the rows (lab T1). */
// T1's content width plus the canonical page-row insets, rather than charging the insets to its controls.
export const TRIGGER_POPOVER_WIDTH = 380 + 2 * PAGE_LIST_METRICS.rowPaddingHorizontalPx;
const CLOCK_FIELD_STYLE = { minWidth: 0, width: FIELD_BOX_METRICS.triggerMinWidthPx } as const;

const styles = StyleSheet.create((theme) => ({
    surface: {
        width: TRIGGER_POPOVER_WIDTH,
        maxWidth: '100%',
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        // The foot sits under a scrolling form: a breath above it so the last field never touches it.
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    footEnd: {
        marginLeft: 'auto',
        flexDirection: 'row',
        gap: theme.space.s8,
    },
    deleteLabel: { color: theme.colors.state.danger.foreground },
    failure: {
        color: theme.colors.state.danger.foreground,
        width: '100%',
    },
    // The pushed page's Back keeps its own width at the page's leading edge, never a full-width bar.
    back: { paddingHorizontal: theme.space.s16, paddingTop: theme.space.s12, alignItems: 'flex-start' },
}));


export const REPEAT_LABEL_KEYS = { daily: 'everyDay', weekdays: 'weekdays', weekly: 'weekly' } as const;

// The form is narrow even on desktop. Its layout follows the window, not the list's page breakpoint.
/**
 * A phone stacks every field beneath its label. Elsewhere a field stays beside its label while the
 * row's own adaptive rule says it fits, and moves beneath it when it does not (a select sized to its
 * longest choice is wider than the half of this popover's row that an inline control is held to).
 */
function useTriggerFieldLayout() {
    return useViewportClass() === 'compact' ? 'stacked' as const : 'adaptive' as const;
}

function whenDescription(kind: TriggerWhenValue['kind'], sessionScoped: boolean): string | undefined {
    switch (kind) {
        case 'turnEnds':
        case 'needsYou':
        case 'sessionArchived':
        case 'sessionStarts':
        case 'prComment':
        case 'pluginEvent':
            return t(`workflows.triggers.kindDescription.${kind}`);
        // "Continues this session on a schedule" is a session trigger's; a workflow or Account
        // schedule runs its own target, which its rows already say.
        case 'schedule':
            return sessionScoped ? t(`workflows.triggers.kindDescription.${kind}`) : undefined;
        case 'ciFailed':
        case 'runLifecycle':
            return undefined;
    }
}

/** A field select row: the canonical `DropdownMenu` item trigger, opened from its own row. */
export function FieldSelect(props: Readonly<{
    currentUiContextCommandScope?: string;
    testID: string;
    title: string;
    subtitle?: string;
    /** A long list (the Actions catalog) filters as you type. */
    search?: boolean;
    items: readonly DropdownMenuItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    onOpenChange?: (open: boolean) => void;
    /** The menu's line when it has no rows (a list still loading, or none to choose). */
    emptyLabel?: string;
    /** An option that acts in place (a retry) and leaves the menu open on its result. */
    keepsOpen?: (id: string) => boolean;
    /** The stored value no longer resolves: the field wears the invalid border instead of looking chosen. */
    invalid?: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    const scope = props.currentUiContextCommandScope;
    const select = (id: string) => { if (!props.keepsOpen?.(id)) setOpen(false); props.onSelect(id); };
    const commands = useCurrentUiContextLocalCommands(scope === undefined ? [] : [
        { key: 'open', title: props.title, description: `${scope}.open`, invoke: () => setOpen(true) },
        { key: 'close', title: t('common.close'), description: `${scope}.close`, invoke: () => setOpen(false) },
        { key: 'select', title: props.title, description: JSON.stringify({ control: `${scope}.select`,
            selectedId: props.selectedId, input: { id: 'option id' }, options: props.items.map(({ id, title, disabled }) => ({ id, title, disabled: disabled === true })) }),
            invoke: input => {
                if (!isRecord(input) || typeof input.id !== 'string') return false;
                const item = props.items.find(candidate => candidate.id === input.id);
                if (!item || item.disabled) return false;
                select(item.id);
            } },
    ], { foregroundOverlay: true, contextKey: scope });
    React.useEffect(() => {
        if (!props.onOpenChange) return;
        props.onOpenChange(open);
        return () => props.onOpenChange?.(false);
    }, [open, props.onOpenChange]);
    const accessoryLayout = useTriggerFieldLayout();
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={scope === undefined ? setOpen : next => { void commands.invoke(next ? 'open' : 'close'); }}
            items={props.items}
            selectedId={props.selectedId}
            {...(props.keepsOpen === undefined ? {} : { closeOnSelect: false })}
            {...(props.emptyLabel === undefined ? {} : { emptyLabel: props.emptyLabel })}
            onSelect={scope === undefined ? select : id => { void commands.invoke('select', { id }); }}
            // A description wraps; a truncated consequence is no consequence.
            itemTrigger={{
                title: props.title,
                ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
                ...(props.invalid ? { field: { invalid: true } } : {}),
                itemProps: { subtitleLines: 0, accessoryLayout },
            }}
            {...(props.search ? { search: true } : {})}
        />
    );
}

/**
 * The one trigger popover (FIN 04 §5.4–§5.5; 07 S4, S16, S16b; lab `editor-T1/T2`): title = the
 * summary, **When** (the kinds), the kind's own rows, **Then** with its four choices and their rows,
 * and a foot with history, Run now and **Delete trigger**, or **Cancel** and **Add trigger** for a new
 * one. Session and Account triggers differ only in the kinds offered and the write their host makes.
 */
export function TriggerPopover(props: TriggerPopoverProps): React.ReactElement {
    const Shell = props.shell ?? TriggerAnchoredPopoverShell;
    const scope = useActiveServerAccountScope();
    const originServerId = props.serverId ?? scope?.serverId;
    const isNew = props.initial === null && props.submitRefusal === undefined;
    const [savedWhen] = React.useState(() => props.initial?.when);
    const [when, setWhen] = React.useState<TriggerWhenValue>(() => savedWhen ?? props.initialWhen
        ?? createDefaultWhen(props.whenKinds[0] ?? 'turnEnds', props.pullRequestLinks));
    const triggerScope = props.creatingSession ? 'session' : props.scope ?? (props.sessionId !== null ? 'session' : 'account');
    // Standalone Account enrollment has no executable target. A Session or
    // saved workflow's trigger still belongs to its host's execution contract.
    const observationOnly = triggerScope === 'account' && props.showThen !== false && when.kind === 'pluginEvent'
        ? when.observationOnly : undefined;
    const [then, setThen] = React.useState<TriggerThenValue>(() => props.initial?.then
        ?? (props.initialActionTargets?.[0] ? readTriggerThen(props.initialActionTargets[0], { kind: 'detached_run' }) : createDefaultThen('sendPrompt')));
    const enabled = props.initial?.enabled ?? true;
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<WorkflowProblemPresentation | null>(null);
    const [rawInputText, setRawInputText] = React.useState<Readonly<Record<string, string>>>({});
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const [eventEditing, setEventEditing] = React.useState(Boolean(props.initialEventSeed));
    const workflow = useTriggerWorkflowDefinition(!observationOnly && then.kind === 'runWorkflow' ? then.ref : null,
        props.libraryWorkflowsAvailable !== false, props.accountLifetime);
    const inlineDefinition = props.showThen !== false && !observationOnly && then.kind === 'kept' && then.target.kind === 'inline' ? then.target.definition : null;
    const inputFields = React.useMemo(() => projectSessionTriggerWorkflowInputFields({
        when,
        inputs: inlineDefinition?.inputs ?? workflow.definition?.inputs ?? [],
        values: then.kind === 'runWorkflow' || then.kind === 'kept' ? then.inputs : {},
        rawTextValues: rawInputText,
        ...(props.sessionId && originServerId ? { originSession: {
            serverId: originServerId, sessionId: props.sessionId,
        } } : {}),
        deferOriginSessionDefault: props.creatingSession === true,
    }), [when, inlineDefinition, workflow.definition, then, rawInputText, props.sessionId, props.creatingSession, originServerId]);
    const inputPresentation = resolveWorkflowBuiltinInputPresentation(then.kind === 'runWorkflow' ? then.ref : null);
    const changeThen = (next: TriggerThenValue) => {
        if (next.kind !== then.kind || (next.kind === 'runWorkflow' && then.kind === 'runWorkflow' && next.ref !== then.ref)) {
            setRawInputText({});
        }
        const actionDefault = next.kind === 'doAction' ? props.initialActionTargets?.map(target => readTriggerThen(target))
            .find(value => value.kind === 'doAction' && value.actionId === next.actionId) : undefined;
        setThen(next.kind === 'doAction' && actionDefault?.kind === 'doAction'
            ? { ...next, input: { ...actionDefault.input, ...next.input } } : next);
    };

    const trigger = React.useMemo(() => props.manual || props.creatingSession ? null
        : buildTriggerDefinition({ when, enabled, sessionId: props.sessionId }), [props.manual, props.creatingSession, props.sessionId, when, enabled]);
    const initialTrigger = React.useMemo(() => props.creatingSession ? buildInitialTriggerDefinition({ when, enabled }) : null,
        [props.creatingSession, when, enabled]);
    const displayedTrigger = props.creatingSession ? initialTrigger : trigger;
    const sessionScoped = triggerScope === 'session';
    const showThen = props.showThen ?? true;
    const needsTarget = showThen && !observationOnly;
    const target = needsTarget ? buildTriggerTarget(then, triggerScope) : null;
    const promptDestination = useSessionReferenceTarget(
        needsTarget && then.kind === 'sendPrompt' && then.runsIn?.kind === 'session' ? then.runsIn.sessionId : '', originServerId,
    );
    const unavailableWhen = when.kind === 'runLifecycle' ? undefined : props.unavailableKinds?.[when.kind];
    const refused = props.submitRefusal !== undefined || failure?.code === 'legacy_conversion_unsupported';
    // Saved forms may omit the private definition. Retain their When until the user
    // changes it; only a changed When needs to build a replacement definition.
    const whenUnchanged = when === savedWhen;
    const complete = !refused && props.pushedPage === undefined && (whenUnchanged || props.manual || displayedTrigger !== null) && (!needsTarget || (target !== null && !promptDestination.deleted)) && unavailableWhen === undefined
        && (observationOnly || props.hostComplete !== false) && (!needsTarget || then.kind !== 'runWorkflow'
            || (workflow.status === 'ready' && !inputFields.some((field) => field.blocking)))
        && (inlineDefinition === null || !inputFields.some((field) => field.blocking));
    const title = props.submitRefusal !== undefined ? props.newTitle ?? t('workflows.triggers.legacy.reviewRequired') : isNew
        ? props.newTitle ?? t('workflows.triggers.popover.newTrigger')
        : props.manual ? t('workflows.triggers.summary.manual')
            : displayedTrigger === null ? when.kind === 'pluginEvent'
                ? when.eventRef ? formatTriggerSummary({ kind: 'pluginEvent', eventRef: when.eventRef }) : t('workflows.triggers.kind.pluginEvent')
                : t('workflows.triggers.summary.schedule') : formatTriggerSummary(displayedTrigger);

    const run = React.useCallback((operation: () => Promise<void>, close = true) => {
        if (pending) return;
        setPending(true);
        setFailure(null);
        return operation()
            .then(() => { if (close) props.onRequestClose(); })
            .catch((error: unknown) => setFailure(resolveWorkflowProblemPresentation(error)))
            .finally(() => setPending(false));
    }, [pending, props]);

    const submit = (context?: ActionExecutorContext) => {
        if (!complete) return;
        if (observationOnly && whenUnchanged) {
            props.onRequestClose();
            return;
        }
        // Confirmation freezes relative text into one instant. Save failures, retries and the
        // workflow's later Save retain this instant rather than starting the delay again.
        const submittedTrigger = props.manual || props.creatingSession ? null : buildTriggerDefinition({ when, enabled, sessionId: props.sessionId });
        const submittedInitialTrigger = props.creatingSession ? buildInitialTriggerDefinition({ when, enabled }) : null;
        if (!props.manual && !whenUnchanged && (props.creatingSession ? submittedInitialTrigger : submittedTrigger) === null) return;
        const submittedSchedule = submittedTrigger?.kind === 'schedule' ? submittedTrigger.schedule
            : submittedInitialTrigger?.kind === 'schedule' ? submittedInitialTrigger.schedule : null;
        const submittedWhen = submittedSchedule?.kind === 'once' ? readScheduleWhen(submittedSchedule) : when;
        if (submittedWhen !== when) setWhen(submittedWhen);
        const inputs = observationOnly ? {} : then.kind === 'runWorkflow' || inlineDefinition !== null ? buildSessionTriggerWorkflowInputs({ when,
            fields: inputFields, declarations: inlineDefinition?.inputs ?? workflow.definition?.inputs ?? [],
            retainedInputs: then.kind === 'runWorkflow' || then.kind === 'kept' ? then.inputs : {} })
            : then.kind === 'kept' ? then.inputs : {};
        const submittedThen = then.kind === 'runWorkflow' || then.kind === 'kept' ? { ...then, inputs } : then;
        const value = { when: submittedWhen, then: submittedThen, enabled };
        return run(() => props.creatingSession
            ? props.onSubmit(value, { trigger: submittedInitialTrigger, target, inputs }, context)
            : props.onSubmit(value, { trigger: submittedTrigger, target, inputs, ...(observationOnly ? { observationOnly } : {}) }, context));
    };
    const scheduleUnchanged = when.kind === 'schedule' && savedWhen?.kind === 'schedule'
        && when.expression === savedWhen.expression && when.timezone === savedWhen.timezone && when.everyMs === savedWhen.everyMs
        && when.once?.scheduledAt === savedWhen.once?.scheduledAt && when.once?.date === savedWhen.once?.date
        && when.once?.time === savedWhen.once?.time && when.once?.relative === savedWhen.once?.relative;
    const preview = useProposedScheduleOccurrence(enabled && !scheduleUnchanged && props.pushedPage === undefined
        && displayedTrigger?.kind === 'schedule' ? displayedTrigger.schedule : null, props.accountLifetime);
    const nextRunAt = enabled && scheduleUnchanged ? props.savedNextRunAt ?? null
        : preview?.status === 'ready' ? preview.nextRunAt : null;
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(nextRunAt, nowMs), [nextRunAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, nextRunAt !== null && props.pushedPage === undefined);
    const subtitle = nextRunAt === null ? preview?.status === 'invalid_schedule' ? t('workflows.triggers.popover.invalidSchedule')
        : preview?.status === 'failed' ? preview.message
            : preview?.status === 'loading' ? t('common.loading') : props.subtitle : t('workflows.triggers.popover.nextOccurrence', {
        time: formatNextScheduledRunTime(nextRunAt, enabled, nowMs),
    });
    const failureMessage = props.submitRefusal ?? (failure === null ? null : failure.code === 'legacy_conversion_unsupported'
        ? failure.message : `${t('workflows.triggers.section.saveFailed')} ${failure.message}`);
    const commandScope = props.currentUiContextCommandScope;
    const commands = useCurrentUiContextLocalCommands(commandScope === undefined ? [] : [{
        key: 'submit', title: props.submitLabel ?? t('workflows.triggers.popover.done'),
        description: JSON.stringify({ control: `${commandScope}.submit`, complete: Boolean(complete), pending }),
        invoke: (_input, context) => { if (!complete || pending) return false; return submit(context); },
    }], { foregroundOverlay: true, contextKey: commandScope });
    const handleSubmit = commandScope === undefined ? () => submit() : () => { void commands.invoke('submit'); };

    const whenItems: DropdownMenuItem[] = props.whenKinds.map((kind) => {
        const reason = props.unavailableKinds?.[kind];
        return {
            id: kind,
            testID: `${props.testID}-when:${kind}`,
            title: t(`workflows.triggers.kind.${kind}`),
            ...(reason === undefined ? {} : { subtitle: reason, disabled: true }),
        };
    });
    const whenOptions = props.whenKinds.map((kind) => {
        const reason = props.unavailableKinds?.[kind];
        return { id: kind, label: t(`workflows.triggers.kind.${kind}`), ...(reason === undefined ? {} : { unavailableReason: reason }) };
    });
    const thenItems: DropdownMenuItem[] = [...TRIGGER_THEN_KINDS.map((kind) => ({
        id: kind,
        testID: `${props.testID}-then:${kind}`,
        title: t(`workflows.triggers.then.${kind}`),
    })), { id: 'example', testID: `${props.testID}-examples`, title: t('workflows.examples.title') }];
    const completion = <TextLinkButton testID={`${props.testID}-submit`}
        label={pending ? t('common.loading') : props.submitLabel ?? t('workflows.triggers.popover.done')}
        disabled={!complete || pending} onPress={handleSubmit} />;

    return (
        <Shell
            // Each step reuses the overlay's focus/close owner; the parent keeps the form draft.
            key={eventEditing ? 'event' : 'trigger'}
            open
            phonePresentation="sheet"
            sheetHeaderAction={!isNew && !eventEditing && !props.pushedPage && failureMessage === null ? completion : undefined}
            sheetSubtitle={eventEditing || props.pushedPage ? undefined : unavailableWhen ?? subtitle}
            accessibilityLabel={props.pushedPage?.title ?? (eventEditing ? t('workflows.triggers.popover.configureEvent') : title)}
            anchorRef={props.anchorRef}
            maxWidthCap={TRIGGER_POPOVER_WIDTH}
            maxHeightCap={640}
            autoFocusOnOpen
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight, placement, presentation }) => <TriggerPushedPageHost page={props.pushedPage} presentation={presentation}
                renderPage={(page, sheetHeaderBack) => (
                // Its own scroller: reusing the form's kept the form's scroll offset and hid Back and the title (D13).
                <FloatingOverlay key="pushed-page" maxHeight={maxHeight} scrollEnabled surfaceChrome="theme" arrow={placement ? { placement } : false}>
                    <ListPresentationProvider value="page">
                        <View style={styles.surface}>
                            {sheetHeaderBack ? null : <View style={styles.back}><ToolbarButton testID={`${props.testID}-back`}
                                label={t('common.back')} onPress={page.onBack} /></View>}
                            {/* A phone sheet already names the pushed page in its header; the section repeats no title. */}
                            <ItemGroup title={presentation === 'sheet' ? undefined : page.title} surface="none">{page.content}</ItemGroup>
                        </View>
                    </ListPresentationProvider>
                </FloatingOverlay>
            )}>{eventEditing && when.kind === 'pluginEvent' ? (
                <TriggerPluginEventRows testID={props.testID} when={when} onChange={setWhen}
                    machineId={props.machineId ?? null} serverId={props.serverId ?? null} initialEventSeed={props.initialEventSeed}
                    initialEventEditSeed={props.initialEventEditSeed}
                    onEditSeedApplied={props.onEditSeedApplied}
                    eventEdit={props.eventEdit} activityEvent={props.activityEvent}
                    editing onEditingChange={setEventEditing} editorMaxHeight={maxHeight} />
            ) : (
                // The floating theme surface every popover shares (DESIGN.md floating glass).
                <FloatingOverlay maxHeight={maxHeight} scrollEnabled surfaceChrome="theme" arrow={placement ? { placement } : false} footer={<RoundButtonSizeScope size="small" presentation="uniform"><View style={styles.foot}>
                            {failureMessage === null ? null : <Text testID={`${props.testID}-failure`} accessibilityLiveRegion="polite" style={styles.failure}>{failureMessage}</Text>}
                            {!isNew && failureMessage !== null ? completion : null}
                            {isNew ? (
                                <>
                                    <RoundButton size="small" display="inverted"
                                        testID={`${props.testID}-cancel`}
                                        title={t('workflows.triggers.popover.cancel')}
                                        onPress={props.onRequestClose}
                                    />
                                    <View style={styles.footEnd}>
                                        <RoundButton
                                            testID={`${props.testID}-submit`}
                                            size="small"
                                            title={props.submitLabel ?? t('workflows.triggers.popover.addTrigger')}
                                            disabled={!complete}
                                            loading={pending}
                                            onPress={handleSubmit}
                                        />
                                    </View>
                                </>
                            ) : (
                                <>
                                    {props.onHistory ? <RoundButton size="small" display="inverted" testID={`${props.testID}-history`}
                                        title={t("workflows.destination.history.title")} onPress={props.onHistory} /> : null}
                                    {props.onRunNow ? <RoundButton size="small" display="secondary" testID={`${props.testID}-run-now`}
                                        title={t('workflows.editor.runNow')} disabled={pending}
                                        onPress={() => run(props.onRunNow!, false)} /> : null}
                                    {props.onToggleEnabled ? <RoundButton size="small" display="inverted" testID={`${props.testID}-toggle`}
                                        title={t(props.onToggleEnabled.enabled ? 'workflows.triggers.popover.turnOff' : 'workflows.triggers.popover.turnOn')}
                                        disabled={pending} onPress={props.onToggleEnabled.onPress} /> : null}
                                    {props.onDelete ? (
                                        <View style={styles.footEnd}>
                                            {/* Last and quiet, as T1 draws it: red words, no outline beside Run now. */}
                                            <RoundButton size="small" display="inverted"
                                                textStyle={styles.deleteLabel}
                                                testID={`${props.testID}-delete`}
                                                title={t(props.manual ? 'workflows.page.deleteWorkflow' : 'workflows.triggers.popover.deleteTrigger')}
                                                disabled={pending}
                                                onPress={() => run(props.onDelete!)}
                                            />
                                        </View>
                                    ) : null}
                                </>
                            )}
                        </View></RoundButtonSizeScope>}>
                    <ListPresentationProvider value="page">
                    <View testID={props.testID} style={styles.surface}>
                        {/* The popover is a configuration page (07 §3 Sections): its title is the
                            summary, its description the next occurrence, and Done is its one primary,
                            beside the title (lab T1). */}
                        {/* The popover is the surface: its rows sit on it directly, with no card inside it (lab T1). */}
                        <ItemGroup
                            header={presentation === 'sheet' ? 'none' : 'section'}
                            surface="none"
                            title={presentation === 'sheet' ? undefined : title}
                            {...(unavailableWhen !== undefined ? { description: unavailableWhen }
                                : subtitle === undefined ? {} : { description: subtitle })}
                            {...(isNew || presentation === 'sheet' || failureMessage !== null ? {} : { action: completion })}
                        >
                            {props.submitNotice ? <Item mode="info" title={props.submitNotice} titleLines={0} showChevron={false} /> : null}
                            {props.submitRefusal === undefined ? <>
                            {props.manual || when.kind === 'runLifecycle' ? <Item mode="info" title={t('workflows.triggers.popover.when')}
                                detail={when.kind === 'runLifecycle' ? formatTriggerSummary(when) : t('workflows.triggers.summary.manual')} showChevron={false} />
                                // Two to four short choices stay visible side by side; longer lists keep the field select.
                                : props.whenKinds.length >= 2 && props.whenKinds.length <= 4 ? <SegmentedChoiceItem<SessionTriggerWhenKind>
                                testID={`${props.testID}-when`}
                                testIDPrefix={`${props.testID}-when`}
                                // The same stacked field anatomy as Repeat beneath it, so the two choices read alike.
                                accessoryLayout="stacked"
                                labelSize="field"
                                title={t('workflows.triggers.popover.when')}
                                {...(whenDescription(when.kind, sessionScoped) === undefined
                                    ? {} : { subtitle: whenDescription(when.kind, sessionScoped) })}
                                options={whenOptions}
                                value={when.kind}
                                onChange={(kind) => setWhen(createDefaultWhen(kind, props.pullRequestLinks))}
                            /> : <FieldSelect
                                currentUiContextCommandScope={commandScope === undefined ? undefined : `${commandScope}-when`}
                                testID={`${props.testID}-when`}
                                title={t('workflows.triggers.popover.when')}
                                {...(whenDescription(when.kind, sessionScoped) === undefined
                                    ? {} : { subtitle: whenDescription(when.kind, sessionScoped) })}
                                items={whenItems}
                                selectedId={when.kind}
                                onSelect={(id) => {
                                    const kind = props.whenKinds.find((candidate) => candidate === id);
                                    if (kind !== undefined) setWhen(createDefaultWhen(kind, props.pullRequestLinks));
                                }}
                            />}
                            {!props.manual && when.kind === 'schedule' ? <ScheduleRows testID={props.testID}
                                currentUiContextCommandScope={commandScope} when={when} onChange={setWhen} /> : null}
                            {!props.manual && when.kind === 'pluginEvent' ? <TriggerPluginEventRows
                                testID={props.testID} when={when} onChange={setWhen} machineId={props.machineId ?? null}
                                serverId={props.serverId ?? null} eventEdit={props.eventEdit} activityEvent={props.activityEvent} initialEventSeed={props.initialEventSeed}
                                initialEventEditSeed={props.initialEventEditSeed}
                                onEditSeedApplied={props.onEditSeedApplied}
                                onEditingChange={setEventEditing} /> : null}
                            {(when.kind === 'prComment' || when.kind === 'ciFailed') && props.sessionId !== null ? (
                                <SessionTriggerPullRequestPicker
                                    testID={`${props.testID}-pull-request`}
                                    sessionId={props.sessionId}
                                    selection={when.pullRequest}
                                    onSelect={(pullRequest) => setWhen({ kind: when.kind, pullRequest })}
                                />
                            ) : null}
                            {observationOnly ? null : props.setRows ?? null}
                            {needsTarget ? (
                                <>
                                    <FieldSelect
                                        testID={`${props.testID}-then`}
                                        title={t('workflows.triggers.then.label')}
                                        {...(then.kind === 'sendPrompt' && sessionScoped ? { subtitle: t('workflows.triggers.then.sendPromptDescription') } : {})}
                                        items={thenItems}
                                        selectedId={then.kind === 'kept' ? null : then.kind}
                                        onSelect={(id) => {
                                            if (id === 'example') { setExamplesOpen(true); return; }
                                            const kind = TRIGGER_THEN_KINDS.find((candidate) => candidate === id);
                                            if (kind !== undefined) changeThen(createDefaultThen(kind));
                                        }}
                                    />
                                    {examplesOpen ? <WorkflowExamplesSection opensDraft={false} onUse={(example) => {
                                        setRawInputText({});
                                        setExamplesOpen(false);
                                        changeThen({ kind: 'kept', target: { kind: 'inline', definition: example.definition }, inputs: {} });
                                    }} /> : null}
                                    <ThenRows
                                        testID={props.testID}
                                        then={then}
                                        onChange={changeThen}
                                        workflowOptions={props.workflowOptions}
                                        scope={triggerScope}
                                        machineId={props.machineId ?? null}
                                        serverId={props.serverId ?? null}
                                        directory={props.directory ?? null}
                                        workflowFields={inputFields}
                                        inputPresentation={inputPresentation}
                                        rawInputText={rawInputText}
                                        onChangeInputText={(name, text) => setRawInputText((current) => ({ ...current, [name]: text }))}
                                        onChangeInputValue={(name, value) => {
                                            setRawInputText((current) => {
                                                const { [name]: _previous, ...rest } = current;
                                                return rest;
                                            });
                                            if (then.kind !== 'runWorkflow' && then.kind !== 'kept') return;
                                            const { [name]: _previous, ...rest } = then.inputs;
                                            setThen({ ...then, inputs: value === undefined ? rest : { ...rest, [name]: value } });
                                        }}
                                        pending={pending}
                                    />
                                    {then.kind === 'runWorkflow' && workflow.status === 'loading' ? (
                                        <Item title={t('common.loading')} mode="info" />
                                    ) : null}
                                    {then.kind === 'runWorkflow' && workflow.status === 'failed' ? (
                                        <Item title={t('workflows.loadFailedTitle')} subtitle={t('workflows.loadFailedBody')}
                                            detail={t('workflows.retry')} onPress={workflow.retry} />
                                    ) : null}
                                    {/* Its own steps open as a workflow to review: a destination, so a row
                                        under the steps that says what happens, not one more foot button. No
                                        icon: one would shift every row of the popover onto an icon column. */}
                                    {!isNew && props.onSaveAsWorkflow && target?.kind === 'inline' ? (
                                        <Item
                                            testID={`${props.testID}-save-as-workflow`}
                                            title={t('workflows.triggers.popover.saveAsWorkflow')}
                                            subtitle={t('workflows.triggers.popover.saveAsWorkflowDescription')}
                                            onPress={() => {
                                                props.onSaveAsWorkflow?.(target);
                                                props.onRequestClose();
                                            }}
                                        />
                                    ) : null}
                                </>
                            ) : null}
                            {props.afterRows ?? null}
                            </> : null}
                        </ItemGroup>
                        {/* Placement rows already present this review; Session hosts supply only their Machine. */}
                        {!props.setRows && !observationOnly ? <WorkflowRequesterDisclosure machineId={props.machineId}
                            serverId={props.serverId} accountLifetime={props.accountLifetime} retention="trigger" /> : null}

                    </View>
                    </ListPresentationProvider>
                </FloatingOverlay>
            )}</TriggerPushedPageHost>}
        </Shell>
    );
}

type TriggerPopoverPushedPage = Readonly<{ title: string; onBack: () => void; content: React.ReactNode }>;

/**
 * A page pushed over the trigger form (its History, its roles). In a phone sheet it pushes into the
 * sheet's own stack, so the sheet's header leads with Back and names it, and the form stays mounted
 * under it; an anchored popover shows it in place of the form, under a Back row.
 */
function TriggerPushedPageHost(props: Readonly<{
    page: TriggerPopoverPushedPage | undefined;
    presentation: 'sheet' | 'popover';
    renderPage: (page: TriggerPopoverPushedPage, sheetHeaderBack: boolean) => React.ReactNode;
    children: React.ReactNode;
}>): React.ReactElement {
    const stack = React.useContext(PhoneSheetPushContext);
    const pushes = props.presentation === 'sheet' && stack !== null;
    // The form keeps its place whichever way the page shows, so a popover turning into a sheet keeps its rows.
    return <>
        {pushes ? <TriggerSheetPushedPage page={props.page} stack={stack} renderPage={props.renderPage} /> : null}
        {pushes || props.page === undefined ? props.children : props.renderPage(props.page, false)}
    </>;
}

function TriggerSheetPushedPage(props: Readonly<{
    page: TriggerPopoverPushedPage | undefined;
    stack: PhoneSheetPushStack;
    renderPage: (page: TriggerPopoverPushedPage, sheetHeaderBack: boolean) => React.ReactNode;
}>): null {
    const { page, renderPage } = props;
    usePhoneSheetPush({
        stack: props.stack,
        open: page !== undefined,
        title: page?.title,
        onRequestClose: page?.onBack,
        render: () => page === undefined ? null : renderPage(page, true),
    });
    return null;
}

/** Repeat · Day · At, or the expression a schedule was written with when it is not a simple one. */
export function ScheduleRows(props: Readonly<{
    currentUiContextCommandScope?: string;
    testID: string;
    when: Extract<TriggerWhenValue, Readonly<{ kind: 'schedule' }>>;
    onChange: (next: TriggerWhenValue) => void;
}>) {
    const { when } = props;
    const accessoryLayout = useTriggerFieldLayout();
    const schedule = when.schedule;
    const everyMs = when.everyMs;
    const commands = useTriggerScheduleCommands(props);
    const repeatValue = when.once ? 'once' : schedule?.repeat ?? (everyMs === undefined ? 'custom' : 'interval');
    const repeatOptions = [
        { id: 'once', label: t('workflows.triggers.once.label') },
        ...REPEATS.map(repeat => ({ id: repeat, label: t(`workflows.triggers.popover.${REPEAT_LABEL_KEYS[repeat]}`) })),
    ];
    // A saved repeat a person doesn't pick here (an interval, every hour, an expression) leads a field select of the picked ones.
    const repeatRow = everyMs !== undefined || repeatValue === 'custom' || repeatValue === 'hourly' ? <FieldSelect
        testID={`${props.testID}-repeat`}
        title={t('workflows.triggers.popover.repeat')}
        items={[{ id: repeatValue, title: everyMs !== undefined ? formatTriggerInterval(everyMs)
            : repeatValue === 'hourly' ? t('workflows.triggers.popover.everyHour') : t('workflows.triggers.popover.expression') },
            ...repeatOptions.map(option => ({ id: option.id, title: option.label }))]}
        selectedId={repeatValue} onSelect={commands.changeRepeat} /> : <SegmentedChoiceItem
        accessoryLayout="stacked" labelSize="field" testIDPrefix={`${props.testID}-repeat`}
        title={t('workflows.triggers.popover.repeat')} value={repeatValue}
        onChange={commands.changeRepeat} options={repeatOptions} />;
    if (when.once !== undefined) {
        // A retained occurrence may already be done; only edited fields must choose a future instant.
        return <>
            {repeatRow}
            <Item title={t('workflows.triggers.popover.at')} subtitle={when.timezone ?? undefined}
                accessoryLayout="stacked" showChevron={false}
                rightElement={<LocalDateTimeEditor nowMs={when.once.scheduledAt === undefined ? Date.now()
                    : (parseHappierLocalDateTime(when.once) ?? when.once.scheduledAt) - 1}
                    value={when.once} onChange={commands.changeOnceDateTime} testIDPrefix={`${props.testID}-once`}
                    labels={{ date: t('sessionsList.reminders.dateLabel'), time: t('sessionsList.reminders.timeLabel'),
                        pastInstant: t('sessionsList.reminders.futureTimeRequired') }} />} />
            <FieldValueItem testID={`${props.testID}-relative`} accessoryLayout={accessoryLayout}
                title={t('workflows.triggers.once.relative')} subtitle={t('workflows.triggers.once.relativeHint')}
                value={when.once.relative} onCommit={commands.commitRelative} autoCapitalize="none"
                error={when.once.relative.trim() && resolveOnceSchedule(when.once) === null ? t('workflows.triggers.once.relativeInvalid') : null} />
        </>;
    }
    if (schedule === null) {
        return <>{repeatRow}{everyMs === undefined ? <FieldValueItem
            accessoryLayout={accessoryLayout} testID={`${props.testID}-expression`}
            title={t('workflows.triggers.popover.expression')} subtitle={when.timezone ?? undefined}
            value={when.expression} monospace autoCapitalize="none" onCommit={commands.commitExpression} /> : null}</>;
    }
    const setSchedule = (next: typeof schedule) => props.onChange({ ...when, schedule: next, expression: buildSimpleScheduleCron(next) });
    return (
        <>
            {repeatRow}
            {schedule.repeat === 'weekly' ? (
                <FieldSelect
                    currentUiContextCommandScope={props.currentUiContextCommandScope === undefined ? undefined : `${props.currentUiContextCommandScope}-day`}
                    testID={`${props.testID}-day`}
                    title={t('workflows.triggers.popover.day')}
                    items={[1, 2, 3, 4, 5, 6, 0].map((day) => ({ id: String(day), title: weekdayName(day) }))}
                    selectedId={String(schedule.day)}
                    onSelect={(id) => setSchedule({ ...schedule, day: Number(id) })}
                />
            ) : null}
            <FieldValueItem
                accessoryLayout={accessoryLayout}
                testID={`${props.testID}-at`}
                fieldStyle={CLOCK_FIELD_STYLE}
                title={t('workflows.triggers.popover.at')}
                {...(when.timezone ? { subtitle: when.timezone } : {})}
                value={formatScheduleTimeInput(schedule)}
                onCommit={commands.commitTime}
            />
        </>
    );
}

/** The chosen Then's own rows (07 S16b); "kept" steps show no editor and stay as they are. */
function ThenRows(props: Readonly<{
    testID: string;
    then: TriggerThenValue;
    onChange: (next: TriggerThenValue) => void;
    workflowOptions: readonly TriggerWorkflowOption[];
    scope: 'session' | 'account';
    machineId: string | null;
    serverId: string | null;
    directory: string | null;
    workflowFields: readonly WorkflowRunInputFieldState[];
    inputPresentation: React.ComponentProps<typeof WorkflowRunInputs>['presentation'];
    rawInputText: Readonly<Record<string, string>>;
    onChangeInputText: (name: string, text: string) => void;
    onChangeInputValue: (name: string, value: JsonValue | undefined) => void;
    pending: boolean;
}>) {
    const { then } = props;
    const accessoryLayout = useTriggerFieldLayout();
    switch (then.kind) {
        case 'sendPrompt':
            return (
                <>
                    {props.scope === 'account' ? (
                        <RunsInRows
                            testID={props.testID}
                            runsIn={then.runsIn ?? { kind: 'newSession' }}
                            machineId={props.machineId}
                            serverId={props.serverId}
                            onChange={(runsIn) => props.onChange({ ...then, runsIn })}
                        />
                    ) : null}
                    {props.scope === 'account' && then.runsIn?.kind !== 'session' ? (
                        <PromptAgentRows testID={props.testID} then={then} onChange={props.onChange}
                            machineId={props.machineId} serverId={props.serverId} directory={props.directory} />
                    ) : null}
                    <Item
                        title={t('workflows.triggers.then.promptLabel')}
                        showChevron={false}
                        accessoryLayout="stacked"
                        rightElement={(
                            <FieldTextInput
                                testID={`${props.testID}-prompt`}
                                value={then.prompt}
                                multiline
                                placeholder={t('workflows.triggers.then.promptPlaceholder')}
                                accessibilityLabel={t('workflows.triggers.then.promptLabel')}
                                onChangeText={(prompt) => props.onChange({ ...then, prompt })}
                            />
                        )}
                    />
                </>
            );
        case 'doAction':
            return (
                <DoActionRows
                    testID={props.testID}
                    value={then}
                    machineId={props.machineId}
                    serverId={props.serverId}
                    onChange={props.onChange}
                />
            );
        case 'notifyMe':
            return (
                <>
                    <FieldValueItem
                        accessoryLayout={accessoryLayout}
                        testID={`${props.testID}-message`}
                        title={t('workflows.triggers.then.message')}
                        value={then.message}
                        onCommit={(message) => props.onChange({ ...then, message })}
                    />
                    <FieldValueItem
                        accessoryLayout={accessoryLayout}
                        testID={`${props.testID}-title`}
                        title={t('workflows.triggers.then.title')}
                        value={then.title}
                        allowEmpty
                        onCommit={(title) => props.onChange({ ...then, title })}
                    />
                    <SendToSelect
                        testID={`${props.testID}-send-to`}
                        selected={then.channels}
                        onChange={(channels) => props.onChange({ ...then, channels })}
                    />
                </>
            );
        case 'runWorkflow':
            return (
                <>
                    <FieldSelect
                        testID={`${props.testID}-workflow`}
                        title={t('workflows.triggers.then.workflow')}
                        items={props.workflowOptions.map((option) => ({ id: option.ref, title: option.title,
                            ...(option.unavailableReason === undefined ? {} : { disabled: true, subtitle: option.unavailableReason }) }))}
                        selectedId={then.ref}
                        onSelect={(ref) => {
                            if (!props.workflowOptions.some(option => option.ref === ref && option.unavailableReason === undefined)) return;
                            props.onChange({ kind: 'runWorkflow', ref, inputs: {} });
                        }}
                    />
                    <WorkflowRunInputs fields={props.workflowFields} values={then.inputs} rawTextValues={props.rawInputText}
                        optionsConsumer={then.ref === null ? undefined : { kind: 'workflow', workflow: then.ref }}
                        onChangeText={props.onChangeInputText} onChangeValue={props.onChangeInputValue}
                        pending={props.pending} machineId={props.machineId} serverId={props.serverId}
                        presentation={props.inputPresentation}
                        prefix={`${props.testID}-input`} />
                </>
            );
        case 'kept':
            return then.target.kind !== 'inline' ? null : <WorkflowRunInputs fields={props.workflowFields}
                values={then.inputs} rawTextValues={props.rawInputText} onChangeText={props.onChangeInputText}
                onChangeValue={props.onChangeInputValue} pending={props.pending} machineId={props.machineId}
                serverId={props.serverId} prefix={`${props.testID}-input`} />;
    }
}

/** Uses the editor/New Session catalog and picker only while authoring a new Agent session. */
export function PromptAgentRows(props: Readonly<{
    testID: string;
    then: Extract<TriggerThenValue, { kind: 'sendPrompt' }>;
    onChange: (next: TriggerThenValue) => void;
    machineId: string | null;
    serverId: string | null;
    directory: string | null;
}>) {
    const activeScope = useActiveServerAccountScope();
    const facts = useSessionAuthoringControlFacts({ machineId: props.machineId,
        serverId: props.serverId ?? activeScope?.serverId ?? null, directory: props.directory });
    const source = props.then.sourceDefinition;
    const only = source?.blocks.length === 1 ? source.blocks[0] : undefined;
    const retained = resolveWorkflowStepSelectionV1({ defaults: source?.defaults ?? {},
        step: only?.kind === 'step' ? only.execution : undefined, purpose: 'authoring' });
    const values = props.then.selection === undefined ? retained.selection
        : resolveWorkflowStepSelectionV1({ defaults: withWorkflowAuthoringEngineFields(retained.selection, props.then.selection), purpose: 'authoring' }).selection;
    const retainedEngine = only?.kind === 'step' ? only.execution?.engine ?? source?.defaults.engine : source?.defaults.engine;
    const defaultAgentTarget = facts.contextualDefaultAgentTarget;
    React.useEffect(() => {
        if (values.agentTarget != null || retainedEngine !== undefined || defaultAgentTarget == null) return;
        props.onChange({ ...props.then, selection: { ...props.then.selection, agentTarget: defaultAgentTarget } });
    }, [values.agentTarget, retainedEngine, defaultAgentTarget, props.then, props.onChange]);
    return <SessionAuthoringControls presentation="fields" fields={['agentTarget', 'connectedServices']} values={values}
        facts={facts} testIDPrefix={`${props.testID}-agent`}
        onChangeFields={(fields) => props.onChange({ ...props.then, selection: { ...props.then.selection, ...fields } })}
        onChangeField={(field, value) => props.onChange({ ...props.then,
            selection: { ...props.then.selection, [field]: value } })} />;
}

const RUNS_IN_KINDS = ['newSession', 'session', 'backgroundRun'] as const;

/**
 * Runs in (07 S16b, X12): A new session · A session… · A background run, over existing leaf
 * capabilities. "A session…" lists the sessions on Runs on's machine (01 §5.5).
 */
function RunsInRows(props: Readonly<{
    testID: string;
    runsIn: TriggerRunsIn;
    machineId: string | null;
    serverId: string | null;
    onChange: (next: TriggerRunsIn) => void;
}>) {
    const activeServerId = useActiveServerAccountScope()?.serverId ?? null;
    const serverId = props.serverId ?? activeServerId;
    const [runsInOpen, setRunsInOpen] = React.useState(false);
    const [sessionOpen, setSessionOpen] = React.useState(false);
    const demanded = runsInOpen || sessionOpen;
    const { existingSessions, sessionOptionsStatus, retrySessionOptions } = useWorkflowExistingSessionOptions({ serverId,
        machineId: props.machineId, enabled: demanded });
    const first = existingSessions[0];
    const choice = resolveWorkflowSessionChoice(sessionOptionsStatus, first !== undefined);
    const keepsOpen = React.useCallback((id: string) => choice === 'failed'
        && (id === 'session' || id === WORKFLOW_SESSION_RETRY_ITEM_ID), [choice]);
    const storedSessionId = props.runsIn.kind === 'session' ? props.runsIn.sessionId : '';
    const stored = useStoredSessionItem({ sessionId: storedSessionId, serverId,
        offered: existingSessions.some((option) => option.sessionId === storedSessionId),
        settled: demanded && sessionOptionsStatus === 'ready' });
    const sessionMenu = workflowSessionMenuState(choice, t('workflows.triggers.then.noSessionOnMachine'));
    return (
        <>
            {/* Three long choices: a select, not a segmented bar that cannot fit a popover or a phone (DESIGN-18 T1). */}
            <FieldSelect
                testID={`${props.testID}-runs-in`}
                onOpenChange={setRunsInOpen}
                title={t('workflows.triggers.then.runsIn')}
                items={RUNS_IN_KINDS.map((kind) => ({
                    id: kind,
                    testID: `${props.testID}-runs-in:${kind}`,
                    title: t(`workflows.triggers.then.runsInChoice.${kind}`),
                    // The chosen kind needs no reason; its Session field below speaks for it.
                    ...(kind === 'session' && props.runsIn.kind !== 'session'
                        ? workflowSessionOptionState(choice, t('workflows.triggers.then.noSessionOnMachine')) : {}),
                }))}
                selectedId={props.runsIn.kind}
                keepsOpen={keepsOpen}
                onSelect={(id) => {
                    const kind = RUNS_IN_KINDS.find((candidate) => candidate === id);
                    if (kind === undefined) return;
                    if (kind === 'session') {
                        if (choice === 'failed') retrySessionOptions();
                        else if (first !== undefined) props.onChange({ kind: 'session', sessionId: first.sessionId, machineId: first.machineId });
                        return;
                    }
                    props.onChange({ kind });
                }}
            />
            {props.runsIn.kind === 'session' ? (
                <FieldSelect
                    testID={`${props.testID}-runs-in-session`}
                    onOpenChange={setSessionOpen}
                    title={t('workflows.triggers.then.session')}
                    items={[...sessionMenu.leadingItems, ...(stored === null ? [] : [stored]),
                        ...existingSessions.map((option) => ({ id: option.sessionId, title: option.label, ...workflowSessionOptionRow(option) }))]}
                    {...(sessionMenu.emptyLabel === undefined ? {} : { emptyLabel: sessionMenu.emptyLabel })}
                    selectedId={props.runsIn.sessionId}
                    keepsOpen={keepsOpen}
                    invalid={stored?.disabled === true}
                    onSelect={(sessionId) => {
                        if (sessionId === WORKFLOW_SESSION_RETRY_ITEM_ID) { retrySessionOptions(); return; }
                        const option = existingSessions.find((candidate) => candidate.sessionId === sessionId);
                        if (option) props.onChange({ kind: 'session', sessionId: option.sessionId, machineId: option.machineId });
                    }}
                />
            ) : null}
        </>
    );
}

/**
 * The stored Session of a "A session…" trigger while it is not among the offered Sessions: by its name
 * when this device knows it, never as an empty "Choose…". It is called unavailable only on evidence
 * (deleted here, or a settled read that no longer offers it); an unloaded Session is not a missing one.
 */
export function useStoredSessionItem(params: Readonly<{ sessionId: string; serverId: string | null; offered: boolean; settled: boolean }>): DropdownMenuItem | null {
    const nameSource = useSessionDisplayNameSource(params.sessionId, params.serverId);
    const isSessionVisible = useSessionRecordingVisibility();
    const visible = isSessionVisible({ sessionId: params.sessionId, serverId: params.serverId });
    const { deleted } = useSessionReferenceTarget(params.sessionId, params.serverId);
    if (params.sessionId.length === 0 || params.offered) return null;
    const name = !visible ? t('workflows.conversation.savedSession') : nameSource === null ? null : getSessionName(nameSource);
    const unavailable = deleted || (visible && params.settled);
    return {
        id: params.sessionId,
        title: name ?? (unavailable ? t('workflows.conversation.unavailableSession') : t('workflows.conversation.savedSession')),
        ...(unavailable ? { disabled: true, subtitle: deleted ? t('workflows.conversation.sessionGone') : t('workflows.conversation.sessionNotHere') } : {}),
    };
}

/**
 * Do an action (07 S16b): the Actions catalog a workflow's Action step offers (Notify me has its own
 * Then), then the chosen Action's fields from its own input hints, with pickers from its options
 * sources on the trigger's Machine. Values are written as literals of one Action step.
 */
function DoActionRows(props: Readonly<{
    testID: string;
    value: Extract<TriggerThenValue, Readonly<{ kind: 'doAction' }>>;
    machineId: string | null;
    serverId: string | null;
    onChange: (next: TriggerThenValue) => void;
}>) {
    const { value } = props;
    const catalog = useWorkflowActionCatalog({ kind: 'machine', machineId: props.machineId, serverId: props.serverId });
    const specs = React.useMemo(
        () => catalog.specs.filter((spec) => spec.id !== NOTIFY_ME_ACTION_ID),
        [catalog.specs],
    );
    const spec = value.actionId === null ? null : findWorkflowActionSpec(value.actionId, specs);
    const fields = React.useMemo(
        () => (spec === null ? [] : resolveEffectiveActionInputFields(spec, value.input).filter((field) => !field.path.includes('.'))),
        [spec, value.input],
    );
    const activeServerId = useActiveServerAccountScope()?.serverId ?? null;
    const resolveFieldOptions = useActionFieldOptionsForMachine({
        machineId: props.machineId,
        serverId: props.serverId ?? activeServerId,
        enabled: spec !== null,
        requests: fields.map((field) => ({ field, actionId: spec?.id, draftInput: value.input })),
    });
    return (
        <>
            <FieldSelect
                testID={`${props.testID}-action`}
                title={t('workflows.triggers.then.action')}
                search
                items={specs.map((candidate) => ({
                    id: candidate.id,
                    title: candidate.title,
                    ...(candidate.description ? { subtitle: candidate.description } : {}),
                }))}
                selectedId={value.actionId}
                onSelect={(actionId) => props.onChange({ kind: 'doAction', actionId, input: {} })}
            />
            {spec === null || fields.length === 0 ? null : (
                <ActionInputFields
                    fields={fields}
                    input={{ ...value.input }}
                    editable
                    resolveFieldOptions={resolveFieldOptions}
                    onPatch={(patch) => props.onChange({ ...value, input: { ...value.input, ...patch } })}
                    resolveFieldTestID={(field) => `${props.testID}-action-field-${field.path}`}
                />
            )}
        </>
    );
}

/**
 * Send to (F2): a multi-select over Notify me's own channel options, read only while this row is
 * shown; none chosen means your notification settings (03 §3.4).
 */
function SendToSelect(props: Readonly<{
    testID: string;
    selected: readonly string[];
    onChange: (channels: readonly string[]) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const accessoryLayout = useTriggerFieldLayout();
    const options = useNotifyMeChannelOptions();
    const labels = new Map(options.map((option) => [option.value, option.label]));
    const summary = props.selected.length === 0
        ? t('workflows.triggers.then.sendToDefault')
        : props.selected.map((channel) => labels.get(channel) ?? channel).join(', ');
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            closeOnSelect={false}
            items={options.map((option) => ({
                id: option.value,
                testID: `${props.testID}:${option.value}`,
                title: option.label,
                checked: props.selected.includes(option.value),
            }))}
            onSelect={(id) => props.onChange(props.selected.includes(id)
                ? props.selected.filter((channel) => channel !== id)
                : [...props.selected, id])}
            itemTrigger={{ title: t('workflows.triggers.then.sendTo'), detailFormatter: () => summary, itemProps: { accessoryLayout } }}
        />
    );
}
