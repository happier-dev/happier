import * as React from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import type { DetailsSurfaceRendererV1, DetailsSurfaceRenderInputV1 } from '@/components/appShell/panes/details/surfaces';
import { DetailsSurfaceFallback } from '@/components/appShell/panes/details/surfaces/DetailsSurfaceFallback';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { resolveAgentInputColumn } from '@/components/sessions/agentInput/layout/agentInputColumn';
import { ContextualStartLead } from '@/components/sessions/authoring/ContextualStartLead';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WorkflowRunPeekDetailsView } from '@/components/sessions/work/WorkflowRunPeekDetailsView';
import { isWorkflowRunPeekDetailsResource } from '@/components/sessions/work/createWorkflowRunPeekDetailsTab';
import { getWorkflowDefinition } from '@/sync/domains/workflows/workflowDefinitionActions';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t, tLoose } from '@/text';
import { affectsSelectedWorkflowDefinition, useWorkflowPluginSource } from '../library/workflowLibraryReads';
import { WorkflowAccountLifetimeProvider } from '../workflowAccountScope';
import { WorkflowRunComposer } from './WorkflowRunComposer';
import { useWorkflowComposerStart } from './useWorkflowComposerStart';
import type { WorkflowStartSelection } from './WorkflowStartPicker';
import { isWorkflowStartResource, type WorkflowStartSource } from './workflowStartDetailsModel';

export { createWorkflowStartDetailsTab, isWorkflowStartResource,
    type WorkflowStartSource, type WorkflowStartResource } from './workflowStartDetailsModel';

type StartParams = Parameters<typeof useWorkflowComposerStart>[0];

