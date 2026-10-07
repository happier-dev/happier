import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { JsonValue, TriggerTargetV1, WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { useActionFieldOptionsForMachine } from '@/components/sessions/actions/useSessionActionFieldOptions';
import { findWorkflowActionSpec } from '@/components/workflows/presentation/workflowActionCatalog';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import { useWorkflowExistingSessionOptions } from '@/components/workflows/screens/useWorkflowExistingSessionOptions';
import { WorkflowRunInputs } from '@/components/workflows/run/WorkflowRunComposer';
import { buildWorkflowRunStartInputs, projectWorkflowRunInputFields, type WorkflowRunInputFieldState } from '@/sync/domains/workflows/workflowAuthoring';

import { formatTriggerInterval, formatTriggerSummary, weekdayName } from './formatTriggerSummary';
import {
    NOTIFY_ME_ACTION_ID,
    TRIGGER_THEN_KINDS,
    buildTriggerDefinition,
    buildInitialTriggerDefinition,
    buildTriggerTarget,
    createDefaultThen,
    createDefaultWhen,
    type SessionTriggerWhenKind,
    type TriggerFormValue,
    type TriggerRunsIn,
    type TriggerThenValue,
    type TriggerWhenValue,
} from './sessionTriggerForm';
import { buildSimpleScheduleCron, formatClockTime, parseClockTime, type SimpleScheduleRepeat } from './triggerSchedule';
import { useNotifyMeChannelOptions, useTriggerWorkflowDefinition } from './useTriggerThenOptions';
import { SessionTriggerPullRequestPicker } from './SessionTriggerPullRequestPicker';
import { WorkflowExamplesSection } from '../library/WorkflowExamplesSection';
import { resolveWorkflowBuiltinInputPresentation } from '../presentation/workflowBuiltinInputPresentation';
import type { WorkflowReferenceOption } from '../presentation/workflowReferenceOptions';

/** A choice the popover lists but cannot offer here, with the reason it says instead. */
export type TriggerKindAvailability = Readonly<Partial<Record<SessionTriggerWhenKind, string>>>;

export type TriggerWorkflowOption = WorkflowReferenceOption;

type TriggerPopoverBaseProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    testID: string;
    /** The kinds **When** offers, in order; an entry in `unavailableKinds` is listed with its reason. */
    whenKinds: readonly SessionTriggerWhenKind[];
    unavailableKinds?: TriggerKindAvailability;
    /** The session a lifecycle kind listens to; `null` for an Account trigger. */
    sessionId: string | null;
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
    /** Reviewed legacy edit: opening never writes; the disclosure stays above Done. */
    submitNotice?: string;
    /** A retained manual Automation has no firing definition; saving must not invent one. */
    manual?: boolean;
    onRunNow?: () => Promise<void>;
    /** A new trigger's starting When (the "When this turn finishes…" entry binds it to that turn). */
    initialWhen?: TriggerWhenValue;
    /**
     * The Machine whose options an Action's fields and "A session…" read: the session's own Machine,
     * or the trigger set's Runs on Machine.
     */
    machineId?: string | null;
    serverId?: string | null;
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
    onToggleEnabled?: (next: boolean) => Promise<void>;
    onDelete?: () => Promise<void>;
}>;

type TriggerPopoverWrite<Trigger> = Readonly<{
    trigger: Trigger;
    target: ReturnType<typeof buildTriggerTarget>;
    inputs: Readonly<Record<string, JsonValue>>;
}>;

export type TriggerPopoverProps = TriggerPopoverBaseProps & (
    | Readonly<{ creatingSession?: false;
        onSubmit: (value: TriggerFormValue, write: TriggerPopoverWrite<ReturnType<typeof buildTriggerDefinition>>) => Promise<void> }>
    | Readonly<{ creatingSession: true; sessionId: null;
        onSubmit: (value: TriggerFormValue, write: TriggerPopoverWrite<ReturnType<typeof buildInitialTriggerDefinition>>) => Promise<void> }>
);

/** The popover is exactly as wide as its content, so no empty band sits beside the rows (lab T1). */
const TRIGGER_POPOVER_WIDTH = 380;

const styles = StyleSheet.create((theme) => ({
    surface: {
        width: TRIGGER_POPOVER_WIDTH,
        maxWidth: '100%',
    },
    foot: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.margins.sm,
        paddingHorizontal: theme.margins.lg,
        paddingBottom: theme.margins.lg,
    },
    footEnd: {
        marginLeft: 'auto',
        flexDirection: 'row',
        gap: theme.margins.sm,
    },
    failure: {
        color: theme.colors.state.danger.foreground,
        paddingHorizontal: theme.margins.lg,
        paddingBottom: theme.margins.sm,
    },
}));


