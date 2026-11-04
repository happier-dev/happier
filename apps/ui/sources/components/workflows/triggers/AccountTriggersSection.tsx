import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { TriggerTargetV1} from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';

import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { formatTriggerSummary } from './formatTriggerSummary';
import { Modal } from '@/modal';
import { useActiveServerAccountScope, useAllMachines, useMachineListForServer } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';
import { useGlobalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import { useAutomationRunNowController } from '@/components/automations/list/useAutomationRunNowController';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    addWorkflowTrigger,
    removeWorkflowTrigger,
    reviewWorkflowTriggerSet,
    updateWorkflowTrigger,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { projectAccountTriggerRows, type AccountTriggerRow } from './accountTriggerRows';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRow } from './TriggerRow';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { buildTriggerExecutionTarget, readWorkflowTriggerSetForm } from './sessionTriggerForm';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { useOpenTriggerAsWorkflow } from './useOpenTriggerAsWorkflow';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

/**
 * The Account's inline trigger sets through `workflow.trigger.list {scope:'account_inline'}`, the one
 * membership the column and agents share. The Automation projection is only a change signal: when an
 * unscoped row changes (an agent wrote a trigger, a run finished) the list is read again.
 */
const ACCOUNT_TRIGGER_QUERY = { scope: 'account_inline' } as const;

/**
 * The Workflows column's **Triggers** section (FIN 04 §3.3, F1; 07 S1, S16b): the Account's triggers
 * that hold their own steps, never a saved workflow's or a session's. A row opens the one trigger
 * popover; its writes go through `workflow.trigger.update | remove`. Absent when empty.
 */
export const AccountTriggersSection = React.memo(function AccountTriggersSection(props: Readonly<{ first?: boolean }>) {
    const params = useGlobalSearchParams<{ serverId?: string | string[] }>();
    const serverId = readSessionRouteServerId(params);
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const lastBinding = React.useRef<ServerAccountScopeLifetime | null>(null);
    const displayBinding = binding ?? (resolution.kind === 'bound'
        && areServerAccountScopesEqual(lastBinding.current?.scope, resolution.scope) ? lastBinding.current : null);
    lastBinding.current = displayBinding;
    const activeScope = useActiveServerAccountScope();
    const scope = serverId ? displayBinding?.scope : activeScope;
    if (serverId && !displayBinding && resolution.kind !== 'resolving') return <SurfaceStateCard size="line" kind="unavailable"
        testID="retired-automation-unavailable" title={t('workflows.triggers.legacy.notAvailable')} />;
    return <WorkflowAccountLifetimeProvider value={serverId ? displayBinding : undefined}>
        <AccountTriggersContent key={`${serverId}:${scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'}`} {...props}
            {...(serverId ? { accountLifetime: displayBinding } : {})} /></WorkflowAccountLifetimeProvider>;
});

function AccountTriggersContent(props: Readonly<{ first?: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>) {
    const read = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY, props.accountLifetime);
    return <AccountTriggersReadContent {...props} read={read} />;
}

