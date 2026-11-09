import type { WorkflowInvocationLifecycleV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { describeWorkflowInvocationLifecycle, type WorkflowInvocationLifecycleContext } from '@/components/workflows/presentation/workflowLifecyclePresentation';

import type { WorkflowFlowNode, WorkflowFlowNodeRunState, WorkflowFlowProjection } from './workflowFlowProjection';

/** An occurrence's status through the shared Work status owner (INT I3): the map's ring and the item filter. */
export function resolveWorkflowFlowOccurrenceStatus(
    state: Pick<WorkflowFlowNodeRunState, 'lifecycle'>,
    blockKind: WorkflowFlowNode['kind'],
    context: WorkflowInvocationLifecycleContext | undefined,
) {
    return resolveWorkStatusTone({
        kind: 'workflow_step',
        facts: { ...context, lifecycle: state.lifecycle,
            word: describeWorkflowInvocationLifecycle(state.lifecycle, { ...context, blockKind }).label },
    });
}

/** What a loop item is doing for the person: the one rollup behind the selector and its filter. */
export type WorkflowFlowLoopItemStatus = 'needsYou' | 'failed' | 'running' | null;
export type WorkflowFlowLoopItemFilter = 'all' | Exclude<WorkflowFlowLoopItemStatus, null>;

export type WorkflowFlowLoopItem = Readonly<{
    index: number;
    label: string;
    status: WorkflowFlowLoopItemStatus;
    /** The item's most pressing state, drawn on its row in the selector. */
    lifecycle: WorkflowInvocationLifecycleV1;
    blockKind: WorkflowFlowNode['kind'];
}>;

export type WorkflowFlowLoopView = Readonly<{
    items: readonly WorkflowFlowLoopItem[];
    /** What the filter narrowed the choices to; every item when the filter has nothing left. */
    visibleItems: readonly WorkflowFlowLoopItem[];
    selectedIndex: number;
    filter: WorkflowFlowLoopItemFilter;
    counts: Readonly<Record<Exclude<WorkflowFlowLoopItemFilter, 'all'>, number>>;
}>;

const STATUS_RANK: Readonly<Record<NonNullable<WorkflowFlowLoopItemStatus>, number>> = { needsYou: 0, failed: 1, running: 2 };
const SETTLED_RANK = 3;
const rankOf = (status: WorkflowFlowLoopItemStatus) => status === null ? SETTLED_RANK : STATUS_RANK[status];

/**
 * A repeated body's item selection: which of the loop's items the Map draws. It decides from the run
 * states the Run already holds, so a loop's items cost one pass over loaded occurrences and no body read.
 * Outer loops resolve first, so a nested loop lists only what ran under the outer item on show.
 */
export function resolveWorkflowFlowLoopScope(params: Readonly<{
    projection: WorkflowFlowProjection;
    runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>;
    /** The view's chosen item per loop node; the first most-pressing item otherwise. */
    picks: ReadonlyMap<string, number>;
    filters: ReadonlyMap<string, WorkflowFlowLoopItemFilter>;
    classify: (state: WorkflowFlowNodeRunState, node: WorkflowFlowNode) => WorkflowFlowLoopItemStatus;
}>): Readonly<{
    runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>;
    loops: ReadonlyMap<string, WorkflowFlowLoopView>;
}> {
    const statesByLoop = new Map<string, WorkflowFlowNodeRunState[]>();
    for (const states of params.runStates.values()) {
        for (const state of states) {
            for (const repetition of state.repetitions ?? []) {
                const members = statesByLoop.get(repetition.loopNodeId);
                if (members === undefined) statesByLoop.set(repetition.loopNodeId, [state]);
                else members.push(state);
            }
        }
    }
    const selected = new Map<string, number>();
    const loops = new Map<string, WorkflowFlowLoopView>();
    for (const node of params.projection.nodes) {
        if (node.kind !== 'loop') continue;
        const members = statesByLoop.get(node.nodeId);
        if (members === undefined) continue;
        const view = resolveLoopView({
            loopNodeId: node.nodeId,
            members: members.filter(state => isInSelectedOuterItems(state, node.nodeId, selected)),
            projection: params.projection,
            pick: params.picks.get(node.nodeId),
            filter: params.filters.get(node.nodeId) ?? 'all',
            classify: params.classify,
        });
        if (view === null) continue;
        loops.set(node.nodeId, view);
        selected.set(node.nodeId, view.selectedIndex);
    }
    if (loops.size === 0) return { runStates: params.runStates, loops };
    const runStates = new Map<string, readonly WorkflowFlowNodeRunState[]>();
    for (const [nodeId, states] of params.runStates) {
        runStates.set(nodeId, states.filter(state => isInSelectedItems(state, selected)));
    }
    return { runStates, loops };
}

/** Keep what the Map settled on, so a Run's progress doesn't change the item under the reader. */
export function retainWorkflowFlowLoopPicks(
    picks: ReadonlyMap<string, number>,
    loops: ReadonlyMap<string, WorkflowFlowLoopView>,
): ReadonlyMap<string, number> {
    let next: Map<string, number> | undefined;
    for (const [loopNodeId, view] of loops) {
        if ((next ?? picks).get(loopNodeId) === view.selectedIndex) continue;
        next ??= new Map(picks);
        next.set(loopNodeId, view.selectedIndex);
    }
    return next ?? picks;
}

function isInSelectedOuterItems(state: WorkflowFlowNodeRunState, loopNodeId: string, selected: ReadonlyMap<string, number>): boolean {
    return (state.repetitions ?? []).every(repetition => repetition.loopNodeId === loopNodeId
        || !selected.has(repetition.loopNodeId) || selected.get(repetition.loopNodeId) === repetition.index);
}

function isInSelectedItems(state: WorkflowFlowNodeRunState, selected: ReadonlyMap<string, number>): boolean {
    return (state.repetitions ?? []).every(repetition => !selected.has(repetition.loopNodeId) || selected.get(repetition.loopNodeId) === repetition.index);
}

function resolveLoopView(params: Readonly<{
    loopNodeId: string;
    members: readonly WorkflowFlowNodeRunState[];
    projection: WorkflowFlowProjection;
    pick: number | undefined;
    filter: WorkflowFlowLoopItemFilter;
    classify: (state: WorkflowFlowNodeRunState, node: WorkflowFlowNode) => WorkflowFlowLoopItemStatus;
}>): WorkflowFlowLoopView | null {
    // A retried step keeps its earlier attempts; only the latest says how the item is doing.
    const latestByItem = new Map<number, Map<string, WorkflowFlowNodeRunState>>();
    for (const state of params.members) {
        const own = state.repetitions?.find(repetition => repetition.loopNodeId === params.loopNodeId);
        if (own === undefined) continue;
        let latest = latestByItem.get(own.index);
        if (latest === undefined) latestByItem.set(own.index, latest = new Map());
        const key = `${state.nodeId}\u0000${(state.repetitions ?? []).map(repetition => repetition.index).join(',')}`;
        const before = latest.get(key);
        if (before === undefined || Number(before.attempt ?? '0') < Number(state.attempt ?? '0')) latest.set(key, state);
    }
    if (latestByItem.size === 0) return null;
    const items: WorkflowFlowLoopItem[] = [];
    for (const [index, latest] of latestByItem) {
        let representative: WorkflowFlowNodeRunState | undefined;
        let status: WorkflowFlowLoopItemStatus = null;
        for (const state of latest.values()) {
            const stateStatus = params.classify(state, params.projection.nodesById.get(state.nodeId)!);
            if (representative === undefined || rankOf(stateStatus) < rankOf(status)) {
                representative = state;
                status = stateStatus;
            }
        }
        const label = representative!.repetitions!.find(repetition => repetition.loopNodeId === params.loopNodeId)!.label;
        items.push({ index, label, status, lifecycle: representative!.lifecycle,
            blockKind: params.projection.nodesById.get(representative!.nodeId)!.kind });
    }
    items.sort((left, right) => left.index - right.index);
    const counts = { needsYou: 0, failed: 0, running: 0 };
    for (const item of items) if (item.status !== null) counts[item.status] += 1;
    const filter = params.filter !== 'all' && counts[params.filter] === 0 ? 'all' : params.filter;
    const visibleItems = filter === 'all' ? items : items.filter(item => item.status === filter);
    const pickVisible = visibleItems.some(item => item.index === params.pick);
    const selectedIndex = pickVisible ? params.pick! : visibleItems.reduce((best, item) =>
        rankOf(item.status) < rankOf(best.status) ? item : best).index;
    return { items, visibleItems, selectedIndex, filter, counts };
}
