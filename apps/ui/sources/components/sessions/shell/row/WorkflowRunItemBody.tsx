import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { normalizeResultPreview } from '@/components/workflows/presentation/resultPreview';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunDestinationProgress, describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { resolveWorkStatusRowMark } from '@/components/work/status/workStatusRowMark';
import { CollectionRequestPeek } from '@/components/ui/lists/collection/CollectionRequestPeek';
import type { CollectionRequestRef } from '@/components/ui/lists/collection/collectionRequestRef';
import { getStorage, useWorkflowRun, useUser } from '@/sync/domains/state/storage';
import { resolveEditedByLabel } from '@/components/workflows/run/workflowEditedBy';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { Item } from '@/components/ui/lists/Item';
import { WORKER_KIND_GLYPHS } from '@/components/sessions/work/workerKindGlyphs';
import { resolveSessionRowTitleColorRole, sessionRowTitleInk, type SessionListActiveColorModeV1 } from './sessionRowTitleColorRole';

import { resolveCollectionRowDensity, type SessionListRowDensity } from '../resolveSessionListDensityViewState';
import { SESSION_LIST_SHEET_INSET_PX } from '../sessionListStyles';
import { CollectionRowContent, CollectionRowLine, CollectionRowTitle, useTouchCompactRow } from '@/components/ui/lists/collection/CollectionRowContent';

export type WorkflowRunItemProps = Readonly<{
    kind: 'workflow_run';
    runId: string;
    serverId: string;
    dataActive?: boolean;
    density?: SessionListRowDensity;
    selected?: boolean;
    folderDepth?: number;
    reportsDepth?: number;
    /** Opened habit History only; collection/trigger summary rows never request result bodies. */
    includeResult?: boolean;
    /** The expanded History page resolves people once, never from an individual row. */
    sourceProfile?: Parameters<typeof resolveEditedByLabel>[0]['profile'];
    /** A row of Workflow History: the only place the viewer's own save reads "Edited by you". */
    inTriggerHistory?: boolean;
    /** Work-pane configuration rows use the same Item anatomy as Triggers. */
    presentation?: 'list' | 'work';
    /** Writes-here rows retain their destination, separately from the Run's origin. */
    destinationSessionId?: string;
    /** What names a Run whose own title cannot be read: the trigger or workflow it belongs to. */
    fallbackName?: string;
    /** The Account's `session.list.statusWords`: a one-line list row's state word beside its glyph. */
    statusWords?: boolean;
    /** The list's `sessionListActiveColorMode`, read once by the list for every row. */
    activeColorMode?: SessionListActiveColorModeV1;
}>;

const styles = StyleSheet.create((theme) => ({
    // The column's gutter: a Run row lies flat on the plane beside its Session siblings (lab `clflat`).
    row: { marginHorizontal: SESSION_LIST_SHEET_INSET_PX },
    context: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    status: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 1, minWidth: 0 },
    statusWord: { flexShrink: 1, minWidth: 0 },
    guide: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
}));

/** Only the age leaf observes the existing shared clock; hidden rows keep a frozen snapshot. */
function WorkflowRunRowAge(props: Readonly<{
    runId: string; timestamp: number; dataActive: boolean; density: SessionListRowDensity; readablePhone: boolean; textScale: number;
}>) {
    const frozenNow = React.useRef(Date.now());
    const age = useWorkRelativeTime(props.timestamp, props.dataActive ? undefined : frozenNow.current);
    return <CollectionRowLine testID={`workflow-run-row:${props.runId}:age`}
        density={resolveCollectionRowDensity(props.density)} touchCompact={props.readablePhone} textScale={props.textScale}>{age}</CollectionRowLine>;
}