/** Library rows open the incumbent settings popover, including retained-template review. No list read. */
export function useAccountWorkflowEditor(props: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null;
    read: ReturnType<typeof useWorkflowTriggerSets> }>) {
    const { sets, retry: refresh } = props.read;
    const captureLifetime = () => props.accountLifetime === undefined
        ? captureActiveServerAccountScopeLifetime() : props.accountLifetime;
    const actionOptions = props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime };
    const [open, setOpen] = React.useState<Readonly<{ set: WorkflowTriggerSetV1; triggerId: AccountTriggerRow['triggerId']; anchor: React.RefObject<View | null> }> | null>(null);
    const [history, setHistory] = React.useState<Readonly<{ automationId: string; triggerId: string; title: string }> | null>(null);
    const thenOptions = useTriggerThenOptions({ ...actionOptions, libraryEnabled: open !== null, sets });
    const openTriggerAsWorkflow = useOpenTriggerAsWorkflow(props.accountLifetime);
    const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
    const alertUnavailable = (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'>, set: WorkflowTriggerSetV1, title: string, message: string) => {
        const triggerId = row.triggerId;
        const lifetime = captureLifetime();
        void Modal.alert(title, message, triggerId === null ? undefined : [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('workflows.triggers.popover.deleteTrigger'), style: 'destructive', onPress: async () => {
                if (!lifetime?.isCurrent()) return;
                try {
                    await removeWorkflowTrigger({ automationId: set.automationId, triggerId }, actionOptions);
                    refresh();
                } catch (error) {
                    void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
                }
            } },
        ]);
    };
    const openRow = useEventCallback(async (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'> & Partial<Pick<AccountTriggerRow, 'legacy'>>, anchor: React.RefObject<View | null>) => {
        const set = sets.find((candidate) => candidate.automationId === row.automationId);
        if (!set) return;
        setHistory(null);
        if (set.legacy?.lockedReason === 'review_required') {
            if (pending.has(set.automationId)) return;
            const lifetime = captureLifetime();
            setPending((current) => new Set(current).add(set.automationId));
            try {
                const reviewed = await reviewWorkflowTriggerSet(set.automationId, actionOptions);
                if (!lifetime?.isCurrent()) return;
                if (readWorkflowTriggerSetForm(reviewed, row.triggerId) === null) {
                    throw new Error(t('workflows.problem.legacyConversionUnsupported'));
                }
                setOpen({ set: reviewed, triggerId: row.triggerId, anchor });
            } catch (error) {
                if (lifetime?.isCurrent()) alertUnavailable(row, set, t('workflows.triggers.legacy.reviewRequired'), formatWorkflowProblemMessage(error));
            } finally {
                setPending((current) => { const next = new Set(current); next.delete(set.automationId); return next; });
            }
            return;
        }
        if (readWorkflowTriggerSetForm(set, row.triggerId) === null) {
            alertUnavailable(row, set, row.legacy?.title ?? t('workflows.problem.legacyConversionUnsupported'),
                t('workflows.problem.legacyConversionUnsupported'));
            return;
        }
        setOpen({ set, triggerId: row.triggerId, anchor });
    });
    const toggle = useEventCallback(async (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'>, next: boolean) => {
        const set = sets.find((candidate) => candidate.automationId === row.automationId);
        if (!set || pending.has(set.automationId) || set.legacy?.lockedReason === 'review_required') return;
        setPending((current) => new Set(current).add(set.automationId));
        try {
            const lifetime = captureLifetime();
            if (set.legacy && !await Modal.confirm(t('workflows.triggers.legacy.editNotice'),
                t('workflows.triggers.legacy.conversionBoundary'), {
                    confirmText: t(next ? 'workflows.triggers.popover.turnOn' : 'workflows.triggers.popover.turnOff'),
                })) return;
            if (!lifetime?.isCurrent()) return;
            await writeAccountTriggerEnabled(set, row.triggerId, next, props.accountLifetime);
            refresh();
        } catch (error) {
            void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
        } finally {
            setPending((current) => { const next = new Set(current); next.delete(set.automationId); return next; });
        }
    });
    const openTrigger = open?.triggerId == null ? undefined : open.set.triggers.find((trigger) => trigger.id === open.triggerId);
    const openEnabled = open !== null && open.set.enabled && openTrigger?.enabled !== false;
    const popover = open === null ? history === null ? null : (
        <ItemGroup title={t('workflows.destination.history.title')}
            action={<ToolbarButton label={t('common.close')} onPress={() => setHistory(null)} />}>
            <WorkflowTriggerRunHistory automationId={history.automationId} triggerId={history.triggerId} triggerName={history.title} />
        </ItemGroup>
    ) : (
        <AccountTriggerPopover
            key={`${open.set.automationId}:${open.triggerId ?? 'manual'}`}
            set={open.set}
            triggerId={open.triggerId}
            anchorRef={open.anchor}
            workflowOptions={thenOptions.workflowOptions}
            {...actionOptions}
            onRequestClose={() => setOpen(null)}
            {...(openTrigger ? { onHistory: () => {
                setHistory({ automationId: open.set.automationId, triggerId: openTrigger.id, title: formatTriggerSummary(openTrigger) });
                setOpen(null);
            } } : {})}
            onWritten={refresh}
            {...(open.set.legacy?.lockedReason === 'review_required' ? {} : { onToggleEnabled: { enabled: openEnabled, onPress: () => {
                setOpen(null);
                void toggle({ automationId: open.set.automationId, triggerId: open.triggerId }, !openEnabled);
            } } })}
            onSaveAsWorkflow={(target) => openTriggerAsWorkflow(target, {
                scope: 'account', automationId: open.set.automationId,
                ...(open.triggerId === null ? {} : { triggerId: open.triggerId }), expectedRevision: open.set.revision,
            })}
        />
    );
    return React.useMemo(() => ({ pending, open: openRow, toggle, popover, resolveWorkflowTitle: thenOptions.resolveWorkflowTitle }),
        [pending, openRow, toggle, popover, thenOptions.resolveWorkflowTitle]);
}

