import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { readWorkflowFlowChildren } from './readWorkflowFlowChildren';
import { projectWorkflowFlow } from './workflowFlowProjection';

const savedRef = 'b559d6d3-cd30-4508-a9ba-4c7521a597a7';
const definition = (blocks: readonly unknown[]) => WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [], defaults: {}, blocks });
const call = (id: string, workflowRef: string) => ({ kind: 'workflow', id, workflowRef, input: {} });

describe('editor Flow definition reads', () => {
    it('starts both sibling reads before either settles and reads a shared descendant once', async () => {
        const sibling = 'b559d6d3-cd30-4508-a9ba-4c7521a597a8';
        const shared = 'b559d6d3-cd30-4508-a9ba-4c7521a597a9';
        const child = definition([call('shared', shared)]);
        const leaf = definition([{ kind: 'wait', id: 'leaf', document: { text: 'Continue?', references: [], attachments: [] } }]);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const readArtifact = vi.fn(async (id: string) => {
            if (id === shared) return { definition: leaf };
            await gate;
            return { definition: child };
        });

        const pending = readWorkflowFlowChildren(definition([call('left', savedRef), call('right', sibling)]), { readArtifact });
        const startedBeforeSettlement = readArtifact.mock.calls.map(([id]) => id);
        release();
        const children = await pending;

        expect(startedBeforeSettlement).toEqual([savedRef, sibling]);
        expect(readArtifact.mock.calls.map(([id]) => id)).toEqual([savedRef, sibling, shared]);
        expect(children).toEqual({ [savedRef]: child, [sibling]: child, [shared]: leaf });
    });

    it('reads only a changed nested reference, retaining unchanged children and dropping removed descendants', async () => {
        const nested = 'b559d6d3-cd30-4508-a9ba-4c7521a597a8';
        const parent = definition([call('saved', savedRef)]);
        const oldNested = definition([call('plan', 'builtin:plan-with-a-panel')]);
        const readArtifact = vi.fn(async (id: string) => ({ definition: id === savedRef
            ? definition([call('nested', nested)]) : oldNested }));
        const previousChildren = await readWorkflowFlowChildren(parent, { readArtifact });
        const changed = definition([{ kind: 'wait', id: 'new', document: { text: 'New', references: [], attachments: [] } }]);
        readArtifact.mockClear();
        readArtifact.mockResolvedValue({ definition: changed });
        const children = await readWorkflowFlowChildren(parent, { readArtifact, previousChildren,
            changedDefinitionIds: new Set([nested]), pluginSourcesChanged: false });
        expect(readArtifact.mock.calls.map(([id]) => id)).toEqual([nested]);
        expect(children[savedRef]).toBe(previousChildren[savedRef]);
        expect(children[nested]).toBe(changed);
        expect(children['builtin:plan-with-a-panel']).toBeUndefined();
    });
    it('demands each exact plugin reference once, including repeated nested calls', async () => {
        const workflow = 'plugin:example.recipe/check';
        const child = definition([{ kind: 'wait', id: 'held', document: { text: 'Continue?', references: [], attachments: [] } }]);
        // Plugin discovery is the external Action boundary; recursive routing stays real.
        const readPluginWorkflows = vi.fn(async () => [{ workflow, pluginId: 'example.recipe', version: '1.0.0',
            title: 'Check', definition: child }]);
        const children = await readWorkflowFlowChildren(definition([call('left', workflow), call('right', workflow)]), { readPluginWorkflows });
        expect(children[workflow]).toEqual(child);
        expect(readPluginWorkflows.mock.calls).toEqual([[workflow]]);
    });
    it('resolves referenced saved and built-in children through the canonical resolver and expands reused calls separately', async () => {
        const parent = definition([call('left', savedRef), call('right', savedRef)]);
        const child = definition([call('plan', 'builtin:plan-with-a-panel')]);
        // Artifact reads are the external persistent/network boundary; reference routing stays real.
        const children = await readWorkflowFlowChildren(parent, { readArtifact: async (id) => id === savedRef ? { definition: child } : null });
        expect(children[savedRef]).toEqual(child);
        expect(children['builtin:plan-with-a-panel']?.blocks.length).toBeGreaterThan(0);
        const projection = projectWorkflowFlow(parent, children);
        expect(projection.nodesById.get('left')?.childNodeIds).not.toEqual(projection.nodesById.get('right')?.childNodeIds);
        // The nested built-in expands to its own planner steps; the parent itself has only workflow calls.
        expect(projection.nodes.some((node) => node.kind === 'step')).toBe(true);
    });

    it('reports an unreadable child and honors cancellation instead of inventing its structure', async () => {
        const parent = definition([call('child', savedRef)]);
        await expect(readWorkflowFlowChildren(parent, { readArtifact: async () => null })).rejects.toMatchObject({ code: 'source_unavailable' });
        const controller = new AbortController();
        controller.abort();
        await expect(readWorkflowFlowChildren(parent, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
