import type { DeploymentEnvironmentHeaderV1, WorkflowDefinitionV1 } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { z } from 'zod/mini';
import { createHash } from 'node:crypto';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readWorkflowDataCreationResult } from './targets/workflowDataCreationResult';

export type PreviewCloseWorkflowHost = Readonly<{
    readEnvironments(): Promise<readonly DeploymentEnvironmentHeaderV1[]>;
    readEnvironment(environmentId: string): Promise<DeploymentEnvironmentDetailV1>;
    readInvocations(input: Readonly<{ runId: string; cursor?: string }>): Promise<z.infer<typeof WorkflowInvocationListResultV1Schema>>;
}>;

/** PR close consumes the existing authenticated Workflow captures and teardown Actions. */
export async function readPreviewCloseWorkflowForHost(host: PreviewCloseWorkflowHost): Promise<WorkflowDefinitionV1 | null> {
    const blocks: WorkflowDefinitionV1['blocks'] = [];
    const literal = (value: unknown) => ({ kind: 'literal' as const, value: normalizeStrictJsonValue(value) });
    const key = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    for (const candidate of await host.readEnvironments()) {
        const child = await host.readEnvironment(candidate.id);
        const header = child.environment;
        const runId = child.content.previewCreationRunId;
        let previous: string | undefined;
        const captures: { runId: string; invocationId: string; targetLinkId: string }[] = [];
        if (runId) {
            let cursor: string | undefined;
            do {
                const page = await host.readInvocations({ runId, ...(cursor ? { cursor } : {}) });
                for (const invocation of page.invocationDetails ?? []) {
                    const execution = invocation.progress.execution;
                    const output = execution?.kind === 'action' ? execution.output : undefined;
                    if (!output || typeof output !== 'object' || Array.isArray(output) || output.kind !== 'deployment_data_created') continue;
                    const captured = readWorkflowDataCreationResult({ invocation }, { runId, invocationId: invocation.index.id });
                    // The Run may contain other effects; choose only this child's captured DATA creation.
                    if (captured.input.serverId !== header.serverId || captured.input.environmentId !== header.id) continue;
                    const row = child.targetLinks.find(row => row.targetLink.id === captured.input.targetLinkId);
                    if (!row) {
                        throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
                    }
                    captures.push({ runId, invocationId: invocation.index.id, targetLinkId: row.targetLink.id });
                }
                cursor = page.nextCursor;
            } while (cursor);
        }
        for (const capture of captures) {
            const link = child.targetLinks.find(row => row.targetLink.id === capture.targetLinkId)!.targetLink;
            const id = `data-close-${blocks.length}`;
            blocks.push({ kind: 'action', id, actionId: 'deployments.teardown', input: {
                serverId: literal(header.serverId), environmentId: literal(header.id),
                expectedRevision: previous ? { kind: 'result', producer: { blockId: previous, scope: { kind: 'current' } }, path: ['revision'] } : literal(header.revision),
                targetLinkId: literal(link.id), expectedTargetLinkRevision: literal(link.revision),
                dataCreation: literal({ runId: capture.runId, invocationId: capture.invocationId }), reason: literal('previewClosed'),
                requestKey: literal(key('preview-data-close', capture.runId, capture.invocationId)),
                ...(!header.runtimeTargetLinkId && capture === captures.at(-1) ? { removeEnvironment: literal(true) } : {}),
            } });
            previous = id;
        }
        if (header.runtimeTargetLinkId) {
            blocks.push({ kind: 'action', id: `runtime-close-${blocks.length}`, actionId: 'deployments.teardown', input: {
                serverId: literal(header.serverId), environmentId: literal(header.id), reason: literal('previewClosed'),
                requestKey: literal(key('preview-close', header.id)), removeEnvironment: literal(true),
            } });
        } else if (captures.length === 0) {
            // Empty previews have no native workload to tear down.
            blocks.push({ kind: 'action', id: `empty-close-${blocks.length}`, actionId: 'deployments.environments.delete', input: {
                serverId: literal(header.serverId), environmentId: literal(header.id), expectedRevision: literal(header.revision),
            } });
        }
    }
    return blocks.length ? WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [], blocks }) : null;
}
