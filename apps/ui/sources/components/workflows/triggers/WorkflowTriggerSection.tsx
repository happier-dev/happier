import * as React from 'react';
import { View } from 'react-native';
import type { JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import { Icon } from '@/components/ui/icons/Icon';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
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
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { formatScheduledRunQualifier, formatTriggerSummary, readNextScheduledRunRefreshAtMs } from './formatTriggerSummary';
import { createDefaultThen, readScheduleWhen, readTriggerWhen, type ExecutableTriggerFormValue as TriggerFormValue, type TriggerWhenValue } from './sessionTriggerForm';
import { FieldSelect, TriggerPopover } from './TriggerPopover';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { TriggerRow } from './TriggerRow';
import type { TriggerRowProps } from './TriggerRow';
import { useWorkflowSourcePeople } from '../useWorkflowSourcePeople';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { describeLegacyTriggerSet } from './sessionTriggerGroups';
import { WorkflowRunRoles, workflowUsedRoleIds } from '../run/WorkflowRunRoles';
import { useWorkflowRunVisibility } from '../run/useWorkflowRunVisibility';
import {
    editWorkflowTriggerDraft,
    projectWorkflowTriggerRows,
    type WorkflowTriggerDraft,
    type WorkflowTriggerRowModel,
    type WorkflowTriggerSetContextDraft,
} from './workflowTriggerDraft';

export type WorkflowTriggerSectionProps = Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    testIDPrefix: string;
    workflowDefinitionId?: string;
    /** This Account's trigger set on this workflow, as last read; `null` with none. */
    set: WorkflowTriggerSetV1 | null;
    draft: WorkflowTriggerDraft;
    onChangeDraft: (next: WorkflowTriggerDraft) => void;
    status: 'loading' | 'ready' | 'failed';
    onRetry: () => void;
    /** The steps have unsaved changes, so the description adds "Save to include your changes." */
    stepsUnsaved: boolean;
    /** The editor's Where: it seeds the set's Runs on, and a different Runs on says Run now uses it. */
    whereTarget: WorkflowProjectTargetV1 | null;
    whereSummary: string | null;
    /** The workflow's declared inputs, each "Same for all triggers" on the set (03 §5.3). */
    inputs: readonly WorkflowInputDefinition[];
    definition?: React.ComponentProps<typeof WorkflowRunRoles>['definition'];
}>;

function rowWhen(row: WorkflowTriggerRowModel, set: WorkflowTriggerSetV1 | null, draft: WorkflowTriggerDraft): TriggerWhenValue | null {
    if (row.schedule !== null) return readScheduleWhen(row.schedule.schedule);
    const input = row.kind === 'new' ? draft.adds.find((add) => add.clientId === row.clientId)?.trigger
        : draft.updates[row.triggerId]?.trigger;
    if (input?.kind === 'pluginEvent' && 'sourceInstanceId' in input) {
        return { kind: 'pluginEvent', value: { ...input, enabled: row.enabled } };
    }
    const saved = row.kind === 'saved' ? set?.triggers.find((trigger) => trigger.id === row.triggerId) : null;
    return saved ? readTriggerWhen(saved) : null;
}

/** "Next run: {time}" for a saved, enabled schedule whose owner has computed its next occurrence. */
function readNextRunAt(row: WorkflowTriggerRowModel | null): number | null {
    if (row === null || row.kind !== 'saved' || !row.enabled || row.trigger.kind !== 'schedule') return null;
    // The draft projection replaces an edited schedule with its proposed definition, which has no occurrence.
    return 'nextRunAt' in row.trigger ? row.trigger.nextRunAt : null;
}

