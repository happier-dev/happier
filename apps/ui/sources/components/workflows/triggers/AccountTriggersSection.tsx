import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import type { TriggerTargetV1} from '@happier-dev/protocol/workflows/triggers/triggerTargetV1';
import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { PluginUiOpenAutomationEventRequestV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginEventAutomationEditSeed } from '@/sync/domains/automations/pluginEventAutomationEditSeed';
import { readManagedMachineTriggerAction } from '@happier-dev/protocol/actions/executor/workflowTriggerActions';
import { buildManagedCreationScopeTriggerTarget } from '@/sync/domains/machines/managedCreationScopeTrigger';

import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { useActiveServerAccountScope, useActiveMachineFacts, useMachineListForServer } from '@/sync/domains/state/storage';
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
    listWorkflowTriggerSets,
    removeWorkflowTrigger,
    reviewWorkflowTriggerSet,
    updateWorkflowTrigger,
    writeAccountTriggerEnabled,
} from '@/sync/domains/workflows/workflowTriggerActions';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { accountTriggerRemoval, projectAccountTriggerRows, type AccountTriggerRow } from './accountTriggerRows';
import { isWorkflowTriggerSourceGone } from './sessionTriggerGroups';
import { TriggerPopover } from './TriggerPopover';
import { TriggerRow } from './TriggerRow';
import { DeploymentPushTriggerFields, showDeploymentPushDeliveryResult } from './DeploymentPushTriggerFields';
import { buildDeploymentPushFilter, readDeploymentPushManagedRepositoryId } from './deploymentPushSetup';
import { TriggerRunsOnRow } from './TriggerRunsOnRow';
import { buildTriggerExecutionTarget, readWorkflowTriggerSetForm } from './sessionTriggerForm';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { useOpenTriggerAsWorkflow } from './useOpenTriggerAsWorkflow';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { formatTriggerSummary } from './formatTriggerSummary';
import { presentSpentOnceSchedule } from './triggerSchedule';
import { readTriggerScheduleHold } from './scheduleHoldPresentation';

/**
 * The Account's inline trigger sets through `workflow.trigger.list {scope:'account_inline'}`, the one
 * membership the column and agents share. The Automation projection is only a change signal: when an
 * unscoped row changes (an agent wrote a trigger, a run finished) the list is read again.
 */
const ACCOUNT_TRIGGER_QUERY = { scope: 'account_inline' } as const;

/**
 * The standalone trigger-set list: a retained addressed-Home link (`?serverId=`) and the testkit
 * preview, each with its exact-Home read and editor scope. The active Home's Account Workflows are
 * Library rows (Q7), drawn by the Library itself through `useAccountWorkflowEditor`.
 */
