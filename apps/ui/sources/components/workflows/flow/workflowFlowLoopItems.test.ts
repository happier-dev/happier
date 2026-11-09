import { describe, expect, it } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { projectWorkflowFlow, type WorkflowFlowNodeRunState } from './workflowFlowProjection';
import { resolveWorkflowFlowLoopScope, type WorkflowFlowLoopItemStatus } from './workflowFlowLoopItems';

function step(id: string) {
    return { kind: 'step' as const, id, document: { text: id, references: [], attachments: [] }, input: [], result: { kind: 'text' as const } };
}

function loop(id: string, body: unknown[]) {
    return { kind: 'loop' as const, id, repetition: { kind: 'items' as const, items: { kind: 'literal' as const, value: [] }, execution: 'parallel' as const, failurePolicy: 'collect_outcomes' as const }, body };
}

function definition(blocks: unknown[]): WorkflowDefinitionV1 {
    return { version: 1, inputs: [], defaults: {}, blocks } as unknown as WorkflowDefinitionV1;
}

const OUTER = definition([loop('issues', [step('fix'), step('note')])]);

type Lifecycle = WorkflowFlowNodeRunState['lifecycle'];

function state(nodeId: string, index: number, lifecycle: Lifecycle, attempt = '0'): WorkflowFlowNodeRunState {
    return { nodeId, invocationId: `${nodeId}-${index}-${attempt}`, lifecycle, attempt,
        repetitions: [{ loopNodeId: 'issues', index, label: `Issue ${index + 1}` }] };
}

function statesOf(...states: readonly WorkflowFlowNodeRunState[]): ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]> {
    const byNode = new Map<string, WorkflowFlowNodeRunState[]>();
    for (const entry of states) byNode.set(entry.nodeId, [...(byNode.get(entry.nodeId) ?? []), entry]);
    return byNode;
}

const classify = (entry: WorkflowFlowNodeRunState): WorkflowFlowLoopItemStatus => {
    if (entry.lifecycle === 'waiting_for_review') return 'needsYou';
    if (entry.lifecycle === 'failed') return 'failed';
    if (entry.lifecycle === 'running') return 'running';
    return null;
};

function resolve(runStates: ReadonlyMap<string, readonly WorkflowFlowNodeRunState[]>, options: Readonly<{
    projection?: ReturnType<typeof projectWorkflowFlow>;
    picks?: ReadonlyMap<string, number>;
    filters?: ReadonlyMap<string, 'all' | 'needsYou' | 'running' | 'failed'>;
}> = {}) {
    return resolveWorkflowFlowLoopScope({
        projection: options.projection ?? projectWorkflowFlow(OUTER),
        runStates,
        picks: options.picks ?? new Map(),
        filters: options.filters ?? new Map(),
        classify,
    });
}

describe('resolveWorkflowFlowLoopScope', () => {
    it('lists the items the Run already has and swaps the body to the selected item', () => {
        const scope = resolve(statesOf(
            state('fix', 0, 'completed'), state('fix', 1, 'completed'), state('fix', 2, 'running'),
            state('note', 1, 'completed'),
        ), { picks: new Map([['issues', 1]]) });

        expect(scope.loops.get('issues')?.items.map(item => item.label)).toEqual(['Issue 1', 'Issue 2', 'Issue 3']);
        expect(scope.loops.get('issues')?.selectedIndex).toBe(1);
        expect(scope.runStates.get('fix')?.map(entry => entry.invocationId)).toEqual(['fix-1-0']);
        expect(scope.runStates.get('note')?.map(entry => entry.invocationId)).toEqual(['note-1-0']);
    });

    it('starts on the item that needs the person most, then a failure, then running work, then the first', () => {
        const needsYou = statesOf(state('fix', 0, 'completed'), state('fix', 1, 'failed'), state('fix', 2, 'running'), state('note', 3, 'waiting_for_review'));
        expect(resolve(needsYou).loops.get('issues')?.selectedIndex).toBe(3);
        const failed = statesOf(state('fix', 0, 'completed'), state('fix', 1, 'running'), state('fix', 2, 'failed'));
        expect(resolve(failed).loops.get('issues')?.selectedIndex).toBe(2);
        const running = statesOf(state('fix', 0, 'completed'), state('fix', 1, 'running'));
        expect(resolve(running).loops.get('issues')?.selectedIndex).toBe(1);
        const settled = statesOf(state('fix', 0, 'completed'), state('fix', 1, 'completed'));
        expect(resolve(settled).loops.get('issues')?.selectedIndex).toBe(0);
    });

    it('rolls an item up from the latest attempt, so a retried failure no longer reads as failed', () => {
        const scope = resolve(statesOf(state('fix', 0, 'failed', '0'), state('fix', 0, 'running', '1'), state('fix', 1, 'completed')));
        expect(scope.loops.get('issues')?.items[0]?.status).toBe('running');
        expect(scope.loops.get('issues')?.counts).toEqual({ needsYou: 0, running: 1, failed: 0 });
    });

    it('narrows the choices to a status, moves off an item the filter excludes, and keeps counts of every item', () => {
        const runStates = statesOf(state('fix', 0, 'waiting_for_review'), state('fix', 1, 'running'), state('fix', 2, 'running'), state('fix', 3, 'completed'));
        const scope = resolve(runStates, { picks: new Map([['issues', 3]]), filters: new Map([['issues', 'running']]) });
        const view = scope.loops.get('issues')!;
        expect(view.filter).toBe('running');
        expect(view.visibleItems.map(item => item.index)).toEqual([1, 2]);
        expect(view.selectedIndex).toBe(1);
        expect(view.counts).toEqual({ needsYou: 1, running: 2, failed: 0 });
        expect(scope.runStates.get('fix')?.map(entry => entry.invocationId)).toEqual(['fix-1-0']);
    });

    it('shows every item again once a filter has nothing left, and stays on the item the person chose', () => {
        const scope = resolve(statesOf(state('fix', 0, 'completed'), state('fix', 1, 'completed')), {
            picks: new Map([['issues', 1]]), filters: new Map([['issues', 'needsYou']]),
        });
        const view = scope.loops.get('issues')!;
        expect(view.filter).toBe('all');
        expect(view.visibleItems).toHaveLength(2);
        expect(view.selectedIndex).toBe(1);
    });

    it('scopes a nested loop to the outer item, listing only what ran there', () => {
        const projection = projectWorkflowFlow(definition([loop('outer', [loop('inner', [step('leaf')])])]));
        const leaf = (outer: number, inner: number): WorkflowFlowNodeRunState => ({
            nodeId: 'leaf', invocationId: `leaf-${outer}-${inner}`, lifecycle: 'completed', attempt: '0',
            repetitions: [{ loopNodeId: 'outer', index: outer, label: `O${outer}` }, { loopNodeId: 'inner', index: inner, label: `I${inner}` }],
        });
        const scope = resolve(statesOf(leaf(0, 0), leaf(0, 1), leaf(1, 5)), { projection, picks: new Map([['outer', 1]]) });
        expect(scope.loops.get('inner')?.items.map(item => item.index)).toEqual([5]);
        expect(scope.runStates.get('leaf')?.map(entry => entry.invocationId)).toEqual(['leaf-1-5']);
    });

    it('leaves occurrences that sit in no loop untouched', () => {
        const before: WorkflowFlowNodeRunState = { nodeId: 'fix', invocationId: 'once', lifecycle: 'running', attempt: '0' };
        const scope = resolve(new Map([['fix', [before]]]));
        expect(scope.runStates.get('fix')).toEqual([before]);
        expect(scope.loops.size).toBe(0);
    });
});
