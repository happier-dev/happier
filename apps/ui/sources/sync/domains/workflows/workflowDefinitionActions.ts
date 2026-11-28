import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionCreateResultV1Schema, WorkflowDefinitionDeleteRequestV1Schema, WorkflowDefinitionDeleteResultV1Schema, WorkflowDefinitionGetRequestV1Schema, WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListRequestV1Schema, WorkflowDefinitionListResultV1Schema, WorkflowDefinitionUpdateRequestV1Schema, WorkflowDefinitionUpdateResultV1Schema, type WorkflowDefinitionCreateResultV1, type WorkflowDefinitionDeleteResultV1, type WorkflowDefinitionGetResultV1, type WorkflowDefinitionListResultV1, type WorkflowDefinitionUpdateResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { WorkflowIntendedTriggerV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowDefinitionArtifactHeaderV1ReadSchema, type WorkflowArtifactRevisionV1, type WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import { HappyError } from '@/utils/errors/errors';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { callWorkflowAction, type WorkflowActionCallerContext, type WorkflowActionOperation } from './callWorkflowAction';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { WorkflowDefinitionExportResultV1Schema, type WorkflowDefinitionExportResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { WorkflowDefinitionCaptureRequestV1Schema, WorkflowDefinitionCaptureResultV1Schema,
    type WorkflowDefinitionCaptureRequestV1, type WorkflowDefinitionCaptureResultV1 } from '@happier-dev/protocol/workflows/actionsV1';

/** Read/transform only; persistence and start remain their existing Actions. */
export async function captureWorkflowDefinition(params: WorkflowDefinitionCaptureRequestV1 & Readonly<{
    signal?: AbortSignal; accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<WorkflowDefinitionCaptureResultV1> {
    const { signal, accountLifetime, ...input } = params;
    return callDefinitionAction({ actionId: 'workflow.definition.capture', input: WorkflowDefinitionCaptureRequestV1Schema.parse(input),
        parseResult: value => WorkflowDefinitionCaptureResultV1Schema.parse(value), ...signalOption(signal),
        ...(accountLifetime === undefined ? {} : { accountLifetime }) });
}

/** Export reads the saved Artifact once at the canonical document owner. The platform owns delivery. */
export async function exportSavedWorkflowDocument(params: Readonly<{ definitionId: string; signal?: AbortSignal }>): Promise<Extract<WorkflowDefinitionExportResultV1, { definitionId: string }>> {
    return callDefinitionAction({ actionId: 'workflow.definition.export',
        input: WorkflowDefinitionGetRequestV1Schema.parse({ definitionId: params.definitionId }),
        parseResult: (value) => WorkflowDefinitionExportResultV1Schema.def.options[0].parse(value), ...signalOption(params.signal) });
}

/**
 * The workflow library client: `workflow.definition.list/get/create/update/delete`.
 *
 * The library is an Account-scoped view of Artifact kind
 * `workflow-definition.v1`, alongside read-only plugin sources from the serving
 * machine's canonical projection. This module is deliberately thin: it names the
 * Action, hands the one Action front door a request the canonical Protocol
 * schema accepts, and parses the reply through the canonical result schema. It
 * adds no transport, no CRUD service and no local definition cache, so the row,
 * detail and edit surfaces all read the same identity, scope and Action owner.
 *
 * Parsing in both directions is the fail-closed boundary: a malformed request
 * never reaches the front door, and a malformed or partially migrated reply
 * never reaches a screen.
 *
 * Failures are raised as the existing canonical {@link WorkflowActionError},
 * which preserves the closed `WORKFLOW_OPERATION_ERROR_CODES_V1` vocabulary, so
 * a save conflict is recognized by code rather than by matching prose.
 */

/** Dispatch and failure mapping live at the one shared workflow Action seam. */
async function callDefinitionAction<TResult>(params: Readonly<{
    actionId: ActionId;
    input: unknown;
    parseResult: (value: unknown) => TResult;
    deletedArtifactId?: string;
    deletedArtifactTitle?: string;
    context?: WorkflowActionCallerContext;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> & WorkflowActionOperation): Promise<TResult> {
    const lifetime = params.accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : params.accountLifetime;
    const result = await callWorkflowAction({
        ...params,
        fallbackMessage: 'Workflow definition request failed',
    });
    if (lifetime?.isCurrent() && params.actionId === 'workflow.definition.delete') {
        // Deletion retains its landing receipt. The feed publishes content changes
        // once for every client, including the client that saved them.
        publishHomeAccountChange(lifetime.scope.serverId, undefined,
            { workflowDefinitionsAffect: false,
                ...(params.deletedArtifactId === undefined ? {} : { deletedWorkflowDefinitionIds: [params.deletedArtifactId],
                    ...(params.deletedArtifactTitle === undefined ? {} : {
                        deletedArtifactTitles: { [params.deletedArtifactId]: params.deletedArtifactTitle },
                    }) }) });
    }
    return result;
}

function signalOption(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
    return signal === undefined ? {} : { signal };
}

/** One shared page of Account workflows and current read-only plugin descriptors. */
export async function listWorkflowDefinitions(params: Readonly<{
    cursor?: string;
    limit?: number;
    workflow?: string;
    definitionId?: string;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> = {}): Promise<WorkflowDefinitionListResultV1> {
    const input = WorkflowDefinitionListRequestV1Schema.parse({
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.workflow === undefined ? {} : { workflow: params.workflow }),
        ...(params.definitionId === undefined ? {} : { definitionId: params.definitionId }),
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.list',
        input,
        parseResult: (value) => WorkflowDefinitionListResultV1Schema.parse(value),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
        ...signalOption(params.signal),
    });
}

/**
 * One saved workflow with the exact Artifact revision it was read at. Edit
 * opens on that revision and returns it as `expectedRevision` when saving.
 */
export async function getWorkflowDefinition(params: Readonly<{
    definitionId: string;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<WorkflowDefinitionGetResultV1> {
    const input = WorkflowDefinitionGetRequestV1Schema.parse({ definitionId: params.definitionId });
    return callDefinitionAction({
        actionId: 'workflow.definition.get',
        input,
        parseResult: (value) => WorkflowDefinitionGetResultV1Schema.parse(value),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
        ...signalOption(params.signal),
    });
}

/** An accepted editor can revalidate its Artifact revision and access without opening its body. */
export async function readWorkflowDefinitionRevision(params: Readonly<{
    definitionId: string;
    accountLifetime: ServerAccountScopeLifetime;
    signal: AbortSignal;
}>): Promise<Pick<WorkflowDefinitionGetResultV1, 'definitionId' | 'revision' | 'access'> | null> {
    const { definitionId, accountLifetime, signal } = params;
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, signal, undefined, accountLifetime.scope);
    try {
        const artifact = await account.readArtifactHeader(definitionId, { signal, fresh: true });
        account.assertCurrent();
        if (!artifact?.isDecrypted || !artifact.access || artifact.id !== definitionId) return null;
        const header = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(artifact.rawHeader);
        if (!header.success || header.data.definitionId !== definitionId
            || header.data.revision.headerVersion !== artifact.headerVersion
            || header.data.revision.bodyVersion !== artifact.bodyVersion) return null;
        return { definitionId, revision: header.data.revision, access: artifact.access };
    } catch (error) {
        throwIfAborted(signal);
        // Older Homes without the header projection retain the exact read.
        if (error instanceof HappyError && (error.status === 400 || error.status === 404 || error.status === 405)) return null;
        throw error;
    } finally {
        account.dispose();
    }
}

/**
 * Store a reusable definition. `definition` is the authored candidate in the
 * canonical ingress dialect; the request schema and the Action owner normalize
 * it, so the caller never invents a second serialization.
 */
export async function createWorkflowDefinition(params: Readonly<{
    definitionId: string;
    definition: unknown;
    metadata: WorkflowDefinitionMetadataV1;
    intendedTriggers?: readonly WorkflowIntendedTriggerV1[];
    context?: WorkflowActionCallerContext;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> & WorkflowActionOperation): Promise<WorkflowDefinitionCreateResultV1> {
    const input = WorkflowDefinitionCreateRequestV1Schema.parse({
        definitionId: params.definitionId,
        definition: params.definition,
        metadata: params.metadata,
        ...(params.intendedTriggers === undefined ? {} : { intendedTriggers: params.intendedTriggers }),
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.create',
        input,
        parseResult: (value) => WorkflowDefinitionCreateResultV1Schema.parse(value),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
        ...(params.context === undefined ? {} : { context: params.context }),
        ...signalOption(params.signal),
        ...(params.operationProgress === undefined ? {} : { operationProgress: params.operationProgress }),
    });
}

/**
 * Save over an existing definition at the revision the editor opened.
 *
 * `expectedRevision` is required by the canonical request, so a save that lost
 * a race is a currentness conflict the editor can present — never a silent
 * last-writer-wins overwrite of someone else's work.
 */
export async function updateWorkflowDefinition(params: Readonly<{
    definitionId: string;
    expectedRevision: WorkflowArtifactRevisionV1;
    definition: unknown;
    metadata: WorkflowDefinitionMetadataV1;
    intendedTriggers?: readonly WorkflowIntendedTriggerV1[];
    context?: WorkflowActionCallerContext;
    accountLifetime?: ServerAccountScopeLifetime | null;
}> & WorkflowActionOperation): Promise<WorkflowDefinitionUpdateResultV1> {
    const input = WorkflowDefinitionUpdateRequestV1Schema.parse({
        definitionId: params.definitionId,
        expectedRevision: params.expectedRevision,
        definition: params.definition,
        metadata: params.metadata,
        ...(params.intendedTriggers === undefined ? {} : { intendedTriggers: params.intendedTriggers }),
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.update',
        input,
        parseResult: (value) => WorkflowDefinitionUpdateResultV1Schema.parse(value),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
        ...(params.context === undefined ? {} : { context: params.context }),
        ...signalOption(params.signal),
        ...(params.operationProgress === undefined ? {} : { operationProgress: params.operationProgress }),
    });
}

/**
 * Remove a definition and its attached triggers. Admitted Runs are unaffected;
 * that contract is the Action owner's, not this client's.
 */
export async function deleteWorkflowDefinition(params: Readonly<{
    definitionId: string;
    /** The saved title the caller already read, for local landing feedback after the row disappears. */
    title?: string;
    signal?: AbortSignal;
    onTransportIssued?: () => void;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): Promise<WorkflowDefinitionDeleteResultV1> {
    const input = WorkflowDefinitionDeleteRequestV1Schema.parse({ definitionId: params.definitionId });
    return callDefinitionAction({
        actionId: 'workflow.definition.delete',
        input,
        deletedArtifactId: input.definitionId,
        ...(params.title === undefined ? {} : { deletedArtifactTitle: params.title }),
        parseResult: (value) => WorkflowDefinitionDeleteResultV1Schema.parse(value),
        ...(params.accountLifetime === undefined ? {} : { accountLifetime: params.accountLifetime }),
        ...signalOption(params.signal),
        ...(params.onTransportIssued ? { context: { onTransportIssued: params.onTransportIssued } } : {}),
    });
}

/**
 * Whether a rejected save is the canonical `currentness_conflict`.
 *
 * The code comes from the closed `WORKFLOW_OPERATION_ERROR_CODES_V1` vocabulary
 * carried by {@link WorkflowActionError}; an `Error` that merely happens to
 * mention the phrase is not a conflict, because a transport failure must not be
 * presented as "someone else saved a newer version".
 */
export function isWorkflowDefinitionConflictError(error: unknown): boolean {
    return error instanceof WorkflowActionError && error.code === 'currentness_conflict';
}
