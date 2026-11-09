import { buildHappierWorkMap, type HappierWorkMap, type HappierWorkMapNodeDeclaration, type HappierWorkMapPlaced } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';

import { endsWithQuietTime, type WorkItem, type WorkProjection, type WorkStatus } from './workProjection';

/**
 * The Session and run producer for the neutral Work map (ORC §3.8 "Map", O11; lab `session-A2`,
 * `map-M1`): the lead at the root, each Session under the Session it reports to, and the workflows,
 * background runs and in-session agents the lead started under the lead. Every edge comes from the Work projection's manager
 * ancestry (with archived intermediates folded out), or "this Session started it"; nothing is inferred
 * from order, time or workspace.
 * The lead's node says what it waits on ("Waiting on 3", lab `session-A2`) in the status slot, but stays
 * neutral whatever its reports need (S-6): ancestors are never tinted for their descendants.
 */
export type SessionWorkMapNodeDeclaration = HappierWorkMapNodeDeclaration & Readonly<{
    kind: 'lead' | WorkItem['kind'];
    status: WorkStatus | null;
    /** Nothing is going on here any more (the List row ends with a quiet time, or it finished): drawn in the quiet ink. */
    settled: boolean;
    agentId: string | null;
    facts: readonly string[];
}>;

export type SessionWorkMapNode = HappierWorkMapPlaced<SessionWorkMapNodeDeclaration>;

export type SessionWorkMap = HappierWorkMap<SessionWorkMapNode>;

/**
 * Settled work: finished, or quiet with nothing to act on (the Work list ends such a row with when it
 * last moved). The map folds it away, or draws it in the quiet ink when work still goes under it, so
 * a settled report never reads like one that is still working.
 */
export function isWorkSettled(item: WorkItem): boolean {
    return item.status.bucket === 'finished' || endsWithQuietTime(item);
}

/**
 * The work the map leaves out (lab `session-A2`: "Finished work leaves the map; List keeps it"):
 * settled items with nothing still going under them, in projection order. A finished Session that
 * leads outstanding work stays, so no outstanding node loses its place. The map hosts say what was
 * folded in one quiet line.
 */
export function readWorkFoldedFromMap(projection: WorkProjection): readonly WorkItem[] {
    const items = [...projection.sessions, ...projection.workflows, ...projection.backgroundRuns, ...projection.agents, ...projection.projectCommands];
    const parentByKey = new Map<string, string>();
    for (const item of projection.sessions) if (item.parentKey) parentByKey.set(item.key, item.parentKey);
    const leadsOutstanding = new Set<string>();
    for (const item of items) {
        if (isWorkSettled(item)) continue;
        for (let parent = parentByKey.get(item.key); parent && !leadsOutstanding.has(parent); parent = parentByKey.get(parent)) {
            leadsOutstanding.add(parent);
        }
    }
    return items.filter((item) => isWorkSettled(item) && !leadsOutstanding.has(item.key));
}

/** A settled node carries no state word: the List row says when it last moved, the map just keeps the structure. */
function readNodeStatus(item: WorkItem): WorkStatus | null {
    return endsWithQuietTime(item) ? null : item.status;
}

export function projectSessionWorkMap(input: Readonly<{
    managerSessionId: string;
    leadTitle: string;
    leadAgentId?: string | null;
    leadFacts?: readonly string[];
    projection: WorkProjection;
}>): SessionWorkMap {
    const leadNodeId = `session:${input.managerSessionId}`;
    const folded = new Set(readWorkFoldedFromMap(input.projection).map((item) => item.key));
    const waitingOn = input.projection.summary.outstanding;
    const nodes: SessionWorkMapNodeDeclaration[] = [{
        nodeId: leadNodeId,
        label: input.leadTitle,
        parentNodeId: null,
        open: { kind: 'session', sessionId: input.managerSessionId },
        kind: 'lead',
        status: waitingOn > 0
            ? { state: 'waiting_on_reports', bucket: 'working', tone: 'neutral', attentionType: null, word: t('sessionWork.map.waitingOn', { count: waitingOn }) }
            : null,
        settled: false,
        agentId: input.leadAgentId ?? null,
        facts: input.leadFacts ?? [],
    }];
    for (const item of input.projection.sessions) {
        if (item.open.kind !== 'session' || folded.has(item.key)) continue;
        nodes.push({
            nodeId: item.key,
            label: item.title,
            parentNodeId: item.parentKey ?? leadNodeId,
            open: { kind: 'session', sessionId: item.open.sessionId },
            kind: item.kind,
            status: readNodeStatus(item),
            settled: isWorkSettled(item),
            agentId: item.agentId,
            facts: item.facts,
        });
    }
    for (const item of [...input.projection.workflows, ...input.projection.backgroundRuns]) {
        const runId = item.open.kind === 'workflow_run'
            ? item.open.runId
            : item.open.kind === 'agent_activity' ? item.open.runId : null;
        if (!runId || folded.has(item.key)) continue;
        nodes.push({
            nodeId: item.key,
            label: item.title,
            parentNodeId: leadNodeId,
            open: { kind: 'run', runId },
            kind: item.kind,
            status: readNodeStatus(item),
            settled: isWorkSettled(item),
            agentId: item.agentId,
            facts: item.facts,
        });
    }
    // In-session agents (subagents, teammates) have no Session or Run of their own to point the node at;
    // the view opens a node through its Work item, so the Work opener's agent target stays the only one.
    for (const item of input.projection.agents) {
        if (folded.has(item.key)) continue;
        nodes.push({
            nodeId: item.key,
            label: item.title,
            parentNodeId: leadNodeId,
            kind: item.kind,
            status: readNodeStatus(item),
            settled: isWorkSettled(item),
            agentId: item.agentId,
            facts: item.facts,
        });
    }
    for (const item of input.projection.projectCommands) {
        if (item.open.kind !== 'action_operation' || folded.has(item.key)) continue;
        nodes.push({
            nodeId: item.key, label: item.title, parentNodeId: leadNodeId, open: item.open,
            kind: item.kind, status: item.status, settled: isWorkSettled(item), agentId: item.agentId, facts: item.facts,
        });
    }
    return buildHappierWorkMap({ relationships: 'authored', nodes });
}
