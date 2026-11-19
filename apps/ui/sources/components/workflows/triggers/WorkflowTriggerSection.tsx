import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WorkflowProjectTargetControl } from '@/components/workflows/editor/WorkflowProjectTargetControl';
import { WorkflowFieldPair } from '@/components/workflows/editor/WorkflowStepDataEditor';
import { workflowEditorStyles } from '@/components/workflows/editor/workflowEditorStyles';
import { isWorkflowProjectTarget } from '@/sync/domains/workflows/workflowProjectTarget';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { useHappierFieldValueDraft } from '@happier-dev/plugin-ui/presentation';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { formatWorkflowInputValue, parseWorkflowInputText } from '@/sync/domains/workflows/workflowInputText';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useActiveMachineFacts, useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import {
    formatScheduledRunQualifier,
    formatTriggerSummary,
    readNextScheduledRunRefreshAtMs,
} from './formatTriggerSummary';
import { readScheduleWhen, readTriggerWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { FieldSelect } from './TriggerPopover';
import type { TriggerPluginEventRows } from './TriggerPluginEventRows';
import { WorkflowRequesterDisclosure } from '../presentation/WorkflowRequesterDisclosure';
import { TriggerRow } from './TriggerRow';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { WorkflowTriggerBlock } from './WorkflowTriggerBlock';
import { useWorkflowTriggerEventOptions } from './useWorkflowTriggerEventOptions';
import { readWorkflowEventDraftSeed } from '../events/workflowEventFacts';
import { describeLegacyTriggerSet } from './sessionTriggerGroups';
import { WorkflowRunRoles, workflowUsedRoleIds } from '../run/WorkflowRunRoles';
import type { WorkflowEditorReadable } from '../editor/workflowEditorDraftStore';
import { useWorkflowRunVisibility } from '../run/useWorkflowRunVisibility';
import {
    editWorkflowTriggerDraft,
    projectWorkflowTriggerRows,
    type WorkflowTriggerDraft,
    type WorkflowTriggerRowModel,
    type WorkflowTriggerSetContextDraft,
} from './workflowTriggerDraft';
import { WorkflowTriggerSentenceLines, type WorkflowTriggerSentenceLine } from './WorkflowTriggerSentenceLines';
import {
    buildWorkflowTriggerStartOptions,
    EMPTY_WORKFLOW_TRIGGER_INCOMPLETE,
    commitWorkflowTriggerWhen,
    addWorkflowTriggerWhen,
    createWorkflowTriggerStartWhen,
    readWorkflowTriggerStartId,
    removeWorkflowTriggerRow,
    type WorkflowTriggerIncomplete,
    type WorkflowTriggerRowRef,
    type WorkflowTriggerStartContext,
} from './workflowTriggerStarts';

const styles = StyleSheet.create((theme) => ({
    /** A hairline between triggers, and above Add a trigger (lab `trig-card-two`). */
    rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    empty: { ...Typography.variant('label'), color: theme.colors.text.secondary, paddingVertical: theme.space.s12 },
    runsOn: { paddingVertical: theme.space.s8 },
    runsOnValue: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s12, rowGap: theme.space.s4 },
    addRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s12, paddingVertical: theme.space.s8 },
    addAction: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, borderRadius: theme.borderRadius.md },
    addLabel: { ...Typography.variant('label'), color: theme.colors.text.secondary },
    menuFoot: { ...Typography.variant('meta'), color: theme.colors.text.secondary, paddingHorizontal: theme.space.s12, paddingVertical: theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    addNote: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, flexShrink: 1, textAlign: 'right' },
    addRowStacked: { flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', gap: theme.space.s4 },
    addNoteStacked: { textAlign: 'left' },
}));

type WorkflowTriggerRoleDefinition = React.ComponentProps<typeof WorkflowRunRoles>['definition'];
const subscribeToNoDefinition = () => () => {};

export type WorkflowTriggerSectionProps = Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    testIDPrefix: string;
    workflowDefinitionId?: string;
    /** This Account's trigger set on this workflow, as last read; `null` with none. */
    set: WorkflowTriggerSetV1 | null;
    draft: WorkflowTriggerDraft;
    onChangeDraft: (next: WorkflowTriggerDraft) => void;
    onEditSeedApplied?: React.ComponentProps<typeof TriggerPluginEventRows>['onEditSeedApplied'];
    status: 'loading' | 'ready' | 'failed';
    onRetry: () => void;
    /** The steps have unsaved changes, so the description adds "Save to include your changes." */
    stepsUnsaved: boolean;
    /** The editor's Where: it seeds the set's Runs on, and a different Runs on says Run now uses it. */
    whereTarget: WorkflowProjectTargetV1 | null;
    whereSummary: string | null;
    /** The workflow's declared inputs, each "Same for all triggers" on the set (03 §5.3). */
    inputs: readonly WorkflowInputDefinition[];
    definition?: WorkflowTriggerRoleDefinition;
    /** The editor's existing draft source, consumed only by the set's Roles controls. */
    definitionSource?: WorkflowEditorReadable<WorkflowTriggerRoleDefinition>;
    /** `card` (default): the When card's rows. `sentence`: the Sentence view's When clause (round 1116c). */
    presentation?: 'card' | 'sentence';
    /** A resource host ("Automate this…"): its own starts lead every start menu (Q5). */
    startContext?: WorkflowTriggerStartContext;
    /**
     * The editor's incomplete triggers (`useWorkflowTriggerEditing`), so the card and the sentence show the
     * same ones. A host with one presentation may leave them here.
     */
    incomplete?: Readonly<{
        state: WorkflowTriggerIncomplete;
        onChange: (update: (current: WorkflowTriggerIncomplete) => WorkflowTriggerIncomplete) => void;
    }>;
}>;

