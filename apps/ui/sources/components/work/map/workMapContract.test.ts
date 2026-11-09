import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

import { renderScreen } from '@/dev/testkit';
import { projectWorkflowFlow } from '@/components/workflows/flow/workflowFlowProjection';

import {
    buildHappierWorkMap,
    HappierWorkMapView,
    type HappierWorkMap,
    type HappierWorkMapNode,
} from '@happier-dev/plugin-ui/presentation';

import { WorkMapView } from './WorkMapView';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

/**
 * A lead and the work it started, as a session/run producer would declare it:
 * the lead owns one session and one background run through declared edges;
 * a second root session is listed right after the lead but has no edge.
 */
function leadProducer(): HappierWorkMap {
    return buildHappierWorkMap({
        relationships: 'authored',
        nodes: [
            { nodeId: 'lead', label: 'Payments v2 rollout', parentNodeId: null, open: { kind: 'session', sessionId: 'lead' } },
            { nodeId: 'worker', label: 'Checkout UI retry', parentNodeId: 'lead', open: { kind: 'session', sessionId: 'worker' } },
            { nodeId: 'run-1', label: 'Review each', parentNodeId: 'lead', open: { kind: 'run', runId: 'run-1' } },
            { nodeId: 'solo', label: 'Unrelated session', parentNodeId: null, open: { kind: 'session', sessionId: 'solo' } },
        ],
    });
}

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

function step(id: string) {
    return {
        kind: 'step' as const,
        id,
        document: { text: `${id} prompt`, references: [], attachments: [] },
        input: [],
        result: { kind: 'text' as const },
    };
}

function workflowDefinition(): WorkflowDefinitionV1 {
    return {
        version: 1,
        inputs: [],
        defaults: { agentTarget: AGENT_TARGET },
        blocks: [
            step('analyze'),
            {
                kind: 'parallel' as const,
                id: 'fan-out',
                failurePolicy: 'fail_stop' as const,
                branches: [{ id: 'checks', blocks: [step('review'), step('implement')] }],
            },
        ],
    } as WorkflowDefinitionV1;
}

async function renderMap<TNode extends HappierWorkMapNode>(
    map: HappierWorkMap<TNode>,
    onOpen: (node: TNode) => void,
) {
    return renderScreen(React.createElement(WorkMapView<TNode>, {
        map,
        selectedNodeId: null,
        testIDPrefix: 'map',
        accessibilityLabelForNode: (node: TNode) => node.label,
        renderStatus: (node: TNode) => React.createElement('status-slot', { testID: `status-${node.nodeId}` }),
        onOpen,
    }));
}

function itemIdsInside(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    groupTestId: string,
): string[] {
    const group = screen.findByTestId(groupTestId);
    if (group === null) return [];
    return group
        .findAll((instance) => typeof instance.props.testID === 'string'
            && instance.props.testID.startsWith('map-item-')
            && typeof instance.type === 'string')
        .map((instance) => String(instance.props.testID).slice('map-item-'.length));
}

describe('work map neutral contract', () => {
    it('derives structure from declared edges only: order never becomes an edge', () => {
        const map = leadProducer();

        expect(map.rootNodeIds).toEqual(['lead', 'solo']);
        expect(map.nodesById.get('lead')?.childNodeIds).toEqual(['worker', 'run-1']);
        expect(map.nodesById.get('run-1')).toMatchObject({ depth: 1, ordinal: 2, parentNodeId: 'lead' });
        // Declared immediately after the lead's work, `solo` is still its own root.
        expect(map.nodesById.get('solo')).toMatchObject({ depth: 0, ordinal: 2, parentNodeId: null, childNodeIds: [] });
    });

    it('renders a session/run producer through the one renderer, nesting exactly the declared edges', async () => {
        const opened: HappierWorkMapNode[] = [];
        const screen = await renderMap(leadProducer(), (node) => opened.push(node));

        expect(itemIdsInside(screen, 'map-group-lead')).toEqual(['worker', 'run-1']);
        expect(screen.findByTestId('map-group-solo')).toBeNull();
        expect(itemIdsInside(screen, 'map-group-worker')).toEqual([]);
        expect(screen.findByTestId('status-run-1')).not.toBeNull();

        screen.pressByTestId('map-node-run-1');
        expect(opened.map((node) => node.open)).toEqual([{ kind: 'run', runId: 'run-1' }]);
        // Core's map is the shared renderer plugin authors use, bound to the app's theme and text.
        expect(screen.findAll((node) => node.type === HappierWorkMapView)).toHaveLength(1);
    });

    it('renders the workflow producer through the same renderer with a workflow-step open target', async () => {
        const opened: HappierWorkMapNode[] = [];
        const screen = await renderMap(projectWorkflowFlow(workflowDefinition()), (node) => opened.push(node));

        expect(itemIdsInside(screen, 'map-group-fan-out')).toEqual(['fan-out#checks', 'review', 'implement']);
        expect(itemIdsInside(screen, 'map-group-fan-out#checks')).toEqual(['review', 'implement']);
        // Sequential root steps stay siblings; the renderer adds no edge between them.
        expect(screen.findByTestId('map-group-analyze')).toBeNull();

        screen.pressByTestId('map-node-review');
        expect(opened.map((node) => node.open)).toEqual([{ kind: 'workflow-step', nodeId: 'review' }]);
    });

    it('keeps retained rows mounted while selection, nested facts and the open handler advance', async () => {
        const map = leadProducer();
        const initialOpen = vi.fn();
        const nextOpen = vi.fn();
        const label = (node: HappierWorkMapNode) => node.label;
        const view = (current: HappierWorkMap, selectedNodeId: string | null, onOpen: typeof initialOpen) => (
            React.createElement(WorkMapView, {
                map: current, selectedNodeId, onOpen, testIDPrefix: 'map', accessibilityLabelForNode: label,
            })
        );
        const screen = await renderScreen(view(map, 'worker', initialOpen));
        const worker = screen.findByTestId('map-node-worker');
        const solo = screen.findByTestId('map-node-solo');
        await screen.update(view(map, 'worker', nextOpen));
        expect(screen.findByTestId('map-node-solo')).toBe(solo);
        await screen.pressByTestIdAsync('map-node-solo');
        expect(initialOpen).not.toHaveBeenCalled();
        expect(nextOpen.mock.calls.at(-1)?.[0]).toBe(map.nodesById.get('solo'));

        const nextWorker = { ...map.nodesById.get('worker')!, label: 'Checkout retry finished' };
        const updated = {
            ...map,
            nodes: map.nodes.map(node => node.nodeId === nextWorker.nodeId ? nextWorker : node),
            nodesById: new Map([...map.nodesById, [nextWorker.nodeId, nextWorker]]),
        };
        await screen.update(view(updated, 'run-1', nextOpen));
        expect(screen.findByTestId('map-node-worker')).toBe(worker);
        expect(screen.findByTestId('map-node-worker')?.props.accessibilityLabel).toBe(nextWorker.label);
        expect(screen.findByTestId('map-node-worker')?.props.accessibilityState.selected).toBe(false);
        expect(screen.findByTestId('map-node-run-1')?.props.accessibilityState.selected).toBe(true);
        expect(itemIdsInside(screen, 'map-group-lead')).toEqual(['worker', 'run-1']);
        await screen.pressByTestIdAsync('map-node-worker');
        expect(nextOpen.mock.calls.at(-1)?.[0]).toBe(nextWorker);
    });
});
