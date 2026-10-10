import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_WORK_PANE_METRICS, HappierPressable, HappierWorkSummary } from '@happier-dev/plugin-ui/presentation';
import { WorkRowShell, WORK_ROW_TEXT_INSET } from '@/components/sessions/work/WorkItemRow';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { ExecutionRunAgentMark } from '@/components/sessions/runs/ExecutionRunAgentMark';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionListRowSubtitle } from '@/components/sessions/shell/row/SessionListRowPresentation';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActiveServerAccountScope, useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionAvatarId, getSessionName } from '@/utils/sessions/sessionUtils';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, formatTriggerSummary, readNextScheduledRunRefreshAtMs } from './formatTriggerSummary';
import { resolveTriggerEventGroup } from './triggerEventGroups';
import { describeTriggerTarget } from './sessionTriggerGroups';
import { useTriggerThenOptions } from './useTriggerThenOptions';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';
import { projectScheduledWorkflowRows } from './scheduledWorkflowRows';
import type { ScheduledWorkflowRow } from './scheduledWorkflowRows';

const ACCOUNT_SCHEDULES = { scope: 'account_all' } as const;

/**
 * Account upcoming work and Session destinations share one trigger projection/read. A host that must
 * know whether anything is scheduled before it draws its own heading (the Session's "Writes here")
 * reads it here and hands the result to `ScheduledWorkflowRows`.
 */
export function useScheduledWorkflowRows(sessionId?: string) {
    const scope = useActiveServerAccountScope();
    const access = useWorkflowsDestinationAccess();
    const available = access.kind === 'workflows' || access.kind === 'triggersOnly';
    const read = useWorkflowTriggerSets(scope && available ? ACCOUNT_SCHEDULES : null);
    const previous = React.useRef<readonly ScheduledWorkflowRow[]>([]);
    const rows = React.useMemo(() => {
        const known = new Map(previous.current.map(row => [row.key, row]));
        previous.current = projectScheduledWorkflowRows(read.sets, sessionId).map(row => {
            const old = known.get(row.key);
            return old?.set === row.set && old.trigger === row.trigger ? old : row;
        });
        return previous.current;
    }, [read.sets, sessionId]);
    return { available, rows, status: read.status, retry: read.retry, serverId: scope?.serverId ?? null };
}

export type ScheduledWorkflowRowsRead = ReturnType<typeof useScheduledWorkflowRows>;

/** The scheduled rows of one read, then its loading or failure line. Mounted only where rows may show. */
export const ScheduledWorkflowRows = React.memo(function ScheduledWorkflowRows(props: Readonly<{
    read: ScheduledWorkflowRowsRead; sessionId?: string;
}>) {
    const { read } = props;
    const titles = useTriggerThenOptions({ libraryEnabled: read.available });
    const router = useRouter();
    const serverId = read.serverId;
    const open = React.useCallback((row: ScheduledWorkflowRow) => {
        // An upcoming occurrence has no admitted Run id. Open its existing trigger
        // editor, never infer an id or execute work from a navigation gesture.
        const set = row.set;
        if (set.scopeSessionId) router.push({ pathname: '/session/[id]/triggers',
            params: { id: set.scopeSessionId, trigger: set.automationId, ...(serverId ? { serverId } : {}) } } as never);
        else if (set.target?.kind === 'workflow') router.push({ pathname: '/workflows/[id]',
            params: { id: set.target.ref, intent: 'schedule' } } as never);
        else router.push({ pathname: '/workflows', params: { trigger: set.automationId } } as never);
    }, [router, serverId]);
    return <>
        <ScheduledWorkflowSectionView rows={read.rows} onOpen={open} resolveWorkflowTitle={titles.resolveWorkflowTitle}
            sessionId={props.sessionId} />
        {read.status !== 'ready' ? <SurfaceFreshnessLine testID="scheduled-workflow-read" tone={read.status === 'failed' ? 'warning' : 'neutral'}
            reason={t(read.status === 'failed'
                ? props.sessionId === undefined ? 'workflows.triggers.section.accountLoadFailed' : 'workflows.triggers.section.loadFailed'
                : 'common.loading')}
            {...(read.status === 'failed' ? { action: { label: t('workflows.retry'), onPress: read.retry } } : {})} /> : null}
    </>;
});

/** The Account's upcoming scheduled work, as its own Work section. */
export const ScheduledWorkflowSection = React.memo(function ScheduledWorkflowSection() {
    const read = useScheduledWorkflowRows();
    if (!read.available || (read.rows.length === 0 && read.status === 'ready')) return null;
    return <WorkSection testID="workflows-column:group:scheduled"
        title={t('sessionWork.scheduled.title')} count={read.rows.length}><ScheduledWorkflowRows read={read} /></WorkSection>;
});

