import type {
    WorkflowOperationErrorCodeV1,
    WorkflowRunAvailabilityV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowDefinitionContentUnavailableReasonV1, WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import type { TranslationKeyNoParams } from '@/text/i18n';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { t } from '@/text';

/**
 * The one place a Workflow failure becomes something a person can read.
 *
 * `workflowActionError.ts` preserves the closed Protocol code precisely so a
 * surface does not have to match prose — but preserving it only helps if
 * something turns it into copy. Every workflow surface (library, editor, Run
 * detail, availability gate) read that error and either dropped the code for
 * one generic sentence or leaked the server's internal reason, so the same
 * failure said four different things depending on where it landed.
 *
 * Two rules are structural rather than stylistic:
 *
 * 1. **Nothing here decides a failure.** The code always comes from the Action
 *    owner; this module only describes it, and an unrecognized transport
 *    failure stays generic rather than being coerced into a workflow code the
 *    owner never reported.
 * 2. **No surface string-matches on its own.** Adding a branch on a reason code
 *    anywhere else is a second mapping, which is the drift this replaces.
 */

export type WorkflowProblemRepair = 'retry' | 'refresh' | 'none';

export type WorkflowProblemPresentation = Readonly<{
    /** The closed Protocol code, or `null` for an unrecognized transport failure. */
    code: WorkflowOperationErrorCodeV1 | null;
    title: string;
    /** Localized copy. Never a raw code and never the server's own sentence. */
    message: string;
    repair: WorkflowProblemRepair;
    /** Already-translated label, or `null` when nothing the person presses helps. */
    repairLabel: string | null;
    /**
     * Whether this interrupts what the person just did, or reports something
     * they are waiting on. It drives the live-region role, so a wait does not
     * assertively interrupt a screen reader.
     */
    accessibilitySemantics: 'alert' | 'status';
}>;

type WorkflowProblemShape = Readonly<{
    messageKey: TranslationKeyNoParams;
    repair: WorkflowProblemRepair;
    accessibilitySemantics: 'alert' | 'status';
}>;

/**
 * The complete closed vocabulary. It is a record rather than a switch so a
 * Protocol addition fails to compile here — at the one owner — instead of
 * silently reaching four screens as the generic sentence.
 *
 * Codes share copy only where the person's situation and repair are genuinely
 * identical: a missing reference and an out-of-scope reference are both "this
 * definition needs repair before it can run", and a conversation that is gone
 * and one that cannot be continued both mean the same thing to the reader.
 */
const WORKFLOW_PROBLEM_SHAPES = {
    subtree_denied: { messageKey: 'workflows.problem.subtreeDenied', repair: 'none', accessibilitySemantics: 'alert' },
    role_target_unavailable: { messageKey: 'workflows.problem.roleTargetUnavailable', repair: 'none', accessibilitySemantics: 'alert' },
    role_runs_as_mismatch: { messageKey: 'workflows.problem.roleRunsAsMismatch', repair: 'none', accessibilitySemantics: 'alert' },
    policy_denied_field: { messageKey: 'workflows.problem.policyDeniedField', repair: 'none', accessibilitySemantics: 'alert' },
    permission_exceeds_ceiling: { messageKey: 'workflows.problem.permissionExceedsCeiling', repair: 'none', accessibilitySemantics: 'alert' },
    work_depth_exceeded: { messageKey: 'workflows.problem.workDepthExceeded', repair: 'none', accessibilitySemantics: 'alert' },
    definition_exceeds_authority: { messageKey: 'workflows.problem.definitionExceedsAuthority', repair: 'none', accessibilitySemantics: 'alert' },
    invalid_input: { messageKey: 'workflows.problem.needsRepair', repair: 'none', accessibilitySemantics: 'alert' },
    missing_reference: { messageKey: 'workflows.problem.needsRepair', repair: 'none', accessibilitySemantics: 'alert' },
    invalid_reference_scope: { messageKey: 'workflows.problem.needsRepair', repair: 'none', accessibilitySemantics: 'alert' },
    target_unavailable: { messageKey: 'workflows.problem.targetUnavailable', repair: 'retry', accessibilitySemantics: 'alert' },
    run_not_found: { messageKey: 'workflows.problem.notFound', repair: 'none', accessibilitySemantics: 'alert' },
    run_access_denied: { messageKey: 'workflows.problem.accessDenied', repair: 'none', accessibilitySemantics: 'alert' },
    currentness_conflict: { messageKey: 'workflows.problem.conflict', repair: 'refresh', accessibilitySemantics: 'alert' },
    workflow_input_too_large: { messageKey: 'workflows.problem.inputTooLarge', repair: 'none', accessibilitySemantics: 'alert' },
    // A stop that cannot yet be proven is a wait, not a rejection — and no
    // acknowledgement anywhere may bypass it, so the copy has to say what is
    // being waited on rather than name the condition.
    workflow_outcome_unresolved: { messageKey: 'workflows.problem.unresolvedOutcome', repair: 'refresh', accessibilitySemantics: 'status' },
    workflow_interaction_capacity_exceeded: { messageKey: 'workflows.problem.interactionCapacity', repair: 'retry', accessibilitySemantics: 'status' },
    workflow_conversation_unavailable: { messageKey: 'workflows.problem.conversationUnavailable', repair: 'none', accessibilitySemantics: 'alert' },
    continuation_unavailable: { messageKey: 'workflows.problem.conversationUnavailable', repair: 'none', accessibilitySemantics: 'alert' },
    workflow_workspace_restore_unavailable: { messageKey: 'workflows.problem.workspaceRestore', repair: 'none', accessibilitySemantics: 'alert' },
    workflow_workspace_restore_failed: { messageKey: 'workflows.problem.workspaceRestore', repair: 'retry', accessibilitySemantics: 'alert' },
    workflow_wait_self_dependency: { messageKey: 'workflows.problem.waitSelfDependency', repair: 'none', accessibilitySemantics: 'alert' },
    ineligible_state: { messageKey: 'workflows.problem.ineligible', repair: 'refresh', accessibilitySemantics: 'status' },
    custody_pending: { messageKey: 'workflows.problem.custodyPending', repair: 'refresh', accessibilitySemantics: 'status' },
    // The Account-content owner already has this sentence; a second one here
    // would be the same concept said two ways.
    content_unavailable: { messageKey: 'workflows.contentUnavailable', repair: 'none', accessibilitySemantics: 'alert' },
    source_unavailable: { messageKey: 'workflows.problem.sourceUnavailable', repair: 'none', accessibilitySemantics: 'alert' },
    legacy_conversion_unsupported: { messageKey: 'workflows.problem.legacyConversionUnsupported', repair: 'none', accessibilitySemantics: 'alert' },
    native_goal_owner: { messageKey: 'workflows.problem.nativeGoalOwner', repair: 'none', accessibilitySemantics: 'alert' },
    session_already_started: { messageKey: 'workflows.problem.sessionAlreadyStarted', repair: 'none', accessibilitySemantics: 'alert' },
} as const satisfies Readonly<Record<WorkflowOperationErrorCodeV1, WorkflowProblemShape>>;

/**
 * Why a canonical control is not available, as the Run owner reported it.
 *
 * These codes are an open string on the wire, so an unrecognized one still
 * produces a reason — the control is not available here — rather than the
 * identifier or an unexplained disabled button.
 */
const WORKFLOW_AVAILABILITY_REASON_KEYS = {
    run_terminal: 'workflows.problem.runFinished',
    ineligible_state: 'workflows.problem.ineligible',
    checkpoint_unavailable: 'workflows.problem.checkpointUnavailable',
    private_recovery_evidence_required: 'workflows.problem.recoveryEvidenceRequired',
    execution_not_admitted: 'workflows.problem.executionNotStarted',
    custody_settled: 'workflows.problem.custodySettled',
} as const satisfies Readonly<Record<string, TranslationKeyNoParams>>;

const WORKFLOW_CONTENT_REASON_KEYS = {
    invalid_header: 'workflows.contentReasons.invalidHeader',
    revision_mismatch: 'workflows.contentReasons.revisionMismatch',
    missing_body: 'workflows.contentReasons.missingBody',
    invalid_body: 'workflows.contentReasons.invalidBody',
    not_found: 'workflows.contentReasons.notFound',
} as const satisfies Readonly<Record<WorkflowDefinitionContentUnavailableReasonV1, TranslationKeyNoParams>>;

export function formatWorkflowDefinitionContentUnavailableReason(reason: WorkflowDefinitionContentUnavailableReasonV1): string {
    return t(WORKFLOW_CONTENT_REASON_KEYS[reason]);
}

/** A missing rejected-header title is unavailable, not a fabricated authored name. */
export function formatWorkflowDefinitionLibraryTitle(definition: Readonly<{ metadata: WorkflowDefinitionMetadataV1 | null }>): string {
    return definition.metadata?.title ?? t('common.unavailable');
}

function repairLabelFor(repair: WorkflowProblemRepair): string | null {
    if (repair === 'retry') return t('workflows.retry');
    if (repair === 'refresh') return t('common.refresh');
    return null;
}

function present(
    code: WorkflowOperationErrorCodeV1 | null,
    shape: WorkflowProblemShape,
): WorkflowProblemPresentation {
    return {
        code,
        title: code === 'content_unavailable' ? t('common.unavailable') : shape.accessibilitySemantics === 'status'
            ? t('workflows.problem.waitingTitle')
            : t('workflows.problem.title'),
        message: t(shape.messageKey),
        repair: shape.repair,
        repairLabel: repairLabelFor(shape.repair),
        accessibilitySemantics: shape.accessibilitySemantics,
    };
}

const GENERIC_SHAPE: WorkflowProblemShape = {
    messageKey: 'workflows.problem.generic',
    repair: 'retry',
    accessibilitySemantics: 'alert',
};

/**
 * The localized state for anything a workflow Action threw.
 *
 * A failure with no recognized workflow code — a transport error, an aborted
 * request, a thrown `Error` from somewhere else — stays generic and keeps
 * `code: null`, because inventing a workflow meaning for it would be the
 * fabricated-code defect rather than the discarded-code one.
 */
export function resolveWorkflowProblemPresentation(error: unknown): WorkflowProblemPresentation {
    const code = error instanceof WorkflowActionError ? error.code : null;
    const failure = error instanceof WorkflowActionError ? error.failure : null;
    if (failure?.errorCode === 'content_unavailable' && failure.details !== undefined) {
        return present(code, { ...WORKFLOW_PROBLEM_SHAPES.content_unavailable,
            messageKey: WORKFLOW_CONTENT_REASON_KEYS[failure.details.reason] });
    }
    if (failure?.errorCode === 'legacy_conversion_unsupported' && failure.details.reason === 'channel_reply_handoff') {
        return present(code, { ...WORKFLOW_PROBLEM_SHAPES.legacy_conversion_unsupported,
            messageKey: 'workflows.triggers.legacy.channelReplyRefusal' });
    }
    return code === null ? present(null, GENERIC_SHAPE) : present(code, WORKFLOW_PROBLEM_SHAPES[code]);
}

/** Convenience for the surfaces that show one sentence rather than a state card. */
export function formatWorkflowProblemMessage(error: unknown): string {
    return resolveWorkflowProblemPresentation(error).message;
}

/**
 * The nearby reason for a canonical control the Run owner disabled.
 *
 * `null` means the owner recorded no reason for that operation, so nothing is
 * shown — an explanation is not manufactured to fill the space.
 */
export function resolveWorkflowOperationUnavailableReason(
    availability: WorkflowRunAvailabilityV1,
    operation: WorkflowRunAvailabilityV1['disabledReasons'][number]['operation'],
): string | null {
    const reason = availability.disabledReasons.find((candidate) => candidate.operation === operation);
    if (reason === undefined) return null;
    const key = (WORKFLOW_AVAILABILITY_REASON_KEYS as Readonly<Record<string, TranslationKeyNoParams>>)[reason.code];
    return key === undefined ? t('workflows.problem.unavailableHere') : t(key);
}

/**
 * The Workflow capability is not available on this server.
 *
 * This is not a failed read, and the load-failure copy the gate borrowed both
 * misdescribed it and invited a retry that could never succeed.
 */
export function resolveWorkflowsUnavailablePresentation(): WorkflowProblemPresentation {
    return {
        code: null,
        title: t('workflows.unavailable.title'),
        message: t('workflows.unavailable.body'),
        repair: 'none',
        repairLabel: null,
        accessibilitySemantics: 'status',
    };
}
