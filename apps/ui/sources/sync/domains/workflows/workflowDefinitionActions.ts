import { WorkflowDefinitionCreateRequestV1Schema, WorkflowDefinitionCreateResultV1Schema, WorkflowDefinitionDeleteRequestV1Schema, WorkflowDefinitionDeleteResultV1Schema, WorkflowDefinitionGetRequestV1Schema, WorkflowDefinitionGetResultV1Schema, WorkflowDefinitionListRequestV1Schema, WorkflowDefinitionListResultV1Schema, WorkflowDefinitionUpdateRequestV1Schema, WorkflowDefinitionUpdateResultV1Schema, type WorkflowDefinitionCreateResultV1, type WorkflowDefinitionDeleteResultV1, type WorkflowDefinitionGetResultV1, type WorkflowDefinitionListResultV1, type WorkflowDefinitionUpdateResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { WorkflowArtifactRevisionV1, WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { callWorkflowAction } from './callWorkflowAction';

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
    signal?: AbortSignal;
}>): Promise<TResult> {
    return callWorkflowAction({
        ...params,
        fallbackMessage: 'Workflow definition request failed',
    });
}

function signalOption(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
    return signal === undefined ? {} : { signal };
}

/** One shared page of Account workflows and current read-only plugin descriptors. */
export async function listWorkflowDefinitions(params: Readonly<{
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
}> = {}): Promise<WorkflowDefinitionListResultV1> {
    const input = WorkflowDefinitionListRequestV1Schema.parse({
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.list',
        input,
        parseResult: (value) => WorkflowDefinitionListResultV1Schema.parse(value),
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
}>): Promise<WorkflowDefinitionGetResultV1> {
    const input = WorkflowDefinitionGetRequestV1Schema.parse({ definitionId: params.definitionId });
    return callDefinitionAction({
        actionId: 'workflow.definition.get',
        input,
        parseResult: (value) => WorkflowDefinitionGetResultV1Schema.parse(value),
        ...signalOption(params.signal),
    });
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
    signal?: AbortSignal;
}>): Promise<WorkflowDefinitionCreateResultV1> {
    const input = WorkflowDefinitionCreateRequestV1Schema.parse({
        definitionId: params.definitionId,
        definition: params.definition,
        metadata: params.metadata,
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.create',
        input,
        parseResult: (value) => WorkflowDefinitionCreateResultV1Schema.parse(value),
        ...signalOption(params.signal),
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
    signal?: AbortSignal;
}>): Promise<WorkflowDefinitionUpdateResultV1> {
    const input = WorkflowDefinitionUpdateRequestV1Schema.parse({
        definitionId: params.definitionId,
        expectedRevision: params.expectedRevision,
        definition: params.definition,
        metadata: params.metadata,
    });
    return callDefinitionAction({
        actionId: 'workflow.definition.update',
        input,
        parseResult: (value) => WorkflowDefinitionUpdateResultV1Schema.parse(value),
        ...signalOption(params.signal),
    });
}

/**
 * Remove a definition from the library. Existing Automations and admitted Runs
 * are unaffected; that contract is the Action owner's, not this client's.
 */
export async function deleteWorkflowDefinition(params: Readonly<{
    definitionId: string;
    signal?: AbortSignal;
}>): Promise<WorkflowDefinitionDeleteResultV1> {
    const input = WorkflowDefinitionDeleteRequestV1Schema.parse({ definitionId: params.definitionId });
    return callDefinitionAction({
        actionId: 'workflow.definition.delete',
        input,
        parseResult: (value) => WorkflowDefinitionDeleteResultV1Schema.parse(value),
        ...signalOption(params.signal),
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
