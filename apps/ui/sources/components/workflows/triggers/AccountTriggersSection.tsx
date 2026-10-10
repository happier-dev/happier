import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { TriggerTargetV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
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

import { projectAccountTriggerRows, type AccountTriggerRow } from './accountTriggerRows';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRow } from './TriggerRow';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { buildTriggerExecutionTarget, createDefaultWhen, readTriggerThen, readTriggerWhen, type TriggerFormValue } from './sessionTriggerForm';
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
    const scope = useActiveServerAccountScope();
    return <AccountTriggersContent key={scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'} {...props} />;
});

function AccountTriggersContent(props: Readonly<{ first?: boolean }>) {
    const { sets, status, retry: refresh } = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY);
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const thenOptions = useTriggerThenOptions();
    const openTriggerAsWorkflow = useOpenTriggerAsWorkflow();
    const machines = useAllMachines();
    const rows = React.useMemo(
        () => projectAccountTriggerRows({ sets, resolveWorkflowTitle: thenOptions.resolveWorkflowTitle,
            resolveMachineTitle: (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' }) }),
        [sets, thenOptions.resolveWorkflowTitle, machines],
    );
    const [open, setOpen] = React.useState<Readonly<{ set: WorkflowTriggerSetV1; triggerId: AccountTriggerRow['triggerId']; anchor: React.RefObject<View | null> }> | null>(null);
    const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
    const alertUnavailable = (row: AccountTriggerRow, set: WorkflowTriggerSetV1, title: string, message: string) => {
        const triggerId = row.triggerId;
        const lifetime = captureActiveServerAccountScopeLifetime();
        void Modal.alert(title, message, triggerId === null ? undefined : [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('workflows.triggers.popover.deleteTrigger'), style: 'destructive', onPress: async () => {
                if (!lifetime?.isCurrent()) return;
                try {
                    await removeWorkflowTrigger({ automationId: set.automationId, triggerId });
                    refresh();
                } catch (error) {
                    void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
                }
            } },
        ]);
    };
    const openRow = async (row: AccountTriggerRow, anchor: React.RefObject<View | null>) => {
        const set = sets.find((candidate) => candidate.automationId === row.automationId);
        if (!set) return;
        if (set.legacy?.lockedReason === 'review_required') {
            if (pending.has(set.automationId)) return;
            const lifetime = captureActiveServerAccountScopeLifetime();
            setPending((current) => new Set(current).add(set.automationId));
            try {
                const reviewed = await reviewWorkflowTriggerSet(set.automationId);
                if (!lifetime?.isCurrent()) return;
                if (readAccountTriggerForm(reviewed, row.triggerId) === null) {
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
        if (readAccountTriggerForm(set, row.triggerId) === null) {
            alertUnavailable(row, set, row.legacy?.title ?? t('workflows.problem.legacyConversionUnsupported'),
                t('workflows.problem.legacyConversionUnsupported'));
            return;
        }
        setOpen({ set, triggerId: row.triggerId, anchor });
    };
    const toggle = async (row: AccountTriggerRow, next: boolean) => {
        const set = sets.find((candidate) => candidate.automationId === row.automationId);
        if (!set || pending.has(set.automationId) || set.legacy?.lockedReason === 'review_required') return;
        setPending((current) => new Set(current).add(set.automationId));
        try {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (set.legacy && !await Modal.confirm(t('workflows.triggers.legacy.editNotice'),
                t('workflows.triggers.legacy.conversionBoundary'), {
                    confirmText: t(next ? 'workflows.triggers.popover.turnOn' : 'workflows.triggers.popover.turnOff'),
                })) return;
            if (!lifetime?.isCurrent()) return;
            await writeAccountTriggerEnabled(set, row.triggerId, next);
            refresh();
        } catch (error) {
            void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
        } finally {
            setPending((current) => { const next = new Set(current); next.delete(set.automationId); return next; });
        }
    };
    if (rows.length === 0 && status === 'ready') return null;
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
            {open === null ? null : (
                <AccountTriggerPopover
                    key={`${open.set.automationId}:${open.triggerId ?? 'manual'}`}
                    set={open.set}
                    triggerId={open.triggerId}
                    anchorRef={open.anchor}
                    workflowOptions={thenOptions.workflowOptions}
                    onRequestClose={() => setOpen(null)}
                    onWritten={refresh}
                    onSaveAsWorkflow={(target) => openTriggerAsWorkflow(target, {
                        scope: 'account',
                        automationId: open.set.automationId,
                        ...(open.triggerId === null ? {} : { triggerId: open.triggerId }),
                        expectedRevision: open.set.revision,
                    })}
                />
            )}
        </>
    );
}

function readAccountTriggerForm(set: WorkflowTriggerSetV1, triggerId: AccountTriggerRow['triggerId']): TriggerFormValue | null {
    const trigger = set.triggers.find((candidate) => candidate.id === triggerId);
    const when = trigger ? readTriggerWhen(trigger) : set.triggers.length === 0 ? createDefaultWhen('schedule') : null;
    if (set.health !== 'available' || !set.target || !when) return null;
    return { when, then: readTriggerThen(set.target, set.context?.executionTarget, set.context?.inputs),
        enabled: set.legacy?.lockedReason === 'review_required' ? trigger?.enabled ?? true : (set.enabled && (trigger?.enabled ?? true)) };
}

async function writeAccountTriggerEnabled(set: WorkflowTriggerSetV1, triggerId: AccountTriggerRow['triggerId'], enabled: boolean) {
    return updateWorkflowTrigger({ automationId: set.automationId, expectedRevision: set.revision,
        ...(triggerId === null ? {} : { triggerId }), patch: { enabled } });
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
    set: WorkflowTriggerSetV1;
    triggerId: AccountTriggerRow['triggerId'];
    anchorRef: React.RefObject<View | null>;
    workflowOptions: ReturnType<typeof useTriggerThenOptions>['workflowOptions'];
    onRequestClose: () => void;
    onWritten: () => void;
    onSaveAsWorkflow: (target: TriggerTargetV1) => void;
}>) {
    const machines = useAllMachines();
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(props.set.project ?? null);
    const runNow = useAutomationRunNowController();
    const form = readAccountTriggerForm(props.set, props.triggerId);
    if (form === null) return null;
    const { set } = props;
    const needsReview = set.legacy?.lockedReason === 'review_required';
    const placements = set.placements ?? [];
    const triggerId = props.triggerId;
    return (
        <TriggerPopover
            testID="workflows-column-trigger-popover"
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            whenKinds={['schedule', 'pluginEvent']}
            sessionId={null}
            initial={form}
            manual={triggerId === null}
            subtitle={needsReview ? t('workflows.triggers.legacy.reviewRequired') : set.legacy ? t('workflows.triggers.legacy.editNotice') : undefined}
            submitNotice={needsReview ? t('workflows.triggers.legacy.reviewConversionNotice') : set.legacy ? t('workflows.triggers.legacy.conversionBoundary') : undefined}
            submitLabel={needsReview ? t('common.save') : undefined}
            workflowOptions={props.workflowOptions}
            machineId={project?.machineId ?? null}
            {...(triggerId !== null && form.when.kind === 'pluginEvent' ? { eventEdit: { automationId: set.automationId, triggerId } } : {})}
            hostComplete={project !== null}
            setRows={<>
                {needsReview && placements.length > 1 ? <Item mode="info"
                    title={t('workflows.triggers.row.machines', { count: placements.length })}
                    subtitle={placements.map((placement) => `${getMachineDisplayName(machines.find((machine) => machine.id === placement.machineId)
                        ?? { id: placement.machineId, absence: 'unlisted' })} · ${placement.directory}`).join('\n')}
                    subtitleLines={0} showChevron={false} /> : null}
                <TriggerRunsOnRow testID="workflows-column-trigger-runs-on" target={project} onChange={setProject}
                    description={t('workflows.triggers.editor.runsOnAccountDescription')} />
            </>}
            onRunNow={!needsReview && triggerId === null ? async () => { await runNow.runNow(set.automationId, 'newSession'); } : undefined}
            onSaveAsWorkflow={needsReview ? undefined : props.onSaveAsWorkflow}
            onSubmit={async (value, write) => {
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
                });
                props.onWritten();
            }}
            onDelete={triggerId === null ? undefined : async () => {
                await removeWorkflowTrigger({ automationId: set.automationId, triggerId });
                props.onWritten();
            }}
        />
    );
}

