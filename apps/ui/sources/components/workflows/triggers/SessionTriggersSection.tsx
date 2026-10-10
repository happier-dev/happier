import { HappierPageSheetGroup } from '@happier-dev/plugin-ui/presentation';
import type { TriggerTargetV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { WorkSection } from '@/components/sessions/work/WorkSection';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useIsFocused, useLocalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { parseExactTurnAutomationPrefillRoute } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import { useAutomationRunNowController } from '@/components/automations/list/useAutomationRunNowController';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useActiveServerAccountScope, useAllMachines } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createAdmittedWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

import { TriggerPopover } from './TriggerPopover';
import { TriggerRow } from './TriggerRow';
import { projectSessionTriggerGroups, type SessionTriggerGroupModel, type SessionTriggerRowModel } from './sessionTriggerGroups';
import {
    SESSION_TRIGGER_WHEN_KINDS,
    readTriggerThen,
    readTriggerWhen,
    type TriggerFormValue,
    type TriggerWhenValue,
} from './sessionTriggerForm';
import { useSessionTriggers } from './useSessionTriggers';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { useOpenTriggerAsWorkflow } from './useOpenTriggerAsWorkflow';
import { useSessionTriggerLastRuns } from './useSessionTriggerLastRuns';
import { WorkflowTriggerRunHistory } from './WorkflowTriggerRunHistory';
import { WorkflowExamplesPopover } from '../library/WorkflowExamplesPopover';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';

export type SessionTriggersSectionViewProps = Readonly<{
    groups: readonly SessionTriggerGroupModel[];
    status: 'loading' | 'ready' | 'failed';
    pullRequestLinksUnavailable?: boolean;
    /** Trigger rows whose write is in flight. */
    pendingKeys: ReadonlySet<string>;
    onToggle: (row: SessionTriggerRowModel, next: boolean) => void;
    onOpen: (row: SessionTriggerRowModel, anchor: React.RefObject<View | null>) => void;
    onAdd: (anchor: React.RefObject<View | null>) => void;
    onRetry: () => void;
    onHistory?: (row: SessionTriggerRowModel) => void;
    historyRowKey?: string;
    history?: React.ReactNode;
    /** The header "+", which also anchors a popover the host opens itself (a bound turn). */
    addAnchorRef?: React.RefObject<View | null>;
    /** A retired Automation link reveals this set's first row, as in the Account column. */
    deepLinkAutomationId?: string;
}>;

/**
 * The session's Triggers section in the Work tab (FIN 04 §5.5; 07 S16 and its owner-approved
 * presentation; lab `convo-W9`, phone `convo-P9`): flat, grouped by event under a glyph and a
 * legible label, rows named by what they run, header "Triggers · {n} on · ⓘ · +". Built on I4-W's
 * `WorkSection anatomy="page"` and one `HappierPageSheetGroup` per event, whose group boundary draws
 * the only separators. With none it says so and offers the first trigger (07 S16 empty state).
 */