export const ScheduledWorkflowSectionView = React.memo(function ScheduledWorkflowSectionView(props: Readonly<{
    rows: readonly ScheduledWorkflowRow[]; onOpen: (row: ScheduledWorkflowRow) => void;
    resolveWorkflowTitle?: (ref: string) => string | null; sessionId?: string;
}>) {
    return <>{props.rows.map(row => <ScheduledRow key={row.key} row={row} onOpen={props.onOpen}
        resolveWorkflowTitle={props.resolveWorkflowTitle} sessionId={props.sessionId} />)}</>;
});

const ScheduledRow = React.memo(function ScheduledRow(props: Readonly<{
    row: ScheduledWorkflowRow; onOpen: (row: ScheduledWorkflowRow) => void;
    resolveWorkflowTitle?: (ref: string) => string | null; sessionId?: string;
}>) {
    const { row } = props;
    const theme = useWorkTheme();
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(row.trigger.nextRunAt, nowMs),
        [row.trigger.nextRunAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, row.trigger.nextRunAt !== null);
    const title = describeTriggerTarget(row.set.target, props.resolveWorkflowTitle ?? (() => null));
    const statusLabel = formatNextScheduledRun(row.trigger.nextRunAt, row.set.enabled && row.trigger.enabled, nowMs);
    const authoredLeaves = row.set.target?.kind === 'inline'
        ? new Map(walkWorkflowBlocks(row.set.target.definition.blocks).map(block => [block.id, block])) : null;
    const steps = row.set.destinations?.leaves.flatMap(leaf => {
        if (leaf.ordinal === undefined || (props.sessionId !== undefined && !leaf.sessionIds.includes(props.sessionId))) return [];
        const stepTitle = leaf.name?.trim() || (leaf.sourceKey === '$root' && authoredLeaves?.has(leaf.blockId)
            ? workflowBlockReferenceLabel(authoredLeaves.get(leaf.blockId)!)
            : t('message.provenanceWorkflow'));
        return stepTitle === title.trim() ? [] : [t('sessionWork.scheduled.step', { ordinal: leaf.ordinal, title: stepTitle })];
    }) ?? [];
    const facts = [statusLabel, ...steps, formatTriggerSummary(row.trigger)];
    const label = [title, ...facts, formatNextScheduledRunAccessibilityLabel(row.trigger.nextRunAt)].join('. ');
    if (props.sessionId !== undefined) return <Item testID={`scheduled-workflow:${row.key}`}
        title={title} subtitle={facts.join(' · ')}
        icon={<Icon name={resolveTriggerEventGroup(row.trigger).glyph} />}
        accessibilityLabel={label} showChevron={false} onPress={() => props.onOpen(row)} />;
    const summary = <HappierWorkSummary testID={`scheduled-workflow:${row.key}-summary`} title={title}
        phase="finished" facts={facts} accessibilityLabel={label} theme={theme} host={WORK_HOST}
        mark={<ExecutionRunAgentMark agentId={null} iconName={resolveTriggerEventGroup(row.trigger).glyph} size={30} />} />;
    return <View>
        <WorkRowShell testID={`scheduled-workflow:${row.key}`} accessibilityLabel={label} onPress={() => props.onOpen(row)}>
            {summary}
        </WorkRowShell>
        {props.sessionId === undefined && row.set.destinations?.targetSessionIds.length ? <View style={styles.destinations}>
            {row.set.destinations.targetSessionIds.map(sessionId => <DestinationChip key={sessionId} sessionId={sessionId} rowKey={row.key} />)}
        </View> : null}
    </View>;
});

const DestinationChip = React.memo(function DestinationChip(props: Readonly<{ sessionId: string; rowKey: string }>) {
    const session = useSessionDisplayNameSource(props.sessionId);
    const scope = useActiveServerAccountScope();
    const router = useRouter();
    const label = session ? getSessionName(session) : t('message.sessionReferenceUnavailable');
    return <HappierPressable testID={`scheduled-workflow:${props.rowKey}-destination:${props.sessionId}`}
        accessibilityRole="link" accessibilityLabel={label} style={styles.destination}
        onPress={() => router.push({ pathname: '/session/[id]', params: { id: props.sessionId,
            ...(scope ? { serverId: scope.serverId } : {}) } } as never)}>
        <Avatar id={session ? getSessionAvatarId(session, scope?.serverId) : props.sessionId} size={16} monochrome />
        <View style={styles.destinationLabel}><SessionListRowSubtitle density="compact">{label}</SessionListRowSubtitle></View>
    </HappierPressable>;
});

const styles = StyleSheet.create(theme => ({
    destination: { minHeight: resolveMinimumInteractiveTargetSize(Platform.OS), flexDirection: 'row', alignItems: 'center',
        gap: theme.margins.xs, maxWidth: '100%' },
    destinationLabel: { flexShrink: 1, minWidth: 0 },
    destinations: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.margins.xs,
        marginLeft: WORK_ROW_TEXT_INSET, marginRight: HAPPIER_WORK_PANE_METRICS.rowInsetPx, paddingBottom: theme.margins.xs },
}));
