import { resolveWorkflowDefinitionRefV1, WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

/** Read-only editor previews use current references; Run maps receive accepted frozen children instead. */
export async function readWorkflowFlowChildren(
    definition: WorkflowDefinitionV1,
    options: NonNullable<Parameters<typeof resolveWorkflowDefinitionRefV1>[1]> = {},
): Promise<Readonly<Record<string, WorkflowDefinitionV1>>> {
    const children: Record<string, WorkflowDefinitionV1> = {};
    const visited = new Set<string>();
    const visit = async (current: WorkflowDefinitionV1): Promise<void> => {
        options.signal?.throwIfAborted();
        for (const block of walkWorkflowBlocks(current.blocks)) {
            if (block.kind !== 'workflow' || visited.has(block.workflowRef)) continue;
            visited.add(block.workflowRef);
            const resolved = await resolveWorkflowDefinitionRefV1(block.workflowRef, options);
            if (resolved === null) throw new WorkflowActionError({ message: 'Workflow source unavailable', rawCode: 'source_unavailable' });
            const child = WorkflowDefinitionV1Schema.parse(resolved.definition);
            children[block.workflowRef] = child;
            await visit(child);
        }
    };
    await visit(definition);
    return children;
}