function rowWhen(row: WorkflowTriggerRowModel, set: WorkflowTriggerSetV1 | null, draft: WorkflowTriggerDraft): TriggerWhenValue | null {
    if (row.schedule !== null) return readScheduleWhen(row.schedule.schedule);
    const input = row.kind === 'new' ? draft.adds.find((add) => add.clientId === row.clientId)?.trigger
        : draft.updates[row.triggerId]?.trigger;
    if (input?.kind === 'pluginEvent' && 'sourceInstanceId' in input) {
        return { kind: 'pluginEvent', value: { ...input, enabled: row.enabled } };
    }
    // A drafted before/after Action trigger is its own When.
    if (input?.kind === 'action' && 'phase' in input) {
        const { enabled: _enabled, ...when } = input;
        return when;
    }
    // A drafted session event (the card only drafts Account kinds; schedules are read above).
    if (input?.kind === 'sessionLifecycle') {
        return readTriggerWhen(input);
    }
    const saved = row.kind === 'saved' ? set?.triggers.find((trigger) => trigger.id === row.triggerId) : null;
    return saved ? readTriggerWhen(saved) : null;
}

function rowRef(row: WorkflowTriggerRowModel): WorkflowTriggerRowRef {
    return row.kind === 'saved' ? { kind: 'saved', triggerId: row.triggerId } : { kind: 'new', clientId: row.clientId };
}

/** "Next: {time}" for a saved, enabled schedule whose owner has computed its next occurrence. */
function readNextRunAt(row: WorkflowTriggerRowModel | null): number | null {
    if (row === null || row.kind !== 'saved' || !row.enabled || row.trigger.kind !== 'schedule') return null;
    // The draft projection replaces an edited schedule with its proposed definition, which has no occurrence.
    return 'nextRunAt' in row.trigger ? row.trigger.nextRunAt : null;
}

function LegacyWorkflowTriggerSummary(props: Readonly<{ legacy: NonNullable<ReturnType<typeof describeLegacyTriggerSet>> }>) {
    const time = props.legacy.qualifierTime;
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(time?.atMs ?? null, nowMs), [time]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, time !== undefined);
    return <Item title={props.legacy.title} titleLines={0}
        subtitle={time ? formatScheduledRunQualifier(time, nowMs) : props.legacy.qualifier} subtitleLines={0} mode="info" />;
}

/** A trigger that is not complete yet (no Session or Event chosen): held beside the draft, never in it. */
type PendingStart = WorkflowTriggerIncomplete['pending'][number];

/**
 * **When it runs** (owner 11-15; lab round 1116 `trig-card-*`, `btrig-v-*`): every trigger of this
 * workflow as one block — its sentence, switch and "…", then When and only the rows its start needs —
 * and **Add a trigger**, one searchable menu of every start; with none, one line says what a trigger
 * adds. Edits are part of the editor's draft: Save writes the definition, then the trigger delta. A
 * trigger here always runs this workflow, in the editor's Where; what the set gives every trigger
 * (constant inputs, Roles, Visible to) follows the triggers.
 */
