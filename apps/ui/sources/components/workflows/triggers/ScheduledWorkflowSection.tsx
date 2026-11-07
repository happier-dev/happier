import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { resolveSessionListGroupRowGeometry, SESSION_LIST_GROUP_ROW_PROPS, SessionListGroup, SessionListGroupMoreRow } from '@/components/sessions/shell/SessionListGroup';
import {
    resolveSessionListRowIdentityMetrics,
    type SessionListRowDensity,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { useIsTablet } from '@/utils/platform/responsive';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { SessionAvatar } from '@/components/sessions/bots/face/SessionAvatar';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { CollectionRowLine } from '@/components/ui/lists/collection/CollectionRowContent';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActiveServerAccountScope, useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatNextScheduledRun, formatNextScheduledRunAccessibilityLabel, formatNextScheduledRunTime, formatTriggerSummary, readNextScheduledRunRefreshAtMs } from './formatTriggerSummary';
import { resolveTriggerEventGroup } from './triggerEventGroups';
import { describeTriggerTarget } from './sessionTriggerGroups';
import { useWorkflowReferenceTitles } from '@/components/workflows/presentation/workflowReferenceOptions';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';
import { projectScheduledWorkflowRows } from './scheduledWorkflowRows';
import type { ScheduledWorkflowRow } from './scheduledWorkflowRows';

const ACCOUNT_SCHEDULES = { scope: 'account_all' } as const;

/**
 * Account upcoming work and Session destinations share one trigger projection/read. A host that must
 * know whether anything is scheduled before it draws its own heading (the Session's "Writes here")
 * reads it here and hands the result to `ScheduledWorkflowRows`.
 */
