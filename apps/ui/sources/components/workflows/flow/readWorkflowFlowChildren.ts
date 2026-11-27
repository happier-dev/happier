import { resolveWorkflowDefinitionRefV1, type WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows/workflowPluginSourceContractV1';

/** Read-only editor previews use current references; Run maps receive accepted frozen children instead. */
export async function readWorkflowFlowChildren(
    definition: WorkflowDefinitionV1,
    options: Omit<NonNullable<Parameters<typeof resolveWorkflowDefinitionRefV1>[1]>, 'readPluginWorkflows' | 'readArtifact'> & Readonly<{
        readArtifact?: (id: string, signal?: AbortSignal) => Promise<Readonly<{ definition: WorkflowDefinitionV1 }> | null>;
        readPluginWorkflows?: (workflow: string) => Promise<readonly WorkflowPluginSourceV1[]>;
        previousChildren?: Readonly<Record<string, WorkflowDefinitionV1>>;
        changedDefinitionIds?: ReadonlySet<string>;
        pluginSourcesChanged?: boolean;
    }> = {},
): Promise<Readonly<Record<string, WorkflowDefinitionV1>>> {
    const children: Record<string, WorkflowDefinitionV1> = {};
    const visited = new Set<string>();
    const visit = async (current: WorkflowDefinitionV1): Promise<void> => {
        options.signal?.throwIfAborted();
        const reads: Promise<WorkflowDefinitionV1>[] = [];
        for (const block of walkWorkflowBlocks(current.blocks)) {
            if (block.kind !== 'workflow' || visited.has(block.workflowRef)) continue;
            const workflowRef = block.workflowRef;
            visited.add(workflowRef);
            reads.push((async () => {
                const ref = parseWorkflowDefinitionRefV1(workflowRef);
                let child = options.previousChildren?.[workflowRef];
                if (!child || (ref?.kind === 'artifact' && (options.changedDefinitionIds === undefined || options.changedDefinitionIds.has(ref.artifactId)))
                    || (ref?.kind === 'plugin' && options.pluginSourcesChanged !== false)) {
                    const resolved = await resolveWorkflowDefinitionRefV1(workflowRef, { ...options,
                        readPluginWorkflows: () => options.readPluginWorkflows?.(workflowRef) ?? Promise.resolve([]),
                    });
                    if (resolved === null) throw new WorkflowActionError({ message: 'Workflow source unavailable', rawCode: 'source_unavailable' });
                    child = resolved.definition;
                }
                children[workflowRef] = child;
                return child;
            })());
        }
        const siblings = await Promise.all(reads);
        await Promise.all(siblings.map(visit));
    };
    await visit(definition);
    return children;
}
