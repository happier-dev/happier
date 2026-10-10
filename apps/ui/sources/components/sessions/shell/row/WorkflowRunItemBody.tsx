import * as React from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { describeWorkflowRunState, isTerminalWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { normalizeResultPreview } from '@/components/workflows/presentation/resultPreview';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { getStorage, useWorkflowRun } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishOpenedWorkflowRunDetail } from '@/sync/engine/workflows/refreshWorkflowRun';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';

import type { SessionListRowDensity } from '../resolveSessionListDensityViewState';
import { SESSION_LIST_SHEET_INSET_PX } from '../sessionListStyles';
import { SessionListRowPresentation, SessionListRowSubtitle, SessionListRowTitle } from './SessionListRowPresentation';

export type WorkflowRunItemProps = Readonly<{
    kind: 'workflow_run';
    runId: string;
    serverId: string;
    dataActive?: boolean;
    density?: SessionListRowDensity;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
    folderDepth?: number;
    reportsDepth?: number;
    /** Opened habit History only; collection/trigger summary rows never request result bodies. */
    includeResult?: boolean;
    /** Work-pane configuration rows use the same Item anatomy as Triggers. */
    presentation?: 'list' | 'work';
}>;

const styles = StyleSheet.create((theme) => ({
    sheet: { marginHorizontal: SESSION_LIST_SHEET_INSET_PX },
    tail: { marginBottom: 12 },
    context: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    guide: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
}));

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

/** The Run arm of SessionItem: the same sheet anatomy, with an exact, demand-bound reader. */
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
            row: inScope ? live ?? getStorage().getState().workflowRunsById[props.runId] ?? null : null };
    }
    // A hidden surface retains its body, never another Account's body.
    const row = inScope && retained.current.scopeKey === scopeKey ? retained.current.row : null;
    const summary = row?.summary;
    const resultEnabled = props.includeResult === true && dataActive && summary != null
        && isTerminalWorkflowRunState(summary.state);
    const result = useOpenedWorkflowRunResult({ runId: props.runId, scopeKey, enabled: resultEnabled, row });
    if (!summary) return null;
    const density = props.density ?? 'default';
    const name = formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(row.metadata));
    const lifecycle = describeWorkflowRunState(summary.state);
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: {
        state: summary.state, word: lifecycle.label, inAttentionWindow: summary.attentionRequired === true,
    } });
    const word = summary.attentionRequired === true && status.tone === 'attention'
        ? t('workStatus.buckets.needs_you') : status.word;
    const context = describeWorkflowRunProgress(summary.stepProgress);
    const resultLine = !resultEnabled ? null : result.text
        ?? t(result.status === 'failed' ? 'workflows.contentUnavailable'
            : result.status === 'pending' ? 'common.loading' : 'workflows.finalOutput.none');
    const starterLabel = summary.startedBy === 'trigger' ? t('workflows.list.startedByTrigger')
        : summary.startedBy === 'agent' ? t('workflows.list.startedByAgent') : null;
    const depth = (props.folderDepth ?? 0) + (props.reportsDepth ?? 0);
    if (props.presentation === 'work') return (
        <Item testID={`workflow-run-row:${props.runId}`}
            title={name} subtitle={[resultLine ?? context, starterLabel].filter(Boolean).join(' · ')}
            icon={<Icon name="tree-structure" />}
            rightElement={<View style={styles.status}>
                {lifecycle.marker.kind === 'activity'
                    ? <ActivitySpinner size={ICON_SIZE.xs} animationEnabled={dataActive} color={workStatusGlyphColor(theme.colors, status.tone)} />
                    : null}
                <SessionListRowSubtitle density={density} textScale={fontScale} style={workStatusWordStyle(status.tone)}>{word}</SessionListRowSubtitle>
            </View>}
            showChevron={false}
            accessibilityLabel={[name, word, context, starterLabel].filter(Boolean).join('. ')}
            onPress={() => router.push(createWorkflowRunRoute(props.runId) as never)} />
    );
    return <View style={[styles.sheet, props.isLast || props.isSingle ? styles.tail : null,
        depth > 0 ? { paddingLeft: depth * 12 } : null]}>
        <View style={depth > 0 ? styles.guide : null}>
            <SessionListRowPresentation density={density} textScale={fontScale} first={props.isFirst || props.isSingle}
                last={props.isLast || props.isSingle} selected={props.selected} separator={!props.isLast && !props.isSingle}
                statusTone={status.tone}
                identity={<Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={<SessionListRowTitle density={density} textScale={fontScale} emphasized={props.selected}>{name}</SessionListRowTitle>}
                trailing={<View style={styles.status}>
                    {lifecycle.marker.kind === 'activity'
                        ? <ActivitySpinner size={ICON_SIZE.xs} animationEnabled={dataActive} color={workStatusGlyphColor(theme.colors, status.tone)} />
                        : <Icon name={lifecycle.marker.icon} size={ICON_SIZE.xs} color={workStatusGlyphColor(theme.colors, status.tone)} />}
                    <SessionListRowSubtitle density={density} textScale={fontScale} style={workStatusWordStyle(status.tone)}>{word}</SessionListRowSubtitle>
                </View>}
                renderContainer={(content, style) => <WorkspaceDestinationRow href={createWorkflowRunRoute(props.runId)}>
                    <Pressable style={style} testID={`workflow-run-row:${props.runId}`}
                    accessibilityRole="button" accessibilityState={{ selected: props.selected === true }}
                    accessibilityLabel={[name, word, context, starterLabel].filter(Boolean).join('. ')}
                    onPress={() => router.push(createWorkflowRunRoute(props.runId) as never)}>{content}</Pressable>
                </WorkspaceDestinationRow>}>
                {context || starterLabel || resultLine !== null ? <View style={styles.context}>
                    {summary.startedBy === 'trigger' || summary.startedBy === 'agent'
                        ? <Icon name={summary.startedBy === 'trigger' ? 'lightning' : 'robot'} size={ICON_SIZE.xs}
                            color={theme.colors.text.tertiary} /> : null}
                    {resultLine !== null || context ? <SessionListRowSubtitle density={density} textScale={fontScale}>
                        {resultLine ?? context}</SessionListRowSubtitle> : null}
                    {resultEnabled && result.status === 'failed' ? <ToolbarButton
                        testID={`workflow-run-result:${props.runId}:retry`} label={t('workflows.retry')}
                        onPress={event => { event.stopPropagation(); result.retry(); }} /> : null}
                </View> : null}
            </SessionListRowPresentation>
        </View>
    </View>;
}