/** Read status is local; the selected result and its producer remain in the Account's sole Run body. */
function useOpenedWorkflowRunResult(input: Readonly<{
    runId: string; scopeKey: string | null; enabled: boolean; row: WorkflowRunRow | null;
}>) {
    const identity = `${input.scopeKey ?? ''}\u0000${input.runId}`;
    const [attempt, setAttempt] = React.useState(0);
    const [read, setRead] = React.useState<Readonly<{ identity: string; status: 'pending' | 'loaded' | 'failed' }> | null>(null);
    const revision = input.row?.summary?.revision;
    React.useEffect(() => {
        if (!input.enabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || serverAccountScopeKeySuffix(lifetime.scope) !== input.scopeKey) return;
        let cancelled = false;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        setRead({ identity, status: 'pending' });
        void workflowRunDetailActions.getRun(input.runId, controller.signal).then(detail => {
            if (cancelled || !lifetime.isCurrent()) return;
            publishOpenedWorkflowRunDetail(detail);
            setRead({ identity, status: 'loaded' });
        }).catch(() => {
            if (!cancelled && lifetime.isCurrent()) setRead({ identity, status: 'failed' });
        });
        return () => { cancelled = true; controller.abort(); retirement.dispose(); };
    }, [attempt, identity, input.enabled, input.runId, input.scopeKey, revision]);
    const retry = React.useCallback(() => setAttempt(value => value + 1), []);
    const status = read?.identity === identity ? read.status : 'pending';
    const detail = input.row?.detail;
    const value = status === 'failed' ? undefined : detail?.result;
    // getRun's strict schema admits result and finalOutputInvocationId as one pair.
    const text = value === undefined ? null
        : normalizeResultPreview(typeof value === 'string' ? value : JSON.stringify(value)).display.replace(/\s+/gu, ' ').trim();
    return { status, text, retry };
}