/** Only the selected definition is demanded; list headers and admission retain their existing owners. */
function useSelectedDefinition(source: WorkflowStartSource, accountLifetime: StartParams['accountLifetime']) {
    const plugin = useWorkflowPluginSource(source.kind === 'catalog' && !source.workflow.startsWith('builtin:') ? source.workflow : null,
        true, accountLifetime);
    const builtin = source.kind === 'catalog' ? BUILTIN_WORKFLOW_CATALOG_V1.find(entry => entry.id === source.workflow) : undefined;
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const requestKey = JSON.stringify([source, attempt]);
    const [read, setRead] = React.useState<Readonly<{ key: string; selection: WorkflowStartSelection | null; failed: boolean }> | null>(null);
    const readNotCurrent = React.useRef(true);
    readNotCurrent.current = read?.key !== requestKey || read.failed;
    React.useEffect(() => {
        if (source.kind !== 'saved' || !accountLifetime?.isCurrent()) return;
        return subscribeHomeAccountChange(event => {
            if (affectsSelectedWorkflowDefinition(event, accountLifetime, source.definitionId)) retry();
        }, { reconnect: { readNotCurrent: () => readNotCurrent.current } });
    }, [accountLifetime, source]);
    React.useEffect(() => {
        if (source.kind !== 'saved' || !accountLifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        void getWorkflowDefinition({ definitionId: source.definitionId, signal: controller.signal, accountLifetime }).then(result => {
            if (controller.signal.aborted) return;
            const selection: WorkflowStartSelection = { id: result.definitionId, name: result.metadata.title,
                description: result.metadata.description ?? '', definition: result.definition,
                source: { ...source, revision: result.revision } };
            setRead(current => ({ key: requestKey, failed: false,
                selection: JSON.stringify(current?.selection) === JSON.stringify(selection) ? current!.selection : selection }));
        }).catch(() => {
            if (!controller.signal.aborted) setRead({ key: requestKey, selection: null, failed: true });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [accountLifetime, requestKey, source]);
    const selection = React.useMemo<WorkflowStartSelection | null>(() => {
        if (builtin) return { id: builtin.id, name: tLoose(builtin.titleKey), description: tLoose(builtin.descriptionKey),
            definition: builtin.definition, source };
        if (source.kind === 'catalog' && plugin.source) return { id: plugin.source.workflow, name: plugin.source.title,
            description: plugin.source.description ?? '', definition: plugin.source.definition,
            source: { kind: 'catalog', workflow: plugin.source.workflow, pluginVersion: plugin.source.version } };
        return read?.key === requestKey ? read.selection : null;
    }, [builtin, plugin.source, read, requestKey, source]);
    return { selection, failed: source.kind === 'saved' ? read?.key === requestKey && read.failed
        : !builtin && (plugin.status === 'failed' || plugin.status === 'missing'),
    retry: source.kind === 'saved' ? retry : plugin.retry };
}

/** The mounted Start acquires its review from the Account-scoped admission owner and current origin adapter. */
export function WorkflowStartDetailsBody(props: StartParams & Readonly<{
    source: WorkflowStartSource;
    retainedDraft?: string;
    children?: React.ReactNode;
}>) {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = props.accountLifetime === undefined ? activeLifetime : props.accountLifetime;
    const sessionOrigin = props.originSession ? { serverId: props.originSession.serverId ?? lifetime?.scope.serverId,
        sessionId: props.originSession.sessionId } : null;
    const intentKey = JSON.stringify(['workflowStart', props.source, props.intentKey ?? sessionOrigin ?? props.origin ?? null]);
    return <WorkflowStartDetailsBodyForAccount {...props} accountLifetime={lifetime} intentKey={intentKey}
        key={JSON.stringify([lifetime?.scope.serverId, lifetime?.scope.accountId, intentKey])} />;
}

function WorkflowStartDetailsBodyForAccount(props: StartParams & Readonly<{
    source: WorkflowStartSource;
    retainedDraft?: string;
    children?: React.ReactNode;
}>) {
    const lifetime = props.accountLifetime ?? null;
    const read = useSelectedDefinition(props.source, lifetime);
    const start = useWorkflowComposerStart(props);
    const startRef = React.useRef(start.start);
    startRef.current = start.start;
    const selected = React.useRef<WorkflowStartSelection | null>(null);
    React.useEffect(() => {
        if (!read.selection || props.project === null || selected.current === read.selection) return;
        if (startRef.current(read.selection, { retainedDraft: props.retainedDraft, reuseInputs: true })) selected.current = read.selection;
    }, [props.project, props.retainedDraft, read.selection, start.composerProps?.pending,
        start.composerProps?.reconciling, start.composerProps?.retainedRequest]);
    const { theme } = useUnistyles();
    // The lead shares the composer's own column, so its title, the Where line and the card keep one edge.
    // The pane and the phone sheet hold it at the composer-area inset at every width (lab flWork `start`/`startP`).
    const column = resolveAgentInputColumn({ screenWidth: useWindowDimensions().width, contentPaddingHorizontal: COMPOSER_CONTENT_HORIZONTAL_INSET });
    const columnStyle = [styles.column, { paddingHorizontal: column.paddingHorizontal },
        column.maxWidth === undefined ? null : { maxWidth: column.maxWidth }];
    return <WorkflowAccountLifetimeProvider value={lifetime}>
        <View testID="workflow-start-details" style={styles.root}>
            {start.composerProps ? (
                // One scroll owner for the Start (pane and phone sheet alike): what runs, where, then its inputs and Start.
                <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    <View style={columnStyle}>
                        <ContextualStartLead testID="workflow-start-lead"
                            title={start.composerProps.workflowName ?? t('workflows.start.workflow')}
                            description={start.composerProps.preview}
                            marks={<Icon name="tree-structure" size={ICON_SIZE.xl} color={theme.colors.text.secondary} />}>
                            {props.children}
                        </ContextualStartLead>
                    </View>
                    <WorkflowRunComposer {...start.composerProps} autoFocusComposer
                        contentPaddingHorizontal={COMPOSER_CONTENT_HORIZONTAL_INSET} />
                </ScrollView>
            ) : <>
                {/* A host that must be placed first (a Discussion's Where) keeps its control, on the Start's own edge, while nothing can start. */}
                {props.children ? <View style={[columnStyle, styles.fallbackPlacement]}>{props.children}</View> : null}
                <DetailsSurfaceFallback status={read.failed || lifetime === null ? 'missing' : 'pending'}
                    {...(read.failed ? { onRetry: read.retry } : {})} />
            </>}
        </View>
    </WorkflowAccountLifetimeProvider>;
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0 },
    content: { flexGrow: 1, paddingTop: theme.space.s8, paddingBottom: theme.space.s16 },
    column: { width: '100%', alignSelf: 'center' },
    fallbackPlacement: { paddingTop: theme.space.s8 },
}));

/** Session and Discussion hosts consume the same reference Start and existing Run pane. */
export function createWorkflowDetailsSurfaceRenderers(options: Readonly<{
    owner: 'session' | 'workspace';
    renderStart: (input: DetailsSurfaceRenderInputV1) => React.ReactNode;
}>): readonly DetailsSurfaceRendererV1[] {
    return [{ id: `${options.owner}-workflow-start`, owner: options.owner, order: 72,
        canRender: input => isWorkflowStartResource(input.tab.resource), render: options.renderStart },
    { id: `${options.owner}-workflow-run`, owner: options.owner, order: 73,
        canRender: input => isWorkflowRunPeekDetailsResource(input.tab.resource),
        render: input => isWorkflowRunPeekDetailsResource(input.tab.resource) ? <WorkflowRunPeekDetailsView runId={input.tab.resource.runId}
            serverId={input.tab.resource.serverId} active={input.active} onClose={() => input.callbacks.closeTab?.(input.tab.key)} /> : null }];
}

