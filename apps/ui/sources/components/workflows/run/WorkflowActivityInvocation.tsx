import * as React from 'react';
import type { WorkflowRunInvocationIndexV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { workflowRunStoreKey, type WorkflowRunInvocationFact } from '@/sync/store/domains/workflowRuns';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t } from '@/text';
import type { WorkflowFlowProjection } from '../flow/workflowFlowProjection';
import { resolveWorkflowConditionHeadline } from '../presentation/workflowConditionPresentation';
import { formatWorkflowInvocationElapsedLabel } from '../presentation/workflowUsagePresentation';
import {
    formatWorkflowOccurrenceLabel,
    type createWorkflowInvocationStructureProjector,
    type WorkflowInvocationStructureInputs,
} from './workflowInvocationStructure';

export type WorkflowActivityPresentation = Readonly<{
    scope: ServerAccountScope | null;
    definition: WorkflowInvocationStructureInputs['definition'];
    projection: WorkflowFlowProjection | null;
    project: ReturnType<typeof createWorkflowInvocationStructureProjector>;
}>;

export type WorkflowActivityInvocationPresentation = Readonly<{
    invocation: WorkflowRunInvocationIndexV1;
    label: string | null;
    occurrence: string | null;
    blockKind: string | null;
    elapsed: string | null;
}>;

type Present = (value: WorkflowActivityInvocationPresentation) => React.ReactElement;

const subscribeInactive = () => () => {};

/** The store already publishes immutable per-id facts; parked rows withdraw only their subscription. */
function useInvocationValue<Value>(runId: string, invocationId: string, scope: ServerAccountScope | null, select: (fact: WorkflowRunInvocationFact | undefined) => Value) {
    const presented = useLayoutPresentationActive();
    const store = getStorage();
    const key = workflowRunStoreKey(runId, scope);
    const read = () => select(store.getState().workflowRunInvocationsByRunId[key]?.factsById[invocationId]);
    return React.useSyncExternalStore(presented ? store.subscribe : subscribeInactive, read, read);
}

/** Each mounted row reads only its own Session names through their existing privacy/title owners. */
function InvocationPresentation(props: Readonly<{
    facts: readonly WorkflowRunInvocationFact[];
    presentation: WorkflowActivityPresentation;
    children: Present;
}>): React.ReactElement {
    const { facts, presentation } = props;
    const presented = useLayoutPresentationActive();
    const invocation = facts[facts.length - 1]!;
    const evidence = new Map(facts.flatMap(fact => fact.opened ? [[fact.id, fact.opened] as const] : []));
    const progress = new Map([...evidence].map(([id, opened]) => [id, opened.progress]));
    const sessionIds = new Set<string>();
    const inputs = { invocations: facts, progressByInvocationId: progress, invocationEvidenceById: evidence };
    const unnamed = presentation.project({ ...inputs, sessionDisplayLabelsById: {
        get(id) { sessionIds.add(id); return undefined; },
    } });
    const addresses = [...sessionIds].map(sessionId => ({ sessionId, serverId: presentation.scope?.serverId }));
    const titles = useSessionDisplayTitles(presented ? addresses : []);
    const visible = useSessionRecordingVisibility(presented && addresses.length > 0);
    const labels = new Map(addresses.flatMap((address, index) => {
        const title = visible(address) ? titles[index] : t('message.sessionReferenceUnavailable');
        return title == null ? [] : [[address.sessionId, title] as const];
    }));
    const entry = (addresses.length === 0 ? unnamed : presentation.project({ ...inputs, sessionDisplayLabelsById: labels })).get(invocation.id);
    const node = entry?.nodeId == null ? undefined : presentation.projection?.nodesById.get(entry.nodeId);
    let label = node?.label ?? (entry?.blockId === '$root' ? t('workflows.run.untitled') : null);
    const block = node?.kind !== 'if' || entry?.blockId == null || presentation.definition === null
        ? null : findWorkflowBlock(presentation.definition, entry.blockId);
    if (block?.kind === 'if' && !block.name?.trim() && presentation.definition !== null) {
        const headline = resolveWorkflowConditionHeadline(presentation.definition, block.when, 'run');
        label = headline.unconditional === true ? headline.sentence
            : t('workflows.page.inspector.ifSentence', { condition: headline.sentence });
    }
    return props.children({ invocation, label, blockKind: node?.kind ?? null,
        occurrence: formatWorkflowOccurrenceLabel(entry?.occurrence ?? [], presentation.projection) ?? null,
        elapsed: formatWorkflowInvocationElapsedLabel(progress.get(invocation.id)?.timing),
    });
}