/**
 * The column "+" menu's **New trigger** (04 §3.3, F1): an Account trigger that holds its own steps,
 * with its set's Runs on, written through `workflow.trigger.add`. It joins the Triggers section.
 */
export function NewAccountTriggerPopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
}>): React.ReactElement {
    const thenOptions = useTriggerThenOptions();
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(null);
    return (
        <TriggerPopover
            testID="workflows-column-new-trigger-popover"
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            whenKinds={['schedule', 'pluginEvent']}
            sessionId={null}
            initial={null}
            workflowOptions={thenOptions.workflowOptions}
            machineId={project?.machineId ?? null}
            hostComplete={project !== null}
            setRows={(
                <TriggerRunsOnRow
                    testID="workflows-column-new-trigger-runs-on"
                    target={project}
                    onChange={setProject}
                    description={t('workflows.triggers.editor.runsOnAccountDescription')}
                />
            )}
            onSubmit={async (value, write) => {
                if (write.target === null || write.trigger === null || project === null) return;
                await addWorkflowTrigger({
                    target: write.target,
                    project,
                    trigger: write.trigger,
                    executionTarget: buildTriggerExecutionTarget(value.then),
                    inputs: write.inputs,
                });
                await sync.refreshAutomations().catch(() => undefined);
            }}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    // The column's row inset, so the line's edges sit on the rows' edges.
    stale: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingTop: theme.margins.xs },
}));