function AccountTriggersReadContent(props: Readonly<{ first?: boolean; accountLifetime?: ServerAccountScopeLifetime | null;
    read: ReturnType<typeof useWorkflowTriggerSets> }>) {
    const { sets, status, retry: refresh } = props.read;
    const { pending, open: openRow, toggle, popover, resolveWorkflowTitle } = useAccountWorkflowEditor(props);
    const activeMachines = useAllMachines();
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '');
    const machines = props.accountLifetime === undefined ? activeMachines : addressedMachines ?? [];
    const rows = React.useMemo(() => projectAccountTriggerRows({ sets, resolveWorkflowTitle,
        resolveMachineTitle: (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' }) }),
        [sets, resolveWorkflowTitle, machines]);
    const params = useGlobalSearchParams<{ trigger?: string }>();
    if (rows.length === 0 && status === 'ready') return null;
    // Between other sections, a section whose existence is not yet known draws nothing: a "Triggers ·
    // Loading…" inserted after the column drew, then removed for an Account with none, pushed the
    // sections under it twice (DESIGN-14 D12). As the page's only section it keeps the loading line.
    if (rows.length === 0 && status === 'loading' && props.first !== true) return null;
    return (
        <>
            <CollectionListGroupLabel
                testID="workflows-column:group:triggers"
                title={t('workflows.destination.sections.triggers')}
                count={rows.length > 0 ? rows.length : undefined}
                {...(props.first ? { first: true } : {})}
            />
            {/* Nothing to say while the retained rows refresh: they stay put at full strength. With
                nothing retained, the loading or failed line holds the rows' place. */}
            {rows.length === 0 && status !== 'ready' ? (
                <SurfaceStateCard testID="account-triggers-read" size="line" kind={status === 'failed' ? 'error' : 'loading'}
                    title={status === 'failed' ? t('workflows.triggers.section.accountLoadFailed') : t('common.loading')}
                    {...(status === 'failed' ? { action: { testID: 'account-triggers-read-retry', label: t('workflows.triggers.popover.tryAgain'), onPress: refresh } } : {})} />
            ) : null}
            {rows.map((row) => (
                <AccountTriggerRowView
                    key={`${row.automationId}:${row.triggerId ?? 'manual'}`}
                    row={row}
                    multiple={sets.find((set) => set.automationId === row.automationId)!.triggers.length > 1}
                    pending={pending.has(row.automationId)}
                    reviewRequired={sets.find((set) => set.automationId === row.automationId)?.legacy?.lockedReason === 'review_required'}
                    deepLink={params.trigger === row.automationId && rows.find((candidate) => candidate.automationId === row.automationId) === row}
                    onOpen={(anchor) => { void openRow(row, anchor); }}
                    onToggle={(next) => { void toggle(row, next); }}
                />
            ))}
            {/* A failed refresh is stale content: said once, under the rows it concerns, so the rows
                themselves never move when it arrives. */}
            {rows.length > 0 && status === 'failed' ? (
                <View style={styles.stale}>
                    <SurfaceFreshnessLine testID="account-triggers-read" tone="warning"
                        reason={t('workflows.triggers.section.accountLoadFailed')}
                        action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: refresh }} />
                </View>
            ) : null}
            {popover}
        </>
    );
}

async function writeAccountTriggerEnabled(set: WorkflowTriggerSetV1, triggerId: AccountTriggerRow['triggerId'], enabled: boolean,
    accountLifetime?: ServerAccountScopeLifetime | null) {
    return updateWorkflowTrigger({ automationId: set.automationId, expectedRevision: set.revision,
        ...(triggerId === null ? {} : { triggerId }), patch: { enabled } }, accountLifetime === undefined ? {} : { accountLifetime });
}

