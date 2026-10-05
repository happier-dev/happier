import type {
    WorkflowDefinitionV1,
    WorkflowRunAcceptedContextV1,
    WorkflowRunSummaryV1,
    JsonValue,
} from '@happier-dev/protocol';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { getTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { workflowDefinitionPromptTitle } from './workflowBlockLabel';
import { setWorkflowStepExecutionTarget } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';

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
    let repeatDraft = { ...params.definition, name: '' };
    for (const leaf of params.acceptedContext.materializedLeaves) {
        if (leaf.sourceKey === '$root' && leaf.kind === 'step') {
            repeatDraft = setWorkflowStepExecutionTarget(repeatDraft, leaf.blockId, leaf.executionTarget.kind);
        }
    }
    return {
        name: params.acceptedContext.metadata?.title ?? workflowDefinitionPromptTitle(params.definition) ?? '',
        ...(params.acceptedContext.metadata?.description === undefined
            ? {} : { description: params.acceptedContext.metadata.description }),
        project: params.acceptedContext.workspaceTarget.project,
        definition: { ...params.definition, blocks: repeatDraft.blocks },
        executionTarget: params.acceptedContext.executionTarget,
        inputs: params.acceptedContext.inputs,
        sourceRunId: params.run.id,
        ...(params.reasonCode === undefined ? {} : {
            supersededRunId: params.run.id,
            reasonCode: params.reasonCode,
        }),
    };
}

const WORKFLOW_REVIEWED_RUN_SEED_KIND = 'happier.workflow-reviewed-run-seed.v1' as const;

type StoredWorkflowReviewedRunSeed = Readonly<{
    kind: typeof WORKFLOW_REVIEWED_RUN_SEED_KIND;
    seed: WorkflowReviewedRunSeed;
    lifetime: ActiveServerAccountScopeLifetime | null;
}>;

/** Returns the opaque route parameter for a reviewed new Run. */
export function storeWorkflowReviewedRunSeed(seed: WorkflowReviewedRunSeed): string {
    return storeTempData({
        kind: WORKFLOW_REVIEWED_RUN_SEED_KIND,
        seed,
        lifetime: captureActiveServerAccountScopeLifetime(),
    } satisfies StoredWorkflowReviewedRunSeed);
}

/**
 * Reads a seed exactly once. The store is single-use by design, so returning
 * through history cannot silently re-seed an editor with stale accepted bytes.
 */
export function readWorkflowReviewedRunSeed(dataId: string): WorkflowReviewedRunSeed | null {
    const stored = getTempData<StoredWorkflowReviewedRunSeed>(dataId);
    if (stored === null || stored.kind !== WORKFLOW_REVIEWED_RUN_SEED_KIND || !stored.lifetime?.isCurrent()) return null;
    return stored.seed;
}