export function WorkflowTriggerSection(props: WorkflowTriggerSectionProps): React.ReactElement {
    const activeMachines = useActiveMachineFacts(props.accountLifetime === undefined);
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '', props.accountLifetime !== undefined);
    const machines = props.accountLifetime === undefined ? activeMachines : addressedMachines ?? [];
    const rows = React.useMemo(() => projectWorkflowTriggerRows(props.set, props.draft), [props.draft, props.set]);
    const definitionIds = React.useMemo(() => props.workflowDefinitionId ? [props.workflowDefinitionId] : [], [props.workflowDefinitionId]);
    const shared = useWorkflowDefinitionLibrary({ enabled: definitionIds.length > 0, definitionIds, accountLifetime: props.accountLifetime });
    const sharedTriggers = shared.definitions.flatMap(definition => definition.triggers.flatMap(trigger =>
        trigger.automationId && trigger.triggerId && trigger.automationId !== props.set?.automationId
            ? [{ ...trigger, automationId: trigger.automationId, triggerId: trigger.triggerId }] : []));
    const [historyKey, setHistoryKey] = React.useState<string | null>(null);
    const toggleHistory = (key: string) => setHistoryKey(current => current === key ? null : key);
    const [localIncomplete, setLocalIncomplete] = React.useState(EMPTY_WORKFLOW_TRIGGER_INCOMPLETE);
    const incomplete = props.incomplete?.state ?? localIncomplete;
    const updateIncomplete = props.incomplete?.onChange ?? setLocalIncomplete;
    const { pending, edits } = incomplete;
    const setPending = (update: (current: readonly PendingStart[]) => readonly PendingStart[]) =>
        updateIncomplete((current) => ({ ...current, pending: update(current.pending) }));
    const setEdits = (update: (current: WorkflowTriggerIncomplete['edits']) => WorkflowTriggerIncomplete['edits']) =>
        updateIncomplete((current) => ({ ...current, edits: update(current.edits) }));
    const [addOpen, setAddOpen] = React.useState(false);
    // The plugin Event catalog is read once a menu that lists it opens, or while a plugin trigger shows.
    const [catalogDemanded, setCatalogDemanded] = React.useState(false);
    const demandCatalog = React.useCallback((open: boolean) => { if (open) setCatalogDemanded(true); }, []);
    const compact = useViewportClass() === 'compact';
    const { theme } = useUnistyles();

    const change = props.onChangeDraft;
    const sessionContext = props.startContext?.session;
    const lifetimeSessionId = sessionContext?.subject.sessionId ?? props.set?.scopeSessionId;
    // One Runs on per trigger set: a pending change, the set's, or the editor's Where for a new set.
    const runsOn = props.draft.context?.project ?? props.set?.project ?? props.whereTarget;
    const runsOnDiffers = runsOn !== null && props.whereTarget !== null
        && (runsOn.machineId !== props.whereTarget.machineId || runsOn.directory !== props.whereTarget.directory);
    const serverId = props.accountLifetime?.scope.serverId ?? null;
    const placement = { machineId: runsOn?.machineId ?? null, serverId };
    const rowWhens = rows.map((row) => edits[row.key] ?? rowWhen(row, props.set, props.draft));
    const showsEvent = [...rowWhens, ...pending.map((item) => item.when)].some((when) => when?.kind === 'pluginEvent');
    const runsBeforeActions = rowWhens.some((when) => when?.kind === 'action' && when.phase === 'before');
    // The Home decides at write whether a before-trigger reaches other people's Actions (R22); until it says so
    // (a new trigger, no subject, a subject the author only views) it runs on the author's own Actions.
    const reachesOthers = rows.some((row) => row.trigger.kind === 'action' && row.trigger.phase === 'before')
        && rows.every((row) => row.trigger.kind !== 'action' || row.trigger.phase !== 'before'
            || ('reachesOthers' in row.trigger && row.trigger.reachesOthers === true));
    const catalog = useWorkflowTriggerEventOptions({ ...placement, enabled: catalogDemanded || showsEvent });
    // The pending fact names the watched resource; only this selected controller resolves its declaration.
    const resolvedPending = pending.map(item => {
        const seed = item.nativeEvent === undefined ? null : readWorkflowEventDraftSeed(item.nativeEvent, { serverId, events: catalog.events });
        return seed?.setupRequired ? { ...item, when: { kind: 'pluginEvent' as const, value: null, eventRef: seed.eventSeed.eventRef }, eventSeed: seed.eventSeed } : item;
    });
    const startOptions = React.useMemo(() => buildWorkflowTriggerStartOptions(catalog.events, undefined, props.startContext),
        [catalog.events, props.startContext]);
    // The menu's foot says where plugin triggers come from: the trigger set's Machine.
    const catalogMachineName = placement.machineId === null ? null
        : getMachineDisplayName(machines.find((machine) => machine.id === placement.machineId) ?? null) ?? t('machine.unnamedMachine');
    const legacy = props.set ? describeLegacyTriggerSet(props.set,
        (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' })) : null;
    const readState = props.status === 'ready' ? null : rows.length > 0 || legacy ? (
        <SurfaceFreshnessLine testID={`${props.testIDPrefix}-triggers-read`} busy={props.status === 'loading'}
            tone={props.status === 'failed' ? 'warning' : 'neutral'}
            reason={props.status === 'failed' ? t('workflows.triggers.section.loadFailed') : t('common.loading')}
            {...(props.status === 'failed' ? { action: { label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry } } : {})} />
    ) : (
        <SurfaceStateCard testID={`${props.testIDPrefix}-triggers-read`} size="line"
            kind={props.status === 'failed' ? 'error' : 'loading'}
            title={props.status === 'failed' ? t('workflows.triggers.section.loadFailed') : t('common.loading')}
            {...(props.status === 'failed' ? { action: { testID: `${props.testIDPrefix}-triggers-read-retry`, label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry } } : {})} />
    );
    if (legacy && props.set) {
        const set = props.set;
        const retained = set.triggers.filter((trigger) => !props.draft.removes.includes(trigger.id));
        return (
            <ItemGroup header="none" surface="none">
                {readState}
                <Item title={t('workflows.triggers.editor.editInWorkflows')} titleLines={0} mode="info" />
                {retained.length === 0 ? (
                    <LegacyWorkflowTriggerSummary legacy={legacy} />
                ) : retained.map((trigger) => (
                    <TriggerRow
                        key={trigger.id}
                        testID={`${props.testIDPrefix}-trigger:${trigger.id}`}
                        title={legacy.title} qualifier={legacy.qualifier} qualifierTime={legacy.qualifierTime} multiline
                        enabled={set.enabled && trigger.enabled} toggleDisabled onToggle={() => {}}
                        onPress={() => {
                            void Modal.confirm(t('workflows.triggers.editor.editInWorkflows'), undefined, {
                                confirmText: t('workflows.triggers.popover.deleteTrigger'), destructive: true,
                            }).then((confirmed) => {
                                if (confirmed) change(editWorkflowTriggerDraft(props.draft, { kind: 'remove', triggerId: trigger.id }));
                            });
                        }}
                    />
                ))}
            </ItemGroup>
        );
    }

    // A complete When joins the draft; an incomplete one stays on screen until it is.
    const editRow = (row: WorkflowTriggerRowModel, when: TriggerWhenValue) => {
        const next = commitWorkflowTriggerWhen({ draft: props.draft, row: rowRef(row), when, enabled: row.enabled,
            sessionId: lifetimeSessionId });
        if (next === null && row.kind === 'new') {
            // A previously complete add must leave the save draft while its replacement is incomplete.
            setPending(current => [...current, { clientId: row.clientId, when, enabled: row.enabled }]);
            change(removeWorkflowTriggerRow(props.draft, rowRef(row)));
            return;
        }
        setEdits(({ [row.key]: _previous, ...rest }) => next === null ? { ...rest, [row.key]: when } : rest);
        if (next !== null) change(next);
        else if (row.kind === 'saved') change(editWorkflowTriggerDraft(props.draft, { kind: 'discardWhen', triggerId: row.triggerId }));
    };
    const editPending = (clientId: string, when: TriggerWhenValue) => {
        const enabled = pending.find(item => item.clientId === clientId)?.enabled ?? true;
        const previousWhen = resolvedPending.find(item => item.clientId === clientId)?.when;
        const next = commitWorkflowTriggerWhen({ draft: props.draft, row: { kind: 'new', clientId }, when, enabled,
            sessionId: lifetimeSessionId });
        setPending(current => next === null
            ? current.some(item => item.clientId === clientId)
                ? current.map(item => item.clientId === clientId
                    ? { ...item, when, ...(readWorkflowTriggerStartId(previousWhen ?? item.when) === readWorkflowTriggerStartId(when) ? {} : { eventSeed: undefined, nativeEvent: undefined }) }
                    : item) : [...current, { clientId, when }]
            : current.filter(item => item.clientId !== clientId));
        if (next !== null) change(next);
    };
    const startTitle = (when: TriggerWhenValue) => {
        const id = readWorkflowTriggerStartId(when);
        return startOptions.find((option) => option.id === id)?.title ?? '';
    };
    // What the trigger set's Machine says about its plugin triggers; null once it has some to list.
    const catalogReason = catalogMachineName === null ? null
        : catalog.status === 'ready'
            ? catalog.events.length === 0 ? t('workflows.triggers.card.noPluginTriggersOn', { machine: catalogMachineName }) : null
            : catalog.status === 'unavailable' ? t('workflows.triggers.card.pluginTriggersUnavailable', { machine: catalogMachineName })
                : t('workflows.triggers.card.pluginTriggersLoading', { machine: catalogMachineName });
    // A pending Event is named by its declaration; until that resolves its When says why, never a blank pill.
    const pendingTitle = (when: TriggerWhenValue) => startTitle(when)
        || (when.kind === 'pluginEvent' ? catalogReason ?? t('automations.form.trigger.chooseEvent') : '');
    // The When select's choice; a session event keeps its Session, and choosing the same start keeps the rows as they are.
    const selectStart = (when: TriggerWhenValue | null, id: string, apply: (next: TriggerWhenValue) => void) => {
        if (when !== null && readWorkflowTriggerStartId(when) === id) return;
        const next = createWorkflowTriggerStartWhen(id, when, props.startContext);
        if (next !== null) apply(next);
    };
    // This Account's set has no trigger; the library may still list others' triggers on this workflow.
    const ownNone = rows.length === 0 && pending.length === 0 && props.status === 'ready';
    const sharedSettled = definitionIds.length === 0 || shared.status === 'loaded';
    const nothingYet = ownNone && sharedTriggers.length === 0 && sharedSettled;
    const blocks: React.ReactNode[] = [
        ...rows.map((row, index) => {
            const edited = edits[row.key];
            const when = rowWhens[index] ?? null;
            const savedSchedule = row.kind === 'saved' && row.trigger.kind === 'schedule' && edited === undefined;
            return (
                <WorkflowTriggerBlock
                    key={row.key}
                    testID={`${props.testIDPrefix}-trigger:${row.key}`}
                    title={edited !== undefined ? startTitle(edited) : formatTriggerSummary(row.trigger)}
                    when={when}
                    enabled={row.enabled}
                    incomplete={edited !== undefined}
                    startOptions={when === null ? startOptions : buildWorkflowTriggerStartOptions(catalog.events,
                        { when, title: formatTriggerSummary(row.trigger) }, props.startContext)}
                    onStartsOpenChange={demandCatalog}
                    onSelectStart={(id) => selectStart(when, id, (next) => editRow(row, next))}
                    {...placement}
                    accountLifetime={props.accountLifetime}
                    sessionId={lifetimeSessionId}
                    sessionContext={sessionContext}
                    {...(savedSchedule ? { savedNextRunAt: props.set?.enabled ? readNextRunAt(row) : null } : {})}
                    {...(row.kind === 'saved' && props.set && row.trigger.kind === 'pluginEvent'
                        ? { eventEdit: { automationId: props.set.automationId, triggerId: row.triggerId } } : {})}
                    {...(props.onEditSeedApplied ? { onEditSeedApplied: props.onEditSeedApplied } : {})}
                    onChangeWhen={(next) => editRow(row, next)}
                    onRemove={() => {
                        setEdits(({ [row.key]: _dropped, ...rest }) => rest);
                        change(removeWorkflowTriggerRow(props.draft, rowRef(row)));
                    }}
                    {...(edited !== undefined ? {} : { onToggleEnabled: () => {
                        if (row.kind === 'saved') {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: row.triggerId, enabled: !row.enabled }));
                            return;
                        }
                        const add = props.draft.adds.find(candidate => candidate.clientId === row.clientId);
                        if (add) change(editWorkflowTriggerDraft(props.draft, {
                            kind: 'add', clientId: row.clientId, trigger: { ...add.trigger, enabled: !row.enabled },
                        }));
                    } })}
                    {...(row.kind === 'saved' && props.set ? {
                        onToggleHistory: () => toggleHistory(row.key),
                        history: historyKey === row.key ? <WorkflowTriggerRunHistory automationId={props.set.automationId} triggerId={row.triggerId}
                            nextRunAt={props.set.enabled ? readNextRunAt(row) : null} accountLifetime={props.accountLifetime}
                            triggerName={formatTriggerSummary(row.trigger)} trigger={row.trigger} /> : undefined,
                    } : {})}
                />
            );
        }),
        ...resolvedPending.map((item) => (
            <WorkflowTriggerBlock key={`new:${item.clientId}`} testID={`${props.testIDPrefix}-trigger:new:${item.clientId}`}
                title={pendingTitle(item.when)} when={item.when} enabled={item.enabled ?? true} incomplete startOptions={startOptions}
                initialEventSeed={item.eventSeed}
                onStartsOpenChange={demandCatalog}
                onSelectStart={(id) => selectStart(item.when, id, (next) => editPending(item.clientId, next))}
                {...placement} accountLifetime={props.accountLifetime} sessionId={lifetimeSessionId} sessionContext={sessionContext}
                onChangeWhen={(when) => editPending(item.clientId, when)}
                onRemove={() => setPending(current => current.filter(candidate => candidate.clientId !== item.clientId))} />
        )),
    ];
    const addFooter = catalogMachineName === null ? undefined : (
        <Text testID={`${props.testIDPrefix}-triggers-add-source`} style={styles.menuFoot}>
            {catalogReason ?? t('workflows.triggers.card.pluginTriggersOn', { count: catalog.events.length, machine: catalogMachineName })}
        </Text>
    );
    const addStart = (id: string) => {
        const when = createWorkflowTriggerStartWhen(id, null, props.startContext);
        if (when !== null) addWorkflowTriggerWhen({ draft: props.draft, when, onChangeDraft: change, updateIncomplete,
            sessionId: lifetimeSessionId });
    };
    if (props.presentation === 'sentence') {
        // The same rows, handlers and pickers as the card: each line's detail chip opens that trigger's own block.
        const lines: WorkflowTriggerSentenceLine[] = [
            ...rows.map((row, index): WorkflowTriggerSentenceLine => {
                const edited = edits[row.key];
                const when = rowWhens[index] ?? null;
                const startId = when === null ? null : readWorkflowTriggerStartId(when);
                const summary = formatTriggerSummary(row.trigger);
                const title = edited !== undefined ? startTitle(edited) : startId === null ? summary : startTitle(when!) || summary;
                return { key: row.key, startId, startTitle: title, enabled: row.enabled, incomplete: edited !== undefined,
                    detail: startId === null ? null : summary === title ? t('workflows.page.inspector.options') : summary,
                    onSelectStart: (id) => selectStart(when, id, (next) => editRow(row, next)),
                    onRemove: () => {
                        setEdits(({ [row.key]: _dropped, ...rest }) => rest);
                        change(removeWorkflowTriggerRow(props.draft, rowRef(row)));
                    },
                    renderRows: () => blocks[index] };
            }),
            ...resolvedPending.map((item, index): WorkflowTriggerSentenceLine => ({ key: `new:${item.clientId}`,
                startId: readWorkflowTriggerStartId(item.when), startTitle: pendingTitle(item.when), detail: null, enabled: item.enabled ?? true, incomplete: true,
                onSelectStart: (id) => selectStart(item.when, id, (next) => editPending(item.clientId, next)),
                onRemove: () => setPending(current => current.filter(candidate => candidate.clientId !== item.clientId)),
                renderRows: () => blocks[rows.length + index] })),
        ];
        return (
            <WorkflowTriggerSentenceLines testIDPrefix={props.testIDPrefix} lines={lines} startOptions={startOptions}
                onAdd={addStart} onStartsOpenChange={demandCatalog} addFooter={addFooter}
                status={props.status === 'failed' ? readState : null} editable />
        );
    }
    const before = readState !== null || (props.stepsUnsaved && rows.length > 0);
    const after = sharedTriggers.length > 0 || shared.status === 'failed' || rows.length > 0;
    return (
        // Rows only: the editor's "When it runs" card owns the title and the one-sentence summary. The
        // triggers and Add a trigger sit on the card's text edge and label track; list rows keep their group.
        <View>
            {before ? (
                <ItemGroup header="none" surface="none">
                    {readState}
                    {props.stepsUnsaved && rows.length > 0 ? <Item testID={`${props.testIDPrefix}-triggers-save-to-include`}
                        title={t('workflows.triggers.editor.saveToInclude')} titleLines={0} mode="info" /> : null}
                </ItemGroup>
            ) : null}
            {nothingYet ? (
                <Text testID={`${props.testIDPrefix}-triggers-empty`} style={styles.empty}>{t('workflows.triggers.card.empty')}</Text>
            ) : null}
            {blocks.map((block, index) => index === 0 ? block : <View key={`rule:${index}`} style={styles.rule}>{block}</View>)}
            {rows.length > 0 && runsOnDiffers ? (
                <WorkflowTriggerRunsOnRow testIDPrefix={props.testIDPrefix} accountLifetime={props.accountLifetime}
                    runsOn={runsOn} whereTarget={props.whereTarget} machines={machines}
                    onChange={(project) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context: { project } }))} />
            ) : null}
            {rows.length > 0 ? <WorkflowTriggerSetInputs {...props} /> : null}
            {after ? (
                <ItemGroup header="none" surface="none">
                    {sharedTriggers.map(trigger => {
                        const key = `${trigger.automationId}:${trigger.triggerId}`;
                        const title = formatTriggerSummary(trigger);
                        return <React.Fragment key={key}>
                            <Item testID={`${props.testIDPrefix}-trigger:${key}`} title={title} mode="info"
                                rightElement={<ToolbarButton testID={`${props.testIDPrefix}-trigger:${key}-history`}
                                    label={t('workflows.destination.history.title')} active={historyKey === key}
                                    onPress={() => toggleHistory(key)} />} />
                            {historyKey === key ? <WorkflowTriggerRunHistory automationId={trigger.automationId}
                                nextRunAt={trigger.kind === 'schedule' ? trigger.nextRunAt : null}
                                triggerId={trigger.triggerId} accountLifetime={props.accountLifetime} triggerName={title} /> : null}
                        </React.Fragment>;
                    })}
                    {shared.status === 'failed' ? <SurfaceFreshnessLine tone="warning"
                        reason={t('workflows.triggers.section.loadFailed')}
                        action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: shared.retry }} /> : null}
                    {rows.length === 0 ? null : (
                        <WorkflowTriggerSetRows {...props} runsOn={runsOn} />
                    )}
                </ItemGroup>
            ) : null}
            {ownNone && !sharedSettled ? null : (
                <View style={styles.rule}>
                    <DropdownMenu
                        testID={`${props.testIDPrefix}-triggers-add-menu`}
                        open={addOpen}
                        onOpenChange={(open) => { setAddOpen(open); demandCatalog(open); }}
                        items={startOptions.map((option) => ({
                            id: option.id,
                            testID: `${props.testIDPrefix}-triggers-add:${option.id}`,
                            title: option.title,
                            category: option.group,
                            icon: <Icon name={option.glyph} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />,
                        }))}
                        showCategoryTitles
                        footer={addFooter}
                        search
                        searchPlaceholder={t('workflows.triggers.card.searchTriggers')}
                        emptyLabel={t('workflows.triggers.card.noTriggersFound')}
                        placement="bottom"
                        popoverAnchorAlign="start"
                        matchTriggerWidth={false}
                        onSelect={(id) => {
                            setAddOpen(false);
                            addStart(id);
                        }}
                        trigger={({ toggle, open }) => (
                            <View style={[styles.addRow, compact ? styles.addRowStacked : null]}>
                                <HappierPressable
                                    testID={`${props.testIDPrefix}-triggers-add`}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('workflows.triggers.card.add')}
                                    expanded={open}
                                    hasPopup="menu"
                                    onPress={toggle}
                                    style={(state) => [styles.addAction, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                                >
                                    <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                                    <Text style={styles.addLabel}>{t('workflows.triggers.card.add')}</Text>
                                </HappierPressable>
                                {/* A before-trigger says where it applies (D6/R22): only Actions started from Happier wait for it. That
                                  * truth stays on a phone, beneath the action; the Run now reminder would only crowd it there. */}
                                {rows.length > 0 && (!compact || runsBeforeActions) ? (
                                    <Text testID={`${props.testIDPrefix}-triggers-add-note`} style={[styles.addNote, compact ? styles.addNoteStacked : null]}>
                                        {t(!runsBeforeActions ? 'workflows.triggers.card.runNowToo'
                                            : reachesOthers ? 'workflows.triggers.card.startedFromHappier' : 'workflows.triggers.card.startedFromHappierOwn')}
                                    </Text>
                                ) : null}
                            </View>
                        )}
                    />
                </View>
            )}
        </View>
    );
}