export const AccountTriggersSection = React.memo(function AccountTriggersSection(props: Readonly<{ first?: boolean;
    /** `false` beside the Library home, which answers a `?trigger=` link itself: one popover per link. */
    answersLink?: boolean }>) {
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

function AccountTriggersContent(props: Readonly<{ first?: boolean; answersLink?: boolean; accountLifetime?: ServerAccountScopeLifetime | null }>) {
    const read = useWorkflowTriggerSets(ACCOUNT_TRIGGER_QUERY, props.accountLifetime);
    return <AccountTriggersReadContent {...props} read={read} />;
}

/** Hydrate an interacted row through its admitted scope; opening the list never inventories private bodies. */
export function useAccountWorkflowEditor(props: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null;
    read: ReturnType<typeof useWorkflowTriggerSets>;
    /** A selected Session attachment can arrive before its admitted lifetime page. */
    lifetimeSessionId?: string }>) {
    const { sets, retry: refresh } = props.read;
    const captureLifetime = () => props.accountLifetime === undefined
        ? captureActiveServerAccountScopeLifetime() : props.accountLifetime;
    const actionOptions = props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime };
    // History is the open settings' pushed page (the same shell, popover or sheet), so it opens where the person is.
    const [open, setOpen] = React.useState<Readonly<{ set: WorkflowTriggerSetV1; triggerId: AccountTriggerRow['triggerId']; anchor: React.RefObject<View | null>; refusal?: string; history?: boolean }> | null>(null);
    const thenOptions = useTriggerThenOptions({ ...actionOptions, libraryEnabled: open !== null, sets, attachedPage: props.read.attachedPage });
    const openTriggerAsWorkflow = useOpenTriggerAsWorkflow(props.accountLifetime);
    const add = React.useCallback(async (request: Parameters<typeof addWorkflowTrigger>[0],
        accountLifetime: ServerAccountScopeLifetime | null | undefined) => {
        const write = await addWorkflowTrigger(request, { accountLifetime });
        refresh();
        return write;
    }, [refresh]);
    const readSet = async (automationId: string) => {
        const held = sets.find(candidate => candidate.automationId === automationId);
        if (held) return held;
        // The exact Account query intentionally excludes Session-lifetime records.
        // Hydrate a cold Session through its existing admitted query and select this row.
        if (props.lifetimeSessionId) {
            const scoped = (await listWorkflowTriggerSets({ lifetimeSession: { sessionId: props.lifetimeSessionId } }, actionOptions))
                .find(candidate => candidate.automationId === automationId);
            if (scoped) return scoped;
        }
        const set = (await listWorkflowTriggerSets({ automationId }, actionOptions)).find(candidate => candidate.automationId === automationId);
        if (!set) throw new WorkflowActionError({ message: 'source_unavailable', rawCode: 'source_unavailable' });
        return set;
    };
    const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
    const openRow = useEventCallback(async (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'> & Partial<Pick<AccountTriggerRow, 'legacy'>>, anchor: React.RefObject<View | null>) => {
        const lifetime = captureLifetime();
        let set: WorkflowTriggerSetV1;
        try {
            set = sets.find(candidate => candidate.automationId === row.automationId) ?? await readSet(row.automationId);
        } catch (error) {
            if (lifetime?.isCurrent()) void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
            return;
        }
        if (!lifetime?.isCurrent()) return;
        if (isWorkflowTriggerSourceGone(set)) {
            void remove(row);
            return;
        }
        if (set.legacy?.lockedReason === 'review_required') {
            if (pending.has(set.automationId)) return;
            const lifetime = captureLifetime();
            setPending((current) => new Set(current).add(set.automationId));
            try {
                const reviewed = await reviewWorkflowTriggerSet(set.automationId, actionOptions);
                if (!lifetime?.isCurrent()) return;
                if (readWorkflowTriggerSetForm(reviewed, row.triggerId) === null) {
                    setOpen({ set: reviewed, triggerId: row.triggerId, anchor, refusal: t('workflows.triggers.legacy.changeUnavailable') });
                    return;
                }
                setOpen({ set: reviewed, triggerId: row.triggerId, anchor });
            } catch (error) {
                if (lifetime?.isCurrent()) setOpen({ set, triggerId: row.triggerId, anchor, refusal: formatWorkflowProblemMessage(error) });
            } finally {
                setPending((current) => { const next = new Set(current); next.delete(set.automationId); return next; });
            }
            return;
        }
        if (readWorkflowTriggerSetForm(set, row.triggerId) === null) {
            setOpen({ set, triggerId: row.triggerId, anchor, refusal: t('workflows.triggers.legacy.changeUnavailable') });
            return;
        }
        setOpen({ set, triggerId: row.triggerId, anchor });
    });
    /** A trigger whose Workflow is gone offers only this; `triggerId: null` is the whole retained set. */
    const remove = useEventCallback(async (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'>) => {
        if (pending.has(row.automationId)) return;
        setPending((current) => new Set(current).add(row.automationId));
        try {
            const lifetime = captureLifetime();
            const set = await readSet(row.automationId);
            if (!lifetime?.isCurrent()) return;
            // The Action owns the confirmation; declining it leaves the row and says nothing.
            await removeWorkflowTrigger(accountTriggerRemoval(set, row.triggerId), actionOptions);
            refresh();
        } catch (error) {
            if (error instanceof WorkflowActionError && error.rawCode === 'approval_canceled') return;
            void Modal.alert(t('workflows.triggers.section.saveFailed'), formatWorkflowProblemMessage(error));
        } finally {
            setPending((current) => { const next = new Set(current); next.delete(row.automationId); return next; });
        }
    });
    const toggle = useEventCallback(async (row: Pick<AccountTriggerRow, 'automationId' | 'triggerId'>, next: boolean) => {
        if (pending.has(row.automationId)) return;
        setPending((current) => new Set(current).add(row.automationId));
        try {
            const lifetime = captureLifetime();
            const set = await readSet(row.automationId);
            if (set.legacy?.lockedReason === 'review_required') return;
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
            setPending((current) => { const next = new Set(current); next.delete(row.automationId); return next; });
        }
    });
    const openTrigger = open?.triggerId == null ? undefined : open.set.triggers.find((trigger) => trigger.id === open.triggerId);
    const openEnabled = open !== null && open.set.enabled && openTrigger?.enabled !== false;
    // A one-time schedule that already ran stays enabled on the server; Turn off/on would read as armed (R12 M12).
    const openSpent = openTrigger ? presentSpentOnceSchedule(openTrigger) : null;
    // History reads the current list's occurrence, not the revision kept open for editing.
    const liveSet = open?.history ? sets.find(set => set.automationId === open.set.automationId) ?? open.set : undefined;
    const liveTrigger = liveSet?.triggers.find(trigger => trigger.id === open?.triggerId);
    const popover = open === null ? null : (
        <AccountTriggerPopover
            key={`${open.set.automationId}:${open.triggerId ?? 'manual'}`}
            set={open.set}
            triggerId={open.triggerId}
            anchorRef={open.anchor}
            workflowOptions={thenOptions.workflowOptions}
            refusal={open.refusal}
            {...actionOptions}
            onRequestClose={() => setOpen(null)}
            {...(openTrigger ? { onHistory: () => setOpen({ ...open, history: true }) } : {})}
            {...(openTrigger && open.history ? { pushedPage: { title: t('workflows.destination.history.title'),
                onBack: () => setOpen({ ...open, history: false }),
                content: <WorkflowTriggerRunHistory automationId={open.set.automationId} triggerId={openTrigger.id}
                    triggerName={formatTriggerSummary(openTrigger)} {...actionOptions} trigger={liveTrigger ?? openTrigger}
                    nextRunAt={liveSet?.enabled && liveTrigger?.enabled && liveTrigger.kind === 'schedule' ? liveTrigger.nextRunAt : null}
                    hold={liveSet?.enabled && liveTrigger?.enabled ? readTriggerScheduleHold(liveSet, liveTrigger.id) : undefined} /> } } : {})}
            onWritten={refresh}
            {...(openSpent ? { subtitle: joinHappierFacts(openSpent.line, t('workflows.triggers.once.runAgain')) } : {})}
            {...(openSpent || open.refusal !== undefined || open.set.legacy?.lockedReason === 'review_required' ? {} : { onToggleEnabled: { enabled: openEnabled, onPress: () => {
                setOpen(null);
                void toggle({ automationId: open.set.automationId, triggerId: open.triggerId }, !openEnabled);
            } } })}
            onSaveAsWorkflow={(target) => openTriggerAsWorkflow(target, {
                scope: 'account', automationId: open.set.automationId,
                ...(open.triggerId === null ? {} : { triggerId: open.triggerId }), expectedRevision: open.set.revision,
            })}
        />
    );
    return React.useMemo(() => ({ pending, open: openRow, add, remove, toggle, popover, resolveWorkflowTitle: thenOptions.resolveWorkflowTitle,
        isWorkflowTitlePending: thenOptions.isWorkflowTitlePending }),
        [pending, openRow, add, remove, toggle, popover, thenOptions.resolveWorkflowTitle, thenOptions.isWorkflowTitlePending]);
}