/** The shared popover owns the saved occurrence display and hides it after schedule edits. */
function WorkflowTriggerPopover(props: React.ComponentProps<typeof TriggerPopover> & Readonly<{
    nextRunAt: number | null;
    definition: WorkflowTriggerSectionProps['definition'];
    sourceArtifactId?: string;
    rolesTestID: string;
    directory: string | null;
    context: Pick<WorkflowTriggerSetContextDraft, 'roleOverrides' | 'visibleTeamId'>;
    onChangeContext: (context: Pick<WorkflowTriggerSetContextDraft, 'roleOverrides' | 'visibleTeamId'>) => void;
}>) {
    const { nextRunAt, definition, sourceArtifactId, rolesTestID, directory, context, onChangeContext, ...popover } = props;
    const [rolesOpen, setRolesOpen] = React.useState(false);
    const roleIds = React.useMemo(() => definition ? workflowUsedRoleIds(definition) : [], [definition]);
    const overrides = context.roleOverrides ?? [];
    const visibility = useWorkflowRunVisibility(sourceArtifactId, {
        selectedTeamId: context.visibleTeamId ?? undefined,
        onChange: (visibleTeamId) => onChangeContext({ visibleTeamId }),
    });
    const selectedTeamId = visibility.resolution.ok ? visibility.resolution.visibleTeamId : null;
    const selectedTeam = visibility.teams.find(team => team.id === selectedTeamId);
    const visibilityDescription = selectedTeam
        ? t('workflows.triggers.editor.visibleToDescription', { team: selectedTeam.name ?? selectedTeam.id })
        : t('workflows.start.visibility.chooseTeam');
    return <TriggerPopover {...popover} savedNextRunAt={nextRunAt}
        pushedPage={rolesOpen && definition ? {
            title: t('workflows.triggers.editor.roles'),
            onBack: () => setRolesOpen(false),
            content: <WorkflowRunRoles definition={definition} roleIds={roleIds} overrides={overrides}
                onChange={(roleOverrides) => onChangeContext({ roleOverrides })} pending={false} prefix={rolesTestID}
                serverId={popover.serverId} machineId={popover.machineId} directory={directory} />,
        } : undefined}
        afterRows={<>
            {roleIds.length > 0 ? <Item testID={rolesTestID} title={t('workflows.triggers.editor.roles')}
                subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                detail={overrides.length > 0 ? t('workflows.triggers.editor.rolesChanged', { count: overrides.length })
                    : t('workflows.start.rolesYour')}
                onPress={() => setRolesOpen(true)} /> : null}
            {visibility.status !== 'ready' ? <SurfaceFreshnessLine busy={visibility.status === 'loading'}
                tone={visibility.status === 'failed' ? 'warning' : 'neutral'}
                reason={visibility.status === 'failed' ? t('workflows.start.visibility.loadFailed') : t('common.loading')}
                {...(visibility.status === 'failed' ? { action: { label: t('common.retry'), onPress: visibility.retry } } : {})} />
                : visibility.teams.length === 0 ? null
                    : visibility.teams.length === 1 && selectedTeam ? <Item title={t('workflows.triggers.editor.visibleTo')}
                        subtitle={visibilityDescription} detail={selectedTeam.name ?? selectedTeam.id} mode="info" />
                        : <FieldSelect testID={`${rolesTestID}-visible-to`} title={t('workflows.triggers.editor.visibleTo')}
                            subtitle={visibilityDescription} items={visibility.teams.map(team => ({ id: team.id, title: team.name ?? team.id }))}
                            selectedId={selectedTeamId} onSelect={visibility.onChange} />}
            {popover.afterRows}
        </>} />;
}

function LegacyWorkflowTriggerSummary(props: Readonly<{ legacy: NonNullable<ReturnType<typeof describeLegacyTriggerSet>> }>) {
    const time = props.legacy.qualifierTime;
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(time?.atMs ?? null, nowMs), [time]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, time !== undefined);
    return <Item title={props.legacy.title} titleLines={0}
        subtitle={time ? formatScheduledRunQualifier(time, nowMs) : props.legacy.qualifier} subtitleLines={0} mode="info" />;
}