export const SessionTriggersSectionView = React.memo(function SessionTriggersSectionView(props: SessionTriggersSectionViewProps) {
    const { theme } = useUnistyles();
    const ownAddAnchorRef = React.useRef<View>(null);
    const addAnchorRef = props.addAnchorRef ?? ownAddAnchorRef;
    const onCount = props.groups.reduce((count, group) => count + group.rows.filter((row) => row.enabled).length, 0);
    const empty = props.groups.length === 0;
    const deepLinkedRow = props.deepLinkAutomationId
        ? props.groups.flatMap((group) => group.rows).find((row) => row.automationId === props.deepLinkAutomationId)
        : undefined;
    return (
        <WorkSection
            testID="session-work-triggers"
            anatomy="page"
            title={t('workflows.triggers.section.title')}
            count={empty ? '' : t('workflows.triggers.section.countOn', { count: onCount })}
            info={t('workflows.triggers.section.info')}
            loading={props.status === 'loading' && empty}
            action={(
                <View ref={addAnchorRef} collapsable={false}>
                    <IconButton
                        testID="session-work-triggers-add"
                        iconName="plus"
                        variant="plain"
                        accessibilityLabel={t('workflows.triggers.section.add')}
                        tooltip={t('workflows.triggers.section.add')}
                        onPress={() => props.onAdd(addAnchorRef)}
                    />
                </View>
            )}
        >
            {props.status === 'failed' ? (
                <SurfaceFreshnessLine
                    testID="session-work-triggers-failed"
                    tone="warning"
                    reason={t('workflows.triggers.section.loadFailed')}
                    action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry }}
                />
            ) : null}
            {props.pullRequestLinksUnavailable ? (
                <SurfaceFreshnessLine
                    testID="session-work-trigger-links-unavailable"
                    tone="warning"
                    reason={t('workflows.triggers.pullRequest.loadFailed')}
                    action={{ label: t('workflows.triggers.popover.tryAgain'), onPress: props.onRetry }}
                />
            ) : null}
            {empty && props.status === 'ready' ? (
                <EmptyState
                    testID="session-work-triggers-empty"
                    layout="line"
                    title={t('workflows.triggers.section.emptyTitle')}
                    subtitle={t('workflows.triggers.section.emptyBody')}
                    primaryAction={{ label: t('workflows.triggers.section.add'), onPress: () => props.onAdd(addAnchorRef) }}
                />
            ) : props.groups.map((group) => (
                <HappierPageSheetGroup
                    key={group.id}
                    header={(
                        <CollectionListGroupLabel
                            testID={`session-work-triggers-group:${group.id}`}
                            title={group.title}
                            count={group.rows.length > 1 ? group.rows.length : undefined}
                            mark={<Icon name={group.glyph} size={16} color={theme.colors.text.secondary} />}
                        />
                    )}
                >
                    {group.rows.map((row) => (
                        <AnchoredTriggerRow
                            key={row.key}
                            row={row}
                            glyph={group.glyph}
                            pending={props.pendingKeys.has(row.key)}
                            deepLink={row === deepLinkedRow}
                            onToggle={props.onToggle}
                            onOpen={props.onOpen}
                            onHistory={props.onHistory}
                            history={props.historyRowKey === row.key ? props.history : undefined}
                        />
                    ))}
                </HappierPageSheetGroup>
            ))}
        </WorkSection>
    );
});

/** A row that anchors its own popover beside it. */
const AnchoredTriggerRow = React.memo(function AnchoredTriggerRow(props: Readonly<{
    row: SessionTriggerRowModel;
    glyph: SessionTriggerGroupModel['glyph'];
    pending: boolean;
    deepLink: boolean;
    onToggle: SessionTriggersSectionViewProps['onToggle'];
    onOpen: SessionTriggersSectionViewProps['onOpen'];
    onHistory: SessionTriggersSectionViewProps['onHistory'];
    history: React.ReactNode;
}>) {
    const anchorRef = React.useRef<View>(null);
    const { row } = props;
    const openRef = React.useRef(props.onOpen);
    openRef.current = props.onOpen;
    React.useEffect(() => { if (props.deepLink) openRef.current(row, anchorRef); }, [props.deepLink]);
    return (
        <View ref={anchorRef} collapsable={false}>
            <TriggerRow
                testID={`session-work-trigger:${row.key}`}
                title={row.title}
                outcome={row.outcome}
                qualifier={row.qualifier}
                qualifierTime={row.qualifierTime}
                qualifierAccessibilityLabel={row.qualifierAccessibilityLabel}
                glyph={props.glyph}
                multiline={row.legacy}
                enabled={row.enabled}
                toggleDisabled={props.pending || row.sourceUnavailable || row.legacy}
                onToggle={(next) => props.onToggle(row, next)}
                onPress={() => props.onOpen(row, anchorRef)}
                actions={(row.legacy || row.sourceUnavailable) && props.onHistory ? <>
                {props.onHistory ? <ToolbarButton testID={`session-work-trigger:${row.key}-history`}
                    label={t('workflows.destination.history.title')} active={props.history !== undefined}
                    onPress={() => props.onHistory?.(row)} /> : null}
                </> : undefined}
            />
            {props.history}
        </View>
    );
});

/** The kinds a session's popover lists but cannot add here, each with its reason (07 S16). */
const SESSION_UNAVAILABLE_KINDS = {
    sessionStarts: 'workflows.triggers.kindDescription.sessionStarts',
} as const;

type OpenPopover = Readonly<{ anchor: React.RefObject<View | null>; row: SessionTriggerRowModel | null }>;