export function AccountTriggersReadContent(props: Readonly<{ first?: boolean; answersLink?: boolean; accountLifetime?: ServerAccountScopeLifetime | null;
    read: ReturnType<typeof useWorkflowTriggerSets> }>) {
    const { sets, status, retry: refresh } = props.read;
    const { pending, open: openRow, toggle, popover, resolveWorkflowTitle } = useAccountWorkflowEditor(props);
    const activeMachines = useActiveMachineFacts(props.accountLifetime === undefined);
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '', props.accountLifetime !== undefined);
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
                    deepLink={props.answersLink !== false && params.trigger === row.automationId && rows.find((candidate) => candidate.automationId === row.automationId) === row}
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
                toggleDisabled={props.pending || props.reviewRequired || props.row.sourceGone === true}
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
    refusal?: string;
    onRequestClose: () => void;
    onWritten: () => void;
    onToggleEnabled?: React.ComponentProps<typeof TriggerPopover>['onToggleEnabled'];
    /** A saved one-time schedule that already ran says so under the title until its time is changed. */
    subtitle?: string;
    onHistory?: () => void;
    pushedPage?: React.ComponentProps<typeof TriggerPopover>['pushedPage'];
    onSaveAsWorkflow?: (target: TriggerTargetV1) => void;
    initialEventSeed?: PluginUiOpenAutomationEventRequestV1;
    initialEventEditSeed?: PluginEventAutomationEditSeed;
}>) {
    const activeMachines = useActiveMachineFacts(props.accountLifetime === undefined);
    const addressedMachines = useMachineListForServer(props.accountLifetime?.scope.serverId ?? '', props.accountLifetime !== undefined);
    const machines = props.accountLifetime === undefined ? activeMachines : addressedMachines ?? [];
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(props.set.project ?? null);
    const runNow = useAutomationRunNowController(props.accountLifetime);
    const form = readWorkflowTriggerSetForm(props.set, props.triggerId);
    const { set } = props;
    const needsReview = set.legacy?.lockedReason === 'review_required';
    const placements = set.placements ?? [];
    const triggerId = props.triggerId;
    const savedTrigger = set.triggers.find(trigger => trigger.id === triggerId);
    const deploymentTrigger = set.context?.deploymentTriggers?.find(trigger => trigger.triggerId === triggerId);
    const [branch, setBranch] = React.useState(deploymentTrigger?.branch ?? '');
    const [actionApproval, setActionApproval] = React.useState<'automatic' | 'ask' | undefined>();
    const savedActionApproval = set.context?.actionApprovals?.some(approval => approval.triggerId === triggerId) ? 'automatic' : 'ask';
    const managed = set.target && readManagedMachineTriggerAction(set.target);
    const actionTargets = managed ? (['stop', 'delete'] as const).map(effect => buildManagedCreationScopeTriggerTarget({
        homeId: managed.input.homeId, managedId: managed.input.managedId, effect,
        supportedIntents: [managed.input.intent],
        ...('afterMs' in managed.input ? { afterMs: managed.input.afterMs } : {}),
    })) : undefined;
    return (
        <TriggerPopover
            testID="workflows-column-trigger-popover"
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            onHistory={props.onHistory}
            pushedPage={props.pushedPage}
            whenKinds={set.observationOnly ? ['pluginEvent'] : ['schedule', 'pluginEvent']}
            sessionId={null}
            serverId={props.accountLifetime?.scope.serverId}
            accountLifetime={props.accountLifetime}
            initial={form}
            submitRefusal={props.refusal ?? (form === null ? t('workflows.triggers.legacy.changeUnavailable') : undefined)}
            savedNextRunAt={savedTrigger?.kind === 'schedule' ? savedTrigger.nextRunAt : null}
            savedScheduleHold={readTriggerScheduleHold(set, savedTrigger?.id)}
            initialEventSeed={props.initialEventSeed}
            initialEventEditSeed={props.initialEventEditSeed}
            initialActionTargets={actionTargets}
            manual={triggerId === null}
            submitNotice={set.legacy ? [t('workflows.triggers.legacy.editNotice'),
                ...(props.refusal !== undefined ? [] : [t(needsReview ? 'workflows.triggers.legacy.reviewConversionNotice' : 'workflows.triggers.legacy.conversionBoundary')])].join('\n') : undefined}
            submitLabel={needsReview ? t('common.save') : undefined}
            workflowOptions={props.workflowOptions}
            machineId={project?.machineId ?? null}
            directory={project?.directory ?? null}
            {...(triggerId !== null && form?.when.kind === 'pluginEvent' ? { eventEdit: { automationId: set.automationId, triggerId } } : {})}
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
            showThen={deploymentTrigger ? false : undefined}
            afterRows={deploymentTrigger ? when => <DeploymentPushTriggerFields branch={branch} onBranchChange={setBranch}
                approval={actionApproval ?? savedActionApproval} onApprovalChange={setActionApproval}
                source={when.kind === 'pluginEvent' ? when.value : undefined} /> : undefined}
            onRunNow={!needsReview && triggerId === null ? async () => { await runNow.runNow(set.automationId, 'newSession'); } : undefined}
            onToggleEnabled={props.onToggleEnabled}
            subtitle={props.subtitle}
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
                const target = write.target ?? (deploymentTrigger ? set.target : null);
                if (target === null || project === null) return;
                const definition = write.trigger === null ? null : (({ enabled: _enabled, ...definition }) => definition)(write.trigger);
                const managedGithubRepositoryId = deploymentTrigger ? readDeploymentPushManagedRepositoryId(write.trigger) : undefined;
                const saved = await updateWorkflowTrigger({
                    automationId: set.automationId,
                    ...(triggerId === null ? {} : { triggerId }),
                    expectedRevision: set.revision,
                    ...(needsReview ? { confirmLegacyConversion: true } : {}),
                    patch: {
                        ...(set.context ? (({ workspace: _workspace, inlineDefinition: _inlineDefinition, onComplete: _onComplete,
                            actionApprovals: _actionApprovals, deploymentTriggers: _deploymentTriggers, ...context }) => context)(set.context) : {}),
                        ...(deploymentTrigger ? { actionApproval: actionApproval ?? savedActionApproval } : {}),
                        ...(managedGithubRepositoryId === undefined ? {} : { managedGithubRepositoryId }),
                        ...(deploymentTrigger && branch !== (deploymentTrigger.branch ?? '')
                            ? { deployment: buildDeploymentPushFilter(branch, deploymentTrigger) } : {}),
                        target,
                        project,
                        ...(triggerId === null || definition === null ? {} : { trigger: definition }),
                        enabled: value.enabled,
                        executionTarget: buildTriggerExecutionTarget(value.then, set.context?.executionTarget),
                        inputs: deploymentTrigger ? set.context?.inputs ?? {} : write.inputs,
                    },
                }, props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                if (deploymentTrigger) showDeploymentPushDeliveryResult(saved?.managedGithubRepositoryHook);
                props.onWritten();
            }}
            onDelete={async () => {
                await removeWorkflowTrigger(accountTriggerRemoval(set, triggerId),
                    props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                props.onWritten();
            }}
        />
    );
}