const REPEATS: readonly SimpleScheduleRepeat[] = ['daily', 'weekdays', 'weekly'];
const REPEAT_LABEL_KEYS = { daily: 'everyDay', weekdays: 'weekdays', weekly: 'weekly' } as const;

function whenDescription(kind: SessionTriggerWhenKind, sessionScoped: boolean): string | undefined {
    switch (kind) {
        case 'turnEnds':
        case 'needsYou':
        case 'sessionArchived':
        case 'sessionStarts':
        case 'prComment':
            return t(`workflows.triggers.kindDescription.${kind}`);
        // "Continues this session on a schedule" is a session trigger's; a workflow or Account
        // schedule runs its own target, which its rows already say.
        case 'schedule':
            return sessionScoped ? t(`workflows.triggers.kindDescription.${kind}`) : undefined;
        case 'ciFailed':
            return undefined;
    }
}

/** A field select row: the canonical `DropdownMenu` item trigger, opened from its own row. */
function FieldSelect(props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
    /** A long list (the Actions catalog) filters as you type. */
    search?: boolean;
    items: readonly DropdownMenuItem[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            testID={props.testID}
            open={open}
            onOpenChange={setOpen}
            items={props.items}
            selectedId={props.selectedId}
            onSelect={(id) => { setOpen(false); props.onSelect(id); }}
            // A description wraps; a truncated consequence is no consequence.
            itemTrigger={{
                title: props.title,
                ...(props.subtitle === undefined ? {} : { subtitle: props.subtitle }),
                itemProps: { subtitleLines: 0 },
            }}
            {...(props.search ? { search: true } : {})}
        />
    );
}

/**
 * The one trigger popover (FIN 04 §5.4–§5.5; 07 S4, S16, S16b; lab `editor-T1/T2`): title = the
 * summary, **When** (the kinds), the kind's own rows, **Then** with its four choices and their rows,
 * and a foot with **Turn off** and **Delete trigger**, or **Cancel** and **Add trigger** for a new
 * one. Session and Account triggers differ only in the kinds offered and the write their host makes.
 */