const AccountTriggerRowView = React.memo(function AccountTriggerRowView(props: Readonly<{
    row: AccountTriggerRow;
    multiple: boolean;
    pending: boolean;
    reviewRequired: boolean;
    deepLink: boolean;
    onOpen: (anchor: React.RefObject<View | null>) => void;
    onToggle: (next: boolean) => void;
}>) {
    const anchorRef = React.useRef<View>(null);
    const { row } = props;
    const openRef = React.useRef(props.onOpen);
    openRef.current = props.onOpen;
    React.useEffect(() => { if (props.deepLink) openRef.current(anchorRef); }, [props.deepLink]);
    return (
        <View ref={anchorRef} collapsable={false}>
            <TriggerRow
                testID={`workflows-column:trigger:${row.automationId}${props.multiple ? `:${row.triggerId}` : ''}`}
                presentation="column"
                glyph={row.glyph}
                // "{when}" over "{then summary}" (04 §3.3); a 0.2 Automation keeps its own name.
                title={props.reviewRequired ? row.title : row.legacy?.title ?? row.title}
                qualifier={row.legacy?.qualifier ?? row.subtitle}
                qualifierTime={row.legacy?.qualifierTime}
                enabled={!row.off}
                multiline={!!row.legacy}
                attention={props.reviewRequired ? t('workflows.triggers.legacy.reviewRequired') : undefined}
                toggleDisabled={props.pending || props.reviewRequired}
                onToggle={props.onToggle}
                onPress={() => props.onOpen(anchorRef)}
            />
        </View>
    );
});