/**
 * What the trigger set gives every trigger: its Runs on while it differs from the editor's Where, the
 * inputs a trigger starts with, Roles and who can watch the runs.
 */
function WorkflowTriggerSetRows(props: WorkflowTriggerSectionProps & Readonly<{
    runsOn: WorkflowProjectTargetV1 | null;
}>) {
    const change = props.onChangeDraft;
    const setContext = (context: WorkflowTriggerSetContextDraft) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context }));
    const readDefinition = () => props.definitionSource?.get() ?? props.definition;
    const definition = React.useSyncExternalStore(props.definitionSource?.subscribe ?? subscribeToNoDefinition,
        readDefinition, readDefinition);
    const roleIds = React.useMemo(() => definition ? workflowUsedRoleIds(definition) : [], [definition]);
    const overrides = props.draft.context?.roleOverrides ?? props.set?.context?.roleOverrides ?? [];
    const [rolesOpen, setRolesOpen] = React.useState(false);
    const visibleTeamId = props.draft.context?.visibleTeamId === undefined ? props.set?.context?.visibleTeamId : props.draft.context.visibleTeamId;
    const visibility = useWorkflowRunVisibility(props.workflowDefinitionId, {
        selectedTeamId: visibleTeamId ?? undefined,
        onChange: (next) => setContext({ visibleTeamId: next }),
    });
    const selectedTeamId = visibility.resolution.ok ? visibility.resolution.visibleTeamId : null;
    const selectedTeam = visibility.teams.find(team => team.id === selectedTeamId);
    const visibilityDescription = selectedTeam
        ? t('workflows.triggers.editor.visibleToDescription', { team: selectedTeam.name ?? selectedTeam.id })
        : t('workflows.start.visibility.chooseTeam');
    const rolesTestID = `${props.testIDPrefix}-trigger-roles`;
    return (
        <>
            {roleIds.length > 0 && definition ? <>
                <Item testID={rolesTestID} title={t('workflows.triggers.editor.roles')}
                    subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                    detail={overrides.length > 0 ? t('workflows.triggers.editor.rolesChanged', { count: overrides.length })
                        : t('workflows.start.rolesYour')}
                    onPress={() => setRolesOpen(open => !open)} />
                {rolesOpen ? <WorkflowRunRoles definition={definition} roleIds={roleIds} overrides={overrides}
                    onChange={(roleOverrides) => setContext({ roleOverrides })} pending={false} prefix={rolesTestID}
                    serverId={props.accountLifetime?.scope.serverId} machineId={props.runsOn?.machineId ?? null}
                    directory={props.runsOn?.directory ?? null} /> : null}
            </> : null}
            {/* Most workflows are shared with no Team, so the row usually never exists: while the grants load
                nothing is drawn here rather than a "Loading…" line that leaves (07 §7). */}
            {visibility.status === 'failed' ? <SurfaceFreshnessLine tone="warning"
                reason={t('workflows.start.visibility.loadFailed')}
                action={{ label: t('common.retry'), onPress: visibility.retry }} />
                : visibility.status === 'loading' || visibility.teams.length === 0 ? null
                    : visibility.teams.length === 1 && selectedTeam ? <Item title={t('workflows.triggers.editor.visibleTo')}
                        // The sentence wraps whole; the Team name moves beneath on a phone (Item's detail layout).
                        subtitle={visibilityDescription} subtitleLines={0} detail={selectedTeam.name ?? selectedTeam.id} mode="info" />
                        : <FieldSelect testID={`${rolesTestID}-visible-to`} title={t('workflows.triggers.editor.visibleTo')}
                            subtitle={visibilityDescription} items={visibility.teams.map(team => ({ id: team.id, title: team.name ?? team.id }))}
                            selectedId={selectedTeamId} onSelect={visibility.onChange} />}
        </>
    );
}