/**
 * Keep parent-link topology across exact opens. The canonical mapper declares which
 * ancestor content is consumed; opened paths select only qualified item-label scalars.
 */
function InvocationAncestry(props: Readonly<{
    parentId: string;
    labelScopes: readonly string[] | null;
    runId: string;
    facts: readonly WorkflowRunInvocationFact[];
    presentation: WorkflowActivityPresentation;
    children: Present;
}>): React.ReactElement {
    const { project, scope } = props.presentation;
    const parentId = useInvocationValue(props.runId, props.parentId, scope, fact => fact?.parentRecordId);
    useInvocationValue(props.runId, props.parentId, scope, fact => props.labelScopes === null ? project.ancestorStructureInput(fact, 'blockId') : undefined);
    useInvocationValue(props.runId, props.parentId, scope, fact => props.labelScopes === null ? project.ancestorStructureInput(fact, 'scopeKey') : undefined);
    useInvocationValue(props.runId, props.parentId, scope, fact => props.labelScopes === null ? project.ancestorStructureInput(fact, 'ownsFrame') : undefined);
    useInvocationValue(props.runId, props.parentId, scope, fact => props.labelScopes === null ? project.ancestorStructureInput(fact, 'selectedBranch') : undefined);
    const readLabel = (fact: WorkflowRunInvocationFact | undefined) => {
        if (props.labelScopes?.length === 0) return undefined;
        const label = fact === undefined ? undefined : project.itemFrameLabel(fact, fact.opened);
        return label && (props.labelScopes === null || props.labelScopes.includes(label.scopeKey)) ? label : undefined;
    };
    const labelScope = useInvocationValue(props.runId, props.parentId, scope, fact => readLabel(fact)?.scopeKey);
    const label = useInvocationValue(props.runId, props.parentId, scope, fact => readLabel(fact)?.label);
    // Immutable links keep the mapper's physical ancestry intact without subscribing
    // an opened child to unrelated ancestor progress or lifecycle facts.
    const current = getStorage().getState().workflowRunInvocationsByRunId[workflowRunStoreKey(props.runId, scope)]?.factsById[props.parentId];
    let fact = current;
    if (fact !== undefined && props.labelScopes !== null && (labelScope === undefined || label === undefined)) {
        const { opened: _opened, ...index } = fact;
        fact = index;
    }
    const facts = fact === undefined ? props.facts : [fact, ...props.facts];
    return parentId == null
        ? <InvocationPresentation facts={facts} presentation={props.presentation}>{props.children}</InvocationPresentation>
        : <InvocationAncestry {...props} parentId={parentId} facts={facts} />;
}

/** Raw facts already keep per-id identity at the store; the recycler needs no whole-map invalidator. */
export function WorkflowActivityInvocation(props: Readonly<{
    invocation: WorkflowRunInvocationIndexV1;
    presentation: WorkflowActivityPresentation;
    children: Present;
}>): React.ReactElement {
    const stored = useInvocationValue(props.invocation.runId, props.invocation.id, props.presentation.scope, value => value);
    const fact = stored ?? props.invocation;
    const labelScopes = props.presentation.project.ancestorLabelScopes(stored?.opened);
    return fact.parentRecordId === null
        ? <InvocationPresentation facts={[fact]} presentation={props.presentation}>{props.children}</InvocationPresentation>
        : <InvocationAncestry parentId={fact.parentRecordId} runId={fact.runId} facts={[fact]} labelScopes={labelScopes}
            presentation={props.presentation}>{props.children}</InvocationAncestry>;
}
