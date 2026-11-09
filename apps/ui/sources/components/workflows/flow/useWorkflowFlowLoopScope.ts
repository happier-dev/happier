import * as React from 'react';

import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { WorkflowInvocationLifecycleContext } from '@/components/workflows/presentation/workflowLifecyclePresentation';

import {
    resolveWorkflowFlowOccurrenceStatus,
    resolveWorkflowFlowLoopScope,
    retainWorkflowFlowLoopPicks,
    type WorkflowFlowLoopItemFilter,
    type WorkflowFlowLoopItemStatus,
    type WorkflowFlowLoopView,
} from './workflowFlowLoopItems';
import type { WorkflowFlowNode, WorkflowFlowNodeRunState, WorkflowFlowProjection } from './workflowFlowProjection';

const NO_PICKS: ReadonlyMap<string, number> = new Map();
const NO_FILTERS: ReadonlyMap<string, WorkflowFlowLoopItemFilter> = new Map();
const NO_LOOPS: ReadonlyMap<string, WorkflowFlowLoopView> = new Map();

/**
 * The Run Map's item selection: view state (07 S14), never a setting. It follows the selected step into
 * its item, so opening a step from anywhere draws that item; picking an item carries an open step along.
 * A chosen or first-resolved item stays put while the Run moves, so the body doesn't swap under the reader.
 */
export function useWorkflowFlowLoopScope(input: Readonly<{
    enabled: boolean;
    projection: WorkflowFlowProjection;
    runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]> | undefined;
    selectedInvocationId: string | null;
    invocationStatusContext: WorkflowInvocationLifecycleContext | undefined;
    onSelectOccurrence: ((invocationId: string) => void) | undefined;
}>) {
    const [storedPicks, setPicks] = React.useState(NO_PICKS);
    const [filters, setFilters] = React.useState(NO_FILTERS);
    const [followedInvocationId, setFollowedInvocationId] = React.useState<string | null>(null);
    const { enabled, projection, runStates, selectedInvocationId, invocationStatusContext } = input;

    const selectedState = React.useMemo(() => {
        if (!enabled || runStates === undefined || selectedInvocationId === null) return undefined;
        for (const states of runStates.values()) {
            const found = states.find(state => state.invocationId === selectedInvocationId);
            if (found !== undefined) return found;
        }
        return undefined;
    }, [enabled, runStates, selectedInvocationId]);

    let picks = storedPicks;
    if (selectedState !== undefined && followedInvocationId !== selectedState.invocationId) {
        setFollowedInvocationId(selectedState.invocationId);
        const followed = new Map(picks);
        for (const repetition of selectedState.repetitions ?? []) followed.set(repetition.loopNodeId, repetition.index);
        picks = followed;
        setPicks(followed);
    }

    const scope = React.useMemo(() => {
        if (!enabled || runStates === undefined) return { runStates, loops: NO_LOOPS };
        return resolveWorkflowFlowLoopScope({
            projection, runStates, picks, filters,
            classify: (state, node) => classifyOccurrence(state, node, invocationStatusContext),
        });
    }, [enabled, filters, invocationStatusContext, picks, projection, runStates]);

    const retained = retainWorkflowFlowLoopPicks(picks, scope.loops);
    if (retained !== picks) setPicks(retained);

    const selectItem = useEventCallback((loopNodeId: string, index: number) => {
        setPicks(current => new Map(current).set(loopNodeId, index));
        const own = selectedState?.repetitions?.find(repetition => repetition.loopNodeId === loopNodeId);
        if (selectedState === undefined || own === undefined || own.index === index) return;
        // The open step comes along when the new item has reached it; otherwise the pane keeps what it shows.
        const peer = (runStates?.get(selectedState.nodeId) ?? [])
            .filter(state => (state.repetitions ?? []).every(repetition => repetition.loopNodeId === loopNodeId
                ? repetition.index === index
                : selectedState.repetitions?.find(other => other.loopNodeId === repetition.loopNodeId)?.index === repetition.index))
            .reduce<WorkflowFlowNodeRunState | undefined>((latest, state) =>
                latest === undefined || Number(latest.attempt ?? '0') < Number(state.attempt ?? '0') ? state : latest, undefined);
        if (peer !== undefined) input.onSelectOccurrence?.(peer.invocationId);
    });
    const filterItems = useEventCallback((loopNodeId: string, filter: WorkflowFlowLoopItemFilter) => {
        setFilters(current => new Map(current).set(loopNodeId, filter));
    });

    return { runStates: scope.runStates, loops: scope.loops, selectItem, filterItems };
}

function classifyOccurrence(
    state: WorkflowFlowNodeRunState,
    node: WorkflowFlowNode,
    context: WorkflowInvocationLifecycleContext | undefined,
): WorkflowFlowLoopItemStatus {
    const { tone, bucket } = resolveWorkflowFlowOccurrenceStatus(state, node.kind, context);
    if (tone === 'attention') return 'needsYou';
    if (tone === 'danger') return 'failed';
    return bucket === 'working' ? 'running' : null;
}
