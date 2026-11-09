import type {
    WorkflowDefinitionV1} from '@happier-dev/protocol/workflows/workflowV1';
import type {
    WorkflowRunAcceptedContextV1} from '@happier-dev/protocol/workflows/actionsV1';
import type {
    WorkflowRunSummaryV1} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type {
    JsonValue,
} from '@happier-dev/protocol/json/strictJsonValue';
import type { WorkflowProjectTargetV1, WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows';

import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { workflowDefinitionPromptTitle } from './workflowBlockLabel';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows';

/**
 * An unsaved authored copy reviewed from a Run, for saving or fresh recovery.
 *
 * D4 resolves a missing workspace by **restoring** it and resuming the same
 * Run. When restoration is impossible there is exactly one truthful remaining
 * offer: open the accepted definition as a new Run the person reviews and
 * starts themselves. This seed carries that content; it admits nothing. The
 * predecessor Run keeps its own history, results and identity, and no completed
 * work is imported into the new one.
 *
 * Like the Schedule seed, it travels through the existing temporary-data store
 * so the route carries only an opaque id — never a prompt, reference or
 * accepted input value.
 */

export type WorkflowReviewedRunSeed = Readonly<{
    name: string;
    description?: string;
    captureProvenance?: WorkflowDefinitionMetadataV1['captureProvenance'];
    /** The accepted host placement, so the new Run starts where the old one ran. */
    project: WorkflowProjectTargetV1;
    /** The accepted definition with root Agent-step runtime choices pinned for a fresh admission. */
    definition: WorkflowDefinitionV1;
    /** The accepted Run-scoped runtime choice, preserved rather than defaulted. */
    executionTarget: WorkflowRunAcceptedContextV1['executionTarget'];
    /** The accepted declared inputs, so the review starts from what actually ran. */
    inputs: WorkflowRunAcceptedContextV1['inputs'];
    /** Review navigation only, never reusable definition content. */
    sourceRunId: string;
    /** Exact displayed Plan hold; navigation/admission intent, never saved definition content. */
    planReview?: Readonly<{
        /** Explicit changed-proposal admission identity, otherwise the original hold id is used. */
        runId?: string;
        invocationId: string;
        expectedContentRevision: string;
        value: JsonValue;
        completeReview: boolean;
        originSessionId?: string;
    }>;
    /** Recovery provenance only. Ordinary library copies do not supersede a Run. */
    supersededRunId?: string;
    /** The exact reason code that made in-place recovery impossible. */
    reasonCode?: string;
}>;

export function buildWorkflowReviewedRunSeed(params: Readonly<{
    run: WorkflowRunSummaryV1;
    definition: WorkflowDefinitionV1;
    acceptedContext: WorkflowRunAcceptedContextV1;
    reasonCode?: string;
}>): WorkflowReviewedRunSeed {
    const prepared = prepareWorkflowRunStartV1(params);
    return {
        name: params.acceptedContext.metadata?.title ?? workflowDefinitionPromptTitle(params.definition) ?? '',
        ...(params.acceptedContext.metadata?.description === undefined
            ? {} : { description: params.acceptedContext.metadata.description }),
        ...(params.acceptedContext.metadata?.captureProvenance === undefined
            ? {} : { captureProvenance: params.acceptedContext.metadata.captureProvenance }),
        project: params.acceptedContext.workspaceTarget.project,
        definition: prepared.definition,
        executionTarget: params.acceptedContext.executionTarget,
        inputs: prepared.inputs!,
        sourceRunId: params.run.id,
        ...(params.reasonCode === undefined ? {} : {
            supersededRunId: params.run.id,
            reasonCode: params.reasonCode,
        }),
    };
}

const WORKFLOW_REVIEWED_RUN_SEED_KIND = 'happier.workflow-reviewed-run-seed.v1' as const;

/** Returns the opaque route parameter for a reviewed new Run. */
export function storeWorkflowReviewedRunSeed(seed: WorkflowReviewedRunSeed, accountLifetime?: ServerAccountScopeLifetime | null): string {
    return storeWorkflowEditorDraftSeed(WORKFLOW_REVIEWED_RUN_SEED_KIND, seed, accountLifetime);
}

/**
 * Reads without consuming during render. The editor consumes after commit,
 * keeping initial render retries safe without permitting history reuse.
 */
export function readWorkflowReviewedRunSeed(dataId: string, scope?: ServerAccountScope | null): WorkflowReviewedRunSeed | null {
    return readWorkflowEditorDraftSeed(WORKFLOW_REVIEWED_RUN_SEED_KIND, dataId, scope);
}
