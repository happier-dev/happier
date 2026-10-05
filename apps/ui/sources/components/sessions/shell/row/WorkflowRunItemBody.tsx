import * as React from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { workStatusGlyphColor, workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { getStorage, useWorkflowRun } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import type { WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';

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
}>;

const styles = StyleSheet.create((theme) => ({
    sheet: { marginHorizontal: SESSION_LIST_SHEET_INSET_PX },
    tail: { marginBottom: 12 },
    context: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    status: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    guide: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border.default },
}));

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
    const starterLabel = summary.startedBy === 'trigger' ? t('workflows.list.startedByTrigger')
        : summary.startedBy === 'agent' ? t('workflows.list.startedByAgent') : null;
    const depth = (props.folderDepth ?? 0) + (props.reportsDepth ?? 0);
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
                {context || starterLabel ? <View style={styles.context}>
                    {summary.startedBy === 'trigger' || summary.startedBy === 'agent'
                        ? <Icon name={summary.startedBy === 'trigger' ? 'lightning' : 'robot'} size={ICON_SIZE.xs}
                            color={theme.colors.text.tertiary} /> : null}
                    {context ? <SessionListRowSubtitle density={density} textScale={fontScale}>{context}</SessionListRowSubtitle> : null}
                </View> : null}
            </SessionListRowPresentation>
        </View>
    </View>;
}
