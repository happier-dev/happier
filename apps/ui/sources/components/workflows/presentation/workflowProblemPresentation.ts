import { AutomationReplyHandoffBlockedCodeV1Schema } from '@happier-dev/protocol/automations/event';
import {
    readWorkflowOperationProblemCopyV1,
    WORKFLOW_OPERATION_PROBLEM_COPY_V1,
    type WorkflowOperationErrorCodeV1,
    type WorkflowTargetUnavailableReasonV1,
    type WorkflowConversationUnavailableDetailsV1,
    type WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowDefinitionContentUnavailableReasonV1, WorkflowDefinitionMetadataV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import type { TranslationKeyNoParams } from '@/text/i18n';
import { isWorkflowOperationErrorCode, WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';
import { t } from '@/text';
import type { TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { DiscussionErrorCodeV1Schema } from '@happier-dev/protocol/discussions/api';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { formatExactTurnAutomationError } from '@/components/automations/automationErrorFormatting';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { presentSessionStartupFailureCause } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { describeActionExecutionPrerequisite } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

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

export type WorkflowProblemRepair = 'retry' | 'refresh' | 'settings' | 'none';

export type WorkflowProblemPresentation = Readonly<{
    /** Only an owner-reported missing definition uses the missing-link recovery. */
    missingDefinition?: true;
    /** The closed Workflow Protocol code, or `null` for other failures. */
    code: WorkflowOperationErrorCodeV1 | null;
    technicalDetails?: readonly TechnicalDetailsLine[];
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
    titleKey?: TranslationKeyNoParams;
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
    approval_required: { titleKey: 'notifications.activity.permissionFallbackBody', repair: 'none', accessibilitySemantics: 'alert' },
    not_authenticated: { repair: 'none', accessibilitySemantics: 'alert' },
    admission_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    invalid_token: { repair: 'none', accessibilitySemantics: 'alert' },
    subtree_denied: { repair: 'none', accessibilitySemantics: 'alert' },
    role_target_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    role_policy_unenforceable: { repair: 'none', accessibilitySemantics: 'alert' },
    role_runs_as_mismatch: { repair: 'none', accessibilitySemantics: 'alert' },
    policy_denied_field: { repair: 'none', accessibilitySemantics: 'alert' },
    permission_exceeds_ceiling: { repair: 'none', accessibilitySemantics: 'alert' },
    work_depth_exceeded: { repair: 'none', accessibilitySemantics: 'alert' },
    definition_exceeds_authority: { repair: 'none', accessibilitySemantics: 'alert' },
    invalid_input: { repair: 'none', accessibilitySemantics: 'alert' },
    missing_reference: { repair: 'none', accessibilitySemantics: 'alert' },
    invalid_reference_scope: { repair: 'none', accessibilitySemantics: 'alert' },
    target_unavailable: { repair: 'retry', accessibilitySemantics: 'alert' },
    github_webhook_home_unreachable: { repair: 'none', accessibilitySemantics: 'alert' },
    run_not_found: { titleKey: 'workflows.problem.notFoundTitle', repair: 'none', accessibilitySemantics: 'alert' },
    run_access_denied: { repair: 'none', accessibilitySemantics: 'alert' },
    visible_team_not_granted: { repair: 'none', accessibilitySemantics: 'alert' },
    currentness_conflict: { repair: 'refresh', accessibilitySemantics: 'alert' },
    event_watcher_not_current: { repair: 'none', accessibilitySemantics: 'alert' },
    event_watcher_not_owned: { repair: 'none', accessibilitySemantics: 'alert' },
    workflow_input_too_large: { repair: 'none', accessibilitySemantics: 'alert' },
    // A stop that cannot yet be proven is a wait, not a rejection — and no
    // acknowledgement anywhere may bypass it, so the copy has to say what is
    // being waited on rather than name the condition.
    workflow_outcome_unresolved: { repair: 'refresh', accessibilitySemantics: 'status' },
    workflow_http_error: { repair: 'retry', accessibilitySemantics: 'alert' },
    workflow_interaction_capacity_exceeded: { repair: 'retry', accessibilitySemantics: 'status' },
    workflow_conversation_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    continuation_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    workflow_workspace_restore_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    workflow_workspace_restore_failed: { repair: 'retry', accessibilitySemantics: 'alert' },
    workflow_step_preparation_failed: { repair: 'none', accessibilitySemantics: 'alert' },
    workflow_wait_self_dependency: { repair: 'none', accessibilitySemantics: 'alert' },
    ineligible_state: { repair: 'refresh', accessibilitySemantics: 'status' },
    custody_pending: { repair: 'refresh', accessibilitySemantics: 'status' },
    requester_custody_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    // The Account-content owner already has this sentence; a second one here
    // would be the same concept said two ways.
    content_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    history_not_readable: { titleKey: 'workflows.readState.historyTitle', repair: 'none', accessibilitySemantics: 'alert' },
    encryption_setup_required: { titleKey: 'workflows.readState.encryptionTitle', repair: 'settings', accessibilitySemantics: 'alert' },
    waiting_for_keys: { titleKey: 'workflows.readState.keysTitle', repair: 'retry', accessibilitySemantics: 'status' },
    storage_unavailable: { titleKey: 'workflows.readState.storageTitle', repair: 'retry', accessibilitySemantics: 'alert' },
    source_unavailable: { repair: 'none', accessibilitySemantics: 'alert' },
    legacy_conversion_unsupported: { repair: 'none', accessibilitySemantics: 'alert' },
    native_goal_owner: { repair: 'none', accessibilitySemantics: 'alert' },
    session_already_started: { repair: 'none', accessibilitySemantics: 'alert' },
    bot_paused: { repair: 'none', accessibilitySemantics: 'alert' },
    pull_request_link_required: { repair: 'none', accessibilitySemantics: 'alert' },
    present_user_required: { repair: 'none', accessibilitySemantics: 'alert' },
} as const satisfies Readonly<Record<WorkflowOperationErrorCodeV1, Omit<WorkflowProblemShape, 'messageKey'>>>;

function workflowProblemShape(code: WorkflowOperationErrorCodeV1): WorkflowProblemShape {
    return { ...WORKFLOW_PROBLEM_SHAPES[code], messageKey: WORKFLOW_OPERATION_PROBLEM_COPY_V1[code].key };
}

const UNAVAILABLE_TARGET = workflowProblemShape('target_unavailable');

const WORKFLOW_CONTENT_REASON_KEYS = {
    history_not_readable: 'workflows.readState.historyBody',
    invalid_header: 'workflows.contentReasons.invalidHeader',
    revision_mismatch: 'workflows.contentReasons.revisionMismatch',
    missing_body: 'workflows.contentReasons.missingBody',
    invalid_body: 'workflows.contentReasons.invalidBody',
    not_found: 'workflows.contentReasons.notFound',
} as const satisfies Readonly<Record<WorkflowDefinitionContentUnavailableReasonV1, TranslationKeyNoParams>>;

const WORKFLOW_TARGET_REASON_SHAPES = {
    // Host diagnostics refine the formerly bare target refusal. Retain its
    // existing presentation while keeping the finite consumer exhaustive.
    requester_projection_unavailable: UNAVAILABLE_TARGET,
    agent_start_context_unavailable: UNAVAILABLE_TARGET,
    caller_session_unavailable: UNAVAILABLE_TARGET,
    caller_run_unavailable: UNAVAILABLE_TARGET,
    caller_witness_invalid: UNAVAILABLE_TARGET,
    caller_depth_unavailable: UNAVAILABLE_TARGET,
    caller_machine_unavailable: UNAVAILABLE_TARGET,
    caller_workspace_unavailable: UNAVAILABLE_TARGET,
    caller_agent_unavailable: UNAVAILABLE_TARGET,
    caller_permission_unavailable: UNAVAILABLE_TARGET,
    role_source_incomplete: UNAVAILABLE_TARGET,
    role_overrides_unavailable: UNAVAILABLE_TARGET,
    spawn_policy_invalid: UNAVAILABLE_TARGET,
    materialization_owner_unavailable: { messageKey: 'workflows.problem.preExecution.materializationUnavailable', repair: 'retry' },
    run_admission_unavailable: UNAVAILABLE_TARGET,
    target_binding_mismatch: UNAVAILABLE_TARGET,
    publisher_machine_unavailable: UNAVAILABLE_TARGET,
    requester_runtime_unavailable: UNAVAILABLE_TARGET,
    credentialed_factory_failed: UNAVAILABLE_TARGET,
    profile_unavailable: { messageKey: 'workflows.problem.preExecution.profileUnavailable', repair: 'none' },
    engine_unavailable: { messageKey: 'workflows.problem.preExecution.engineUnavailable', repair: 'none' },
    machine_check_failed: { messageKey: 'workflows.problem.preExecution.machineCheckFailed', repair: 'retry' },
    agent_probe_failed: { messageKey: 'workflows.problem.preExecution.agentProbeFailed', repair: 'retry' },
    agent_not_installed: { messageKey: 'machineAgents.notInstalled', repair: 'none' },
    platform_unsupported: { messageKey: 'machineAgents.unsupportedOs', repair: 'none' },
    dependency_not_installed: { messageKey: 'machineAgents.blockSetUpToStart', repair: 'none' },
    session_unavailable: { messageKey: 'workflows.problem.conversationChecks.session_unavailable', repair: 'none' },
    action_unavailable: { messageKey: 'workflows.problem.preExecution.actionUnavailable', repair: 'none' },
    selection_unavailable: { messageKey: 'workflows.problem.preExecution.selectionUnavailable', repair: 'none' },
    session_creation_unavailable: { messageKey: 'workflows.problem.preExecution.sessionCreationUnavailable', repair: 'none' },
    detached_execution_unavailable: { messageKey: 'workflows.problem.preExecution.detachedExecutionUnavailable', repair: 'none' },
    workspace_unavailable: { messageKey: 'workflows.problem.workspaceUnavailable', repair: 'none' },
} as const satisfies Readonly<Record<WorkflowTargetUnavailableReasonV1, Pick<WorkflowProblemShape, 'messageKey' | 'repair'>>>;

export function formatWorkflowDefinitionContentUnavailableReason(reason: WorkflowDefinitionContentUnavailableReasonV1): string {
    return t(WORKFLOW_CONTENT_REASON_KEYS[reason]);
}

type WorkflowDefinitionLibraryTitleSource = Readonly<{
    metadata: WorkflowDefinitionMetadataV1 | null;
    definitionId?: string;
    contentUnavailableReason?: WorkflowDefinitionContentUnavailableReasonV1;
}>;

/** The title admitted from the header, if one could be read. */
export function readWorkflowDefinitionLibraryTitle(definition: WorkflowDefinitionLibraryTitleSource): string | null {
    if (definition.contentUnavailableReason === 'history_not_readable'
        && (!definition.metadata || definition.metadata.title === definition.definitionId)) {
        return null;
    }
    return definition.metadata?.title ?? null;
}

export function formatWorkflowDefinitionLibraryTitle(definition: WorkflowDefinitionLibraryTitleSource): string {
    return readWorkflowDefinitionLibraryTitle(definition) ?? t(definition.contentUnavailableReason === 'history_not_readable'
        ? 'workflows.readState.historyTitle' : 'common.unavailable');
}

function repairLabelFor(repair: WorkflowProblemRepair): string | null {
    if (repair === 'retry') return t('workflows.retry');
    if (repair === 'refresh') return t('common.refresh');
    if (repair === 'settings') return t('workflows.readState.openSettings');
    return null;
}

function present(
    code: WorkflowOperationErrorCodeV1 | null,
    shape: WorkflowProblemShape,
): WorkflowProblemPresentation {
    return {
        code,
        title: shape.titleKey ? t(shape.titleKey) : code === 'content_unavailable' ? t('common.unavailable') : shape.accessibilitySemantics === 'status'
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
export function resolveWorkflowProblemPresentation(
    error: unknown,
    scope?: 'run',
    target?: Readonly<{ machineName?: string | null }>,
): WorkflowProblemPresentation {
    const problem = resolveWorkflowProblemCopy(error, scope);
    const authorization = error instanceof WorkflowActionError
        ? ExternalActionHttpErrorSchema.safeParse(error.rawDetails) : null;
    const authorizationPhase = authorization?.success && 'authorizationRefusal' in authorization.data
        ? authorization.data.authorizationRefusal : undefined;
    const technicalCode = problem.code ?? (authorizationPhase && authorization?.success
        ? 'code' in authorization.data ? authorization.data.code : authorization.data.error : null);
    if (technicalCode === null) return problem;
    const failure = error instanceof WorkflowActionError ? error.failure : null;
    const details = failure && 'details' in failure ? failure.details : null;
    return { ...problem,
        ...(authorizationPhase ? { message: t('session.startFailure.cause.permission_denied'),
            repair: 'none', repairLabel: null } as const : {}),
        ...(problem.code === 'target_unavailable' && target?.machineName
            ? { message: `${target.machineName}: ${problem.message}` } : {}),
        technicalDetails: [
        { key: 'code', label: t('workflows.run.technical.failureCode'), value: technicalCode },
        ...(authorizationPhase ? [{ key: 'authorization-phase',
            label: t('approvals.failureTechnicalLabels.causePhase'), value: authorizationPhase }] : []),
        ...(details && 'reason' in details && typeof details.reason === 'string'
            ? [{ key: 'reason', label: t('workflows.run.technical.failureCause'), value: details.reason }] : []),
    ] };
}

function resolveWorkflowProblemCopy(
    error: unknown,
    /**
     * `run`: a control on a Run (Stop, Pause, a hold's answer). A Run has no local work to keep, so a
     * revision conflict there says the Run moved on rather than the editor's reassurance.
     */
    scope?: 'run',
): WorkflowProblemPresentation {
    const code = error instanceof WorkflowActionError && isWorkflowOperationErrorCode(error.code) ? error.code : null;
    if (code === null && error instanceof WorkflowActionError) {
        const discussionCode = DiscussionErrorCodeV1Schema.safeParse(error.rawCode);
        if (discussionCode.success) return {
            ...present(null, { ...GENERIC_SHAPE, repair: 'none' }),
            message: discussionFailureLabel(discussionCode.data),
        };
    }
    const failure = error instanceof WorkflowActionError ? error.failure : null;
    if (failure?.errorCode === 'currentness_conflict') {
        const copy = readWorkflowOperationProblemCopyV1(failure.errorCode, failure.details);
        if (copy.key !== WORKFLOW_OPERATION_PROBLEM_COPY_V1.currentness_conflict.key) {
            return present(code, { ...workflowProblemShape('currentness_conflict'), messageKey: copy.key, repair: 'none' });
        }
    }
    const exactTurn = formatExactTurnAutomationError(error);
    if (exactTurn) return { ...present(code, workflowProblemShape('ineligible_state')), message: exactTurn.message };
    if (scope === 'run' && code === 'currentness_conflict') {
        return present(code, { ...workflowProblemShape('currentness_conflict'), messageKey: 'workflows.problem.runMovedOn' });
    }
    if (failure?.errorCode === 'workflow_conversation_unavailable' && failure.details) {
        return { ...present(code, workflowProblemShape('workflow_conversation_unavailable')),
            message: formatWorkflowConversationProblem(failure.details) };
    }
    if (failure?.errorCode === 'target_unavailable' && failure.details && 'reason' in failure.details
        && failure.details.reason !== undefined) {
        if (failure.details.reason === 'workspace_unavailable') {
            if (failure.details.errorCode === 'workspace_unavailable') return present(code, {
                ...workflowProblemShape('target_unavailable'),
                messageKey: 'workflows.problem.workspaceUnavailable', repair: 'none',
            });
            if (failure.details.errorCode === 'workspace_conflict') return present(code, {
                ...workflowProblemShape('target_unavailable'),
                messageKey: 'workflows.problem.workspaceConflict', repair: 'none',
            });
            if (failure.details.errorCode === 'committed_revision_unavailable') return present(code, {
                ...workflowProblemShape('target_unavailable'),
                messageKey: 'workflows.problem.committedRevisionUnavailable', repair: 'none',
            });
        }
        return describeWorkflowTargetUnavailableProblem(failure.details);
    }
    if (failure?.errorCode === 'content_unavailable' && failure.details !== undefined) {
        if (failure.details.reason === 'not_found') {
            return { ...present(code, { ...workflowProblemShape('content_unavailable'),
                messageKey: WORKFLOW_CONTENT_REASON_KEYS.not_found }), missingDefinition: true };
        }
        if (failure.details.reason === 'account_role_overrides_unavailable') {
            return present(code, { ...workflowProblemShape('content_unavailable'),
                titleKey: 'workflows.problem.accountRolesUnavailableTitle',
                messageKey: 'workflows.problem.accountRolesUnavailable', repair: 'retry' });
        }
        return present(code, { ...workflowProblemShape('content_unavailable'),
            messageKey: WORKFLOW_CONTENT_REASON_KEYS[failure.details.reason] });
    }
    return code === null ? present(null, GENERIC_SHAPE) : describeWorkflowOperationProblem(code);
}

/** A known private-read reason from the metadata owner uses the same presentation as an Action failure. */
export function describeWorkflowOperationProblem(code: WorkflowOperationErrorCodeV1): WorkflowProblemPresentation {
    return present(code, workflowProblemShape(code));
}

export function describeWorkflowTargetUnavailableProblem(diagnostic?: Readonly<{
    reason: WorkflowTargetUnavailableReasonV1;
    platformReason?: 'os' | 'arch';
}>): WorkflowProblemPresentation {
    const reason = diagnostic?.reason;
    return present('target_unavailable', { ...UNAVAILABLE_TARGET,
        ...(reason === undefined ? {} : WORKFLOW_TARGET_REASON_SHAPES[reason]),
        ...(reason === 'platform_unsupported' && diagnostic?.platformReason === 'arch'
            ? { messageKey: 'machineAgents.unsupportedArch' } : {}) });
}

const GENERIC_RUN_FAILURE: WorkflowProblemShape = {
    messageKey: 'errors.operationFailed', repair: 'none', accessibilitySemantics: 'alert',
};

/** A Run can fail before it has an invocation that could carry its cause. */
export function resolveWorkflowRunProblemPresentation(
    run: Pick<WorkflowRunSummaryV1, 'state' | 'errorCode'>,
): WorkflowProblemPresentation | null {
    const code = run.errorCode ?? null;
    if (run.state === 'missed') return present(null, {
        messageKey: code === 'machine_offline' ? 'workflows.triggers.once.missedOffline'
            : code === 'machine_presence_at_due_unavailable' ? 'workflows.triggers.once.missedUnavailable'
                : 'workflows.triggers.once.missed',
        repair: 'none', accessibilitySemantics: 'status',
    });
    if (code === null || (run.state !== 'failed' && run.state !== 'interrupted' && run.state !== 'dispatch_failed')) return null;
    return describeKnownWorkflowRunFailure(code) ?? present(null, GENERIC_RUN_FAILURE);
}

/** Worker replies can carry either a known Run cause or ordinary result text. */
export function describeKnownWorkflowRunFailure(code: string): WorkflowProblemPresentation | null {
    if (code === 'workspace_unavailable') return describeWorkflowTargetUnavailableProblem({ reason: code });
    if (code === 'plugin_action_execution_placement_unavailable') {
        return describeWorkflowTargetUnavailableProblem({ reason: 'action_unavailable' });
    }
    if (isWorkflowOperationErrorCode(code)) return describeWorkflowOperationProblem(code);
    if (code === 'invalid_template') return present(null, {
        ...GENERIC_RUN_FAILURE, messageKey: 'automations.detail.runDetail.invalidTemplate',
    });
    if (code === 'connected_service_run_materialization_blocked') return present(null, {
        ...GENERIC_RUN_FAILURE, messageKey: 'workflows.problem.preExecution.connectedAccountPreparationBlocked',
    });
    const cause = presentSessionStartupFailureCause(code) ?? describeActionExecutionPrerequisite(code)?.message;
    return cause ? { ...present(null, GENERIC_RUN_FAILURE), message: cause } : null;
}

/**
 * Why a missed Run was missed, without restating that it was missed or what to do: for a surface whose heading
 * already says "Missed on …" and states its own instruction (a spent one-time trigger's History, R12 M12).
 */
export function formatWorkflowRunMissedCause(run: Pick<WorkflowRunSummaryV1, 'state' | 'errorCode'>): string | null {
    if (run.state !== 'missed') return null;
    return run.errorCode === 'machine_offline' ? t('workflows.triggers.once.missedCauseOffline')
        : run.errorCode === 'machine_presence_at_due_unavailable' ? t('workflows.triggers.once.missedCauseUnavailable') : null;
}

/** The same typed refusal is shown for an Action and a persisted invocation failure. */
export function formatWorkflowConversationProblem(details: WorkflowConversationUnavailableDetailsV1): string {
    return t(`workflows.problem.conversationChecks.${details.reason}`);
}

/** Convenience for the surfaces that show one sentence rather than a state card. */
export function formatWorkflowProblemMessage(error: unknown): string {
    return resolveWorkflowProblemPresentation(error).message;
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

/** Present the closed reply refusal without reclassifying its recovery eligibility. */
export function describeWorkflowReplyHandoffProblem(code: string | null): string | null {
    const refusal = AutomationReplyHandoffBlockedCodeV1Schema.safeParse(code);
    if (!refusal.success) return null;
    switch (refusal.data) {
        case 'history_not_readable':
        case 'encryption_setup_required':
        case 'waiting_for_keys':
            return describeWorkflowOperationProblem(refusal.data).message;
        case 'actionUnavailable':
            return t('pluginRuntime.actionUnavailable');
        case 'targetMismatch':
            return t('pluginRuntime.actionStale');
        case 'targetUnavailable':
            return describeWorkflowOperationProblem('target_unavailable').message;
        case 'invalidRequest':
        case 'invalidCustodyRequest':
            return t('pluginRuntime.invalidParameters');
        case 'unauthorizedCaller':
            return t('session.startFailure.cause.permission_denied');
        case 'contractIncompatible':
        case 'contractInvalid':
            return t('automations.detail.runMeta.replyHandoffUnrecoverableTitle');
        case 'immutableHandoffInvalid':
        case 'materialUnavailable':
        case 'payloadInvalid':
        case 'contentInvalid':
        case 'modeMismatch':
        case 'bindingMismatch':
        case 'legacyUnsupported':
            return t('workflows.contentUnavailable');
    }
}