export function useScheduledWorkflowRows(sessionId?: string): {
    available: boolean;
    rows: readonly ScheduledWorkflowRow[];
    status: ReturnType<typeof useWorkflowTriggerSets>['status'];
    retry: ReturnType<typeof useWorkflowTriggerSets>['retry'];
    serverId: string | null;
} {
    const scope = useActiveServerAccountScope();
    const access = useWorkflowsDestinationAccess();
    const available = access.kind === 'workflows';
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

/**
 * The scheduled rows of one read. Its host owns the load state and recovery, so
 * Account upcoming work and Session Habits each present a failure exactly once.
 */
export const ScheduledWorkflowRows = React.memo(function ScheduledWorkflowRows(props: Readonly<{
    read: ScheduledWorkflowRowsRead; sessionId?: string;
    /** In the session list: the density of the session rows around the group. */
    density?: SessionListRowDensity;
}>) {
    const { read } = props;
    const refs = React.useMemo(() => read.rows.flatMap(row => row.set.target?.kind === 'workflow' ? [row.set.target.ref] : []), [read.rows]);
    const resolveWorkflowTitle = useWorkflowReferenceTitles(refs, read.available);
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
    return <ScheduledWorkflowSectionView rows={read.rows} onOpen={open} resolveWorkflowTitle={resolveWorkflowTitle}
        sessionId={props.sessionId} density={props.density} />;
});

const ScheduledWorkflowReadFailure = React.memo(function ScheduledWorkflowReadFailure(props: Readonly<{
    read: ScheduledWorkflowRowsRead;
}>) {
    if (props.read.status !== 'failed') return null;
    return <SurfaceFreshnessLine testID="scheduled-workflow-read" tone="warning"
        reason={t('workflows.triggers.section.accountLoadFailed')}
        action={{ label: t('workflows.retry'), onPress: props.read.retry }} />;
});

/** The Account's upcoming scheduled work, as a group of the session list. */
export const ScheduledWorkflowSection = React.memo(function ScheduledWorkflowSection(props: Readonly<{
    density?: SessionListRowDensity;
}>) {
    return <ScheduledWorkflowGroup read={useScheduledWorkflowRows()} density={props.density} />;
});

/**
 * Drawn only once it has rows or a failure to say: the group may not exist, so a read in flight holds
 * no placeholder that would later collapse and move every session row under it.
 */
export const ScheduledWorkflowGroup = React.memo(function ScheduledWorkflowGroup(props: Readonly<{
    read: ScheduledWorkflowRowsRead; density?: SessionListRowDensity;
}>) {
    const { read } = props;
    const [expanded, setExpanded] = React.useState(false);
    // Upcoming work is a glance, not a list to live in: the next few lead and the rest are one press away,
    // so a busy Account's schedules never push its sessions off the screen. The header still counts them all.
    const hidden = expanded ? 0 : Math.max(0, read.rows.length - COLLAPSED_SCHEDULE_ROWS);
    const shown = React.useMemo(
        () => (hidden > 0 ? { ...read, rows: read.rows.slice(0, COLLAPSED_SCHEDULE_ROWS) } : read),
        [hidden, read],
    );
    if (!read.available || (read.rows.length === 0 && read.status !== 'failed')) return null;
    return <SessionListGroup testID="workflows-column:group:scheduled" countTestID="workflows-column:group:scheduled-count"
        title={t('sessionWork.scheduled.title')} count={read.rows.length}
        footer={<ScheduledWorkflowReadFailure read={read} />}>
        {read.rows.length > 0 ? <ScheduledWorkflowRows read={shown} density={props.density ?? 'default'} /> : null}
        {hidden > 0 ? <SessionListGroupMoreRow testID="workflows-column:group:scheduled-more" title={t('sessionWork.showMore', { count: hidden })}
            density={props.density ?? 'default'} onPress={() => setExpanded(true)} /> : null}
    </SessionListGroup>;
});

/** How many upcoming schedules the session list shows before "Show N more". */
const COLLAPSED_SCHEDULE_ROWS = 3;

export const ScheduledWorkflowSectionView = React.memo(function ScheduledWorkflowSectionView(props: Readonly<{
    rows: readonly ScheduledWorkflowRow[]; onOpen: (row: ScheduledWorkflowRow) => void;
    resolveWorkflowTitle?: (ref: string) => string | null; sessionId?: string; density?: SessionListRowDensity;
}>) {
    return <>{props.rows.map(row => <ScheduledRow key={row.key} row={row} onOpen={props.onOpen}
        resolveWorkflowTitle={props.resolveWorkflowTitle} sessionId={props.sessionId} density={props.density} />)}</>;
});

const ScheduledRow = React.memo(function ScheduledRow(props: Readonly<{
    row: ScheduledWorkflowRow; onOpen: (row: ScheduledWorkflowRow) => void;
    resolveWorkflowTitle?: (ref: string) => string | null; sessionId?: string; density?: SessionListRowDensity;
}>) {
    const { row } = props;
    const readNextRefresh = React.useCallback((nowMs: number) => readNextScheduledRunRefreshAtMs(row.trigger.nextRunAt, nowMs),
        [row.trigger.nextRunAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, row.trigger.nextRunAt !== null);
    const title = describeTriggerTarget(row.set.target, props.resolveWorkflowTitle ?? (() => null));
    const enabled = row.set.enabled && row.trigger.enabled;
    const authoredLeaves = row.set.target?.kind === 'inline'
        ? new Map(walkWorkflowBlocks(row.set.target.definition.blocks).map(block => [block.id, block])) : null;
    const steps = row.set.destinations?.leaves.flatMap(leaf => {
        if (leaf.ordinal === undefined || (props.sessionId !== undefined && !leaf.sessionIds.includes(props.sessionId))) return [];
        const stepTitle = leaf.name?.trim() || (leaf.sourceKey === '$root' && authoredLeaves?.has(leaf.blockId)
            ? workflowBlockReferenceLabel(authoredLeaves.get(leaf.blockId)!)
            : t('message.provenanceWorkflow'));
        return stepTitle === title.trim() ? [] : [t('sessionWork.scheduled.step', { ordinal: leaf.ordinal, title: stepTitle })];
    }) ?? [];
    const label = [title, formatNextScheduledRun(row.trigger.nextRunAt, enabled, nowMs), ...steps, formatTriggerSummary(row.trigger),
        formatNextScheduledRunAccessibilityLabel(row.trigger.nextRunAt, enabled, nowMs)].join('. ');
    // One occurrence row for both hosts. The next run is the trailing meta, in the column where Runs
    // show their state word; the quiet line says which step writes where and on what schedule.
    // In a Session's "Writes here" the row sits beside the Runs that already write there, so it leads
    // with the workflow mark (lab lane12-final `b-habit T`); in the session list every row is
    // scheduled, so the event glyph tells a schedule from an event, and the destinations follow.
    const destinations = props.sessionId === undefined ? row.set.destinations?.targetSessionIds ?? [] : [];
    const listDensity = props.sessionId === undefined ? props.density : undefined;
    // In the session list the row takes the density, mark slot and title size of the session rows around
    // it, and its trailing time never outweighs the title it qualifies.
    // The same row geometry as the group's other rows (Drafts), so a phone draws them at its readable size.
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const listRow = listDensity ? (() => {
        const geometry = resolveSessionListGroupRowGeometry(listDensity, { isTablet, windowWidth });
        const identity = resolveSessionListRowIdentityMetrics({ density: listDensity, readableNativePhoneMinimal: geometry.readableNativePhoneMinimal });
        return { density: geometry.itemDensity, iconBoxSize: identity.slotSize,
            titleStyle: geometry.titleTextMetrics, detailStyle: geometry.titleTextMetrics,
            // One line in the compact list, like the Session rows around it.
            ...(listDensity === 'minimal' ? { titleLines: 1 } : {}),
            pressableStyle: SESSION_LIST_GROUP_ROW_PROPS.pressableStyle,
            style: [SESSION_LIST_GROUP_ROW_PROPS.style, { minHeight: geometry.densityViewState.rowHeight }] };
    })() : {};
    const quiet = [...steps, formatTriggerSummary(row.trigger)].join(' · ');
    // A compact list row is one line (lab `clfamily`: "Morning brief · Mon 9:00"); its schedule, steps and
    // destinations stay in its name for assistive technology and on the page it opens.
    const oneLine = listDensity === 'minimal';
    return <Item testID={`scheduled-workflow:${row.key}`}
        title={title}
        // The destinations are the quiet line's second line, on the text edge.
        subtitle={oneLine ? undefined : destinations.length > 0 ? <>{quiet}<View style={styles.destinations}>
            {destinations.map(sessionId => <DestinationChip key={sessionId} sessionId={sessionId} rowKey={row.key} />)}
        </View></> : quiet}
        subtitleTestID={oneLine ? undefined : `scheduled-workflow:${row.key}-subtitle`}
        detail={formatNextScheduledRunTime(row.trigger.nextRunAt, enabled, nowMs)}
        detailTestID={`scheduled-workflow:${row.key}-next`}
        icon={<Icon name={props.sessionId !== undefined ? WORKER_KIND_GLYPHS.workflow_run : resolveTriggerEventGroup(row.trigger).glyph} />}
        {...listRow}
        accessibilityLabel={label} showChevron={false} onPress={() => props.onOpen(row)} />;
});

const DestinationChip = React.memo(function DestinationChip(props: Readonly<{ sessionId: string; rowKey: string }>) {
    const scope = useActiveServerAccountScope();
    const source = useSessionDisplayNameSource(props.sessionId, scope?.serverId);
    const isSessionVisible = useSessionRecordingVisibility();
    const session = isSessionVisible({ sessionId: props.sessionId, serverId: scope?.serverId }) ? source : null;
    const router = useRouter();
    const label = session ? getSessionName(session, scope?.serverId) : t('message.sessionReferenceUnavailable');
    return <HappierPressable testID={`scheduled-workflow:${props.rowKey}-destination:${props.sessionId}`}
        accessibilityRole="link" accessibilityLabel={label} style={styles.destination}
        onPress={() => router.push({ pathname: '/session/[id]', params: { id: props.sessionId,
            ...(scope ? { serverId: scope.serverId } : {}) } } as never)}>
        {session ? <SessionAvatar session={session} serverId={scope?.serverId} size={16} monochrome />
            : <Avatar id={props.sessionId} size={16} monochrome />}
        <View style={styles.destinationLabel}><CollectionRowLine density="comfortable">{label}</CollectionRowLine></View>
    </HappierPressable>;
});

const styles = StyleSheet.create(theme => ({
    // The quiet line keeps its own height under every pointer; a finger reaches past it through the hit area.
    destination: { flexDirection: 'row', alignItems: 'center',
        gap: theme.space.s4, maxWidth: '100%' },
    destinationLabel: { flexShrink: 1, minWidth: 0 },
    destinations: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s12, marginTop: theme.space.s4 },
}));