/**
 * The section as the Work tab mounts it in ORC's `triggersSection` slot: the session's triggers
 * through `session.trigger.*` (the one writer the Work tab and agents share), the switch and the
 * popover each one immediate call with its own result. Last outcomes and expanded history read
 * the shared Account Run store; a firing timestamp alone never supplies a Run's lifecycle.
 */
export const SessionTriggersSection = React.memo(function SessionTriggersSection(props: Readonly<{ sessionId: string; serverId?: string | null }>) {
    const scope = useActiveServerAccountScope(props.serverId);
    if (scope === null) return null;
    return <SessionTriggersContent key={`${serverAccountScopeKeySuffix(scope)}:${props.sessionId}`} sessionId={props.sessionId} />;
});

function SessionTriggersContent(props: Readonly<{ sessionId: string }>) {
    const { theme } = useUnistyles();
    const read = useSessionTriggers(props.sessionId);
    const readRef = React.useRef(read);
    readRef.current = read;
    const openTriggerAsWorkflow = useOpenTriggerAsWorkflow();
    const thenOptions = useTriggerThenOptions();
    const machines = useAllMachines();
    const automationIds = React.useMemo(() => Object.entries(read.lastRunAtByAutomationId)
        .filter(([, at]) => at !== null).map(([id]) => id), [read.lastRunAtByAutomationId]);
    const lastRuns = useSessionTriggerLastRuns(automationIds);
    const lastRunsRef = React.useRef(lastRuns);
    lastRunsRef.current = lastRuns;
    const retry = React.useCallback(() => {
        readRef.current.retry();
        lastRunsRef.current.retry();
    }, []);
    const previousGroups = React.useRef<readonly SessionTriggerGroupModel[]>([]);
    const groups = React.useMemo(() => {
        const projected = projectSessionTriggerGroups({
            sets: read.sets,
            lastRunAtByAutomationId: read.lastRunAtByAutomationId,
            lastRunsByAutomationId: lastRuns.lastRunsByAutomationId,
            resolveWorkflowTitle: thenOptions.resolveWorkflowTitle,
            resolveMachineTitle: (id) => getMachineDisplayName(machines.find((machine) => machine.id === id) ?? { id, absence: 'unlisted' }),
            formatAge: (at) => formatRelativeTimeShort(at, Date.now()),
        });
        const oldRows = new Map(previousGroups.current.flatMap(group => group.rows.map(row => [row.key, row] as const)));
        const next = projected.map(group => {
            const rows = group.rows.map(row => {
                const previous = oldRows.get(row.key);
                return previous && sameStrictJsonValue(previous, row) ? previous : row;
            });
            const previous = previousGroups.current.find(candidate => candidate.id === group.id);
            const nextGroup = { ...group, rows };
            return previous && sameStrictJsonValue(previous, nextGroup) ? previous : nextGroup;
        });
        if (!sameStrictJsonValue(previousGroups.current, next)) previousGroups.current = next;
        return previousGroups.current;
    }, [read.lastRunAtByAutomationId, read.sets, lastRuns.lastRunsByAutomationId, thenOptions.resolveWorkflowTitle, machines]);

    const router = useRouter();
    const pathname = usePathname();
    const focused = useIsFocused();
    const focusedRef = React.useRef(focused);
    focusedRef.current = focused;
    const pathnameRef = React.useRef(pathname);
    pathnameRef.current = pathname;
    const mountedRef = React.useRef(true);
    React.useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
    const runNowController = useAutomationRunNowController();
    const runNowControllerRef = React.useRef(runNowController);
    runNowControllerRef.current = runNowController;
    const runNow = React.useCallback(async (row: SessionTriggerRowModel) => {
        if (row.sourceUnavailable || row.legacy) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const invocationPathname = pathnameRef.current;
        const isInvocationCurrent = () => mountedRef.current && focusedRef.current
            && pathnameRef.current === invocationPathname && lifetime?.isCurrent() === true;
        if (!isInvocationCurrent()) return;
        const admitted = await runNowControllerRef.current.runNow(row.automationId, 'existingSession', { isInvocationCurrent });
        const route = createAdmittedWorkflowRunRoute(admitted?.workflowRun);
        if (route !== null && isInvocationCurrent()) router.push(route as never);
    }, [router]);
    const [historyRowKey, setHistoryRowKey] = React.useState<string>();
    const openHistory = React.useCallback((row: SessionTriggerRowModel) => {
        setHistoryRowKey(current => current === row.key ? undefined : row.key);
    }, []);
    const historyRow = groups.flatMap(group => group.rows).find(candidate => candidate.key === historyRowKey);
    const history = React.useMemo(() => historyRow ? <WorkflowTriggerRunHistory automationId={historyRow.automationId} /> : undefined,
        [historyRow?.automationId]);

    const [pendingKeys, setPendingKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const pendingKeysRef = React.useRef(pendingKeys);
    pendingKeysRef.current = pendingKeys;
    const toggle = React.useCallback((row: SessionTriggerRowModel, next: boolean) => {
        if (row.legacy || pendingKeysRef.current.has(row.key)) return;
        const nextKeys = new Set(pendingKeysRef.current).add(row.key);
        pendingKeysRef.current = nextKeys;
        setPendingKeys(nextKeys);
        void readRef.current.update({ triggerId: row.triggerId, expectedRevision: row.revision, patch: { enabled: next } })
            .catch(() => readRef.current.retry())
            .finally(() => {
                const remaining = new Set(pendingKeysRef.current);
                remaining.delete(row.key);
                pendingKeysRef.current = remaining;
                setPendingKeys(remaining);
            });
    }, []);

    const [popover, setPopover] = React.useState<OpenPopover | null>(null);
    const initial = React.useMemo((): TriggerFormValue | null => {
        const row = popover?.row;
        if (!row) return null;
        const set = read.sets.find((candidate) => candidate.automationId === row.automationId);
        const trigger = set?.triggers.find((candidate) => candidate.id === row.triggerId);
        const when = trigger ? readTriggerWhen(trigger) : null;
        if (!set?.target || !when) return null;
        return { when, then: readTriggerThen(set.target, set.context?.executionTarget, set.context?.inputs), enabled: row.enabled };
    }, [popover, read.sets]);

    const close = React.useCallback(() => setPopover(null), []);
    const row = popover?.row ?? null;

    // "When this turn finishes…" (04 §5.5): the deep link carries the exact turn; the section opens
    // its popover once with When a turn ends bound to that turn (the existing exact-turn owner parses it).
    const addAnchorRef = React.useRef<View>(null);
    const params = useLocalSearchParams();
    const exactTurn = parseExactTurnAutomationPrefillRoute(params);
    const boundTurnId = exactTurn.kind === 'valid' && exactTurn.prefill.sourceSessionId === props.sessionId
        ? exactTurn.prefill.sourceTurnId
        : null;
    const consumedTurnRef = React.useRef<string | null>(null);
    const [boundWhen, setBoundWhen] = React.useState<TriggerWhenValue | undefined>(undefined);
    React.useEffect(() => {
        if (boundTurnId === null || consumedTurnRef.current === boundTurnId || read.status !== 'ready') return;
        consumedTurnRef.current = boundTurnId;
        setBoundWhen({ kind: 'turnEnds', sourceTurnId: boundTurnId });
        setPopover({ anchor: addAnchorRef, row: null });
    }, [boundTurnId, read.status]);
    const openRow = React.useCallback((openedRow: SessionTriggerRowModel, anchor: React.RefObject<View | null>) => {
        if (openedRow.legacy) {
            void Modal.confirm(t('workflows.triggers.editor.editInWorkflows'), undefined, {
                confirmText: t('workflows.triggers.popover.deleteTrigger'), destructive: true,
            }).then((confirmed) => (confirmed ? readRef.current.remove(openedRow.triggerId) : null)).catch((error: unknown) => {
                readRef.current.retry();
                void Modal.alert(t('common.error'), error instanceof Error ? error.message : t('workflows.triggers.section.saveFailed'));
            });
            return;
        }
        // A trigger whose workflow is gone offers only Delete trigger (07 S16).
        if (openedRow.sourceUnavailable) {
            void Modal.confirm(t('workflows.triggers.row.workflowDeleted'), undefined, {
                confirmText: t('workflows.triggers.popover.deleteTrigger'), destructive: true,
            }).then((confirmed) => (confirmed ? readRef.current.remove(openedRow.triggerId) : null)).catch(() => readRef.current.retry());
            return;
        }
        setPopover({ anchor, row: openedRow });
    }, []);
    // "+" starts from an example already bound to this Session (65s5, lab `b-habit T`); "New trigger" under
    // the list opens the blank trigger popover at the same anchor. Without a known Machine an example cannot
    // be bound here, so "+" goes straight to the blank trigger.
    const [examplesAnchor, setExamplesAnchor] = React.useState<React.RefObject<View | null> | null>(null);
    const exampleSession = React.useMemo(() => (read.machineId ? { sessionId: props.sessionId, machineId: read.machineId } : undefined),
        [props.sessionId, read.machineId]);
    const openBlankTrigger = React.useCallback((anchor: React.RefObject<View | null>) => {
        setExamplesAnchor(null);
        setBoundWhen(undefined);
        setPopover({ anchor, row: null });
    }, []);
    const add = React.useCallback((anchor: React.RefObject<View | null>) => {
        if (exampleSession === undefined) { openBlankTrigger(anchor); return; }
        setExamplesAnchor(anchor);
    }, [exampleSession, openBlankTrigger]);
    return (
        <>
            <SessionTriggersSectionView
                groups={groups}
                status={lastRuns.failed ? 'failed' : read.status}
                pullRequestLinksUnavailable={!Array.isArray(read.pullRequestLinks) && read.pullRequestLinks.status === 'unavailable'}
                pendingKeys={pendingKeys}
                onToggle={toggle}
                onOpen={openRow}
                onAdd={add}
                onRetry={retry}
                onHistory={openHistory}
                historyRowKey={historyRowKey}
                history={history}
                addAnchorRef={addAnchorRef}
                {...(typeof params.trigger === 'string' ? { deepLinkAutomationId: params.trigger } : {})}
            />
            {examplesAnchor !== null && exampleSession !== undefined ? (
                <WorkflowExamplesPopover
                    testID="session-work-trigger-examples"
                    anchorRef={examplesAnchor}
                    session={exampleSession}
                    onRequestClose={() => setExamplesAnchor(null)}
                    footer={<ActionListSection separatorAbove actions={[{
                        id: 'new-trigger',
                        testID: 'session-work-trigger-examples-new',
                        label: t('workflows.triggers.popover.newTrigger'),
                        icon: <Icon name="plus" size={16} color={theme.colors.text.secondary} />,
                        onPress: () => openBlankTrigger(examplesAnchor),
                    }]} />}
                />
            ) : null}
            {popover !== null && (row === null || initial !== null) ? (
                <TriggerPopover
                    testID="session-work-trigger-popover"
                    anchorRef={popover.anchor}
                    onRequestClose={close}
                    whenKinds={[...SESSION_TRIGGER_WHEN_KINDS, 'pluginEvent']}
                    unavailableKinds={Object.fromEntries(Object.entries(SESSION_UNAVAILABLE_KINDS).map(([kind, key]) => [kind, t(key)]))}
                    sessionId={props.sessionId}
                    {...(Array.isArray(read.pullRequestLinks) ? { pullRequestLinks: read.pullRequestLinks } : {})}
                    initial={initial}
                    {...(row === null && boundWhen !== undefined ? { initialWhen: boundWhen } : {})}
                    workflowOptions={thenOptions.workflowOptions}
                    onSubmit={async (value, write) => {
                        if (write.target === null || write.trigger === null) return;
                        if (row === null) {
                            await read.add({ target: write.target, trigger: write.trigger, inputs: write.inputs });
                            return;
                        }
                        const { enabled: _enabled, ...definition } = write.trigger;
                        await read.update({
                            triggerId: row.triggerId,
                            expectedRevision: row.revision,
                            patch: { target: write.target, trigger: definition, enabled: value.enabled, inputs: write.inputs },
                        });
                    }}
                    machineId={read.machineId}
                    {...(row !== null && initial?.when.kind === 'pluginEvent' ? { eventEdit: { automationId: row.automationId, triggerId: row.triggerId } } : {})}
                    {...(row === null ? {} : {
                        onSaveAsWorkflow: (target: TriggerTargetV1) => openTriggerAsWorkflow(target, {
                            scope: 'session', sessionId: props.sessionId, triggerId: row.triggerId, expectedRevision: row.revision,
                        }),
                        onDelete: async () => { await read.remove(row.triggerId); },
                        onRunNow: async () => { await runNow(row); },
                        onHistory: () => { openHistory(row); close(); },
                    })}
                />
            ) : null}
        </>
    );
}