/** The inputs the trigger set gives every run: on the card's text edge and label track, like Runs on (item 5). */
function WorkflowTriggerSetInputs(props: WorkflowTriggerSectionProps): React.ReactElement | null {
    const change = props.onChangeDraft;
    const constantInputs: Readonly<Record<string, JsonValue>> = props.draft.context?.inputs ?? props.set?.context?.inputs ?? {};
    if (props.inputs.length === 0) return null;
    return (
        <>
            {props.inputs.map((input) => (
                <WorkflowTriggerInputRow
                    key={input.name}
                    testID={`${props.testIDPrefix}-trigger-input-${input.name}`}
                    name={input.name}
                    value={formatWorkflowInputValue(constantInputs[input.name] ?? input.default)}
                    allowEmpty={!input.required}
                    onCommit={(text) => {
                        const value = parseWorkflowInputText(input, text);
                        const { [input.name]: _previous, ...rest } = constantInputs;
                        change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext',
                            context: { inputs: value === undefined ? rest : { ...rest, [input.name]: value } } }));
                    }}
                />
            ))}
        </>
    );
}

/**
 * A workflow input the trigger set gives every run, on the card's label track like the trigger's own rows (WF-ACCEPT-1118
 * item 5): its name in the label column, its value where the card's values start, "Same for all triggers" beneath.
 */
