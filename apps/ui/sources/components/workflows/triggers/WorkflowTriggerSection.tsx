import * as React from 'react';
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
import { useViewportClass } from '@/utils/platform/useViewportClass';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import {
    formatScheduledRunQualifier,
    formatTriggerSummary,
    readNextScheduledRunRefreshAtMs,
    readSessionLifecycleKind,
} from './formatTriggerSummary';
import { readScheduleWhen, readTriggerWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { FieldSelect } from './TriggerPopover';
import type { TriggerPluginEventRows } from './TriggerPluginEventRows';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { TriggerRow } from './TriggerRow';
import { useWorkflowDefinitionLibrary } from '../library/workflowLibraryReads';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { WorkflowTriggerStartRows } from './WorkflowTriggerStartRows';
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
import { commitWorkflowTriggerWhen, removeWorkflowTriggerRow, type WorkflowTriggerRowRef } from './workflowTriggerStarts';

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
    definition?: React.ComponentProps<typeof WorkflowRunRoles>['definition'];
}>;

function rowWhen(row: WorkflowTriggerRowModel, set: WorkflowTriggerSetV1 | null, draft: WorkflowTriggerDraft): TriggerWhenValue | null {
    if (row.schedule !== null) return readScheduleWhen(row.schedule.schedule);
    const input = row.kind === 'new' ? draft.adds.find((add) => add.clientId === row.clientId)?.trigger
        : draft.updates[row.triggerId]?.trigger;
    if (input?.kind === 'pluginEvent' && 'sourceInstanceId' in input) {
        return { kind: 'pluginEvent', value: { ...input, enabled: row.enabled } };
    }
    // A drafted session event (the card only drafts Account kinds; schedules are read above).
    if (input?.kind === 'sessionLifecycle') return { kind: readSessionLifecycleKind(input.events), sourceSessionId: input.sourceSessionId };
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

/** A way to start that is not complete yet (no Session or Event chosen): held here, never in the draft. */
type PendingStart = Readonly<{ clientId: string; when: TriggerWhenValue | null }>;

/**
 * **When it runs** (owner 11-15; lab round-1115 `r16first-card-two`, `trigger-card-*`): every way this
 * workflow starts, each edited in place — Starts, then only the rows its kind needs — plus **Another
 * way to start**; "Only when you run it" with none. Edits are part of the editor's draft: Save writes
 * the definition, then the trigger delta. A trigger here always runs this workflow, in the editor's
 * Where; what the set gives every trigger (constant inputs, Roles, Visible to) follows the triggers.
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
    const [pending, setPending] = React.useState<readonly PendingStart[]>([]);
    const compact = useViewportClass() === 'compact';
    const [edits, setEdits] = React.useState<Readonly<Record<string, TriggerWhenValue>>>({});

    const change = props.onChangeDraft;
    // One Runs on per trigger set: a pending change, the set's, or the editor's Where for a new set.
    const runsOn = props.draft.context?.project ?? props.set?.project ?? props.whereTarget;
    const runsOnDiffers = runsOn !== null && props.whereTarget !== null
        && (runsOn.machineId !== props.whereTarget.machineId || runsOn.directory !== props.whereTarget.directory);
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

    const placement = { machineId: runsOn?.machineId ?? null, serverId: props.accountLifetime?.scope.serverId ?? null };
    // A complete When joins the draft; an incomplete one stays on screen until it is.
    const editRow = (row: WorkflowTriggerRowModel, when: TriggerWhenValue) => {
        const next = commitWorkflowTriggerWhen({ draft: props.draft, row: rowRef(row), when, enabled: row.enabled });
        setEdits(({ [row.key]: _previous, ...rest }) => next === null ? { ...rest, [row.key]: when } : rest);
        if (next !== null) change(next);
    };
    const editPending = (clientId: string, when: TriggerWhenValue) => {
        const next = commitWorkflowTriggerWhen({ draft: props.draft, row: { kind: 'new', clientId }, when, enabled: true });
        setPending(current => next === null
            ? current.some(item => item.clientId === clientId)
                ? current.map(item => item.clientId === clientId ? { clientId, when } : item) : [...current, { clientId, when }]
            : current.filter(item => item.clientId !== clientId));
        if (next !== null) change(next);
    };
    // This Account's set has no trigger; the library may still list others' triggers on this workflow.
    const ownNone = rows.length === 0 && pending.length === 0 && props.status === 'ready';
    const sharedSettled = definitionIds.length === 0 || shared.status === 'loaded';
    const nothingYet = ownNone && sharedTriggers.length === 0 && sharedSettled;
    return (
        // Rows only: the editor's "When it runs" card owns the title and the one-sentence summary.
        <ItemGroup header="none" surface="none">
            {readState}
            {props.stepsUnsaved && rows.length > 0 ? <Item testID={`${props.testIDPrefix}-triggers-save-to-include`}
                title={t('workflows.triggers.editor.saveToInclude')} titleLines={0} mode="info" /> : null}
            {nothingYet ? (
                <WorkflowTriggerStartRows testID={`${props.testIDPrefix}-triggers-manual`} when={null} enabled incomplete={false}
                    {...placement} onChangeWhen={(when) => editPending(createClientId(), when)} />
            ) : null}
            {rows.map((row) => {
                const edited = edits[row.key];
                return (
                    <WorkflowTriggerStartRows
                        key={row.key}
                        testID={`${props.testIDPrefix}-trigger:${row.key}`}
                        when={edited ?? rowWhen(row, props.set, props.draft)}
                        enabled={row.enabled}
                        incomplete={edited !== undefined}
                        {...placement}
                        {...(row.kind === 'saved' && props.set && row.trigger.kind === 'pluginEvent'
                            ? { eventEdit: { automationId: props.set.automationId, triggerId: row.triggerId } } : {})}
                        {...(props.onEditSeedApplied ? { onEditSeedApplied: props.onEditSeedApplied } : {})}
                        onChangeWhen={(when) => editRow(row, when)}
                        onRemove={() => {
                            setEdits(({ [row.key]: _dropped, ...rest }) => rest);
                            change(removeWorkflowTriggerRow(props.draft, rowRef(row)));
                        }}
                        onToggleEnabled={() => {
                            if (row.kind === 'saved') {
                                change(editWorkflowTriggerDraft(props.draft, { kind: 'update', triggerId: row.triggerId, enabled: !row.enabled }));
                                return;
                            }
                            const add = props.draft.adds.find(candidate => candidate.clientId === row.clientId);
                            if (add) change(editWorkflowTriggerDraft(props.draft, {
                                kind: 'add', clientId: row.clientId, trigger: { ...add.trigger, enabled: !row.enabled },
                            }));
                        }}
                        {...(row.kind === 'saved' && props.set ? {
                            onToggleHistory: () => toggleHistory(row.key),
                            history: historyKey === row.key ? <WorkflowTriggerRunHistory automationId={props.set.automationId} triggerId={row.triggerId}
                                nextRunAt={props.set.enabled ? readNextRunAt(row) : null} accountLifetime={props.accountLifetime}
                                triggerName={formatTriggerSummary(row.trigger)} trigger={row.trigger} /> : undefined,
                        } : {})}
                    />
                );
            })}
            {pending.map((item) => (
                <WorkflowTriggerStartRows key={`new:${item.clientId}`} testID={`${props.testIDPrefix}-trigger:new:${item.clientId}`}
                    when={item.when} unchosen={item.when === null} enabled incomplete {...placement}
                    onChangeWhen={(when) => editPending(item.clientId, when)}
                    onRemove={() => setPending(current => current.filter(candidate => candidate.clientId !== item.clientId))} />
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
                        nextRunAt={trigger.kind === 'schedule' ? trigger.nextRunAt : null}
                        triggerId={trigger.triggerId} accountLifetime={props.accountLifetime} triggerName={title} /> : null}
                </React.Fragment>;
            })}
            {shared.status === 'failed' ? <SurfaceFreshnessLine tone="warning"
                reason={t('workflows.triggers.section.loadFailed')}
                action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: shared.retry }} /> : null}
            {rows.length === 0 ? null : (
                <WorkflowTriggerSetRows {...props} runsOn={runsOn} runsOnDiffers={runsOnDiffers} />
            )}
            {nothingYet || (ownNone && !sharedSettled) ? null : (
                <Item
                    testID={`${props.testIDPrefix}-triggers-add`}
                    title={t('workflows.triggers.card.anotherWay')}
                    // A phone has no room beside the action: the reminder would only truncate it.
                    {...(rows.length > 0 && !compact ? { detail: t('workflows.triggers.card.runNowToo') } : {})}
                    icon={<Icon name="plus" />}
                    showChevron={false}
                    onPress={() => setPending(current => [...current, { clientId: createClientId(), when: null }])}
                />
            )}
        </ItemGroup>
    );
}

/**
 * What the trigger set gives every trigger: its Runs on while it differs from the editor's Where, the
 * inputs a trigger starts with, Roles and who can watch the runs.
 */
function WorkflowTriggerSetRows(props: WorkflowTriggerSectionProps & Readonly<{
    runsOn: WorkflowProjectTargetV1 | null;
    runsOnDiffers: boolean;
}>) {
    const change = props.onChangeDraft;
    const setContext = (context: WorkflowTriggerSetContextDraft) => change(editWorkflowTriggerDraft(props.draft, { kind: 'setContext', context }));
    const constantInputs: Readonly<Record<string, JsonValue>> = props.draft.context?.inputs ?? props.set?.context?.inputs ?? {};
    const roleIds = React.useMemo(() => props.definition ? workflowUsedRoleIds(props.definition) : [], [props.definition]);
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
            {props.runsOnDiffers ? (
                <TriggerRunsOnRow
                    accountLifetime={props.accountLifetime}
                    testID={`${props.testIDPrefix}-trigger-runs-on`}
                    target={props.runsOn}
                    onChange={(project) => setContext({ project })}
                    description={props.whereSummary === null ? t('workflows.triggers.editor.runsOnDescription')
                        : `${t('workflows.triggers.editor.runsOnDescription')} ${t('workflows.triggers.editor.runsOnDiffers', { where: props.whereSummary })}`}
                />
            ) : null}
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
                        setContext({ inputs: value === undefined ? rest : { ...rest, [input.name]: value } });
                    }}
                />
            ))}
            {roleIds.length > 0 && props.definition ? <>
                <Item testID={rolesTestID} title={t('workflows.triggers.editor.roles')}
                    subtitle={t('workflows.triggers.editor.sameForAllTriggers')}
                    detail={overrides.length > 0 ? t('workflows.triggers.editor.rolesChanged', { count: overrides.length })
                        : t('workflows.start.rolesYour')}
                    onPress={() => setRolesOpen(open => !open)} />
                {rolesOpen ? <WorkflowRunRoles definition={props.definition} roleIds={roleIds} overrides={overrides}
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
                        subtitle={visibilityDescription} detail={selectedTeam.name ?? selectedTeam.id} mode="info" />
                        : <FieldSelect testID={`${rolesTestID}-visible-to`} title={t('workflows.triggers.editor.visibleTo')}
                            subtitle={visibilityDescription} items={visibility.teams.map(team => ({ id: team.id, title: team.name ?? team.id }))}
                            selectedId={selectedTeamId} onSelect={visibility.onChange} />}
        </>
    );
}

let clientSequence = 0;
function createClientId(): string {
    clientSequence += 1;
    return `trigger-draft-${Date.now().toString(36)}-${clientSequence}`;
}
