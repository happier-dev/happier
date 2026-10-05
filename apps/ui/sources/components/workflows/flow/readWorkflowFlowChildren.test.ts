import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { readWorkflowFlowChildren } from './readWorkflowFlowChildren';
import { projectWorkflowFlow } from './workflowFlowProjection';

const savedRef = 'b559d6d3-cd30-4508-a9ba-4c7521a597a7';
const definition = (blocks: readonly unknown[]) => WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks });
const call = (id: string, workflowRef: string) => ({ kind: 'workflow', id, workflowRef, input: {} });

describe('editor Flow definition reads', () => {
    it('resolves referenced saved and built-in children through the canonical resolver and expands reused calls separately', async () => {
        const parent = definition([call('left', savedRef), call('right', savedRef)]);
        const child = definition([call('plan', 'builtin:plan-with-a-panel')]);
        // Artifact reads are the external persistent/network boundary; reference routing stays real.
        const children = await readWorkflowFlowChildren(parent, { readArtifact: async (id) => id === savedRef ? { definition: child } : null });
        expect(children[savedRef]).toEqual(child);
        expect(children['builtin:plan-with-a-panel']?.blocks.length).toBeGreaterThan(0);
        const projection = projectWorkflowFlow(parent, children);
        expect(projection.nodesById.get('left')?.childNodeIds).not.toEqual(projection.nodesById.get('right')?.childNodeIds);
        expect(projection.nodes.some((node) => node.kind === 'action')).toBe(true);
    });

    it('reports an unreadable child and honors cancellation instead of inventing its structure', async () => {
        const parent = definition([call('child', savedRef)]);
        await expect(readWorkflowFlowChildren(parent, { readArtifact: async () => null })).rejects.toMatchObject({ code: 'source_unavailable' });
        const controller = new AbortController();
        controller.abort();
        await expect(readWorkflowFlowChildren(parent, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