function WorkflowTriggerInputRow(props: Readonly<{
    testID: string;
    name: string;
    value: string;
    allowEmpty: boolean;
    onCommit: (text: string) => void;
}>): React.ReactElement {
    const field = useHappierFieldValueDraft({ value: props.value, onCommit: props.onCommit, kind: 'text', allowEmpty: props.allowEmpty });
    return (
        <View style={workflowEditorStyles.actionFieldRow} testID={props.testID}>
            <WorkflowFieldPair label={props.name} trackKey={`trigger-input-${props.name}`}>
                <FieldTextInput
                    testID={`${props.testID}-field`}
                    value={field.draft}
                    onChangeText={field.change}
                    accessibilityLabel={props.name}
                    accessibilityHint={t('workflows.triggers.editor.sameForAllTriggers')}
                    onBlur={field.commit}
                    onSubmitEditing={field.commit}
                    onKeyPress={(event) => { if (event.nativeEvent.key === 'Escape') field.cancel(); }}
                />
                <Text style={workflowEditorStyles.metaText}>{t('workflows.triggers.editor.sameForAllTriggers')}</Text>
            </WorkflowFieldPair>
        </View>
    );
}

/**
 * The trigger set's Machine and folder, shown only while it differs from the How card's Where (lab Q1):
 * one row on the card's label track, with "Use the same". Otherwise the How card's Where is the one place.
 */
