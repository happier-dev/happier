import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentEnvironmentHeaderV1, WorkflowDefinitionV1 } from '@happier-dev/protocol';
import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { z } from 'zod/mini';
import { createHash } from 'node:crypto';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readWorkflowDataCreationResult } from './targets/workflowDataCreationResult';
import { DeploymentDeployActionInputV1Schema, DeploymentReceiptResultV1Schema,
    type DeploymentPreviewCleanupV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

export type PreviewCloseWorkflowHost = Readonly<{
    readEnvironments(): Promise<readonly DeploymentEnvironmentHeaderV1[]>;
    readCompanions?(environmentId: string): Promise<readonly DeploymentEnvironmentHeaderV1[]>;
    readEnvironment(environmentId: string): Promise<DeploymentEnvironmentDetailV1>;
    readInvocations(input: Readonly<{ runId: string; cursor?: string }>): Promise<z.infer<typeof WorkflowInvocationListResultV1Schema>>;
}>;

/** PR close consumes the existing authenticated Workflow captures and teardown Actions. */
export async function readPreviewCloseWorkflowForHost(host: PreviewCloseWorkflowHost): Promise<WorkflowDefinitionV1 | null> {
    const blocks: WorkflowDefinitionV1['blocks'][number][] = [];
    const literal = (value: unknown) => ({ kind: 'literal' as const, value: normalizeStrictJsonValue(value) });
    const key = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    const candidates: DeploymentEnvironmentHeaderV1[] = [];
    for (const preview of await host.readEnvironments()) {
        // Relation lookup keeps failed or partially provisioned companions reachable on close.
        candidates.push(...(await host.readCompanions?.(preview.id) ?? []));
        if (preview.deletedAtMs === undefined) candidates.push(preview);
    }
    for (const candidate of candidates) {
        const child = await host.readEnvironment(candidate.id);
        const header = child.environment;
        const runId = child.content.previewCreationRunId;
        let previous: string | undefined;
        let nativeCleanup: DeploymentPreviewCleanupV1 | undefined;
        const captures: { runId: string; invocationId: string; targetLinkId: string }[] = [];
        if (runId) {
            let cursor: string | undefined;
            do {
                const page = await host.readInvocations({ runId, ...(cursor ? { cursor } : {}) });
                for (const invocation of page.invocationDetails ?? []) {
                    const execution = invocation.progress.execution;
                    const output = execution?.kind === 'action' ? execution.output : undefined;
                    if (execution?.kind === 'action' && execution.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 && output !== undefined) {
                        if (invocation.index.runId !== runId) throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
                        const input = DeploymentDeployActionInputV1Schema.parse(execution.input);
                        if (input.serverId !== header.serverId || input.environmentId !== header.id
                            || input.targetLinkId !== header.runtimeTargetLinkId) continue;
                        // An approval hold records the request before any deployment effect or receipt exists.
                        if (invocation.index.lifecycle === 'waiting_for_approval') continue;
                        const result = DeploymentReceiptResultV1Schema.parse(output);
                        if (result.ok && 'state' in result && result.state === 'succeeded'
                            && result.environmentId === header.id && result.previewCleanup) nativeCleanup = result.previewCleanup;
                        continue;
                    }
                    if (!output || typeof output !== 'object' || Array.isArray(output) || output.kind !== 'deployment_data_created') continue;
                    const captured = readWorkflowDataCreationResult({ invocation }, { runId, invocationId: invocation.index.id });
                    // The Run may contain other effects; choose only this child's captured DATA creation.
                    if (captured.input.serverId !== header.serverId || captured.input.environmentId !== header.id) continue;
                    const row = child.targetLinks.find(row => row.targetLink.id === captured.input.targetLinkId);
                    if (!row) {
                        throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
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
                ...(nativeCleanup ? { volumes: literal(nativeCleanup.volumes), machines: literal(nativeCleanup.machines) } : {}),
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
