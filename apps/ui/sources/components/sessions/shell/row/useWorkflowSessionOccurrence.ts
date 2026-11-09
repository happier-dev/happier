import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import type { SessionAwarenessOriginV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { WorkflowInvocationLifecycleV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { storage } from '@/sync/domains/state/storageStore';
import type { WorkflowRunRow, WorkflowRunInvocations } from '@/sync/store/domains/workflowRuns';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { projectWorkflowFlow } from '@/components/workflows/flow/workflowFlowProjection';
import { formatWorkflowOccurrenceLabel, projectWorkflowFlowRunStates, projectWorkflowInvocationStructure } from '@/components/workflows/run/workflowInvocationStructure';
import { isTerminalWorkflowInvocationLifecycle } from '@/components/work/status/resolveWorkStatusTone';
import { isWorkflowAttentionInvocation, isWorkflowRunStopPending } from '@/components/workflows/presentation/workflowLifecyclePresentation';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

type Occurrence = Readonly<{ title: string; lifecycle?: WorkflowInvocationLifecycleV1; blockKind?: string; runStopPending?: boolean }>;
type Facts = WorkflowRunInvocations['factsById'];

// Sibling conversation rows consume one projection of the same immutable Run/fact
// snapshot. Rebuilding the whole invocation tree for each child would be quadratic.
const projections = new WeakMap<WorkflowRunRow, WeakMap<Facts, Readonly<{
    language: string; occurrences: ReadonlyMap<string, Occurrence>;
}>>>();

function projectConversationOccurrences(row: WorkflowRunRow, facts: Facts, language: string): ReadonlyMap<string, Occurrence> {
    let byFacts = projections.get(row);
    const cached = byFacts?.get(facts);
    if (cached?.language === language) return cached.occurrences;
    const result = new Map<string, Occurrence>();
    if (!row.detail) return result;
    const { definition, acceptedContext } = row.detail;
    const invocations = Object.values(facts);
    const evidence = new Map(invocations.flatMap(fact => fact.opened ? [[fact.id, fact.opened] as const] : []));
    const progress = new Map([...evidence].map(([id, opened]) => [id, opened.progress]));
    const projection = projectWorkflowFlow(definition, acceptedContext.frozenChildren, undefined, { presentation: 'run' });
    const structure = projectWorkflowInvocationStructure({ definition, frozenChildren: acceptedContext.frozenChildren,
        invocations, progressByInvocationId: progress, invocationEvidenceById: evidence });
    const states = projectWorkflowFlowRunStates({ invocations, structure, progressByInvocationId: progress, projection });
    const attentionSessions = new Set<string>();
    for (const occurrences of states.values()) for (const occurrence of occurrences) {
        const opened = evidence.get(occurrence.invocationId);
        const execution = opened?.progress.execution;
        if (!opened || opened.index.attempt !== occurrence.attempt || opened.progress.attempt !== occurrence.attempt
            || execution?.kind !== 'session') continue;
        const sessionId = execution.sessionId;
        const attention = isWorkflowAttentionInvocation(occurrence.lifecycle,
            structure.get(occurrence.invocationId)?.coverageKind, row.summary?.state);
        // Like Review next, the first actionable occurrence leads. Unsettled
        // work leads settled siblings; only an entirely settled conversation
        // falls back to its last indexed occurrence, not its creation title.
        if (attentionSessions.has(sessionId)) continue;
        const previous = result.get(sessionId);
        if (!attention && previous?.lifecycle !== undefined
            && !isTerminalWorkflowInvocationLifecycle(previous.lifecycle)) continue;
        if (attention) attentionSessions.add(sessionId);
        const node = projection.nodesById.get(occurrence.nodeId);
        if (!node) continue;
        const coordinates = structure.get(occurrence.invocationId)?.occurrence ?? [];
        result.set(sessionId, {
            title: [node.stepOrdinal, node.label, formatWorkflowOccurrenceLabel(coordinates, projection)]
                .filter(Boolean).join(' · '),
            lifecycle: occurrence.lifecycle, blockKind: opened.progress.blockKind,
            runStopPending: isWorkflowRunStopPending(row.summary ?? row.detail.run),
        });
    }
    if (!byFacts) { byFacts = new WeakMap(); projections.set(row, byFacts); }
    byFacts.set(facts, { language, occurrences: result });
    return result;
}

/** A nested Workflow conversation previews the Map's exact occurrence when that evidence is available. */
export function useWorkflowSessionOccurrence(params: Readonly<{
    sessionId: string; origin?: SessionAwarenessOriginV1; serverId?: string; enabled: boolean;
}>): Occurrence | null {
    const language = usePreferredLanguage();
    const scope = storage(state => state.profileScope);
    const runId = params.enabled && params.origin?.kind === 'run_step' && scope
        && (!params.serverId || areServerProfileIdentifiersEquivalent(scope.serverId, params.serverId))
        ? params.origin.runId ?? null : null;
    const row = storage(state => runId ? state.workflowRunsById[workflowRunStoreKey(runId)] ?? null : null);
    const facts = storage(state => runId ? state.workflowRunInvocationsByRunId[workflowRunStoreKey(runId)]?.factsById ?? null : null);
    return React.useMemo(() => {
        if (!runId) return null;
        // Without exact evidence, keep the canonical saved Session title. History
        // must not replace the authored step name with a generic Workflow label.
        return (row && facts ? projectConversationOccurrences(row, facts, language).get(params.sessionId) : null)
            ?? null;
    }, [facts, language, params.sessionId, row, runId]);
}