/** An opened revision is kept while editing: a refresh cannot replace a dirty draft. */
function AccountTriggerPopover(props: Readonly<{
    accountLifetime?: ServerAccountScopeLifetime | null;
    set: WorkflowTriggerSetV1;
    triggerId: AccountTriggerRow['triggerId'];
    anchorRef: React.RefObject<View | null>;
    workflowOptions: ReturnType<typeof useTriggerThenOptions>['workflowOptions'];
    onRequestClose: () => void;
    onWritten: () => void;
    onToggleEnabled?: React.ComponentProps<typeof TriggerPopover>['onToggleEnabled'];
    onHistory?: () => void;
    onSaveAsWorkflow?: (target: TriggerTargetV1) => void;
    initialEventSeed?: PluginUiOpenAutomationEventRequestV1;
    initialEventEditSeed?: PluginEventAutomationEditSeed;
}>) {
    const activeMachines = useAllMachines();
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '');
    const machines = props.accountLifetime === undefined ? activeMachines : addressedMachines ?? [];
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(props.set.project ?? null);
    const runNow = useAutomationRunNowController(props.accountLifetime);
    const form = readWorkflowTriggerSetForm(props.set, props.triggerId);
    if (form === null) return null;
    const { set } = props;
    const needsReview = set.legacy?.lockedReason === 'review_required';
    const placements = set.placements ?? [];
    const triggerId = props.triggerId;
    return (
        <TriggerPopover
            testID="workflows-column-trigger-popover"
            onHistory={props.onHistory}
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            whenKinds={set.observationOnly ? ['pluginEvent'] : ['schedule', 'pluginEvent']}
            sessionId={null}
            serverId={props.accountLifetime?.scope.serverId}
            accountLifetime={props.accountLifetime}
            initial={form}
            initialEventSeed={props.initialEventSeed}
            initialEventEditSeed={props.initialEventEditSeed}
            manual={triggerId === null}
            subtitle={needsReview ? t('workflows.triggers.legacy.reviewRequired') : set.legacy ? t('workflows.triggers.legacy.editNotice') : undefined}
            submitNotice={needsReview ? t('workflows.triggers.legacy.reviewConversionNotice') : set.legacy ? t('workflows.triggers.legacy.conversionBoundary') : undefined}
            submitLabel={needsReview ? t('common.save') : undefined}
            workflowOptions={props.workflowOptions}
            machineId={project?.machineId ?? null}
            directory={project?.directory ?? null}
            {...(triggerId !== null && form.when.kind === 'pluginEvent' ? { eventEdit: { automationId: set.automationId, triggerId } } : {})}
            hostComplete={project !== null}
            setRows={<>
                {needsReview && placements.length > 1 ? <Item mode="info"
                    title={t('workflows.triggers.row.machines', { count: placements.length })}
                    subtitle={placements.map((placement) => `${getMachineDisplayName(machines.find((machine) => machine.id === placement.machineId)
                        ?? { id: placement.machineId, absence: 'unlisted' })} · ${placement.directory}`).join('\n')}
                    subtitleLines={0} showChevron={false} /> : null}
                <TriggerRunsOnRow testID="workflows-column-trigger-runs-on" target={project} onChange={setProject} accountLifetime={props.accountLifetime}
                    description={t('workflows.triggers.editor.runsOnAccountDescription')} />
            </>}
            onRunNow={!needsReview && triggerId === null ? async () => { await runNow.runNow(set.automationId, 'newSession'); } : undefined}
            onToggleEnabled={props.onToggleEnabled}
            onSaveAsWorkflow={needsReview ? undefined : props.onSaveAsWorkflow}
            onSubmit={async (value, write) => {
                if (write.observationOnly && write.trigger !== null && triggerId !== null) {
                    const { enabled: _enabled, ...definition } = write.trigger;
                    await updateWorkflowTrigger({ automationId: set.automationId, triggerId, expectedRevision: set.revision,
                        patch: { trigger: definition, enabled: value.enabled } },
                        props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                    props.onWritten();
                    return;
                }
                if (write.target === null || project === null) return;
                const definition = write.trigger === null ? null : (({ enabled: _enabled, ...definition }) => definition)(write.trigger);
                await updateWorkflowTrigger({
                    automationId: set.automationId,
                    ...(triggerId === null ? {} : { triggerId }),
                    expectedRevision: set.revision,
                    ...(needsReview ? { confirmLegacyConversion: true } : {}),
                    patch: {
                        ...(set.context ? (({ workspace: _workspace, inlineDefinition: _inlineDefinition, onComplete: _onComplete, ...context }) => context)(set.context) : {}),
                        target: write.target,
                        project,
                        ...(triggerId === null || definition === null ? {} : { trigger: definition }),
                        enabled: value.enabled,
                        executionTarget: buildTriggerExecutionTarget(value.then),
                        inputs: write.inputs,
                    },
                }, props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                props.onWritten();
            }}
            onDelete={async () => {
                await removeWorkflowTrigger({ automationId: set.automationId, ...(triggerId === null ? {} : { triggerId }) },
                    props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                props.onWritten();
            }}
        />
    );
}

/**
 * The column "+" menu's **New trigger** (04 §3.3, F1): an Account trigger that holds its own steps,
 * with its set's Runs on, written through `workflow.trigger.add`. It joins the Triggers section.
 */
type NewAccountTriggerPopoverProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    eventSeed?: PluginUiOpenAutomationEventRequestV1;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>;

export function NewAccountTriggerPopover(props: NewAccountTriggerPopoverProps): React.ReactElement {
    const eventSeed = props.eventSeed;
    return eventSeed?.sourceInstanceId
        ? <ExistingAccountEventSourceIntake {...props} eventSeed={eventSeed} sourceInstanceId={eventSeed.sourceInstanceId} />
        : <NewAccountTriggerDraftPopover {...props} />;
}

/** Resolve private source identity once; an opened revision remains the editor's draft. */
function ExistingAccountEventSourceIntake(props: Omit<NewAccountTriggerPopoverProps, 'eventSeed'> & Readonly<{
    eventSeed: PluginUiOpenAutomationEventRequestV1;
    sourceInstanceId: string;
}>): React.ReactElement {
    const inventory = useWorkflowTriggerSets({ scope: 'account_inline' }, props.accountLifetime);
    const inventorySets = React.useRef(inventory.sets);
    inventorySets.current = inventory.sets;
    const thenOptions = useTriggerThenOptions(props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
    const [resolution, setResolution] = React.useState<
        | Readonly<{ kind: 'loading' }>
        | Readonly<{ kind: 'unavailable' }>
        | Readonly<{ kind: 'new' }>
        | Readonly<{ kind: 'existing'; set: WorkflowTriggerSetV1; seed: PluginEventAutomationEditSeed }>
    >({ kind: 'loading' });
    const { pluginId, localId } = props.eventSeed.eventRef;
    React.useEffect(() => {
        if (resolution.kind !== 'loading' || inventory.status !== 'ready') return;
        const lifetime = props.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : props.accountLifetime;
        let alive = true;
        void (async () => {
            const matches: Array<Readonly<{ set: WorkflowTriggerSetV1; seed: PluginEventAutomationEditSeed }>> = [];
            for (const set of inventorySets.current) {
                for (const trigger of set.triggers) {
                    if (trigger.kind !== 'pluginEvent' || trigger.eventRef.pluginId !== pluginId || trigger.eventRef.localId !== localId) continue;
                    const seed = await sync.getAutomationPluginEventEditSeed(set.automationId, trigger.id);
                    if (!seed) throw new Error('Saved Event source is unavailable');
                    if (seed.source.sourceInstanceId === props.sourceInstanceId) matches.push({ set, seed });
                }
            }
            if (!alive || lifetime?.isCurrent() !== true) return;
            if (matches.length === 0) setResolution({ kind: 'new' });
            else if (matches.length === 1 && readWorkflowTriggerSetForm(matches[0]!.set, matches[0]!.seed.triggerId)) {
                setResolution({ kind: 'existing', ...matches[0]! });
            } else setResolution({ kind: 'unavailable' });
        })().catch(() => {
            if (alive && lifetime?.isCurrent()) setResolution({ kind: 'unavailable' });
        });
        return () => { alive = false; };
    }, [inventory.status, localId, pluginId, props.accountLifetime, props.sourceInstanceId, resolution.kind]);
    if (resolution.kind === 'unavailable' || (resolution.kind === 'loading' && inventory.status === 'failed')) return <SurfaceStateCard
        testID="automation-event-source-intake-unavailable" size="line" kind="unavailable"
        title={t('automations.form.trigger.sourceUnavailable')}
        action={{ label: t('common.retry'), onPress: () => { inventory.retry(); setResolution({ kind: 'loading' }); } }} />;
    if (resolution.kind === 'loading') return <SurfaceStateCard size="line" kind="loading" title={t('common.loading')} />;
    if (resolution.kind === 'new') return <NewAccountTriggerDraftPopover {...props} />;
    const { seed, set } = resolution;
    const eventSeed: PluginUiOpenAutomationEventRequestV1 = {
        ...props.eventSeed,
        ...(seed.observation.kind === 'durablePush' ? {} : { monitoringMachineId: seed.observation.watcherMaterializationRef.machineId }),
        setupInput: { ...Object.fromEntries<PluginEventAutomationEditSeed['source']['sourceConfig']>(
            Object.entries(seed.source.sourceConfig ?? {})), ...props.eventSeed.setupInput },
    };
    return <AccountTriggerPopover set={set} triggerId={seed.triggerId} anchorRef={props.anchorRef}
        accountLifetime={props.accountLifetime} workflowOptions={thenOptions.workflowOptions}
        initialEventSeed={eventSeed} initialEventEditSeed={seed} onRequestClose={props.onRequestClose}
        onWritten={() => { fireAndForget(sync.refreshAutomations()); props.onRequestClose(); }} />;
}

function NewAccountTriggerDraftPopover(props: NewAccountTriggerPopoverProps): React.ReactElement {
    const thenOptions = useTriggerThenOptions(props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
    return (
        <TriggerPopover
            testID="workflows-column-new-trigger-popover"
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            whenKinds={['schedule', 'pluginEvent']}
            sessionId={null}
            initial={null}
            initialWhen={props.eventSeed ? { kind: 'pluginEvent', value: null, eventRef: props.eventSeed.eventRef } : undefined}
            initialEventSeed={props.eventSeed}
            accountLifetime={props.accountLifetime}
            serverId={props.accountLifetime?.scope.serverId}
            workflowOptions={thenOptions.workflowOptions}
            machineId={project?.machineId ?? null}
            directory={project?.directory ?? null}
            hostComplete={project !== null}
            setRows={(
                <TriggerRunsOnRow
                    testID="workflows-column-new-trigger-runs-on"
                    target={project}
                    onChange={setProject}
                    accountLifetime={props.accountLifetime}
                    description={t('workflows.triggers.editor.runsOnAccountDescription')}
                />
            )}
            onSubmit={async (value, write) => {
                if (write.observationOnly && write.trigger !== null) {
                    await addWorkflowTrigger({ trigger: write.trigger, observationOnly: write.observationOnly },
                        props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                    fireAndForget(sync.refreshAutomations());
                    return;
                }
                if (write.target === null || write.trigger === null || project === null) return;
                await addWorkflowTrigger({
                    target: write.target,
                    project,
                    trigger: write.trigger,
                    executionTarget: buildTriggerExecutionTarget(value.then),
                    inputs: write.inputs,
                }, props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                fireAndForget(sync.refreshAutomations());
            }}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    // The column's row inset, so the line's edges sit on the rows' edges.
    stale: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingTop: theme.space.s4 },
}));