export function TriggerPopover(props: TriggerPopoverProps): React.ReactElement {
    const isNew = props.initial === null;
    const [when, setWhen] = React.useState<TriggerWhenValue>(() => props.initial?.when ?? props.initialWhen
        ?? createDefaultWhen(props.whenKinds[0] ?? 'turnEnds', props.pullRequestLinks));
    const [then, setThen] = React.useState<TriggerThenValue>(() => props.initial?.then ?? createDefaultThen('sendPrompt'));
    const enabled = props.initial?.enabled ?? true;
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const [rawInputText, setRawInputText] = React.useState<Readonly<Record<string, string>>>({});
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const workflow = useTriggerWorkflowDefinition(then.kind === 'runWorkflow' ? then.ref : null,
        props.libraryWorkflowsAvailable !== false);
    const inlineDefinition = then.kind === 'kept' && then.target.kind === 'inline' ? then.target.definition : null;
    const inputFields = React.useMemo(() => projectWorkflowRunInputFields({
        inputs: inlineDefinition?.inputs ?? workflow.definition?.inputs ?? [],
        values: then.kind === 'runWorkflow' || then.kind === 'kept' ? then.inputs : {},
        rawTextValues: rawInputText,
    }), [inlineDefinition, workflow.definition, then, rawInputText]);
    const inputPresentation = resolveWorkflowBuiltinInputPresentation(then.kind === 'runWorkflow' ? then.ref : null);
    const changeThen = (next: TriggerThenValue) => {
        if (next.kind !== then.kind || (next.kind === 'runWorkflow' && then.kind === 'runWorkflow' && next.ref !== then.ref)) {
            setRawInputText({});
        }
        setThen(next);
    };

    const trigger = props.manual || props.creatingSession ? null : buildTriggerDefinition({ when, enabled, sessionId: props.sessionId });
    const initialTrigger = props.creatingSession ? buildInitialTriggerDefinition({ when, enabled }) : null;
    const displayedTrigger = props.creatingSession ? initialTrigger : trigger;
    const sessionScoped = props.creatingSession || props.sessionId !== null;
    const showThen = props.showThen ?? true;
    const target = showThen ? buildTriggerTarget(then, sessionScoped ? 'session' : 'account') : null;
    const unavailableWhen = props.unavailableKinds?.[when.kind];
    const complete = (props.manual || displayedTrigger !== null) && (!showThen || target !== null) && unavailableWhen === undefined
        && props.hostComplete !== false && (!showThen || then.kind !== 'runWorkflow'
            || (workflow.status === 'ready' && !inputFields.some((field) => field.blocking)))
        && (inlineDefinition === null || !inputFields.some((field) => field.blocking));
    const title = isNew
        ? props.newTitle ?? t('workflows.triggers.popover.newTrigger')
        : props.manual ? t('workflows.triggers.summary.manual')
            : displayedTrigger === null ? t('workflows.triggers.summary.schedule') : formatTriggerSummary(displayedTrigger);

    const run = React.useCallback((operation: () => Promise<void>, close = true) => {
        if (pending) return;
        setPending(true);
        setFailure(null);
        operation()
            .then(() => { if (close) props.onRequestClose(); })
            .catch((error: unknown) => setFailure(`${t('workflows.triggers.section.saveFailed')} ${formatWorkflowProblemMessage(error)}`))
            .finally(() => setPending(false));
    }, [pending, props]);

    const submit = () => {
        if (!complete) return;
        const inputs = then.kind === 'runWorkflow' || inlineDefinition !== null ? buildWorkflowRunStartInputs(inputFields) ?? {}
            : then.kind === 'kept' ? then.inputs : {};
        const submittedThen = then.kind === 'runWorkflow' || then.kind === 'kept' ? { ...then, inputs } : then;
        const value = { when, then: submittedThen, enabled };
        run(() => props.creatingSession
            ? props.onSubmit(value, { trigger: initialTrigger, target, inputs })
            : props.onSubmit(value, { trigger, target, inputs }));
    };

    const whenItems: DropdownMenuItem[] = props.whenKinds.map((kind) => {
        const reason = props.unavailableKinds?.[kind];
        return {
            id: kind,
            testID: `${props.testID}-when:${kind}`,
            title: t(`workflows.triggers.kind.${kind}`),
            ...(reason === undefined ? {} : { subtitle: reason, disabled: true }),
        };
    });
    const thenItems: DropdownMenuItem[] = [...TRIGGER_THEN_KINDS.map((kind) => ({
        id: kind,
        testID: `${props.testID}-then:${kind}`,
        title: t(`workflows.triggers.then.${kind}`),
    })), { id: 'example', testID: `${props.testID}-examples`, title: t('workflows.examples.title') }];

    return (
        <Popover
            open
            anchorRef={props.anchorRef}
            placement="auto"
            maxWidthCap={TRIGGER_POPOVER_WIDTH}
            maxHeightCap={640}
            autoFocusOnOpen
            onRequestClose={props.onRequestClose}
            // Beside its row, the popover starts level with it and only moves up as far as the
            // window needs (lab T1); centring a tall form on a short row pinned it to the window top.
            portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlignVertical: 'start' }}
        >
            {({ maxHeight }) => (
                // An opaque theme surface: the form must not show the document through it (lab T1).
                <FloatingOverlay maxHeight={maxHeight} scrollEnabled surfaceChrome="theme">
                    <ListPresentationProvider value="page">
                    <View testID={props.testID} style={styles.surface}>
                        {props.submitNotice ? <Item mode="info" title={props.submitNotice} titleLines={0} showChevron={false} /> : null}
                        {/* The popover is a configuration page (07 §3 Sections): its title is the
                            summary, its description the next occurrence, and Done is its one primary,
                            beside the title (lab T1). */}
                        {/* The popover is the surface: its rows sit on it directly, with no card inside it (lab T1). */}
                        <ItemGroup
                            surface="none"
                            title={title}
                            {...(unavailableWhen !== undefined ? { description: unavailableWhen }
                                : props.subtitle === undefined ? {} : { description: props.subtitle })}
                            {...(isNew ? {} : {
                                action: (
                                    <RoundButton
                                        testID={`${props.testID}-submit`}
                                        size="small"
                                        title={t('workflows.triggers.popover.done')}
                                        disabled={!complete}
                                        loading={pending}
                                        onPress={submit}
                                    />
                                ),
                            })}
                        >
                            {props.manual ? <Item mode="info" title={t('workflows.triggers.popover.when')}
                                detail={t('workflows.triggers.summary.manual')} showChevron={false} /> : <FieldSelect
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
                            {!props.manual && when.kind === 'schedule' ? <ScheduleRows testID={props.testID} when={when} onChange={setWhen} /> : null}
                            {(when.kind === 'prComment' || when.kind === 'ciFailed') && props.sessionId !== null ? (
                                <SessionTriggerPullRequestPicker
                                    testID={`${props.testID}-pull-request`}
                                    sessionId={props.sessionId}
                                    selection={when.pullRequest}
                                    onSelect={(pullRequest) => setWhen({ kind: when.kind, pullRequest })}
                                />
                            ) : null}
                            {props.setRows ?? null}
                            {showThen ? (
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
                                        scope={sessionScoped ? 'session' : 'account'}
                                        machineId={props.machineId ?? null}
                                        serverId={props.serverId ?? null}
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
                                </>
                            ) : null}
                            {props.afterRows ?? null}
                        </ItemGroup>
                        {failure === null ? null : (
                            <Text testID={`${props.testID}-failure`} accessibilityLiveRegion="polite" style={styles.failure}>{failure}</Text>
                        )}
                        <View style={styles.foot}>
                            {isNew ? (
                                <>
                                    <ToolbarButton
                                        testID={`${props.testID}-cancel`}
                                        label={t('workflows.triggers.popover.cancel')}
                                        onPress={props.onRequestClose}
                                    />
                                    <View style={styles.footEnd}>
                                        <RoundButton
                                            testID={`${props.testID}-submit`}
                                            size="small"
                                            title={t('workflows.triggers.popover.addTrigger')}
                                            disabled={!complete}
                                            loading={pending}
                                            onPress={submit}
                                        />
                                    </View>
                                </>
                            ) : (
                                <>
                                    {props.onRunNow ? <ToolbarButton testID={`${props.testID}-run-now`}
                                        label={t('workflows.editor.runNow')} disabled={pending}
                                        onPress={() => run(props.onRunNow!, false)} /> : null}
                                    {/* Quiet, never a second primary: Turn off is the trigger's own
                                        on/off (not the run's Pause), Delete trigger is destructive last. */}
                                    {props.onToggleEnabled ? (
                                        <ToolbarButton
                                            testID={`${props.testID}-toggle`}
                                            label={t(enabled ? 'workflows.triggers.popover.turnOff' : 'workflows.triggers.popover.turnOn')}
                                            disabled={pending}
                                            onPress={() => run(() => props.onToggleEnabled!(!enabled))}
                                        />
                                    ) : null}
                                    {props.onSaveAsWorkflow && target?.kind === 'inline' ? (
                                        <ToolbarButton
                                            testID={`${props.testID}-save-as-workflow`}
                                            label={t('workflows.triggers.popover.saveAsWorkflow')}
                                            accessibilityLabel={`${t('workflows.triggers.popover.saveAsWorkflow')}. ${t('workflows.triggers.popover.saveAsWorkflowDescription')}`}
                                            onPress={() => {
                                                props.onSaveAsWorkflow?.(target);
                                                props.onRequestClose();
                                            }}
                                        />
                                    ) : null}
                                    {props.onDelete ? (
                                        <View style={styles.footEnd}>
                                            <ToolbarButton
                                                testID={`${props.testID}-delete`}
                                                tone="danger"
                                                label={t('workflows.triggers.popover.deleteTrigger')}
                                                disabled={pending}
                                                onPress={() => run(props.onDelete!)}
                                            />
                                        </View>
                                    ) : null}
                                </>
                            )}
                        </View>
                    </View>
                    </ListPresentationProvider>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

/** Repeat · Day · At, or the expression a schedule was written with when it is not a simple one. */
function ScheduleRows(props: Readonly<{
    testID: string;
    when: Extract<TriggerWhenValue, Readonly<{ kind: 'schedule' }>>;
    onChange: (next: TriggerWhenValue) => void;
}>) {
    const { when } = props;
    const schedule = when.schedule;
    const everyMs = when.everyMs;
    if (schedule === null && everyMs !== undefined) {
        // An interval ("Every hour") stays as it was saved and reads as itself; choosing a simple
        // repeat replaces it with that schedule (09:00 until the person picks a time).
        return (
            <SegmentedChoiceItem<'interval' | SimpleScheduleRepeat>
                testIDPrefix={`${props.testID}-repeat`}
                title={t('workflows.triggers.popover.repeat')}
                value="interval"
                onChange={(repeat) => {
                    if (repeat === 'interval') return;
                    const next = { repeat, hour: 9, minute: 0, day: 1 };
                    props.onChange({ kind: 'schedule', schedule: next, expression: buildSimpleScheduleCron(next), timezone: when.timezone });
                }}
                options={[
                    { id: 'interval' as const, label: formatTriggerInterval(everyMs) },
                    ...REPEATS.map((repeat) => ({ id: repeat, label: t(`workflows.triggers.popover.${REPEAT_LABEL_KEYS[repeat]}`) })),
                ]}
            />
        );
    }
    if (schedule === null) {
        return (
            <FieldValueItem
                testID={`${props.testID}-expression`}
                title={t('workflows.triggers.popover.expression')}
                {...(when.timezone ? { subtitle: when.timezone } : {})}
                value={when.expression}
                monospace
                autoCapitalize="none"
                onCommit={(expression) => props.onChange({ ...when, expression })}
            />
        );
    }
    const setSchedule = (next: typeof schedule) => props.onChange({ ...when, schedule: next, expression: buildSimpleScheduleCron(next) });
    return (
        <>
            <SegmentedChoiceItem<SimpleScheduleRepeat>
                testIDPrefix={`${props.testID}-repeat`}
                title={t('workflows.triggers.popover.repeat')}
                value={schedule.repeat}
                onChange={(repeat) => setSchedule({ ...schedule, repeat })}
                options={REPEATS.map((repeat) => ({ id: repeat, label: t(`workflows.triggers.popover.${REPEAT_LABEL_KEYS[repeat]}`) }))}
            />
            {schedule.repeat === 'weekly' ? (
                <FieldSelect
                    testID={`${props.testID}-day`}
                    title={t('workflows.triggers.popover.day')}
                    items={[1, 2, 3, 4, 5, 6, 0].map((day) => ({ id: String(day), title: weekdayName(day) }))}
                    selectedId={String(schedule.day)}
                    onSelect={(id) => setSchedule({ ...schedule, day: Number(id) })}
                />
            ) : null}
            <FieldValueItem
                testID={`${props.testID}-at`}
                title={t('workflows.triggers.popover.at')}
                {...(when.timezone ? { subtitle: when.timezone } : {})}
                value={formatClockTime(schedule)}
                onCommit={(draft) => {
                    const time = parseClockTime(draft);
                    if (time === null) return formatClockTime(schedule);
                    setSchedule({ ...schedule, ...time });
                    return undefined;
                }}
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
    workflowFields: readonly WorkflowRunInputFieldState[];
    inputPresentation: React.ComponentProps<typeof WorkflowRunInputs>['presentation'];
    rawInputText: Readonly<Record<string, string>>;
    onChangeInputText: (name: string, text: string) => void;
    onChangeInputValue: (name: string, value: JsonValue | undefined) => void;
    pending: boolean;
}>) {
    const { then } = props;
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
                    <FieldItem label={t('workflows.triggers.then.promptLabel')}>
                        <FieldTextInput
                            testID={`${props.testID}-prompt`}
                            value={then.prompt}
                            multiline
                            placeholder={t('workflows.triggers.then.promptPlaceholder')}
                            accessibilityLabel={t('workflows.triggers.then.promptLabel')}
                            onChangeText={(prompt) => props.onChange({ ...then, prompt })}
                        />
                    </FieldItem>
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
                        testID={`${props.testID}-message`}
                        title={t('workflows.triggers.then.message')}
                        value={then.message}
                        onCommit={(message) => props.onChange({ ...then, message })}
                    />
                    <FieldValueItem
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
    const { existingSessions } = useWorkflowExistingSessionOptions({ serverId: props.serverId ?? activeServerId, machineId: props.machineId });
    const first = existingSessions[0];
    return (
        <>
            <SegmentedChoiceItem<(typeof RUNS_IN_KINDS)[number]>
                testIDPrefix={`${props.testID}-runs-in`}
                title={t('workflows.triggers.then.runsIn')}
                value={props.runsIn.kind}
                onChange={(kind) => {
                    if (kind === 'session') {
                        if (first !== undefined) props.onChange({ kind: 'session', sessionId: first.sessionId, machineId: first.machineId });
                        return;
                    }
                    props.onChange({ kind });
                }}
                options={RUNS_IN_KINDS.map((kind) => ({
                    id: kind,
                    label: t(`workflows.triggers.then.runsInChoice.${kind}`),
                    ...(kind === 'session' && first === undefined ? { unavailableReason: t('workflows.triggers.then.noSessionOnMachine') } : {}),
                }))}
            />
            {props.runsIn.kind === 'session' ? (
                <FieldSelect
                    testID={`${props.testID}-runs-in-session`}
                    title={t('workflows.triggers.then.session')}
                    items={existingSessions.map((option) => ({ id: option.sessionId, title: option.label }))}
                    selectedId={props.runsIn.sessionId}
                    onSelect={(sessionId) => {
                        const option = existingSessions.find((candidate) => candidate.sessionId === sessionId);
                        if (option) props.onChange({ kind: 'session', sessionId: option.sessionId, machineId: option.machineId });
                    }}
                />
            ) : null}
        </>
    );
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
            itemTrigger={{ title: t('workflows.triggers.then.sendTo'), detailFormatter: () => summary }}
        />
    );
}