/**
 * The column "+" menu's **New trigger** (04 §3.3, F1): an Account trigger that holds its own steps,
 * with its set's Runs on, written through `workflow.trigger.add`. It joins the Library as a Workflow (Q7).
 */
type NewAccountTriggerPopoverProps = Readonly<{
    deploymentEnvironment?: DeploymentEnvironmentRefV1;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    eventSeed?: PluginUiOpenAutomationEventRequestV1;
    accountLifetime?: ServerAccountScopeLifetime | null;
    /** Opened from a Machine's own Triggers section: Runs on starts at that Machine. */
    initialProject?: WorkflowProjectTargetV1;
    initialActionTargets?: readonly TriggerTargetV1[];
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
        if (!lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        void (async () => {
            const candidates = inventorySets.current.flatMap(set => set.triggers.flatMap(trigger =>
                trigger.kind === 'pluginEvent' && trigger.eventRef.pluginId === pluginId && trigger.eventRef.localId === localId
                    ? [{ set, automationId: set.automationId, triggerId: trigger.id }] : []));
            const seeds = await sync.getAutomationPluginEventEditSeeds(candidates, controller.signal);
            if (!seeds) throw new Error('Saved Event source is unavailable');
            if (controller.signal.aborted || !lifetime.isCurrent()) return;
            const matches = seeds.flatMap((seed, index) => seed.source.sourceInstanceId === props.sourceInstanceId
                ? [{ set: candidates[index]!.set, seed }] : []);
            const [match] = matches;
            if (matches.length === 0) setResolution({ kind: 'new' });
            else if (matches.length === 1 && match && readWorkflowTriggerSetForm(match.set, match.seed.triggerId)) {
                setResolution({ kind: 'existing', ...match });
            } else setResolution({ kind: 'unavailable' });
        })().catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setResolution({ kind: 'unavailable' });
        });
        return () => { retirement.dispose(); controller.abort(); };
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
    const eventSeed = props.eventSeed;
    const [project, setProject] = React.useState<WorkflowProjectTargetV1 | null>(() => props.initialProject ?? null);
    return (
        <TriggerPopover
            testID="workflows-column-new-trigger-popover"
            // Q7: this creates a Workflow that runs automatically, named as the New workflow menu names it.
            newTitle={t('workflows.triggers.editor.title')}
            submitLabel={t('common.create')}
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            whenKinds={['schedule', 'pluginEvent']}
            sessionId={null}
            initial={null}
            initialWhen={eventSeed ? { kind: 'pluginEvent', value: null, eventRef: eventSeed.eventRef } : undefined}
            initialEventSeed={eventSeed}
            initialActionTargets={props.initialActionTargets}
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
                    await addWorkflowTrigger({
                        trigger: write.trigger,
                        observationOnly: props.deploymentEnvironment
                            ? { ...write.observationOnly, deploymentEnvironment: props.deploymentEnvironment }
                            : write.observationOnly,
                    }, props.accountLifetime === undefined ? {} : { accountLifetime: props.accountLifetime });
                    fireAndForget(sync.refreshAutomations());
                    return;
                }
                if (write.target === null || write.trigger === null || project === null) return;
                await addWorkflowTrigger({
                    target: write.target,
                    project,
                    trigger: write.trigger,
                    executionTarget: buildTriggerExecutionTarget(value.then, props.initialActionTargets ? { kind: 'detached_run' } : undefined),
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