/** The Run arm of SessionItem: the same flat row anatomy, with an exact, demand-bound reader. */
export function WorkflowRunItemBody(props: WorkflowRunItemProps): React.ReactElement | null {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { fontScale } = useWindowDimensions();
    const scope = getStorage()((state) => state.profileScope);
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const inScope = scope !== null && areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId);
    const dataActive = props.dataActive !== false && inScope;
    const live = useWorkflowRun(props.runId, { enabled: dataActive });
    const retained = React.useRef<Readonly<{ scopeKey: string | null; serverId: string; runId: string; row: WorkflowRunRow | null }> | null>(null);
    if (dataActive || retained.current === null || retained.current.scopeKey !== scopeKey
        || retained.current.serverId !== props.serverId || retained.current.runId !== props.runId) {
        retained.current = { scopeKey, serverId: props.serverId, runId: props.runId,
            row: inScope ? live ?? getStorage().getState().workflowRunsById[workflowRunStoreKey(props.runId)] ?? null : null };
    }
    // A hidden surface retains its body, never another Account's body.
    const row = inScope && retained.current.scopeKey === scopeKey ? retained.current.row : null;
    const summary = row?.summary;
    const cachedSourceProfile = useUser(summary?.sourceSavedBy?.kind === 'person' ? summary.sourceSavedBy.accountId : '');
    const editedBy = resolveEditedByLabel({ savedBy: summary?.sourceSavedBy, viewerAccountId: scope?.accountId,
        viewerOwnSave: props.inTriggerHistory === true ? 'you' : 'omit',
        profile: props.sourceProfile === undefined ? cachedSourceProfile : props.sourceProfile });
    const heldInvocationId = summary?.heldStep?.invocationId;
    const requestRef = React.useMemo<CollectionRequestRef | null>(() => heldInvocationId ? {
        kind: 'workflow_hold', serverId: props.serverId, runId: props.runId, invocationRecordId: heldInvocationId,
    } : null, [heldInvocationId, props.runId, props.serverId]);
    // The row reads the Machine's name and reachability only: a heartbeat that keeps presence re-renders nothing.
    const machinePresence = useMachinePresenceSummary(props.serverId, dataActive ? summary?.machineId ?? '' : '');
    const machineReachable = machinePresence.reachability === 'unknown' ? undefined : machinePresence.reachability === 'reachable';
    const machineName = machinePresence.name;
    const resultEnabled = props.includeResult === true && dataActive && summary != null
        && isTerminalWorkflowRunState(summary.state);
    const result = useOpenedWorkflowRunResult({ runId: props.runId, scopeKey, enabled: resultEnabled, row });
    const readablePhone = useTouchCompactRow(props.density === 'minimal');
    const [hovered, setHovered] = React.useState(false);
    if (!summary) return null;
    const density = props.density ?? 'default';
    const rowDensity = resolveCollectionRowDensity(density);
    // A Run is always named: its own title, else the trigger or workflow it belongs to. Why the title
    // could not be read is a quiet part of the line beneath, never the name.
    const displayName = resolveWorkflowRunDisplayName(row.metadata);
    const name = displayName.kind === 'name' ? displayName.value
        : props.fallbackName ?? formatWorkflowRunDisplayName({ kind: 'unknown' });
    const unreadable = displayName.kind === 'unavailable' ? formatWorkflowRunDisplayName(displayName) : null;
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(summary, { machineReachable, machineName }) });
    const word = status.word;
    const destinationProgress = props.destinationSessionId
        ? describeWorkflowRunDestinationProgress(summary.stepProgress, props.destinationSessionId) : [];
    const starterLabel = summary.startedBy === 'trigger' ? t('workflows.list.startedByTrigger')
        : summary.startedBy === 'agent' ? t('workflows.list.startedByAgent') : null;
    // A Writes-here row leads with the step that writes into this Session, then the Run's aggregate
    // progress; when the Run began is not what this row is for. Without a known destination step the
    // work row keeps its start time, so it never reads bare.
    const context = [...destinationProgress,
        props.presentation === 'work' && destinationProgress.length === 0 ? formatAsOfTime(Date.parse(summary.createdAt)) : null,
        describeWorkflowRunProgress(summary.stepProgress),
        props.presentation !== 'work' ? starterLabel : null, unreadable].filter(Boolean).join(' · ');
    const resultLine = !resultEnabled ? null : result.text
        ?? t(result.status === 'failed' ? 'workflows.contentUnavailable'
            : result.status === 'pending' ? 'common.loading' : 'workflows.finalOutput.none');
    const depth = (props.folderDepth ?? 0) + (props.reportsDepth ?? 0);
    // At the list's one-line density a Run reads as a Session row does (calm ruling 2026-11-01): its name, then
    // the calm row mark (or its age), the word only when the person asked for status words, the one decider
    // Session rows follow. Progress, origin, the word and an unreadable title stay in the spoken label and the
    // Run's page.
    const oneLine = rowDensity === 'compact';
    const showWord = !oneLine || props.statusWords === true;
    const rowMark = resolveWorkStatusRowMark(status);
    const contextLine = oneLine && resultLine === null ? null
        : [resultLine ?? (oneLine ? null : context || null), editedBy].filter(Boolean).join(' · ') || null;
    const statusContent = <View style={styles.status}>
        {props.presentation === 'work'
            ? <WorkStatusGlyph status={status} testIDSuffix={`workflow-run-${props.runId}`} animationEnabled={dataActive} />
            : <WorkStatusRowMark status={status} testIDSuffix={`workflow-run-${props.runId}`} animationEnabled={dataActive} />}
        {(props.presentation === 'work' || (showWord && (props.statusWords === true || status.bucket !== 'working' || status.tone !== 'neutral')))
            ? <CollectionRowLine density={rowDensity} touchCompact={readablePhone} textScale={fontScale}
                style={[styles.statusWord, workStatusWordStyle(status.tone)]}>{word}</CollectionRowLine> : null}
    </View>;
    const statusControl = requestRef ? <CollectionRequestPeek request={requestRef} presented={dataActive}
        description={name} testID={`workflow-run-request-peek:${props.runId}`}>{statusContent}</CollectionRequestPeek> : statusContent;
    if (props.presentation === 'work') return (
        <Item testID={`workflow-run-row:${props.runId}`}
            rowRole="item"
            title={name} subtitle={[resultLine ?? context, starterLabel, editedBy].filter(Boolean).join(' · ')}
            icon={<Icon name={WORKER_KIND_GLYPHS.workflow_run} />}
            rightElement={statusControl}
            rightElementOutsidePressable={requestRef !== null}
            showChevron={false}
            accessibilityLabel={[name, word, context, starterLabel, editedBy].filter(Boolean).join('. ')}
            onPress={() => router.push(createWorkflowRunRoute(props.runId, props.serverId) as never)} />
    );
    return <View testID={`workflow-run-sheet:${props.runId}`} style={[styles.row, depth > 0 ? { paddingLeft: depth * 12 } : null]}>
        <View style={depth > 0 ? styles.guide : null}>
            <CollectionRowContent density={rowDensity} touchCompact={readablePhone} textScale={fontScale}
                selected={props.selected} hovered={hovered}
                identity={<Icon name={WORKER_KIND_GLYPHS.workflow_run} size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                // A Run's title takes the ink a Session row in the same state takes: primary while it runs or
                // asks, quiet once it has stopped.
                title={<CollectionRowTitle density={rowDensity} touchCompact={readablePhone} textScale={fontScale}
                    emphasis={props.selected ? 'semiBold' : undefined} color={sessionRowTitleInk(theme.colors, resolveSessionRowTitleColorRole({
                        mode: props.activeColorMode ?? 'activityAndAttention', selected: props.selected === true,
                        isSessionActive: !isTerminalWorkflowRunState(summary.state), status,
                        titleTone: status.tone !== 'neutral' ? 'emphasized' : isTerminalWorkflowRunState(summary.state) ? 'quiet' : 'normal',
                    }))}>{name}</CollectionRowTitle>}
                trailingProps={{ testID: `workflow-run-row:${props.runId}:status` }}
                trailing={!requestRef && rowMark === 'none' && (summary.state === 'succeeded' || !(showWord && word)) ? <WorkflowRunRowAge
                    runId={props.runId} timestamp={Date.parse(summary.finishedAt ?? summary.updatedAt)}
                    dataActive={dataActive} density={density} readablePhone={readablePhone} textScale={fontScale} /> : statusControl}
                renderContainer={(content, style) => <WorkspaceDestinationRow href={createWorkflowRunRoute(props.runId, props.serverId)} style={style}>
                    <Pressable style={style} testID={`workflow-run-row:${props.runId}`}
                    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
                    accessibilityRole="button" accessibilityState={{ selected: props.selected === true }}
                    accessibilityLabel={[name, word, context, starterLabel, editedBy].filter(Boolean).join('. ')}
                    onPress={() => router.push(createWorkflowRunRoute(props.runId, props.serverId) as never)}>{content}</Pressable>
                </WorkspaceDestinationRow>}>
                {contextLine !== null || (!oneLine && starterLabel) ? <View style={styles.context}>
                    {!oneLine && (summary.startedBy === 'trigger' || summary.startedBy === 'agent')
                        ? <Icon name={summary.startedBy === 'trigger' ? 'lightning' : 'robot'} size={ICON_SIZE.xs}
                            color={theme.colors.text.tertiary} /> : null}
                    {contextLine !== null ? <CollectionRowLine density={rowDensity} touchCompact={readablePhone} textScale={fontScale}>
                        {contextLine}</CollectionRowLine> : null}
                    {resultEnabled && result.status === 'failed' ? <ToolbarButton
                        testID={`workflow-run-result:${props.runId}:retry`} label={t('workflows.retry')}
                        onPress={event => { event?.stopPropagation(); result.retry(); }} /> : null}
                </View> : null}
            </CollectionRowContent>
        </View>
    </View>;
}