/**
 * **Runs automatically** (FIN 04 §5.4; 07 S4; lab `editor-T1/T2`): this Account's triggers on this
 * workflow, each its one summary, plus **Add a trigger**; **Manual** with none. Trigger edits are
 * part of the draft: the popover's Done or Add trigger changes the draft only, and the editor's Save
 * writes the definition, then the trigger delta. A trigger here always runs this workflow, so its
 * popover has no Then.
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
            ? [{ ...trigger, automationId: trigger.automationId, triggerId: trigger.triggerId, nextWorkflowRunAt: definition.nextRunAt }] : []));
    const [historyKey, setHistoryKey] = React.useState<string | null>(null);
    const toggleHistory = (key: string) => setHistoryKey(current => current === key ? null : key);
    const sourcePeople = useWorkflowSourcePeople(rows.length > 0 ? [props.set?.sourceSavedBy] : [], props.accountLifetime);
    const [open, setOpen] = React.useState<Readonly<{ row: WorkflowTriggerRowModel | null; anchor: React.RefObject<View | null> }> | null>(null);
    const addAnchorRef = React.useRef<View>(null);
    // Where triggers run is said once, in "Where it runs"; the purpose line names no host (FIN-DESIGN-REVIEW L3).
    const description = [
        t('workflows.triggers.editor.runsBy'),
        props.stepsUnsaved ? t('workflows.triggers.editor.saveToInclude') : t('workflows.triggers.editor.savedWorkflow'),
    ].join(' ');

    const initial = React.useMemo((): TriggerFormValue | null => {
        const row = open?.row;
        if (!row) return null;
        const when = rowWhen(row, props.set, props.draft);
        return when === null ? null : { when, then: createDefaultThen('runWorkflow'), enabled: row.enabled };
    }, [open, props.set, props.draft]);

    const change = props.onChangeDraft;
    const row = open?.row ?? null;
    // One Runs on per trigger set: a pending change, the set's, or the editor's Where for a new set.
    const runsOn = props.draft.context?.project ?? props.set?.project ?? props.whereTarget;
    const runsOnDiffers = runsOn !== null && props.whereTarget !== null
        && (runsOn.machineId !== props.whereTarget.machineId || runsOn.directory !== props.whereTarget.directory);
    const constantInputs: Readonly<Record<string, JsonValue>> = props.draft.context?.inputs ?? props.set?.context?.inputs ?? {};
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
            <ItemGroup title={t('workflows.triggers.editor.title')} description={t('workflows.triggers.editor.editInWorkflows')}>
                {readState}
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
    return (
        <ItemGroup title={t('workflows.triggers.editor.title')} description={description}>
            {readState}
            {rows.length === 0 && sharedTriggers.length === 0 && props.status === 'ready'
                && (definitionIds.length === 0 || shared.status === 'loaded') ? (
                <Item testID={`${props.testIDPrefix}-triggers-manual`} title={t('workflows.triggers.summary.manual')}
                    icon={<Icon name="play" />} mode="info" />
            ) : rows.map((item) => (
                <WorkflowTriggerRowView
                    sourceSavedBy={props.set?.sourceSavedBy} sourceSavedAt={props.set?.sourceSavedAt}
                    sourceProfile={sourcePeople.profiles.get(props.set?.sourceSavedBy?.accountId ?? '')?.profile ?? null}
                    viewerAccountId={sourcePeople.viewerAccountId}
                    key={item.key}
                    testID={`${props.testIDPrefix}-trigger:${item.key}`}
                    row={item}
                    history={item.kind === 'saved' && props.set && historyKey === item.key
                        ? <WorkflowTriggerRunHistory automationId={props.set.automationId} triggerId={item.triggerId}
                            nextRunAt={props.set.enabled ? readNextRunAt(item) : null}
                            accountLifetime={props.accountLifetime} triggerName={formatTriggerSummary(item.trigger)} /> : undefined}
                    onHistory={item.kind === 'saved' ? () => toggleHistory(item.key) : undefined}
                    onOpen={(anchor) => setOpen({ row: item, anchor })}
                    onToggle={(enabled) => {
                        if (item.kind === 'saved') {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: item.triggerId, enabled }));
                            return;
                        }
                        const add = props.draft.adds.find(candidate => candidate.clientId === item.clientId);
                        if (add) change(editWorkflowTriggerDraft(props.draft, {
                            kind: 'add', clientId: item.clientId, trigger: { ...add.trigger, enabled },
                        }));
                    }}
                />
            ))}
            {sharedTriggers.map(trigger => {
                const key = `${trigger.automationId}:${trigger.triggerId}`;
                const title = formatTriggerSummary(trigger);
                return <React.Fragment key={key}>
                    <Item testID={`${props.testIDPrefix}-trigger:${key}`} title={title} mode="info"
                        rightElement={<ToolbarButton testID={`${props.testIDPrefix}-trigger:${key}-history`}
                            label={t('workflows.destination.history.title')} active={historyKey === key}
                            onPress={() => toggleHistory(key)} />} />
                    {historyKey === key ? <WorkflowTriggerRunHistory automationId={trigger.automationId}
                        nextRunAt={trigger.nextWorkflowRunAt}
                        triggerId={trigger.triggerId} accountLifetime={props.accountLifetime} triggerName={title} /> : null}
                </React.Fragment>;
            })}
            {shared.status === 'failed' ? <SurfaceFreshnessLine tone="warning"
                reason={t('workflows.triggers.section.loadFailed')}
                action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: shared.retry }} /> : null}
            <View ref={addAnchorRef} collapsable={false}>
                <Item
                    testID={`${props.testIDPrefix}-triggers-add`}
                    title={t('workflows.triggers.section.add')}
                    icon={<Icon name="plus" />}
                    showChevron={false}
                    onPress={() => setOpen({ row: null, anchor: addAnchorRef })}
                />
            </View>
            {open !== null && (row === null || initial !== null) ? (
                <WorkflowTriggerPopover
                    accountLifetime={props.accountLifetime}
                    serverId={props.accountLifetime?.scope.serverId}
                    key={row?.key ?? 'new'}
                    testID={`${props.testIDPrefix}-trigger-popover`}
                    anchorRef={open.anchor}
                    onRequestClose={() => setOpen(null)}
                    {...(row?.kind === 'saved' ? { onHistory: () => { setHistoryKey(row.key); setOpen(null); } } : {})}
                    nextRunAt={readNextRunAt(row)}
                    definition={props.definition}
                    sourceArtifactId={props.workflowDefinitionId}
                    rolesTestID={`${props.testIDPrefix}-trigger-roles`}
                    directory={runsOn?.directory ?? null}
                    context={{
                        roleOverrides: props.draft.context?.roleOverrides ?? props.set?.context?.roleOverrides,
                        visibleTeamId: props.draft.context?.visibleTeamId === undefined
                            ? props.set?.context?.visibleTeamId : props.draft.context.visibleTeamId,
                    }}
                    onChangeContext={(context) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context }))}
                    whenKinds={['schedule', 'pluginEvent']}
                    sessionId={null}
                    showThen={false}
                    initial={initial}
                    workflowOptions={[]}
                    machineId={runsOn?.machineId ?? null}
                    {...(row?.kind === 'saved' && props.set && initial?.when.kind === 'pluginEvent'
                        ? { eventEdit: { automationId: props.set.automationId, triggerId: row.triggerId } } : {})}
                    setRows={(
                        <TriggerRunsOnRow
                            accountLifetime={props.accountLifetime}
                            testID={`${props.testIDPrefix}-trigger-runs-on`}
                            target={runsOn}
                            onChange={(project) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context: { project } }))}
                            description={runsOnDiffers && props.whereSummary !== null
                                ? `${t('workflows.triggers.editor.runsOnDescription')} ${t('workflows.triggers.editor.runsOnDiffers', { where: props.whereSummary })}`
                                : t('workflows.triggers.editor.runsOnDescription')}
                        />
                    )}
                    afterRows={(
                        <>
                            {props.inputs.map((input) => (
                                <FieldValueItem
                                    key={input.name}
                                    testID={`${props.testIDPrefix}-trigger-input-${input.name}`}
                                    title={input.name}
                                    subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                                    value={formatWorkflowInputValue(constantInputs[input.name] ?? input.default)}
                                    allowEmpty={!input.required}
                                    onCommit={(text) => {
                                        const value = parseWorkflowInputText(input, text);
                                        const { [input.name]: _previous, ...rest } = constantInputs;
                                        change(editWorkflowTriggerDraft(props.draft, {
                                            kind: 'setContext',
                                            context: { inputs: value === undefined ? rest : { ...rest, [input.name]: value } },
                                        }));
                                    }}
                                />
                            ))}
                        </>
                    )}
                    onSubmit={async (value, write) => {
                        if (write.trigger === null) return;
                        if (row === null) {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'add', clientId: createClientId(), trigger: write.trigger }));
                        } else if (row.kind === 'new') {
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'add', clientId: row.clientId, trigger: write.trigger }));
                        } else {
                            const { enabled: _enabled, ...definition } = write.trigger;
                            change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: row.triggerId, trigger: definition, enabled: value.enabled }));
                        }
                    }}
                    {...(row === null ? {} : {
                        onDelete: async () => {
                            change(row.kind === 'new'
                                ? editWorkflowTriggerDraft(props.draft, { kind: 'discardAdd', clientId: row.clientId })
                                : editWorkflowTriggerDraft(props.draft, { kind: 'remove', triggerId: row.triggerId }));
                        },
                    })}
                />
            ) : null}
        </ItemGroup>
    );
}

let clientSequence = 0;
function createClientId(): string {
    clientSequence += 1;
    return `trigger-draft-${Date.now().toString(36)}-${clientSequence}`;
}

const WorkflowTriggerRowView = React.memo(function WorkflowTriggerRowView(props: Readonly<{
    testID: string;
    sourceSavedBy?: TriggerRowProps['sourceSavedBy'];
    sourceSavedAt?: number;
    sourceProfile?: TriggerRowProps['sourceProfile'];
    viewerAccountId?: string | null;
    row: WorkflowTriggerRowModel;
    onOpen: (anchor: React.RefObject<View | null>) => void;
    onToggle: (enabled: boolean) => void;
    onHistory?: () => void;
    history?: React.ReactNode;
}>) {
    const anchorRef = React.useRef<View>(null);
    const { row } = props;
    // The Event editor opens the exact private source only after the user chooses to edit.
    const editable = row.schedule !== null || row.trigger.kind === 'pluginEvent';
    return (
        <View ref={anchorRef} collapsable={false}>
            <TriggerRow
                testID={props.testID}
                sourceSavedBy={props.sourceSavedBy} sourceSavedAt={props.sourceSavedAt}
                sourceProfile={props.sourceProfile} viewerAccountId={props.viewerAccountId}
                title={formatTriggerSummary(row.trigger)}
                qualifier={row.kind === 'new' ? t('workflows.triggers.editor.newRow') : undefined}
                glyph={row.trigger.kind === 'schedule' ? 'clock' : 'lightning'}
                enabled={row.enabled}
                onToggle={props.onToggle}
                actions={props.onHistory ? <ToolbarButton testID={`${props.testID}-history`}
                    label={t('workflows.destination.history.title')} active={props.history !== undefined}
                    onPress={props.onHistory} /> : undefined}
                {...(editable ? { onPress: () => props.onOpen(anchorRef) } : {})}
            />
            {props.history}
        </View>
    );
});
