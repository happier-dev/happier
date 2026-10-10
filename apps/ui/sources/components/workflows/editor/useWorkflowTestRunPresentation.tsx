import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { WorkflowLifecycleStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { WorkflowAgentDetail } from '@/components/workflows/presentation/WorkflowAgentDetail';
import { workflowRunStyles } from '@/components/workflows/run/workflowRunStyles';
import { projectWorkflowInvocationStructure } from '@/components/workflows/run/workflowInvocationStructure';
import { resolveWorkflowFlowScopedNodeId } from '@/components/workflows/flow/workflowFlowProjection';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { storage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { workflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import { subscribeVisibleWorkflowRunListInvalidation } from '@/sync/domains/workflows/workflowRunListInvalidation';
import { formatWorkflowProblemMessage } from '@/components/workflows/presentation/workflowProblemPresentation';
import type { WorkflowRunInvocationFact, WorkflowRunInvocations } from '@/sync/store/domains/workflowRuns';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { t } from '@/text';

import type { WorkflowDocumentPresentation } from './workflowDocumentPresentation';

// One projection per changed fact map, shared by all step subscriptions. A leaf
// subscribes to its own retained fact reference, not to the whole run or editor.
const projections = new WeakMap<WorkflowRunInvocations['factsById'], WeakMap<WorkflowDefinitionV1, ReadonlyMap<string, WorkflowRunInvocationFact>>>();

export function selectWorkflowTestStep(invocations: WorkflowRunInvocations | undefined, definition: WorkflowDefinitionV1, blockId: string): WorkflowRunInvocationFact | null {
    if (!invocations) return null;
    let definitions = projections.get(invocations.factsById);
    if (!definitions) { definitions = new WeakMap(); projections.set(invocations.factsById, definitions); }
    let projection = definitions.get(definition);
    if (!projection) {
        const latest = new Map<string, WorkflowRunInvocationFact>();
        const facts = Object.values(invocations.factsById);
        const structure = projectWorkflowInvocationStructure({ definition, invocations: facts,
            progressByInvocationId: new Map(facts.flatMap((fact) => fact.opened?.index.contentRevision === fact.contentRevision
                ? [[fact.id, fact.opened.progress] as const] : [])) });
        for (const fact of facts) {
            const entry = structure.get(fact.id);
            const id = entry?.blockId;
            // The incumbent structure owner separates child workflow namespaces
            // and never guesses an ambiguous unopened conditional row.
            if (!id || id === '$root' || entry.isFrame || entry.nodeId !== resolveWorkflowFlowScopedNodeId(id, [])) continue;
            const known = latest.get(id);
            if (!known || BigInt(fact.sequence) > BigInt(known.sequence)
                || (fact.sequence === known.sequence && fact.id > known.id)) latest.set(id, fact);
        }
        projection = latest;
        definitions.set(definition, projection);
    }
    return projection.get(blockId) ?? null;
}

type StepProps = Readonly<{ runId: string; blockId: string; definition: WorkflowDefinitionV1 }>;

function WorkflowTestStepState(props: StepProps): React.ReactElement | null {
    const fact = storage((state) => selectWorkflowTestStep(state.workflowRunInvocationsByRunId[props.runId], props.definition, props.blockId));
    if (!fact) return null;
    return <WorkflowLifecycleStatus lifecycle={fact.lifecycle} blockKind={fact.opened?.progress.blockKind}
        testID={`workflow-editor-test-${props.blockId}-status`} />;
}

function WorkflowTestStepOutput(props: StepProps): React.ReactElement | null {
    const router = useRouter();
    const fact = storage((state) => selectWorkflowTestStep(state.workflowRunInvocationsByRunId[props.runId], props.definition, props.blockId));
    if (!fact?.opened || fact.opened.index.contentRevision !== fact.contentRevision) return null;
    const progress = fact.opened.progress;
    const output = progress.result === undefined ? progress.reason?.message : typeof progress.result === 'string'
        ? progress.result : JSON.stringify(progress.result);
    // The invocation index records creation and last update, not worker CPU
    // time. Say what is measured, including admission/waiting, without inventing
    // a clock or an execution-only duration the producer does not record.
    const seconds = Math.max(0, (Date.parse(fact.updatedAt) - Date.parse(fact.createdAt)) / 1000);
    return <View style={styles.output}>
        <Text style={styles.detail} testID={`workflow-editor-test-${props.blockId}-duration`}>
            {t('workflows.testRun.recordedDuration', { seconds })}
        </Text>
        {output === undefined ? null : <WorkflowAgentDetail text={output} detailTestID={`workflow-editor-test-${props.blockId}-output`} />}
        <HappierPressable accessibilityRole="button" testID={`workflow-editor-test-${props.blockId}-open`}
            style={({ pressed }) => [workflowRunStyles.actionTarget, pressed ? workflowRunStyles.pressed : null]}
            onPress={() => router.push({ pathname: '/workflows/runs/[runId]', params: { runId: props.runId, invocationId: fact.id } } as never)}>
            <Text style={workflowRunStyles.quietAction}>{t('workflows.run.openStepDetails')}</Text>
        </HappierPressable>
    </View>;
}

/** In-place results consume the same paged Action, fact store and Home wake as Run detail. */
export function useWorkflowTestRunPresentation(input: Readonly<{ runId: string | null; definition: WorkflowDefinitionV1 | null; editable: boolean }>): WorkflowDocumentPresentation {
    const visible = useDestinationVisibility();
    const activelyViewed = useHostActivelyViewed();
    const [refresh, setRefresh] = React.useState(0);
    const [failure, setFailure] = React.useState<unknown>(null);
    const [pending, setPending] = React.useState(false);
    React.useEffect(() => {
        const runId = input.runId;
        if (runId === null || !visible || !activelyViewed) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) return;
        const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent();
        const retirement = lifetime.onRetire(() => controller.abort());
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({ lifetime, runId, isVisibleWindowLoaded: () => true,
            invalidate: () => setRefresh((value) => value + 1) });
        setPending(true);
        setFailure(null);
        void (async () => {
            let cursor: string | undefined;
            do {
                const page = await workflowRunDetailActions.listInvocations({ runId, includeContent: true,
                    ...(cursor === undefined ? {} : { cursor }) }, controller.signal);
                if (!isCurrent()) return;
                const owner = storage.getState();
                owner.applyWorkflowRunInvocationPage({ runId, invocations: page.invocations, parentRevision: page.parentRevision,
                    nextCursor: page.nextCursor ?? null, mode: cursor === undefined ? 'refresh' : 'append',
                    invocationDetails: page.invocationDetails });
                cursor = page.nextCursor;
            } while (cursor !== undefined);
        })().catch((error: unknown) => { if (isCurrent()) setFailure(error); })
            .finally(() => { if (isCurrent()) setPending(false); });
        return () => { controller.abort(); retirement.dispose(); unsubscribe(); };
    }, [activelyViewed, input.runId, refresh, visible]);

    return React.useMemo(() => ({
        editable: input.editable,
        ...(input.runId === null || input.definition === null ? {} : {
            note: <View style={styles.output}>
                <Text style={styles.detail}>{t('workflows.testRun.resultsNotice')}</Text>
                {failure !== null ? <SurfaceStateCard kind="error" size="line" title={formatWorkflowProblemMessage(failure)}
                    action={{ label: t('common.retry'), onPress: () => setRefresh((value) => value + 1) }} />
                    : pending ? <SurfaceStateCard kind="loading" size="line" title={t('workflows.testRun.loading')} /> : null}
            </View>,
            step: (blockId: string) => ({
                state: <WorkflowTestStepState runId={input.runId!} definition={input.definition!} blockId={blockId} />,
                footer: <WorkflowTestStepOutput runId={input.runId!} definition={input.definition!} blockId={blockId} />,
            }),
        }),
    }), [failure, input.editable, input.runId, input.definition, pending]);
}

const styles = StyleSheet.create((theme) => ({
    output: { gap: theme.margins.sm, flex: 1, minWidth: 0 },
    detail: { ...Typography.default(), color: theme.colors.text.secondary },
}));