function WorkflowTriggerRunsOnRow(props: Readonly<{
    testIDPrefix: string;
    accountLifetime?: ServerAccountScopeLifetime | null;
    runsOn: WorkflowProjectTargetV1 | null;
    whereTarget: WorkflowProjectTargetV1 | null;
    machines: NonNullable<React.ComponentProps<typeof WorkflowProjectTargetControl>['machines']>;
    onChange: (project: WorkflowProjectTargetV1) => void;
}>) {
    const runsOnMachine = props.runsOn === null ? null : props.machines.find((candidate) => candidate.id === props.runsOn?.machineId) ?? null;
    const runsOnMachineName = getMachineDisplayName(runsOnMachine) ?? t('machine.unnamedMachine');
    return (
        <View style={[workflowEditorStyles.actionFieldRow, styles.runsOn]} testID={`${props.testIDPrefix}-trigger-runs-on`}>
            <WorkflowFieldPair label={t('workflows.triggers.card.runsOn')} trackKey="trigger-runs-on">
                <View style={styles.runsOnValue}>
                    <WorkflowProjectTargetControl
                        accountLifetime={props.accountLifetime}
                        purpose="trigger"
                        presentation="value"
                        target={props.runsOn}
                        machineName={props.runsOn === null ? null : runsOnMachineName}
                        machines={props.machines}
                        onChange={(next) => { if (isWorkflowProjectTarget(next)) props.onChange(next); }}
                        testIDPrefix={`${props.testIDPrefix}-trigger-runs-on`}
                    />
                    {props.whereTarget === null ? null : (
                        <TextLinkButton testID={`${props.testIDPrefix}-trigger-runs-on-use-same`} tone="quiet"
                            label={t('workflows.triggers.card.useSame')}
                            onPress={() => { if (props.whereTarget) props.onChange(props.whereTarget); }} />
                    )}
                </View>
            </WorkflowFieldPair>
            <WorkflowRequesterDisclosure machineId={props.runsOn?.machineId}
                accountLifetime={props.accountLifetime} retention="trigger" />
        </View>
    );
}
