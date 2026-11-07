import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { z } from 'zod/mini';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACCOUNT_STORED_CONTENT_SESSION_TURN_WAITING_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { SessionNeedsYouRaiseInputV1Schema, type SessionQuestionContextV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import { normalizeInteractionTransientQuestionsV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { toStructuredQuestionPermissionInput } from './structuredQuestionPermissionInput';
import { SESSION_NEEDS_YOU_REQUEST_SOURCE } from './requestKind';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import { isApprovalReviewerModelEligible } from './approvalReviewerEligibility';
import { logger } from "@/ui/logger";
import { configuration } from '@/configuration';
import type { ApiSessionClient } from "@/api/session/sessionClient";
import { AgentState } from "@/api/types";
import { updateAgentStateBestEffort as updateAgentStateBestEffortShared } from "@/api/session/sessionWritesBestEffort";
import { isToolAllowedForSession, makeToolIdentifier } from './permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist } from './applyPermissionAllowlistUpdates';
import { recordToolTraceEvent, type ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import { PluginContributionLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExecutionRunStartResponseSchema, ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionPermissionExternalHumanDecisionActorV1Schema, SessionPermissionRemoteRespondInputV1Schema, SessionUserActionRemoteAnswerInputV1Schema, SessionPermissionRequestIdV1Schema, SESSION_PERMISSION_REMOTE_QUESTION_CHOICE_UTF8_BYTES, SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES, SESSION_PERMISSION_REMOTE_SUMMARY_DETAIL_UTF8_BYTES, SESSION_PERMISSION_REMOTE_SUMMARY_TITLE_UTF8_BYTES, SESSION_PERMISSION_REMOTE_SUMMARY_TOOL_LABEL_UTF8_BYTES } from '@happier-dev/protocol/sessions/permissions/v1';
import { SessionPermissionRemoteGrantRecordV1Schema, SessionPermissionRemoteSettlementRecordV1Schema, SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX, SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX } from '@happier-dev/protocol/sessions/permissions/mediationRecordsV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionPermissionRespondRpcParamsV1Schema, SessionUserActionPassUpRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import type { SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/questionV1';
import { NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE } from '@happier-dev/protocol/sessions/permissions/v1';
import { SessionInputCausalPermissionAuthorityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { StructuredQuestionAnswersV1Schema, StructuredQuestionResponseV1Schema } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import { TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import type { AccountSettings, SessionPermissionRemoteRespondInputV1, SessionPermissionRemoteRespondOutputV1, SessionPermissionRemotePendingListOutputV1, SessionUserActionRemoteAnswerInputV1, SessionUserActionRemoteAnswerOutputV1, SessionPermissionRemoteGrantRecordV1, SessionPermissionRemoteGrantsListOutputV1, SessionPermissionRemoteGrantRevokeOutputV1, SessionPermissionMediationRecordIdentityV1, SessionPermissionExternalHumanDecisionActorV1, SessionPermissionSourceAuthorityV1, AgentRequestQuestionSummary, StructuredQuestionAnswersV1 } from '@happier-dev/protocol';
import { buildAgentRequestSemanticSummary, formatPermissionRequestSummary, requiresFullFormForRemoteUserAction, summarizeToolInputForNotification } from '@happier-dev/protocol/activity/agentRequestSummary';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude/permissionRequestSource';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS, parseSocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcSessionPermissionRespondAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type {
    PermissionRequestPushSender as PermissionRequestPushSenderFromSettings,
} from '@/settings/notifications/permissionRequestPush';
import { HAPPIER_ACTION_REQUEST_SOURCE, isAgentStructuredQuestionRequest, resolveAgentRequestKind } from './requestKind';
import { admitManagerQuestionAnswer, resolveInitialQuestionHandler } from './sessionQuestionManager';
import { normalizeStructuredQuestionPermissionAnswers } from './structuredQuestionAnswers';
import { AgentStateRequestStore } from './agentStateRequestStore';
import type {
    AgentStateRequestResponseTarget,
    PermissionResponseClaim,
} from './agentStateRequestStore';
import {
    createPermissionRequestCoordinator,
    type PermissionRequestCoordinator,
    type PermissionRequestCoordinatorCompletedRequest,
    type PermissionRequestCoordinatorContext,
} from './permissionRequestCoordinator';
import {
    isPermissionRequestOwnedByPlugin,
    isPermissionRequestOwnedByPluginTurn,
    normalizePermissionRequestOwner,
    permissionRequestOwnersEqual,
    type PermissionRequestOwner,
} from './permissionRequestOwner';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import type {
    PermissionMediationRecordStore,
    PermissionMediationStoredRecord,
    PermissionMediationRecordWrite,
} from './mediation/permissionMediationRecordStore';
import { createPermissionMediationRecordStore } from './mediation/permissionMediationRecordStore';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { AccountRoleOverridesReadV1 } from '@happier-dev/protocol/prompts/roles/roleOverrideRecordV1';
import { isWorkspaceWriteDeniedByRole } from './workspaceWritePolicy';
import type { CodingPromptBehaviorV1 } from '@happier-dev/protocol';

type AgentStateRequestStoreBindableSession = Readonly<{
    bindAgentStateRequestStore?: (store: AgentStateRequestStore) => void;
    respondToSessionActionConfirmation?: (
        response: PermissionResponse,
        actor: SocketRpcSessionPermissionRespondAuthorizationContext['actor'],
    ) => Promise<'resolved' | 'not_found' | 'invalid'>;
}>;

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

const ApprovalReviewerAnswerSchema = z.strictObject({
    decision: z.enum(['allow_once', 'escalate']),
    reason: z.optional(z.string()),
});

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    /** Exact host-projected turn custody; absent only for released legacy requests. */
    turnId?: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    answeringClientCategory?: import('@happier-dev/protocol/sessions/permissions/respondRpcParamsV1').SessionPermissionAnsweringClientCategoryV1;
    // When the user chooses "don't ask again (session)", the UI may send a tool allowlist.
    allowedTools?: string[];
    allowTools?: string[]; // legacy alias
    // Claude Agent SDK / Claude Code hook responses may attach provider-specific permission updates.
    updatedPermissions?: unknown;
    /**
     * Structured user answers (AskUserQuestion user action).
     *
     * When present, the agent can complete the request without requiring an additional free-form user message.
     */
    answers?: StructuredQuestionAnswersV1 | Readonly<Record<string, string>>;
    execPolicyAmendment?: {
        command: string[];
    };
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
    causalPermissionContext?: AcpPermissionCallContext;
    /**
     * A handler-owned policy reread for this pending request. The permission
     * owner remains here; this callback can only preserve or narrow a terminal
     * result using the handler's current causal mode/ceiling.
     */
    resolveCurrentPermissionDecision?: () => PermissionResult;
    acknowledgeDecisionApplication?: (decision: PermissionResult) => Promise<void>;
    coordinatorManaged?: boolean;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
    answers?: StructuredQuestionAnswersV1;
}

/**
 * Outcome of routing an inbound permission/user-action response to a pending request.
 *
 * `not_found` means the explicit request id is unknown (never seen / already gone) — the caller must
 * surface a typed failure instead of a fabricated success (gap 28/29).
 */
export type PermissionResponseRoutingResult =
    | { status: 'resolved' }
    | { status: 'not_found' }
    | { status: 'invalid' };

/**
 * Typed RPC result for `session.permission.respond` / `session.user_action.answer` / `permission`.
 *
 * Resolving a pending request returns `void` (unchanged success contract). An unknown explicit id
 * returns a typed `permission_request_not_found` so a stale UI tap cannot read as silent success.
 */
export type PermissionRespondRpcResult =
    | void
    | Readonly<{
        ok: false;
        errorCode:
            | 'permission_request_not_found'
            | 'permission_actor_unattributable'
            | 'permission_response_invalid'
            | 'present_user_required';
        requestId: string;
    }>;

type UnknownRecord = Readonly<Record<string, unknown>>;
type ActiveRemoteMediationGrant = Extract<
    PermissionMediationStoredRecord,
    Readonly<{ kind: 'remote_grant.v1' }>
>;

type RemoteMediationLedgerAdmission =
    | Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'sessionGrantCapacityExceeded' }>;

function asUnknownRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function hasOnlyKeys(record: UnknownRecord, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(record).every((key) => allowed.has(key));
}

function normalizePermissionRuleIdentifier(rule: unknown): string | null {
    if (typeof rule === 'string') return rule.trim() || null;
    const record = asUnknownRecord(rule);
    if (!record || !hasOnlyKeys(record, ['toolName', 'ruleContent'])) return null;
    const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
    if (!toolName) return null;
    if (typeof record.ruleContent === 'undefined') return toolName;
    if (typeof record.ruleContent !== 'string') return null;
    const ruleContent = record.ruleContent.trim();
    return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

function remoteMediationSourceAuthoritiesEqual(
    left: SessionPermissionSourceAuthorityV1,
    right: SessionPermissionSourceAuthorityV1,
): boolean {
    return left.kind === right.kind
        && left.mediatorPluginId === right.mediatorPluginId
        && left.sourceRef === right.sourceRef
        && left.sourceRevisionOrEpoch === right.sourceRevisionOrEpoch
        && left.admittedPermissionCeiling === right.admittedPermissionCeiling
        && left.remoteApprovalMaxScope === right.remoteApprovalMaxScope;
}

function mediationRecordIdentity(input: Readonly<{
    sessionId: string;
    turnId: string;
    requestId: string;
}>): SessionPermissionMediationRecordIdentityV1 {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        requestId: input.requestId,
    };
}

function mediationRecordIdentityKey(identity: SessionPermissionMediationRecordIdentityV1): string {
    return JSON.stringify([identity.sessionId, identity.turnId, identity.requestId]);
}

/**
 * One bounded page of the remote pending-permission projection. The bound is
 * the protocol's own `max(32)` on the projected array, not a nearby number.
 */
const REMOTE_PENDING_PERMISSION_PAGE_SIZE = 32;

type MediatedPendingPermissionKeyset = Readonly<{
    createdAtMs: number;
    turnId: string;
    requestId: string;
}>;

type MediatedPendingRequest = SessionPermissionRemotePendingListOutputV1['requests'][number];
type MediatedPendingRequestSummary = MediatedPendingRequest['agentRequestSummary'];
type MediatedPendingUserActionQuestion = Extract<
    MediatedPendingRequest,
    Readonly<{ kind: 'user_action' }>
>['agentRequestSummary']['questions'][number];
type MediatedPendingPermissionScopes = Extract<
    MediatedPendingRequest,
    Readonly<{ kind: 'permission' }>
>['allowedScopes'];

/**
 * The single total order the projection is sorted by and its keyset cursor is
 * compared with. Sorting and resuming must never use two comparators, or a
 * page boundary can skip or repeat a request.
 */
function compareMediatedPendingPermissions(
    left: MediatedPendingPermissionKeyset,
    right: MediatedPendingPermissionKeyset,
): number {
    return left.createdAtMs - right.createdAtMs
        || left.turnId.localeCompare(right.turnId)
        || left.requestId.localeCompare(right.requestId);
}

function encodeMediatedPendingPermissionCursor(entry: MediatedPendingPermissionKeyset): string {
    return Buffer.from(
        JSON.stringify([entry.createdAtMs, entry.turnId, entry.requestId]),
        'utf8',
    ).toString('base64url');
}

function decodeMediatedPendingPermissionCursor(
    cursor: string,
): MediatedPendingPermissionKeyset | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [createdAtMs, turnId, requestId] = parsed;
    if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) return null;
    if (typeof turnId !== 'string' || typeof requestId !== 'string') return null;
    return { createdAtMs, turnId, requestId };
}

const REMOTE_MEDIATION_TEXT_ENCODER = new TextEncoder();

/**
 * One credential-redacted text ingress for the complete remote
 * `agentRequestSummary`. Redaction precedes normalization, byte accounting,
 * truncation, persistence by downstream custody, and provider projection.
 */
function normalizeRedactedRemoteMediationText(value: string): string {
    return redactBugReportSensitiveText(value).normalize('NFC');
}

function truncateRemoteMediationText(value: string, fallback: string, maxUtf8Bytes: number): string {
    const normalized = normalizeRedactedRemoteMediationText(value.trim() || fallback);
    if (REMOTE_MEDIATION_TEXT_ENCODER.encode(normalized).byteLength <= maxUtf8Bytes) return normalized;

    const ellipsis = '…';
    const suffixBytes = REMOTE_MEDIATION_TEXT_ENCODER.encode(ellipsis).byteLength;
    let retained = '';
    let retainedBytes = 0;
    for (const codePoint of normalized) {
        const nextBytes = REMOTE_MEDIATION_TEXT_ENCODER.encode(codePoint).byteLength;
        if (retainedBytes + nextBytes + suffixBytes > maxUtf8Bytes) break;
        retained += codePoint;
        retainedBytes += nextBytes;
    }
    return retained ? `${retained}${ellipsis}` : ellipsis;
}

function projectRemoteMediatedQuestion(
    question: AgentRequestQuestionSummary,
): MediatedPendingUserActionQuestion | null {
    const questionText = normalizeRedactedRemoteMediationText(question.question);
    if (
        questionText.trim().length === 0
        || REMOTE_MEDIATION_TEXT_ENCODER.encode(questionText).byteLength
            > SESSION_PERMISSION_REMOTE_QUESTION_TEXT_UTF8_BYTES
    ) {
        return null;
    }

    const choiceLabels = new Set<string>();
    const choiceValues = new Set<string>();
    const choices: string[] = [];
    for (const choice of question.choices) {
        const label = normalizeRedactedRemoteMediationText(choice.label);
        if (
            label.trim().length === 0
            || REMOTE_MEDIATION_TEXT_ENCODER.encode(label).byteLength
                > SESSION_PERMISSION_REMOTE_QUESTION_CHOICE_UTF8_BYTES
            || choiceLabels.has(label)
            || choiceValues.has(choice.value)
        ) {
            return null;
        }
        choiceLabels.add(label);
        choiceValues.add(choice.value);
        choices.push(label);
    }
    Object.freeze(choices);

    return {
        question: questionText,
        selection: question.selection,
        required: question.required,
        allowCustom: question.allowCustom,
        choices,
    };
}

function projectRemoteMediatedRequestSummary(params: Readonly<{
    kind: 'permission' | 'user_action';
    toolName: string;
    toolInput: unknown;
    resolveFullFormUrl?: () => string;
}>): MediatedPendingRequestSummary | null {
    const semantic = buildAgentRequestSemanticSummary(params);
    if (params.kind === 'permission') {
        return {
            kind: 'permission',
            toolLabel: truncateRemoteMediationText(
                semantic.normalizedToolLabel,
                'tool operation',
                SESSION_PERMISSION_REMOTE_SUMMARY_TOOL_LABEL_UTF8_BYTES,
            ),
            title: truncateRemoteMediationText(
                formatPermissionRequestSummary({ toolName: params.toolName, toolInput: params.toolInput }),
                'Permission required',
                SESSION_PERMISSION_REMOTE_SUMMARY_TITLE_UTF8_BYTES,
            ),
            detail: truncateRemoteMediationText(
                summarizeToolInputForNotification(params.toolName, params.toolInput) ?? '',
                'Details unavailable',
                SESSION_PERMISSION_REMOTE_SUMMARY_DETAIL_UTF8_BYTES,
            ),
        };
    }

    if (semantic.questions.length === 0) return null;
    if (requiresFullFormForRemoteUserAction(semantic.questions)) {
        if (!params.resolveFullFormUrl) return null;
        return {
            kind: 'user_action',
            questions: [],
            fullForm: { questionCount: semantic.questionCount, url: params.resolveFullFormUrl() },
        };
    }
    const answerKeys = new Set<string>();
    const questions: MediatedPendingUserActionQuestion[] = [];
    for (const question of semantic.questions) {
        if (answerKeys.has(question.answerKey)) return null;
        answerKeys.add(question.answerKey);
        const projectedQuestion = projectRemoteMediatedQuestion(question);
        if (!projectedQuestion) return null;
        questions.push(projectedQuestion);
    }
    return {
        kind: 'user_action',
        questions,
    };
}

function resolveRemoteMediatedQuestionValues(params: Readonly<{
    question: AgentRequestQuestionSummary;
    values: readonly string[];
}>): readonly string[] | null {
    const { question, values } = params;
    if (question.selection !== 'multiple' && values.length !== 1) return null;
    const resolved: string[] = [];
    const identityKeys = new Set<string>();
    let customCount = 0;
    for (const value of values) {
        const normalizedValue = value.normalize('NFC');
        const matchingChoices = question.choices.filter((choice) => (
            normalizeRedactedRemoteMediationText(choice.label) === normalizedValue
        ));
        if (matchingChoices.length > 1) return null;
        if (matchingChoices.length === 1) {
            const resolvedValue = matchingChoices[0]!.value;
            const identity = `choice:${resolvedValue}`;
            if (identityKeys.has(identity)) return null;
            identityKeys.add(identity);
            resolved.push(resolvedValue);
            continue;
        }
        if (!question.allowCustom) return null;
        customCount += 1;
        if (customCount > 1) return null;
        const identity = `custom:${normalizedValue}`;
        if (identityKeys.has(identity)) return null;
        identityKeys.add(identity);
        resolved.push(value);
    }
    return Object.freeze(resolved);
}

function isExactPendingPermissionUpdate(params: Readonly<{
    update: unknown;
    toolName: string;
    toolInput: unknown;
    permissionSuggestions?: readonly unknown[];
}>): boolean {
    const update = asUnknownRecord(params.update);
    if (!update) return false;
    if (update.type === 'setMode') {
        const generatedCurrentUiUpdate = hasOnlyKeys(update, ['type', 'mode', 'destination'])
            && update.mode === 'acceptEdits'
            && update.destination === 'session';
        return generatedCurrentUiUpdate
            || Boolean(params.permissionSuggestions?.some((suggestion) => isDeepStrictEqual(params.update, suggestion)));
    }
    if (update.type === 'addRules') {
        if (
            update.behavior !== 'allow'
            || update.destination !== 'session'
            || !hasOnlyKeys(update, ['type', 'rules', 'behavior', 'destination'])
            || !Array.isArray(update.rules)
            || update.rules.length === 0
        ) {
            return false;
        }
        return update.rules.every((rule) => {
            const identifier = normalizePermissionRuleIdentifier(rule);
            return identifier !== null
                && isToolAllowedForSession([identifier], params.toolName, params.toolInput);
        });
    }

    return Boolean(params.permissionSuggestions?.some((suggestion) => isDeepStrictEqual(params.update, suggestion)));
}

function readProposedExecPolicyAmendment(input: unknown): readonly string[] | null {
    const record = asUnknownRecord(input);
    if (!record) return null;
    const camelProposal = record.proposedExecpolicyAmendment;
    const snakeProposal = record.proposed_execpolicy_amendment;
    if (
        typeof camelProposal !== 'undefined'
        && typeof snakeProposal !== 'undefined'
        && !isDeepStrictEqual(camelProposal, snakeProposal)
    ) {
        return null;
    }
    const proposal = camelProposal ?? snakeProposal;
    if (!Array.isArray(proposal) || proposal.length === 0) return null;
    if (!proposal.every((part) => typeof part === 'string' && part.length > 0)) return null;
    return proposal;
}

function isPermissionResponseAuthorityValid(params: Readonly<{
    response: PermissionResponse;
    context: Readonly<{
        toolName: string;
        toolInput: unknown;
        source?: string;
        permissionSuggestions?: readonly unknown[];
    }>;
}>): boolean {
    const { response, context } = params;
    const requestKind = resolveAgentRequestKind(context.toolName);
    const hasAllowedTools = typeof response.allowedTools !== 'undefined' || typeof response.allowTools !== 'undefined';
    const hasUpdatedPermissions = typeof response.updatedPermissions !== 'undefined';
    const hasExecPolicyAmendment = typeof response.execPolicyAmendment !== 'undefined';
    const hasAnswers = typeof response.answers !== 'undefined';
    const approvedDecision = response.decision === 'approved'
        || response.decision === 'approved_for_session'
        || response.decision === 'approved_execpolicy_amendment';
    const deniedDecision = response.decision === 'denied' || response.decision === 'abort';

    if ((response.approved && deniedDecision) || (!response.approved && approvedDecision)) return false;

    if (context.source === NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE && (
        hasAllowedTools || hasUpdatedPermissions || hasExecPolicyAmendment
        || response.decision === 'approved_for_session' || response.decision === 'approved_execpolicy_amendment'
    )) return false;

    if (context.source === HAPPIER_ACTION_REQUEST_SOURCE) {
        return !hasAllowedTools && !hasUpdatedPermissions && !hasExecPolicyAmendment && !hasAnswers
            && (response.decision === undefined || response.decision === 'approved'
                || response.decision === 'denied' || response.decision === 'abort');
    }

    if (!response.approved) {
        return !hasAllowedTools && !hasUpdatedPermissions && !hasExecPolicyAmendment && !hasAnswers;
    }
    if (requestKind === 'user_action') {
        return !hasAllowedTools && !hasUpdatedPermissions && !hasExecPolicyAmendment
            && (response.decision === undefined || response.decision === 'approved');
    }
    if (hasAnswers) return false;

    if (
        typeof response.allowedTools !== 'undefined'
        && typeof response.allowTools !== 'undefined'
        && !isDeepStrictEqual(response.allowedTools, response.allowTools)
    ) {
        return false;
    }
    const allowedTools = response.allowedTools ?? response.allowTools;
    if (typeof allowedTools !== 'undefined') {
        if (!Array.isArray(allowedTools) || allowedTools.length === 0) return false;
        if (!allowedTools.every((identifier) => (
            typeof identifier === 'string'
            && identifier.trim().length > 0
            && isToolAllowedForSession([identifier.trim()], context.toolName, context.toolInput)
        ))) {
            return false;
        }
    }

    if (hasUpdatedPermissions) {
        if (!Array.isArray(response.updatedPermissions) || response.updatedPermissions.length === 0) return false;
        if (!response.updatedPermissions.every((update) => isExactPendingPermissionUpdate({
            update,
            toolName: context.toolName,
            toolInput: context.toolInput,
            ...(Array.isArray(context.permissionSuggestions)
                ? { permissionSuggestions: context.permissionSuggestions }
                : {}),
        }))) {
            return false;
        }
    }

    if (response.decision === 'approved_execpolicy_amendment') {
        const proposal = readProposedExecPolicyAmendment(context.toolInput);
        const amendment = asUnknownRecord(response.execPolicyAmendment);
        return Boolean(
            proposal
            && amendment
            && hasOnlyKeys(amendment, ['command'])
            && isDeepStrictEqual(amendment.command, proposal),
        );
    }
    return !hasExecPolicyAmendment;
}

/**
 * Host-stamped mediation response. The action layer supplies the exact
 * plugin contribution identity; external identity is persisted only in the
 * encrypted host-owned mediation record.
 */
export type MediatedPermissionResponseInput = Readonly<{
    /**
     * Exact caller-supplied Session custody. The handler rejects a response
     * routed to a different Session before it can claim a request by ID.
     */
    sessionId: string;
    /** Exact host-stamped turn custody; never inferred by the response path. */
    turnId: string;
    requestId: string;
    sourceRef: string;
    sourceRevisionOrEpoch: string;
    idempotencyKey: string;
    actor: Readonly<{ namespace: string; principalId: string }>;
    decision: 'allow' | 'deny';
    scope: 'request' | 'session';
    mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    signal?: AbortSignal;
}>;

/**
 * Host-stamped mediator input for one AskUserQuestion completion. Unlike a
 * permission decision this has no scope, grant, settlement row, or parallel
 * replay ledger: the incumbent request coordinator remains the sole answer
 * owner and resolves the bounded indices against its current request.
 */
export type MediatedUserActionResponseInput = Readonly<{
    sessionId: string;
    turnId: string;
    requestId: string;
    sourceRef: string;
    sourceRevisionOrEpoch: string;
    answers: readonly Readonly<{
        questionIndex: number;
        values: readonly string[];
    }>[];
    mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    signal?: AbortSignal;
}>;

type PreparedMediatedPermissionResponse = Readonly<{
    input: SessionPermissionRemoteRespondInputV1;
    mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    actor: SessionPermissionExternalHumanDecisionActorV1;
    claim: PermissionResponseClaim;
}>;

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private resetPromise: Promise<void> | null = null;
    private allowedToolIdentifiers = new Set<string>();
    private readonly allowedToolIdentifiersByOwner = new Map<string, Set<string>>();
    private readonly requestStore: AgentStateRequestStore;
    private readonly requestCoordinator: PermissionRequestCoordinator<PermissionResult>;
    private readonly onAbortRequested: (() => void | Promise<void>) | null;
    private readonly getAccountSettingsSnapshotFn: () => AccountSettings | null;
    private readonly getCodingPromptBehaviorFn: (() => CodingPromptBehaviorV1 | null) | null;
    private readonly getWorkspaceWrites: (() => 'allow' | 'deny' | undefined) | null;
    private readonly getAccountRoleOverrides: () => AccountRoleOverridesReadV1;
    private readonly toolTrace: { protocol: ToolTraceProtocol; provider: string } | null;
    private readonly triggerAbortCallbackOnAbortDecision: boolean;
    /** Runtime-registry currentness for a mediator whose grant may have survived admission. */
    private readonly isMediatorPluginCurrent: (pluginId: string) => boolean;
    /** Runtime-registry currentness for the exact mediator contribution that asserted a grant. */
    private readonly isMediatorContributionCurrent: (mediator: Readonly<{
        pluginId: string;
        contributionLocalId: string;
    }>) => boolean;
    private mediationRecordStore: PermissionMediationRecordStore | null;
    /** An injected store is test/host-owned and must survive a session swap. */
    private readonly injectedMediationRecordStore: PermissionMediationRecordStore | null | undefined;
    private readonly activeRemoteMediationGrants = new Map<string, ActiveRemoteMediationGrant>();
    /**
     * A hydrated terminal mediation row without its first-answer claim is a
     * permanent non-authorizing barrier for that exact request tuple. This is
     * derived only from canonical record reconciliation; it neither owns
     * request readiness nor replaces AgentState custody.
     */
    private readonly inertRemoteMediationRequestIdentities = new Set<string>();
    private remoteMediationGrantHydration: Promise<boolean> | null = null;
    /**
     * Serializes only this handler instance's capacity scan, exact-revision
     * prune, and create. It is neither a plugin-wide lock nor persisted
     * coordination: it prevents two local responses from both seeing slot
     * 1,024 before either creates row 1,025.
     */
    private remoteMediationLedgerMutation: Promise<void> = Promise.resolve();

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    /** Re-evaluated for pending responses as well as fresh calls, before YOLO or grants. */
    protected resolveWorkspaceWriteDecision(toolName: string, input: unknown, mcpEffectClass?: 'read' | 'write' | 'unknown'): PermissionResult | null {
        let workspaceWrites: 'allow' | 'deny' | undefined;
        if (this.getWorkspaceWrites) workspaceWrites = this.getWorkspaceWrites();
        else {
            const metadata = this.session.getMetadataSnapshot();
            const read = this.getAccountRoleOverrides();
            const roles = readSessionRolesV1(metadata);
            const inherited = roles?.roleId ? roles.sessionRoles[roles.roleId] : undefined;
            workspaceWrites = read.status === 'ready'
                ? readSessionWorkspaceWritesV1(metadata, { settingsOverrides: read.overrides })
                : inherited ? readSessionWorkspaceWritesV1(metadata) : 'deny';
        }
        return isWorkspaceWriteDeniedByRole({ workspaceWrites, toolName, toolInput: input, mcpEffectClass }) ? { decision: 'denied' } : null;
    }

    private readonly approvalReviews = new Map<string, Promise<'allow_once' | 'escalate'>>();

    protected getApprovalReviewerPermissionMode(): string {
        const metadata = this.session.getMetadataSnapshot();
        const intent = resolvePermissionIntentFromMetadataSnapshot({ metadata })?.intent;
        if (intent) return intent;
        // Absence is the fresh-session default; an unknown explicit mode is not.
        return metadata && Object.prototype.hasOwnProperty.call(metadata, 'permissionMode') ? 'unavailable' : 'default';
    }

    private isApprovalReviewerEnabled(): boolean {
        const metadata = this.session.getMetadataSnapshot();
        const enabled = metadata && Object.prototype.hasOwnProperty.call(metadata, 'approvalReviewerEnabled')
            ? metadata.approvalReviewerEnabled === true
            : this.getAccountSettingsSnapshot()?.approvalReviewerEnabled === true;
        const mode = this.getApprovalReviewerPermissionMode();
        // The permission owner normalizes legacy Accept edits to safe-yolo.
        // Preserve that explicit spelling for this opt-in; safe-yolo itself is not in scope.
        const acceptEdits = mode === 'acceptEdits'
            || (mode === 'safe-yolo' && metadata?.permissionMode === 'acceptEdits');
        return enabled && (mode === 'default' || acceptEdits);
    }

    /** Model work never holds the durable claim or delays publication/human notification. */
    respondAsApprovalReviewer(requestId: string): Promise<'allow_once' | 'escalate'> {
        const existing = this.approvalReviews.get(requestId);
        if (existing) return existing;
        const review = this.reviewPermissionRequest(requestId).catch((error: unknown) => {
            logger.debug(`${this.getLogPrefix()} Approval reviewer unavailable; request remains pending`, error);
            return 'escalate' as const;
        }).finally(() => {
            if (this.approvalReviews.get(requestId) === review) this.approvalReviews.delete(requestId);
        });
        this.approvalReviews.set(requestId, review);
        return review;
    }

    private async reviewPermissionRequest(requestId: string): Promise<'allow_once' | 'escalate'> {
        const context = this.requestCoordinator.getResponseContext(requestId);
        const pending = this.pendingRequests.get(requestId);
        const currentDecision = pending?.resolveCurrentPermissionDecision?.();
        if (!context || !pending?.coordinatorManaged || !this.isApprovalReviewerEnabled() || context.source === HAPPIER_ACTION_REQUEST_SOURCE
            || context.kind === 'user_action' || resolveAgentRequestKind(context.toolName) !== 'permission'
            || currentDecision?.decision === 'denied' || currentDecision?.decision === 'abort') return 'escalate';
        // Public permission sources may carry non-JSON records. Admit a strict,
        // immutable snapshot before disclosure or JSON-value comparison.
        let reviewedInput: ReturnType<typeof normalizeStrictJsonValue>;
        try {
            reviewedInput = normalizeStrictJsonValue(context.toolInput);
        } catch {
            return 'escalate';
        }
        const matchesReviewedInput = (candidate: unknown): boolean => {
            try {
                // Mutable sources can leave the JSON domain across any await,
                // including the durable claim write. Never omit invalid members.
                return sameStrictJsonValue(normalizeStrictJsonValue(candidate), reviewedInput);
            } catch {
                return false;
            }
        };
        const metadata = this.session.getMetadataSnapshot();
        if (!await isApprovalReviewerModelEligible(context.toolName, reviewedInput, metadata?.path ?? '')) return 'escalate';
        const backend = resolveBackendTargetFromSessionMetadata(metadata);
        if (!backend) return 'escalate';
        const projection = projectRemoteMediatedRequestSummary({ kind: 'permission', toolName: context.toolName, toolInput: reviewedInput });
        if (!projection || !this.isApprovalReviewerEnabled()) return 'escalate';
        const start = await this.session.executionRuns.start({
            roleId: 'approval_reviewer', intent: 'task',
            backendTarget: backend,
            permissionMode: 'no_tools', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
            // Target-host admission owns the role engine, Launch Profile and
            // rendered role block. This is only the request-specific task.
            instructions: 'Assess this pending tool request and return the requested JSON result.',
            intentInput: { input: projection, resultSchema: {
                type: 'object', properties: { decision: { type: 'string', enum: ['allow_once', 'escalate'] }, reason: { type: 'string' } },
                required: ['decision'], additionalProperties: false,
            } },
        });
        if (!start.ok) return 'escalate';
        const started = ExecutionRunStartResponseSchema.safeParse(start.data);
        if (!started.success) return 'escalate';
        // Observation timeouts are not decision deadlines. Continue on the same run handle.
        let observed = started.data.wait;
        while (!observed || (observed.ok && observed.status === 'running')) {
            if (!this.isApprovalReviewerEnabled() || !this.requestCoordinator.getResponseContext(requestId)) return 'escalate';
            const waitRun = this.session.executionRuns.wait;
            if (!waitRun) return 'escalate';
            const wait = await waitRun({ runId: started.data.runId });
            if (!wait.ok) return 'escalate';
            const parsed = ExecutionRunWaitResultSchema.safeParse('data' in wait ? wait.data : wait);
            if (!parsed.success) return 'escalate';
            observed = parsed.data;
        }
        if (!observed.ok || observed.status !== 'succeeded' || observed.result.run.runId !== started.data.runId) return 'escalate';
        const answer = ApprovalReviewerAnswerSchema.safeParse(observed.result.latestToolResult);
        if (!answer.success || answer.data.decision !== 'allow_once') return 'escalate';
        return this.requestCoordinator.withResponseClaim(requestId, async () => {
            const current = this.requestCoordinator.getResponseContext(requestId);
            const eligible = () => {
                const decision = this.pendingRequests.get(requestId)?.resolveCurrentPermissionDecision?.()
                    ?? (current ? this.resolveCurrentPermissionDecisionForOutstandingRequest(current) : null);
                return this.pendingRequests.get(requestId) === pending
                    && matchesReviewedInput(pending.input)
                    && this.isApprovalReviewerEnabled() && decision?.decision !== 'denied' && decision?.decision !== 'abort';
            };
            if (!current || this.pendingRequests.get(requestId) !== pending || !eligible() || current.turnId !== context.turnId
                || current.toolName !== context.toolName || !matchesReviewedInput(current.toolInput)) return 'escalate';
            const claim: PermissionResponseClaim = { version: 1, origin: 'approvalReviewer',
                ...(current.turnId ? { turnId: current.turnId } : {}), decision: 'approved', scope: 'request' };
            const acquired = await this.requestCoordinator.acquireResponseClaim({ requestId, claim });
            if (acquired.status !== 'acquired') return 'escalate';
            let completed = false;
            try {
                if (this.pendingRequests.get(requestId) !== pending || !eligible()) return 'escalate';
                completed = await this.completePendingPermissionRequest(requestId, current, { decision: 'approved' }, {
                    status: 'approved', decision: 'approved',
                    isCurrent: () => this.pendingRequests.get(requestId) === pending && eligible(),
                    extraCompletedFields: { permissionDecisionClaimV1: claim, permissionDecisionActorV1: { kind: 'approvalReviewer' } },
                });
                return completed ? 'allow_once' : 'escalate';
            } finally {
                if (!completed) await this.requestCoordinator.releaseResponseClaim({ requestId, claim });
            }
        });
    }

    /**
     * The concrete permission-policy owner decides a remote allow once, at
     * its response admission and before any mediation row is written. An
     * admitted answer then finishes; a narrowed policy refuses the next
     * admission. Base has no policy of its own, so an unimplemented live
     * handler fails closed.
     */
    protected isCurrentRemoteMediationAllowEligible(_params: Readonly<{
        requestId: string;
        toolName: string;
        input: unknown;
        causalPermissionContext: AcpPermissionCallContext;
    }>): boolean {
        return false;
    }

    /**
     * A restarted handler has only the durable AgentState projection. Concrete
     * policy owners may re-read their incumbent current policy before that
     * projection accepts an approval; Base has no independent policy to add.
     */
    protected resolveCurrentPermissionDecisionForOutstandingRequest(
        _context: PermissionRequestCoordinatorContext,
    ): PermissionResult | null {
        return null;
    }

    protected updateAgentStateBestEffort(updater: (state: AgentState) => AgentState, reason: string): void {
        updateAgentStateBestEffortShared(this.session, updater, this.getLogPrefix(), reason);
    }

    constructor(
        session: ApiSessionClient,
        opts?: {
            pushSender?: PermissionRequestPushSender | null;
            getAccountSettings?: (() => AccountSettings | null) | null;
            getCodingPromptBehavior?: (() => CodingPromptBehaviorV1 | null) | null;
            /** Canonical host resolution includes Artifact/plugin and workflow role layers. */
            getWorkspaceWrites?: (() => 'allow' | 'deny' | undefined) | null;
            getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
            onAbortRequested?: (() => void | Promise<void>) | null;
            toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
            triggerAbortCallbackOnAbortDecision?: boolean;
            mediationRecordStore?: PermissionMediationRecordStore | null;
            isMediatorPluginCurrent?: ((pluginId: string) => boolean) | null;
            isMediatorContributionCurrent?: ((mediator: Readonly<{
                pluginId: string;
                contributionLocalId: string;
            }>) => boolean) | null;
        }
    ) {
        this.session = session;
        this.getAccountSettingsSnapshotFn = typeof opts?.getAccountSettings === 'function' ? opts.getAccountSettings : (() => null);
        this.getCodingPromptBehaviorFn = opts?.getCodingPromptBehavior ?? null;
        this.getWorkspaceWrites = opts?.getWorkspaceWrites ?? null;
        const accountScope = getActiveAccountSettingsSnapshot()?.scopeKey;
        this.getAccountRoleOverrides = accountScope
            ? createActionSettingsProvider({ scopeKey: accountScope }).getAccountRoleOverrides
            : () => ({ status: 'unavailable', reason: 'source-unavailable' });
        // A remote grant is an external authorization effect. A host runtime
        // that has not supplied the registry-owned lifecycle read must not
        // continue using it after mediator state changes.
        this.isMediatorPluginCurrent = typeof opts?.isMediatorPluginCurrent === 'function'
            ? opts.isMediatorPluginCurrent
            : (() => false);
        this.isMediatorContributionCurrent = typeof opts?.isMediatorContributionCurrent === 'function'
            ? opts.isMediatorContributionCurrent
            : (() => false);
        this.requestStore = new AgentStateRequestStore({
            session,
            logPrefix: this.getLogPrefix(),
            pushSender: opts?.pushSender ?? null,
            getAccountSettings: this.getAccountSettingsSnapshotFn,
            getAccountSettingsSecretsReadKeys:
                typeof opts?.getAccountSettingsSecretsReadKeys === 'function'
                    ? opts.getAccountSettingsSecretsReadKeys
                    : (() => []),
        });
        this.bindRequestStoreToSession(session);
        this.requestCoordinator = createPermissionRequestCoordinator<PermissionResult>({
            store: this.requestStore,
            resolveAutomaticDecision: (request) => this.isUnlistedToolDenied(request.toolName, request.toolInput)
                ? { result: { decision: 'denied' }, completedRequest: { status: 'denied', decision: 'denied' } }
                : null,
        });
        this.onAbortRequested = typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null;
        this.triggerAbortCallbackOnAbortDecision = opts?.triggerAbortCallbackOnAbortDecision ?? true;
        this.injectedMediationRecordStore = opts?.mediationRecordStore;
        this.mediationRecordStore = this.injectedMediationRecordStore
            ?? createPermissionMediationRecordStore(session);
        this.startRemoteMediationGrantHydration();
        this.toolTrace =
            opts?.toolTrace && typeof opts.toolTrace === 'object'
                ? {
                    protocol: opts.toolTrace.protocol,
                    provider: opts.toolTrace.provider,
                }
                : null;
        this.setupRpcHandler();
        this.seedAllowedToolsFromAgentState();
    }

    protected getAccountSettingsSnapshot(): AccountSettings | null {
        try {
            return this.getAccountSettingsSnapshotFn();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to read account settings`, error);
            return null;
        }
    }

    protected getCodingPromptBehavior(): CodingPromptBehaviorV1 | null | undefined {
        return this.getCodingPromptBehaviorFn?.();
    }

    /**
     * Session-scoped Launch Profile identity, read from the same authority the
     * effective-prompt owner reads (`agent/runtime/session/loop/lifecycle.ts`
     * uses `session.getMetadataSnapshot()?.profileId`). Kept as a read of the
     * live session reference rather than a constructor-injected callback so a
     * post-`updateSession` swap cannot leave a stale profile behind.
     */
    protected getSessionProfileId(): string | null {
        try {
            return this.session.getMetadataSnapshot()?.profileId ?? null;
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to read session profile id`, error);
            return null;
        }
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        const pendingContexts = new Map([...this.pendingRequests.keys()].map((id) =>
            [id, this.requestCoordinator.getResponseContext(id)] as const));

        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        if (this.injectedMediationRecordStore === undefined) {
            // A session swap changes both the bearer and encryption context;
            // retain neither a stale writer nor its decrypting key.
            this.mediationRecordStore = createPermissionMediationRecordStore(newSession);
        }
        this.startRemoteMediationGrantHydration();
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        // Prevent per-session allowlists from leaking across session references.
        // The new session snapshot will re-seed any persisted per-session approvals.
        this.allowedToolIdentifiers.clear();
        this.allowedToolIdentifiersByOwner.clear();
        this.requestStore.updateSession(newSession);
        this.bindRequestStoreToSession(newSession);
        this.seedAllowedToolsFromAgentState();

        // If we were mid-permission when the session reference swapped (offline reconnect),
        // republish still-pending items into the new agentState and re-attempt push notifications.
        for (const [id, pending] of this.pendingRequests.entries()) {
            const context = pendingContexts.get(id);
            if (!context) continue;
            if (!this.requestStore.hasOutstandingRequest(id)) {
                this.requestStore.publishRequest(context);
            } else {
                this.requestStore.notifyPermissionRequestPushBestEffort({
                    permissionId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                });
            }
        }
    }

    /**
     * Restores only durable remote grants. The map is empty until a complete
     * bounded scan succeeds, so a transport, envelope or currentness failure
     * can never turn into an optimistic permission allow.
     */
    private startRemoteMediationGrantHydration(): void {
        this.activeRemoteMediationGrants.clear();
        this.inertRemoteMediationRequestIdentities.clear();
        const store = this.mediationRecordStore;
        const session = this.session;
        const sessionId = session.sessionId;
        this.remoteMediationGrantHydration = store
            ? this.hydrateRemoteMediationGrants({ store, session, sessionId })
            : Promise.resolve(false);
    }

    private async hydrateRemoteMediationGrants(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<boolean> {
        const records: PermissionMediationStoredRecord[] = [];
        let cursor: string | null = null;
        let scanned = 0;
        while (true) {
            if (!this.isCurrentRemoteMediationLedger(params)) return false;
            const page = await params.store.list({ cursor, limit: 500 });
            if (!this.isCurrentRemoteMediationLedger(params)) return false;
            if (page.status !== 'ready') return false;
            scanned += page.records.length;
            if (scanned > SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX) return false;
            records.push(...page.records);
            if (!page.hasNext) break;
            if (!page.nextCursor || page.nextCursor === cursor) return false;
            cursor = page.nextCursor;
        }
        if (!await this.reconcileCommittedRemoteMediationClaims({ ...params, records })) return false;

        const hydrated = new Map<string, ActiveRemoteMediationGrant>();
        for (const stored of records) {
            if (!this.addRemoteMediationGrant(stored, hydrated)) return false;
        }
        if (
            this.session !== params.session
            || this.session.sessionId !== params.sessionId
            || this.mediationRecordStore !== params.store
        ) {
            return false;
        }
        this.activeRemoteMediationGrants.clear();
        for (const [identityKey, grant] of hydrated) {
            this.activeRemoteMediationGrants.set(identityKey, grant);
        }
        return true;
    }

    /**
     * A System Record can commit before the ordinary AgentState completion.
     * On restart, recover only a matching durable first-answer claim through
     * the incumbent coordinator; a record without that claim remains inert.
     */
    private async reconcileCommittedRemoteMediationClaims(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        records: readonly PermissionMediationStoredRecord[];
    }>): Promise<boolean> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        for (const stored of params.records) {
            if (!this.isCurrentRemoteMediationLedger(ledger)) return false;
            // Historic rows ordinarily have no outstanding request. Avoid a
            // no-op AgentState mutation per retained audit row; a later race
            // can only leave the record inert, never authorize from it.
            const outstanding = this.requestStore.readOutstandingRequest(stored.identity.requestId);
            if (
                !outstanding
                || stored.identity.sessionId !== params.sessionId
                || stored.identity.turnId !== outstanding.turnId
            ) continue;

            const prepared = this.prepareMediatedPermissionRecovery(stored);
            if (!prepared) return false;
            const outcome = stored.kind === 'remote_grant.v1' && stored.record.revoked
                ? null
                : this.resolveRemoteMediationRecordOutcome(
                    stored,
                    prepared.input,
                    prepared.mediator,
                    'alreadyApplied',
                );
            if (outcome?.status === 'rejected') return false;

            const reconciled = await this.requestCoordinator.withResponseClaim(
                stored.identity.requestId,
                async () => {
                    const claim = await this.requestCoordinator.rejoinResponseClaim({
                        requestId: stored.identity.requestId,
                        claim: prepared.claim,
                    });
                    if (claim.status === 'unclaimed' || claim.status === 'not_pending') {
                        this.inertRemoteMediationRequestIdentities.add(
                            mediationRecordIdentityKey(stored.identity),
                        );
                        return true;
                    }
                    if (claim.status !== 'rejoined') return false;

                    if (stored.kind === 'remote_grant.v1' && stored.record.revoked) {
                        const settlement = await this.settleMediatedPermissionNonAuthorizing({
                            requestId: stored.identity.requestId,
                            settlementId: stored.record.settlementId,
                        });
                        return settlement !== 'unavailable';
                    }
                    if (!outcome) return false;

                    const rejection = await this.replayRemoteMediationCompletionIfPending({
                        stored,
                        input: prepared.input,
                        mediator: prepared.mediator,
                        outcome,
                        ...ledger,
                        mustComplete: true,
                        skipRemoteMediationGrantHydration: true,
                        deferRemoteMediationGrantActivation: true,
                        onGrantNeutralized: () => undefined,
                    });
                    return !rejection || rejection.code !== 'mediationStateUnavailable';
                },
            );
            if (!reconciled || !this.isCurrentRemoteMediationLedger(ledger)) return false;
        }
        return true;
    }

    private prepareMediatedPermissionRecovery(
        stored: PermissionMediationStoredRecord,
    ): PreparedMediatedPermissionResponse | null {
        const parsed = stored.kind === 'remote_grant.v1'
            ? createStoredReadSchema(SessionPermissionRemoteGrantRecordV1Schema).safeParse(stored.record)
            : createStoredReadSchema(SessionPermissionRemoteSettlementRecordV1Schema).safeParse(stored.record);
        if (!parsed.success) return null;
        const record = parsed.data;
        return this.prepareMediatedPermissionResponse({
            sessionId: stored.identity.sessionId,
            turnId: stored.identity.turnId,
            requestId: stored.identity.requestId,
            sourceRef: record.sourceAuthority.sourceRef,
            sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
            idempotencyKey: record.idempotencyKey,
            actor: {
                namespace: record.actor.namespace,
                principalId: record.actor.principalId,
            },
            decision: record.decision,
            scope: record.requestedScope,
            mediator: record.actor.assertedBy,
        });
    }

    private addRemoteMediationGrant(
        stored: PermissionMediationStoredRecord,
        destination: Map<string, ActiveRemoteMediationGrant>,
    ): boolean {
        if (stored.kind !== 'remote_grant.v1') return true;
        const parsed = createStoredReadSchema(SessionPermissionRemoteGrantRecordV1Schema).safeParse(stored.record);
        if (!parsed.success) return false;
        if (parsed.data.revoked) return true;
        // The System Record is the remote first-answer claim, not an active
        // permission grant by itself. Activation has one ordinary completion
        // owner: the matching AgentState terminal projection.
        if (!this.hasOrdinaryRemoteMediationGrantCompletion(parsed.data)) return true;
        const identityKey = mediationRecordIdentityKey(stored.identity);
        if (!destination.has(identityKey) && destination.size >= SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX) {
            return false;
        }
        destination.set(identityKey, {
            identity: stored.identity,
            kind: 'remote_grant.v1',
            record: parsed.data,
            revision: stored.revision,
        });
        return true;
    }

    private hasOrdinaryRemoteMediationGrantCompletion(
        record: SessionPermissionRemoteGrantRecordV1,
    ): boolean {
        const completed = this.session.getAgentStateSnapshot?.()?.completedRequests?.[record.requestId];
        const entry = asUnknownRecord(completed);
        return TurnIdSchema.safeParse(entry?.turnId).success
            && entry?.turnId === record.turnId
            && entry?.status === 'approved'
            && entry.remoteMediationSettlementId === record.settlementId;
    }

    private async ensureRemoteMediationGrantsHydrated(): Promise<boolean> {
        return await (this.remoteMediationGrantHydration ?? Promise.resolve(false));
    }

    private isCurrentRemoteMediationLedger(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): boolean {
        return this.session === params.session
            && this.session.sessionId === params.sessionId
            && this.mediationRecordStore === params.store;
    }

    private async withRemoteMediationLedgerMutation<T>(
        work: () => Promise<T>,
    ): Promise<T> {
        const previous = this.remoteMediationLedgerMutation;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.remoteMediationLedgerMutation = previous.then(() => held, () => held);
        await previous.catch(() => undefined);
        try {
            return await work();
        } finally {
            release();
        }
    }

    private async listCurrentRemoteMediationLedger(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        signal?: AbortSignal;
    }>): Promise<readonly PermissionMediationStoredRecord[] | null> {
        const records: PermissionMediationStoredRecord[] = [];
        let cursor: string | null = null;
        while (true) {
            if (params.signal?.aborted || !this.isCurrentRemoteMediationLedger(params)) return null;
            const remaining = SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX - records.length;
            if (remaining <= 0) return null;
            const page = await params.store.list({
                cursor,
                limit: Math.min(500, remaining),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                page.status !== 'ready'
                || params.signal?.aborted
                || !this.isCurrentRemoteMediationLedger(params)
                || records.length + page.records.length > SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX
            ) {
                return null;
            }
            records.push(...page.records);
            if (!page.hasNext) return records;
            // A next page after the 1,024th row proves the ledger exceeds its
            // bounded retention budget; never create into an unsafe ledger.
            if (
                records.length >= SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX
                || !page.nextCursor
                || page.nextCursor === cursor
            ) {
                return null;
            }
            cursor = page.nextCursor;
        }
    }

    private reconcileActiveRemoteMediationGrantsFromLedger(
        records: readonly PermissionMediationStoredRecord[],
        params: Readonly<{
            store: PermissionMediationRecordStore;
            session: ApiSessionClient;
            sessionId: string;
        }>,
    ): boolean {
        const active = new Map<string, ActiveRemoteMediationGrant>();
        for (const stored of records) {
            if (!this.addRemoteMediationGrant(stored, active)) return false;
        }
        if (!this.isCurrentRemoteMediationLedger(params)) return false;
        this.activeRemoteMediationGrants.clear();
        for (const [identityKey, grant] of active) {
            this.activeRemoteMediationGrants.set(identityKey, grant);
        }
        return true;
    }

    private oldestInactiveRemoteMediationRecord(
        records: readonly PermissionMediationStoredRecord[],
    ): PermissionMediationStoredRecord | null {
        const inactive = records.filter((stored) => (
            stored.kind !== 'remote_grant.v1' || stored.record.revoked
        ));
        if (inactive.length === 0) return null;
        inactive.sort((left, right) => {
            const createdAtDifference = left.record.createdAtMs - right.record.createdAtMs;
            if (createdAtDifference !== 0) return createdAtDifference;
            const settlementIdDifference = left.record.settlementId.localeCompare(right.record.settlementId);
            if (settlementIdDifference !== 0) return settlementIdDifference;
            return left.identity.turnId.localeCompare(right.identity.turnId)
                || left.identity.requestId.localeCompare(right.identity.requestId);
        });
        return inactive[0] ?? null;
    }

    private async admitRemoteMediationLedgerWrite(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        recordWrite: PermissionMediationRecordWrite;
        signal?: AbortSignal;
    }>): Promise<RemoteMediationLedgerAdmission> {
        if (
            params.signal?.aborted
            || !this.isCurrentRemoteMediationLedger(params)
            || !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(params)
        ) {
            return { status: 'unavailable' };
        }

        // One conflict gets a fresh, complete selection. A second conflict is
        // unsafe to guess through, so callers fail closed and leave the
        // request pending for a later retry.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const records = await this.listCurrentRemoteMediationLedger(params);
            if (!records || !this.reconcileActiveRemoteMediationGrantsFromLedger(records, params)) {
                return { status: 'unavailable' };
            }
            if (
                params.recordWrite.kind === 'remote_grant.v1'
                && this.activeRemoteMediationGrants.size >= SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX
            ) {
                return { status: 'sessionGrantCapacityExceeded' };
            }
            if (records.length < SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX) {
                return { status: 'ready' };
            }
            const oldestInactive = this.oldestInactiveRemoteMediationRecord(records);
            if (!oldestInactive) return { status: 'unavailable' };
            const pruned = await params.store.pruneInactive({
                identity: oldestInactive.identity,
                expectedRevision: oldestInactive.revision,
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || !this.isCurrentRemoteMediationLedger(params)
                || pruned.status === 'unavailable'
            ) {
                return { status: 'unavailable' };
            }
            if (pruned.status === 'pruned') return { status: 'ready' };
        }
        return { status: 'unavailable' };
    }

    /**
     * A remote session grant is bounded to the exact admitted causal source,
     * its revision and ceiling, and to one exact tool identifier. It never
     * consults or modifies the present-user `allowedTools` path.
     */
    protected isAllowedByRemoteMediationGrant(
        toolName: string,
        input: unknown,
        sourceAuthority: SessionPermissionSourceAuthorityV1 | undefined,
    ): boolean {
        if (!sourceAuthority) return false;
        const sessionId = this.session.sessionId;
        try {
            if (this.isMediatorPluginCurrent(sourceAuthority.mediatorPluginId) !== true) return false;
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to resolve remote mediator currentness`, error);
            return false;
        }
        const identifier = makeToolIdentifier(toolName, input);
        for (const grant of this.activeRemoteMediationGrants.values()) {
            if (grant.identity.sessionId !== sessionId) continue;
            const record = grant.record;
            try {
                if (this.isMediatorContributionCurrent(record.actor.assertedBy) !== true) continue;
            } catch (error) {
                logger.debug(`${this.getLogPrefix()} Failed to resolve remote mediator contribution currentness`, error);
                continue;
            }
            if (
                record.revoked
                || record.effect.kind !== 'sessionGrant'
                || record.effect.rule.kind !== 'exactTool'
                || record.effect.rule.identifier !== identifier
                || !remoteMediationSourceAuthoritiesEqual(record.sourceAuthority, sourceAuthority)
            ) {
                continue;
            }
            return true;
        }
        return false;
    }

    private bindRequestStoreToSession(session: ApiSessionClient): void {
        const binder = (session as AgentStateRequestStoreBindableSession).bindAgentStateRequestStore;
        if (typeof binder !== 'function') return;
        binder.call(session, this.requestStore);
    }

    private seedAllowedToolsFromAgentState(): void {
        try {
            applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, this.session.getMetadataSnapshot?.()?.allowedTools);
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;
            const completedRecord = completed && typeof completed === 'object' && !Array.isArray(completed)
                ? completed as Record<string, unknown>
                : null;
            if (!completedRecord) return;

            for (const value of Object.values(completedRecord)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const entry = value as Record<string, unknown>;
                if (entry.status !== 'approved') continue;
                if (entry.source === HAPPIER_ACTION_REQUEST_SOURCE) continue;

                const toolName = typeof entry.tool === 'string' ? entry.tool : '';
                if (!toolName) continue;
                const decision = entry.decision === 'approved'
                    || entry.decision === 'approved_for_session'
                    || entry.decision === 'approved_execpolicy_amendment'
                    || entry.decision === 'denied'
                    || entry.decision === 'abort'
                    ? entry.decision
                    : undefined;
                const replayedResponse: PermissionResponse = {
                    id: 'completed-request-replay',
                    approved: true,
                    ...(decision ? { decision } : {}),
                    ...(Array.isArray(entry.allowedTools) ? { allowedTools: entry.allowedTools } : {}),
                    ...(Array.isArray(entry.allowTools) ? { allowTools: entry.allowTools } : {}),
                    ...(typeof entry.updatedPermissions !== 'undefined'
                        ? { updatedPermissions: entry.updatedPermissions }
                        : {}),
                    ...(entry.execPolicyAmendment && typeof entry.execPolicyAmendment === 'object'
                        ? { execPolicyAmendment: entry.execPolicyAmendment as PermissionResponse['execPolicyAmendment'] }
                        : {}),
                };
                if (!isPermissionResponseAuthorityValid({
                    response: replayedResponse,
                    context: {
                        toolName,
                        toolInput: entry.arguments,
                        ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
                    },
                })) {
                    continue;
                }

                const allowedIdentifiers = this.getAllowedToolIdentifiersForOwner(entry.owner);
                applyUpdatedPermissionsToAllowlist(allowedIdentifiers, entry.updatedPermissions);
                applyAllowedToolsToAllowlist(allowedIdentifiers, entry.allowedTools ?? entry.allowTools);
            }
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to seed allowlist from agentState`, error);
        }
    }

    private buildPermissionResult(response: PermissionResponse): PermissionResult {
        if (response.approved) {
            const wantsExecpolicyAmendment =
                response.decision === 'approved_execpolicy_amendment' && Boolean(response.execPolicyAmendment?.command?.length);

            if (wantsExecpolicyAmendment) {
                return {
                    decision: 'approved_execpolicy_amendment',
                    execPolicyAmendment: response.execPolicyAmendment,
                };
            }

            if (response.decision === 'approved_for_session') {
                return { decision: 'approved_for_session' };
            }

            return { decision: 'approved' };
        }

        return { decision: response.decision === 'denied' ? 'denied' : 'abort' };
    }

    private buildCompletedRequestForResponse(
        response: PermissionResponse,
        result: PermissionResult,
        responseAllowedTools: readonly string[] | undefined,
        updatedPermissions: unknown,
        requestSource: Readonly<{ toolName: string; input: unknown }>,
        permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'],
        remoteMediationSettlementId?: string,
    ): PermissionRequestCoordinatorCompletedRequest {
        const wantsDerivedAllowTools =
            response.approved
            && !Array.isArray(responseAllowedTools)
            && result.decision === 'approved_for_session';
        const derivedAllowTools = Array.isArray(responseAllowedTools)
            ? responseAllowedTools
            : (wantsDerivedAllowTools ? [makeToolIdentifier(requestSource.toolName, requestSource.input)] : undefined);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            ...(typeof derivedAllowTools !== 'undefined' ? { allowedTools: derivedAllowTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(permissionDecisionActorV1 ? {
                extraCompletedFields: {
                    permissionDecisionActorV1,
                    ...(response.answeringClientCategory ? { answeringClientCategory: response.answeringClientCategory } : {}),
                },
            } : remoteMediationSettlementId ? {
                // The encrypted, host-owned System Record is the sole place
                // that carries the asserted external person. AgentState keeps
                // only this non-authorizing correlation pointer.
                extraCompletedFields: { remoteMediationSettlementId },
            } : {}),
        };
    }

    private applyPermissionResponseAnswers(response: PermissionResponse, result: PermissionResult): boolean {
        if (!response.approved || typeof response.answers === 'undefined') return true;

        const answersRaw = response.answers;
        if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) return false;

        const structured = StructuredQuestionAnswersV1Schema.safeParse(answersRaw);
        if (structured.success) {
            result.answers = structured.data;
            return true;
        }

        // Compatibility reader for UI/action clients through the released 0.2.2 preview,
        // which wrote question -> scalar answer. Remove after that preview is outside the
        // supported mixed-version window and stored/in-flight requests cannot carry it.
        const normalized = Object.create(null) as Record<string, readonly string[]>;
        for (const [key, value] of Object.entries(answersRaw)) {
            if (!key || typeof value !== 'string') return false;
            normalized[key] = [value];
        }

        result.answers = normalized;
        return true;
    }

    private applyPermissionResponseSideEffects(params: Readonly<{
        response: PermissionResponse;
        result: PermissionResult;
        responseAllowedTools: readonly string[] | undefined;
        updatedPermissions: unknown;
        requestSource: Readonly<{ toolName: string; input: unknown }>;
        owner?: PermissionRequestOwner;
        debugMessage: string;
    }>): void {
        const { response, result, responseAllowedTools, updatedPermissions, requestSource } = params;
        const allowedIdentifiers = this.getAllowedToolIdentifiersForOwner(params.owner);

        if (response.approved) {
            applyUpdatedPermissionsToAllowlist(allowedIdentifiers, updatedPermissions);
            applyAllowedToolsToAllowlist(allowedIdentifiers, responseAllowedTools);
            if (!Array.isArray(responseAllowedTools) && result.decision === 'approved_for_session') {
                allowedIdentifiers.add(makeToolIdentifier(requestSource.toolName, requestSource.input));
            }
        }

        if (this.toolTrace) {
            recordToolTraceEvent({
                direction: 'inbound',
                sessionId: this.session.sessionId,
                protocol: this.toolTrace.protocol,
                provider: this.toolTrace.provider,
                kind: 'permission-response',
                payload: {
                    type: 'permission-response',
                    permissionId: response.id,
                    approved: response.approved,
                    decision: result.decision,
                },
            });
        }

        if (result.decision === 'abort' && this.triggerAbortCallbackOnAbortDecision) {
            try {
                const cb = this.onAbortRequested;
                if (cb) {
                    Promise.resolve(cb()).catch((error) => {
                        logger.debug(`${this.getLogPrefix()} onAbortRequested failed (non-fatal)`, error);
                    });
                }
            } catch (error) {
                logger.debug(`${this.getLogPrefix()} onAbortRequested threw (non-fatal)`, error);
            }
        }

        logger.debug(`${this.getLogPrefix()} ${params.debugMessage}`);
    }

    private async raiseNeedsYouQuestion(input: unknown, context?: RpcHandlerContext) {
        const parsed = SessionNeedsYouRaiseInputV1Schema.safeParse(input);
        if (!parsed.success) return { ok: false, errorCode: 'question_input_invalid' } as const;
        const origin = context?.sessionActionOrigin;
        if (origin?.caller.kind !== 'session' || origin.caller.sessionId !== this.session.sessionId
            || (parsed.data.sessionId !== undefined && parsed.data.sessionId !== this.session.sessionId)) {
            return { ok: false, errorCode: 'question_author_forbidden' } as const;
        }
        const data = parsed.data;
        if ('withdraw' in data) {
            return this.requestCoordinator.withResponseClaim(data.requestId, async () => {
                const request = this.requestStore.readOutstandingRequest(data.requestId);
                if (!request || !isAgentStructuredQuestionRequest(request)) {
                    return { ok: false, errorCode: 'permission_request_not_found', requestId: data.requestId } as const;
                }
                const withdrawn = await this.requestStore.completeRequest({ requestId: data.requestId,
                    status: 'canceled', decision: 'abort', reason: data.withdraw });
                if (withdrawn) this.requestCoordinator.cancelRequest(data.requestId, data.withdraw);
                return withdrawn
                    ? { ok: true, requestId: data.requestId, withdrawn: true } as const
                    : { ok: false, errorCode: 'permission_request_not_found', requestId: data.requestId } as const;
            });
        }
        if (context?.signal.aborted) return { ok: false, errorCode: 'question_author_cancelled' } as const;
        if (data.mode === 'wait') {
            const snapshot = this.session.getServerFeaturesSnapshot?.();
            const wireVersion = snapshot?.status === 'ready'
                ? snapshot.features.capabilities.accountStoredContentCompatibility?.currentProtocolVersion : undefined;
            // This is wire admission, not a feature toggle: older strict Homes
            // cannot persist the wait mutation after the native turn has ended.
            if (typeof this.session.yieldQuestionTurn !== 'function'
                || wireVersion === undefined || wireVersion < ACCOUNT_STORED_CONTENT_SESSION_TURN_WAITING_PROTOCOL_VERSION) {
                return { ok: false, errorCode: 'question_turn_yield_unavailable' } as const;
            }
        }
        // Reuse the admitted Action identity rather than minting a second retry identity.
        const requestId = origin.requestId;
        return this.requestCoordinator.withResponseClaim(requestId, async () => {
            const existing = this.requestStore.readOutstandingRequest(requestId);
            const completed = this.session.getAgentStateSnapshot?.()?.completedRequests?.[requestId];
            if (existing || completed) {
                const prior = existing ?? completed!;
                if (prior.source !== SESSION_NEEDS_YOU_REQUEST_SOURCE) {
                    return { ok: false, errorCode: 'question_request_conflict', requestId } as const;
                }
                if (existing?.questionV1?.mode === 'wait'
                    && (!existing.turnId || !await this.session.yieldQuestionTurn(existing.turnId))) {
                    return { ok: false, errorCode: 'question_turn_yield_unavailable', requestId } as const;
                }
                return { ok: true, requestId, mode: prior.questionV1?.mode ?? data.mode } as const;
            }
            const questionV1: SessionQuestionContextV1 = { mode: data.mode, type: data.type,
                lasting: data.lasting ?? false, ...(data.assumption === undefined ? {} : { assumption: data.assumption }),
                ...(data.reason === undefined ? {} : { reason: data.reason }) };
            return this.withPendingRequestPreparation({ requestId, toolName: 'AskUserQuestion', input: data,
                signal: context?.signal }, async (assertCurrent) => {
                const currentHandler = typeof this.session.readQuestionSessionSnapshot === 'function'
                    ? await resolveInitialQuestionHandler({ sessionId: this.session.sessionId, lasting: questionV1.lasting,
                        readSession: sessionId => this.session.readQuestionSessionSnapshot(sessionId) })
                    : { kind: 'person' as const };
                assertCurrent();
                const form = normalizeInteractionTransientQuestionsV1({ kind: 'questions',
                    questions: data.questions, ...(data.title === undefined ? {} : { title: data.title }) });
                await this.requestStore.publishRequestAndWait({ requestId, toolName: 'AskUserQuestion',
                    toolInput: toStructuredQuestionPermissionInput(form), createdAt: Date.now(),
                    turnId: origin.sourceTurnId, kind: 'user_action', source: SESSION_NEEDS_YOU_REQUEST_SOURCE,
                    questionV1, currentHandler,
                    responseTarget: { kind: 'session_question_answer', sessionId: this.session.sessionId, sourceTurnId: origin.sourceTurnId,
                        ...(origin.sourceInputId ? { sourceInputId: origin.sourceInputId } : {}) },
                });
                assertCurrent();
                this.pendingRequests.delete(requestId);
                if (data.mode === 'wait' && !await this.session.yieldQuestionTurn(origin.sourceTurnId)) {
                    // The durable question remains recoverable; never claim a turn ended when it did not.
                    return { ok: false, errorCode: 'question_turn_yield_unavailable', requestId } as const;
                }
                return { ok: true, requestId, mode: data.mode } as const;
            });
        });
    }

    /** Setup RPC handlers at the existing request owner. */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_NEEDS_YOU_RAISE,
            (input: unknown, context) => this.raiseNeedsYouQuestion(input, context));
        const parsePermissionResponse = (input: unknown, legacy = false): PermissionResponse | null => {
            let candidate = input;
            if (legacy && input && typeof input === 'object' && !Array.isArray(input)) {
                const { allowTools, allowedTools, answers, ...rest } = input as Record<string, unknown>;
                if (allowTools !== undefined && allowedTools !== undefined && !isDeepStrictEqual(allowTools, allowedTools)) {
                    return null;
                }
                // The inspected 0.2 predecessor sends scalar answers over `permission`.
                // Translate that historical carrier, then use the same strict current parser.
                const normalizedAnswers = answers && typeof answers === 'object' && !Array.isArray(answers)
                    && Object.values(answers).every((value) => typeof value === 'string')
                    ? Object.fromEntries(Object.entries(answers).map(([question, value]) => [question, [value]]))
                    : answers;
                candidate = {
                    ...rest,
                    ...(allowedTools === undefined && allowTools === undefined ? {} : { allowedTools: allowedTools ?? allowTools }),
                    ...(answers === undefined ? {} : { answers: normalizedAnswers }),
                };
            }
            const parsed = SessionPermissionRespondRpcParamsV1Schema.safeParse(candidate);
            return parsed.success ? parsed.data : null;
        };
        const invalidResponse = (input: unknown): PermissionRespondRpcResult => ({
            ok: false,
            errorCode: 'permission_response_invalid',
            requestId: input && typeof input === 'object' && 'id' in input && typeof input.id === 'string' ? input.id : '',
        });
        const requestIdFor = (response: PermissionResponse): string => (
            typeof response?.id === 'string' ? response.id : ''
        );
        const handleAttributedPermissionResponse = async (
            response: PermissionResponse,
            rpcContext?: RpcHandlerContext,
            expectedRequestKind?: 'permission' | 'user_action',
        ): Promise<PermissionRespondRpcResult> => {
            const permissionDecisionActorV1 = this.resolvePresentUserPermissionActor(rpcContext);
            // The predecessor's single method carries both kinds. Its codec
            // adapter must not bypass the canonical question authority owner.
            const context = expectedRequestKind === undefined
                ? this.requestCoordinator.getResponseContext(response.id) : null;
            if (context && (context.kind ?? resolveAgentRequestKind(context.toolName)) === 'user_action'
                && (rpcContext?.sessionActionOrigin || permissionDecisionActorV1)) {
                return await handleUserActionAnswer(response, rpcContext, permissionDecisionActorV1 ?? undefined);
            }
            if (!permissionDecisionActorV1) {
                return {
                    ok: false,
                    errorCode: 'permission_actor_unattributable',
                    requestId: requestIdFor(response),
                } as const;
            }
            if (expectedRequestKind === 'permission') {
                const actionOutcome = await (this.session as AgentStateRequestStoreBindableSession)
                    .respondToSessionActionConfirmation?.(response, permissionDecisionActorV1);
                if (actionOutcome === 'resolved') return undefined;
                if (actionOutcome === 'invalid') {
                    return {
                        ok: false,
                        errorCode: 'permission_response_invalid',
                        requestId: requestIdFor(response),
                    } as const;
                }
            }
            const outcome = await this.handleIncomingPermissionResponse(response, {
                ...(expectedRequestKind ? { expectedRequestKind } : {}),
                permissionDecisionActorV1,
            });
            if (outcome.status === 'not_found') {
                return {
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: requestIdFor(response),
                } as const;
            }
            if (outcome.status === 'invalid') {
                return {
                    ok: false,
                    errorCode: 'permission_response_invalid',
                    requestId: requestIdFor(response),
                } as const;
            }
            return undefined;
        };
        const managerQuestionRefusal = (requestId: string): PermissionRespondRpcResult => ({
            ok: false, errorCode: 'present_user_required', requestId,
        });
        const handleManagerQuestionResponse = async (
            requestId: string,
            rpcContext: RpcHandlerContext | undefined,
            response: PermissionResponse | null,
        ): Promise<PermissionRespondRpcResult> => {
            const origin = rpcContext?.sessionActionOrigin;
            if (!rpcContext || !origin) return managerQuestionRefusal(requestId);
            return await this.requestCoordinator.withResponseClaim(requestId, async (): Promise<PermissionRespondRpcResult> => {
                const context = this.requestCoordinator.getResponseContext(requestId);
                if (!context) return { ok: false, errorCode: 'permission_request_not_found', requestId };
                const actor = this.resolvePresentUserPermissionActor(rpcContext);
                const readSession = this.session.readQuestionSessionSnapshot?.bind(this.session);
                if (!actor || !context.currentHandler || !readSession
                    || rpcContext.signal.aborted
                    || (response && (!response.approved || !response.answers
                        || (response.decision !== undefined && response.decision !== 'approved')))) {
                    return managerQuestionRefusal(requestId);
                }
                let admitted: boolean;
                try {
                    admitted = await admitManagerQuestionAnswer({
                        sessionId: this.session.sessionId, callerSessionId: origin.caller.sessionId,
                        accountId: actor.accountId, handler: context.currentHandler,
                        question: isAgentStructuredQuestionRequest(context),
                        lasting: context.questionV1?.lasting !== false, readSession,
                    });
                } catch (error) {
                    logger.debug(`${this.getLogPrefix()} Manager question admission unavailable`, error);
                    return managerQuestionRefusal(requestId);
                }
                if (!admitted || rpcContext.signal.aborted) return managerQuestionRefusal(requestId);
                if (!response) {
                    let currentHandler: SessionQuestionHandlerV1;
                    try {
                        currentHandler = await resolveInitialQuestionHandler({
                            sessionId: origin.caller.sessionId, lasting: false, readSession,
                        });
                    } catch (error) {
                        logger.debug(`${this.getLogPrefix()} Manager question pass-up unavailable`, error);
                        return managerQuestionRefusal(requestId);
                    }
                    if (rpcContext.signal.aborted) return managerQuestionRefusal(requestId);
                    const changed = await this.requestCoordinator.changeQuestionHandler({
                        requestId, expectedCreatedAt: context.createdAt, expectedHandler: context.currentHandler, currentHandler,
                    });
                    return changed ? undefined : { ok: false, errorCode: 'permission_request_not_found', requestId };
                }
                const outcome = await this.handleIncomingPermissionResponseUnclaimed(response, {
                    expectedRequestKind: 'user_action',
                    answeredBy: { kind: 'session', sessionId: origin.caller.sessionId },
                    isCurrent: () => {
                        const current = this.requestCoordinator.getResponseContext(requestId);
                        return !rpcContext.signal.aborted && current?.createdAt === context.createdAt
                            && isDeepStrictEqual(current.currentHandler, context.currentHandler);
                    },
                });
                return outcome.status === 'resolved' ? undefined : {
                    ok: false, errorCode: outcome.status === 'invalid' ? 'permission_response_invalid' : 'permission_request_not_found', requestId,
                };
            });
        };
        const handleUserActionAnswer = async (
            response: PermissionResponse,
            rpcContext?: RpcHandlerContext,
            permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'],
        ): Promise<PermissionRespondRpcResult> => {
            if (rpcContext?.sessionActionOrigin) return await handleManagerQuestionResponse(response.id, rpcContext, response);
            const nonPerson = (rpcContext?.callerAuthority !== undefined && rpcContext.callerAuthority !== 'present_user')
                || (rpcContext?.localActionContext?.authority !== undefined && rpcContext.localActionContext.authority !== 'present_user');
            const tokenQuestionContext = nonPerson ? this.requestCoordinator.getResponseContext(response.id) : null;
            const isTokenQuestionAnswerEligible = (): boolean => {
                // RpcHandlerManager has already verified this exact request's
                // signed input binding and grant. This domain exception is
                // conversational only: it cannot authorize approval wrappers
                // or a lasting person-only question.
                const binding = rpcContext?.callerInputAuthorization?.binding;
                const context = this.requestCoordinator.getResponseContext(response.id);
                return Boolean(!rpcContext?.signal.aborted && binding && 'grant' in binding
                    && binding.actionId === 'session.user_action.answer'
                    && binding.target.kind === 'session' && binding.target.sessionId === this.session.sessionId
                    && context && context.createdAt === tokenQuestionContext?.createdAt
                    && isAgentStructuredQuestionRequest(context) && context.questionV1?.lasting !== true);
            };
            if (nonPerson && !isTokenQuestionAnswerEligible()) {
                return managerQuestionRefusal(response.id);
            }
            permissionDecisionActorV1 ??= !nonPerson
                ? this.resolvePresentUserPermissionActor(rpcContext) ?? undefined : undefined;
            const outcome = await this.handleIncomingPermissionResponse(response, {
                expectedRequestKind: 'user_action',
                ...(permissionDecisionActorV1 ? { permissionDecisionActorV1 } : {}),
                ...(!nonPerson && permissionDecisionActorV1 ? { answeredBy: {
                    kind: 'person' as const, accountId: permissionDecisionActorV1.accountId,
                } } : {}),
                ...(nonPerson ? { isCurrent: isTokenQuestionAnswerEligible } : {}),
            });
            if (outcome.status === 'not_found') {
                return {
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: requestIdFor(response),
                } as const;
            }
            if (outcome.status === 'invalid') {
                return {
                    ok: false,
                    errorCode: 'permission_response_invalid',
                    requestId: requestIdFor(response),
                } as const;
            }
            return undefined;
        };
        this.session.rpcHandlerManager.registerHandler<unknown, PermissionRespondRpcResult>(
            'session.permission.respond',
            (input, rpcContext) => {
                const response = parsePermissionResponse(input);
                return response ? handleAttributedPermissionResponse(response, rpcContext, 'permission') : invalidResponse(input);
            },
        );
        this.session.rpcHandlerManager.registerHandler<unknown, PermissionRespondRpcResult>(
            'session.user_action.answer',
            (input, rpcContext) => {
                const passUp = SessionUserActionPassUpRpcParamsV1Schema.safeParse(input);
                if (passUp.success) return handleManagerQuestionResponse(passUp.data.id, rpcContext, null);
                const response = parsePermissionResponse(input);
                return response ? handleUserActionAnswer(response, rpcContext) : invalidResponse(input);
            },
        );
        // Moving 0.2 predecessor codec: retain its lossless carrier and void
        // success contract, delegating authorization and completion in place.
        this.session.rpcHandlerManager.registerHandler<unknown, PermissionRespondRpcResult>(
            SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
            (input, rpcContext) => {
                const response = StructuredQuestionResponseV1Schema.safeParse(input);
                return response.success ? handleUserActionAnswer({
                    id: response.data.id, approved: true, answers: response.data.structuredAnswersV1,
                }, rpcContext) : invalidResponse(input);
            },
        );
        this.updateAgentStateBestEffort((state) => ({
            ...state, capabilities: { ...state.capabilities, structuredQuestionAnswersV1Supported: true },
        }), 'structured-question-answer-capability');
        this.session.rpcHandlerManager.registerHandler<unknown, PermissionRespondRpcResult>(
            'permission',
            // Compatibility adapter for released clients that used this one
            // legacy RPC for both permission and structured-question answers.
            // It has no independent completion logic and still requires the
            // server-derived actor before it can resolve either request shape.
            (input, rpcContext) => {
                const response = parsePermissionResponse(input, true);
                return response ? handleAttributedPermissionResponse(response, rpcContext) : invalidResponse(input);
            },
        );
    }

    /**
     * Project only bounded semantic facts for source-bound requests that a
     * host-stamped mediator can answer. This keeps live and AgentState-only
     * correlation at the existing request owner; it never exposes raw tool
     * input or creates a Channels-owned request model.
     */
    listMediatedPendingRequests(params: Readonly<{
        mediatorPluginId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
        cursor?: string | null;
    }>): SessionPermissionRemotePendingListOutputV1 {
        const mediatorPluginId = params.mediatorPluginId.trim();
        const sourceRef = params.sourceRef.trim();
        const sourceRevisionOrEpoch = params.sourceRevisionOrEpoch.trim();
        if (!mediatorPluginId || !sourceRef || !sourceRevisionOrEpoch) {
            return { requests: [], truncated: false, nextCursor: null };
        }
        const after = params.cursor === undefined || params.cursor === null
            ? null
            : decodeMediatedPendingPermissionCursor(params.cursor);
        if (after === null && params.cursor !== undefined && params.cursor !== null) {
            // An undecodable continuation cannot certify an exact negative to a
            // mediator that still holds custody, so it fails closed instead of
            // silently restarting at the oldest request.
            return { requests: [], truncated: true, nextCursor: null };
        }

        // A durable source-matched request can survive a handler restart before
        // its provider reattaches the live waiter. It is not yet answerable,
        // so omit it from the projection, but do not falsely certify an exact
        // negative list to a mediator that must retain its custody. This is a
        // whole-projection fact, so it is reported on every page.
        let hasUnprojectedSourceRequest = false;
        const requests: MediatedPendingRequest[] = [];
        for (const context of this.requestCoordinator.listResponseContexts()) {
            const kind = resolveAgentRequestKind(context.toolName);
            if (kind !== 'permission' && kind !== 'user_action') continue;
            const sourceAuthority = context.owner?.sourceAuthority;
            if (
                !sourceAuthority
                || sourceAuthority.mediatorPluginId !== mediatorPluginId
                || sourceAuthority.sourceRef !== sourceRef
                || sourceAuthority.sourceRevisionOrEpoch !== sourceRevisionOrEpoch
                || (kind === 'permission' && sourceAuthority.remoteApprovalMaxScope === 'off')
                || !Number.isFinite(context.createdAt)
            ) {
                continue;
            }
            // Do not trim or normalize the opaque request identity here:
            // it is one member of the exact durable tuple.
            const requestId = context.requestId;
            if (!SessionPermissionRequestIdV1Schema.safeParse(requestId).success) continue;
            // `requestId` is not sufficient custody for a remote mediator.
            // Old/corrupt records without a host-stamped turn remain locally
            // resolvable but are deliberately invisible to this authority-bearing projection.
            const turnId = TurnIdSchema.safeParse(context.turnId);
            if (!turnId.success) continue;
            if (context.correlation !== 'record' || context.status !== 'live') {
                const identity = mediationRecordIdentityKey({
                    sessionId: this.session.sessionId,
                    turnId: turnId.data,
                    requestId,
                });
                if (!this.inertRemoteMediationRequestIdentities.has(identity)) {
                    hasUnprojectedSourceRequest = true;
                }
                continue;
            }

            const agentRequestSummary = projectRemoteMediatedRequestSummary({
                kind,
                toolName: context.toolName,
                toolInput: context.toolInput,
                resolveFullFormUrl: () => {
                    const url = new URL(`/session/${encodeURIComponent(this.session.sessionId)}`, configuration.webappUrl);
                    url.username = '';
                    url.password = '';
                    const snapshot = this.session.getServerFeaturesSnapshot();
                    const serverIdentityId = snapshot?.status === 'ready'
                        ? snapshot.features.capabilities.serverIdentity.serverIdentityId
                        : undefined;
                    if (serverIdentityId) url.searchParams.set('serverId', serverIdentityId);
                    return url.toString();
                },
            });
            if (!agentRequestSummary) {
                hasUnprojectedSourceRequest = true;
                continue;
            }
            if (kind === 'user_action') {
                if (agentRequestSummary.kind !== 'user_action') {
                    hasUnprojectedSourceRequest = true;
                    continue;
                }
                requests.push({
                    kind,
                    requestId,
                    turnId: turnId.data,
                    createdAtMs: context.createdAt,
                    agentRequestSummary,
                });
                continue;
            }

            if (agentRequestSummary.kind !== 'permission') {
                hasUnprojectedSourceRequest = true;
                continue;
            }
            const allowedScopes: MediatedPendingPermissionScopes =
                sourceAuthority.remoteApprovalMaxScope === 'session'
                    ? ['request', 'session']
                    : ['request'];
            requests.push({
                kind,
                requestId,
                turnId: turnId.data,
                createdAtMs: context.createdAt,
                allowedScopes,
                agentRequestSummary,
            });
        }
        requests.sort(compareMediatedPendingPermissions);
        const remaining = after === null
            ? requests
            : requests.filter((entry) => compareMediatedPendingPermissions(entry, after) > 0);
        const page = remaining.slice(0, REMOTE_PENDING_PERMISSION_PAGE_SIZE);
        const last = page.at(-1);
        return {
            requests: page,
            // `truncated` is the existing protocol signal that a durable
            // source-matched request exists that this projection cannot yet
            // answer for. A caller can therefore never use an empty result to
            // suppress custody during restart hydration. Further pages are a
            // different fact and are reported by `nextCursor`.
            truncated: hasUnprojectedSourceRequest,
            nextCursor: last !== undefined && remaining.length > page.length
                ? encodeMediatedPendingPermissionCursor(last)
                : null,
        };
    }

    /**
     * Projects durable session grants without exposing encrypted record payloads
     * or generic System Records access. Plugin callers see only their own
     * grants; the host owner sees the exact rule and revocation provenance.
     */
    async listMediatedPermissionGrants(params: Readonly<{
        viewer: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        limit: number;
        cursor?: string | null;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionRemoteGrantsListOutputV1 | null> {
        const store = this.mediationRecordStore;
        if (!store) return null;
        const session = this.session;
        const sessionId = session.sessionId;
        const ledger = { store, session, sessionId } as const;
        if (
            params.signal?.aborted
            || !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(ledger)
        ) return null;
        const outputLimit = Math.min(200, Math.max(1, Math.floor(params.limit)));
        const grants: SessionPermissionRemoteGrantsListOutputV1['grants'] = [];

        const appendVisibleGrants = (records: readonly PermissionMediationStoredRecord[]): void => {
            for (const stored of records) {
                if (stored.kind !== 'remote_grant.v1') continue;
                const record = stored.record;
                if (record.effect.kind !== 'sessionGrant') continue;
                if (
                    params.viewer.kind === 'mediatorPlugin'
                    && record.mediatorPluginId !== params.viewer.pluginId
                ) {
                    continue;
                }
                grants.push({
                    turnId: stored.identity.turnId,
                    requestId: record.requestId,
                    settlementId: record.settlementId,
                    grantId: record.effect.grantId,
                    sourceRef: record.sourceAuthority.sourceRef,
                    sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
                    admittedPermissionCeiling: record.sourceAuthority.admittedPermissionCeiling,
                    actor: {
                        namespace: record.actor.namespace,
                        principalId: record.actor.principalId,
                    },
                    createdAtMs: record.createdAtMs,
                    ...(record.revoked ? { revokedAtMs: record.revoked.atMs } : {}),
                    projection: params.viewer.kind === 'mediatorPlugin'
                        ? { kind: 'mediator' as const }
                        : {
                            kind: 'owner' as const,
                            rule: record.effect.rule,
                            ...(record.revoked ? { revocationActor: record.revoked.actor } : {}),
                        },
                });
            }
        };

        if (params.viewer.kind === 'host') {
            const page = await store.list({
                limit: outputLimit,
                ...(params.cursor ? { cursor: params.cursor } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || page.status !== 'ready'
                || !this.isCurrentRemoteMediationLedger(ledger)
            ) return null;
            appendVisibleGrants(page.records);
            return {
                grants: grants.slice(0, outputLimit),
                nextCursor: page.hasNext ? page.nextCursor : null,
            };
        }

        // A plugin can see only its own rows.  Continue canonical pages until
        // the requested output is filled, the source ends, or the bounded
        // 500-record scan budget is exhausted; each batch is no larger than
        // the output still needed, so the returned cursor skips no row that
        // this invocation has not examined.
        let cursor = params.cursor ?? null;
        let scanned = 0;
        while (grants.length < outputLimit && scanned < 500) {
            const page = await store.list({
                limit: Math.min(outputLimit - grants.length, 500 - scanned),
                ...(cursor ? { cursor } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || page.status !== 'ready'
                || !this.isCurrentRemoteMediationLedger(ledger)
            ) return null;
            scanned += page.records.length;
            appendVisibleGrants(page.records);
            if (!page.hasNext) {
                return { grants, nextCursor: null };
            }
            if (!page.nextCursor || page.nextCursor === cursor || page.records.length === 0) {
                return null;
            }
            cursor = page.nextCursor;
        }
        return {
            grants,
            nextCursor: cursor,
        };
    }

    /** CAS-only durable revocation. It never deletes the audit record. */
    async revokeMediatedPermissionGrant(params: Readonly<{
        turnId: string;
        requestId: string;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        const store = this.mediationRecordStore;
        if (!store) return { status: 'rejected', code: 'mediationStateUnavailable' };
        const session = this.session;
        const sessionId = session.sessionId;
        const identity = mediationRecordIdentity({
            sessionId,
            turnId: params.turnId,
            requestId: params.requestId,
        });
        const ledger = { store, session, sessionId } as const;
        // Hydration can rejoin this request's response claim. Wait for it
        // before taking that claim, then carry the exact ledger through the
        // serialized CAS so a session swap cannot mutate its replacement.
        if (
            !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(ledger)
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        // A grant's final ordinary completion and its revoke CAS share the
        // per-request and ledger-mutation owners. Otherwise a stale created
        // row can activate after a newer durable revocation has succeeded.
        return await this.requestCoordinator.withResponseClaim(
            identity.requestId,
            async () => await this.revokeMediatedPermissionGrantClaimHeld({
                identity,
                grantId: params.grantId,
                caller: params.caller,
                ...(params.signal ? { signal: params.signal } : {}),
            }, ledger),
        );
    }

    /** Caller already owns this request's coordinator response claim and completed its hydration precondition. */
    private async revokeMediatedPermissionGrantClaimHeld(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>, ledger: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        return await this.withRemoteMediationLedgerMutation(
            async () => await this.revokeMediatedPermissionGrantClaimHeldWithinLedgerMutation(params, ledger),
        );
    }

    private async revokeMediatedPermissionGrantClaimHeldWithinLedgerMutation(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>, ledger: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const found = await ledger.store.read({ identity: params.identity, ...(params.signal ? { signal: params.signal } : {}) });
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (found.status === 'unavailable') return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (found.status !== 'found' || found.stored.kind !== 'remote_grant.v1') {
            return { status: 'rejected', code: 'notFound' };
        }
        const record = found.stored.record;
        if (record.effect.kind !== 'sessionGrant' || record.effect.grantId !== params.grantId) {
            return { status: 'rejected', code: 'notFound' };
        }
        let actor: { kind: 'accountUser'; accountId: string } | { kind: 'mediatorPlugin'; pluginId: string };
        if (params.caller.kind === 'mediatorPlugin') {
            if (record.mediatorPluginId !== params.caller.pluginId) return { status: 'rejected', code: 'notFound' };
            actor = { kind: 'mediatorPlugin', pluginId: params.caller.pluginId };
        } else {
            const accountId = await ledger.session.getAuthenticatedAccountId?.();
            if (!accountId || !this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            actor = { kind: 'accountUser', accountId };
        }
        if (record.revoked) {
            this.activeRemoteMediationGrants.delete(mediationRecordIdentityKey(found.stored.identity));
            return { status: 'alreadyRevoked', grantId: record.effect.grantId };
        }
        const nextRecord = SessionPermissionRemoteGrantRecordV1Schema.safeParse({
            ...record,
            revoked: { atMs: Date.now(), actor },
        });
        if (!nextRecord.success) return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const updated = await ledger.store.compareAndSet({
            identity: params.identity,
            expectedRevision: found.stored.revision,
            kind: 'remote_grant.v1',
            record: nextRecord.data,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        const ledgerStillCurrent = this.isCurrentRemoteMediationLedger(ledger);
        // A CAS may have committed even when its result is unavailable, and
        // every conflicting writer is another revocation. While this ledger
        // remains current, all such outcomes must fail closed in memory before
        // cancellation or transport status is reported.
        if (ledgerStillCurrent) this.activeRemoteMediationGrants.delete(mediationRecordIdentityKey(found.stored.identity));
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!ledgerStillCurrent) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (updated.status === 'unavailable') return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (updated.status === 'conflict') {
            const afterConflict = await ledger.store.read({ identity: params.identity, ...(params.signal ? { signal: params.signal } : {}) });
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            if (!this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (
                afterConflict.status === 'found'
                && afterConflict.stored.kind === 'remote_grant.v1'
                && afterConflict.stored.record.effect.kind === 'sessionGrant'
                && afterConflict.stored.record.effect.grantId === params.grantId
                && afterConflict.stored.record.revoked
            ) {
                return { status: 'alreadyRevoked', grantId: params.grantId };
            }
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return { status: 'revoked', grantId: params.grantId };
    }

    /**
     * Settles a source-bound pending permission through the host-owned remote
     * mediation record. This is the only owner-local path that may turn a
     * plugin-attributed external decision into a terminal permission result.
     */
    async respondToMediatedPendingPermission(
        params: MediatedPermissionResponseInput,
    ): Promise<SessionPermissionRemoteRespondOutputV1> {
        const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
        if (!SessionPermissionRequestIdV1Schema.safeParse(requestId).success) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        const prepared = this.prepareMediatedPermissionResponse(params);
        if (!prepared) return { status: 'rejected', code: 'actorUnattributable' };
        // `requestId` is Session-local. Claim it only after all three public
        // custody members identify this handler's live Session and turn.
        if (prepared.input.sessionId !== this.session.sessionId) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (!this.isMediatedPermissionResponseAddressable(prepared)) {
            // A stale session grant remains as exact durable audit evidence
            // after the host revokes it. A replacement handler may report
            // that exact retry as non-pending, but may not use the row to
            // replay, authorize, or mint a response claim.
            if (await this.hasExactRevokedRemoteMediationGrant(prepared, params.signal)) {
                return { status: 'rejected', code: 'requestNotPending' };
            }
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            return { status: 'rejected', code: 'requestNotFound' };
        }

        const acquisition = await this.requestCoordinator.acquireResponseClaim({
            requestId,
            claim: prepared.claim,
        }).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to durably claim remote permission response`, error);
            return null;
        });
        if (!acquisition) return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (acquisition.status === 'conflict') {
            return { status: 'rejected', code: 'decisionConflict' };
        }

        let settlementPersisted = false;
        try {
            return await this.respondToMediatedPendingPermissionUnclaimed(
                params,
                prepared,
                acquisition.status === 'rejoined',
                acquisition.status === 'not_pending',
                () => {
                    settlementPersisted = true;
                },
                () => {
                    settlementPersisted = false;
                },
            );
        } finally {
            // If no remote row/effect exists, a later valid response must
            // remain admissible (for example after a narrowed allow is
            // rejected). Once a row has existed, retain the first-answer
            // claim through completion or a deliberate stale-row
            // neutralization; an exact retry must not turn that invalid
            // external decision into a fresh terminal owner.
            if (acquisition.status !== 'not_pending' && !settlementPersisted) {
                await this.requestCoordinator.releaseResponseClaim({
                    requestId,
                    claim: prepared.claim,
                });
            }
        }
    }

    /**
     * Routes a source-bound external answer through the incumbent
     * user-action completion path. This deliberately has no permission scope,
     * settlement record, grant, or result lookup: an AskUserQuestion remains
     * a live Session request and the request coordinator is its only owner.
     */
    async respondToMediatedPendingUserAction(
        params: MediatedUserActionResponseInput,
    ): Promise<SessionUserActionRemoteAnswerOutputV1> {
        const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
        if (!SessionPermissionRequestIdV1Schema.safeParse(requestId).success) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (
            !PluginIdSchema.safeParse(params.mediator?.pluginId).success
            || !PluginContributionLocalIdSchema.safeParse(params.mediator?.contributionLocalId).success
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const parsed = SessionUserActionRemoteAnswerInputV1Schema.safeParse({
            sessionId: params.sessionId,
            turnId: params.turnId,
            requestId,
            sourceRef: params.sourceRef,
            sourceRevisionOrEpoch: params.sourceRevisionOrEpoch,
            answers: params.answers,
        });
        if (!parsed.success) return { status: 'rejected', code: 'answerInvalid' };
        const input = parsed.data;
        if (input.sessionId !== this.session.sessionId) {
            return { status: 'rejected', code: 'requestNotFound' };
        }

        const context = this.currentMediatedUserActionContext({
            input,
            mediatorPluginId: params.mediator.pluginId,
        });
        if (!context) return { status: 'rejected', code: 'requestNotFound' };
        const answers = this.resolveMediatedUserActionAnswers({ context, input });
        if (!answers) return { status: 'rejected', code: 'answerInvalid' };

        const isCurrent = (): boolean => this.currentMediatedUserActionContext({
            input,
            mediatorPluginId: params.mediator.pluginId,
        }) !== null;
        if (!isCurrent()) return { status: 'rejected', code: 'requestNotPending' };
        const outcome = await this.handleIncomingPermissionResponse({
            id: input.requestId,
            approved: true,
            decision: 'approved',
            answers,
        }, {
            expectedRequestKind: 'user_action',
            isCurrent,
        });
        if (outcome.status === 'resolved') {
            return { status: 'applied', requestId: input.requestId };
        }
        return {
            status: 'rejected',
            code: outcome.status === 'invalid' ? 'answerInvalid' : 'requestNotPending',
        };
    }

    private currentMediatedUserActionContext(params: Readonly<{
        input: SessionUserActionRemoteAnswerInputV1;
        mediatorPluginId: string;
    }>): PermissionRequestCoordinatorContext | null {
        const context = this.requestCoordinator.getResponseContext(params.input.requestId);
        if (
            !context
            || context.correlation !== 'record'
            || context.status !== 'live'
            || resolveAgentRequestKind(context.toolName) !== 'user_action'
            || !matchesMediatedPermissionTurnId(context.turnId, params.input)
            || !matchesRemoteMediationSourceAuthority(
                context.owner?.sourceAuthority,
                params.input,
                params.mediatorPluginId,
            )
        ) {
            return null;
        }
        return context;
    }

    private resolveMediatedUserActionAnswers(params: Readonly<{
        context: PermissionRequestCoordinatorContext;
        input: SessionUserActionRemoteAnswerInputV1;
    }>): StructuredQuestionAnswersV1 | null {
        const semantic = buildAgentRequestSemanticSummary({
            kind: 'user_action',
            toolName: params.context.toolName,
            toolInput: params.context.toolInput,
        });
        if (
            semantic.questions.length === 0
            || requiresFullFormForRemoteUserAction(semantic.questions)
        ) {
            return null;
        }
        const answersByQuestionIndex = new Map<number, readonly string[]>();
        for (const answer of params.input.answers) {
            if (
                answer.questionIndex >= semantic.questions.length
                || answersByQuestionIndex.has(answer.questionIndex)
            ) {
                return null;
            }
            answersByQuestionIndex.set(answer.questionIndex, answer.values);
        }
        const answers: Record<string, readonly string[]> = Object.create(null);
        for (const [questionIndex, question] of semantic.questions.entries()) {
            if (answers[question.answerKey] !== undefined) return null;
            const values = answersByQuestionIndex.get(questionIndex);
            if (!values) {
                if (question.required) return null;
                continue;
            }
            const resolvedValues = resolveRemoteMediatedQuestionValues({ question, values });
            if (!resolvedValues) return null;
            answers[question.answerKey] = resolvedValues;
        }
        const parsed = StructuredQuestionAnswersV1Schema.safeParse(answers);
        return parsed.success ? parsed.data : null;
    }

    private prepareMediatedPermissionResponse(
        params: MediatedPermissionResponseInput,
    ): PreparedMediatedPermissionResponse | null {
        const inputResult = SessionPermissionRemoteRespondInputV1Schema.safeParse({
            sessionId: params.sessionId,
            turnId: params.turnId,
            requestId: params.requestId,
            sourceRef: params.sourceRef,
            sourceRevisionOrEpoch: params.sourceRevisionOrEpoch,
            idempotencyKey: params.idempotencyKey,
            actor: params.actor,
            decision: params.decision,
            scope: params.scope,
        });
        if (!inputResult.success) return null;
        const mediatorPluginId = PluginIdSchema.safeParse(params.mediator?.pluginId);
        const mediatorContributionLocalId = PluginContributionLocalIdSchema.safeParse(
            params.mediator?.contributionLocalId,
        );
        if (!mediatorPluginId.success || !mediatorContributionLocalId.success) return null;
        const mediator = {
            pluginId: mediatorPluginId.data,
            contributionLocalId: mediatorContributionLocalId.data,
        } as const;
        const actor = SessionPermissionExternalHumanDecisionActorV1Schema.safeParse({
            kind: 'externalHuman',
            assurance: 'pluginAsserted',
            namespace: inputResult.data.actor.namespace,
            principalId: inputResult.data.actor.principalId,
            assertedBy: mediator,
        });
        if (!actor.success) return null;

        return {
            input: inputResult.data,
            mediator,
            actor: actor.data,
            claim: {
                version: 1,
                origin: 'remoteMediation',
                actor: actor.data,
                mediatorPluginId: mediator.pluginId,
                turnId: inputResult.data.turnId,
                sourceRef: inputResult.data.sourceRef,
                sourceRevisionOrEpoch: inputResult.data.sourceRevisionOrEpoch,
                idempotencyKey: inputResult.data.idempotencyKey,
                decision: inputResult.data.decision,
                scope: inputResult.data.scope,
            },
        };
    }

    /**
     * A new remote answer may enter the terminal-claim path only through this
     * handler's live coordinator record. Durable claims and completed
     * projections remain addressable for their existing recovery/retry paths;
     * a raw AgentState-only outstanding request must first reattach through
     * the incumbent request owner.
     */
    private isMediatedPermissionResponseAddressable(
        prepared: PreparedMediatedPermissionResponse,
    ): boolean {
        const context = this.requestCoordinator.getResponseContext(prepared.input.requestId);
        if (
            context
            && context.correlation === 'record'
            && context.status === 'live'
            && resolveAgentRequestKind(context.toolName) === 'permission'
            && matchesMediatedPermissionTurnId(context.turnId, prepared.input)
            && matchesRemoteMediationSourceAuthority(
                context.owner?.sourceAuthority,
                prepared.input,
                prepared.mediator.pluginId,
            )
        ) {
            return true;
        }
        const outstanding = this.requestStore.readOutstandingRequest(prepared.input.requestId);
        const hasMatchingOutstandingClaim = Boolean(
            outstanding
            && resolveAgentRequestKind(outstanding.toolName) === 'permission'
            && matchesMediatedPermissionTurnId(outstanding.turnId, prepared.input)
            && matchesRemoteMediationSourceAuthority(
                outstanding.owner?.sourceAuthority,
                prepared.input,
                prepared.mediator.pluginId,
            )
            && this.requestStore.hasPermissionResponseClaim(prepared.input.requestId),
        );
        return hasMatchingOutstandingClaim
            || this.isCompletedMediatedPermissionRequestVisible({
                input: prepared.input,
                mediatorPluginId: prepared.mediator.pluginId,
            });
    }

    /**
     * A revoked session-grant row is a non-authorizing exact-retry barrier.
     * This deliberately admits no live response path: it only preserves the
     * stable `requestNotPending` result after a handler restart. All payload
     * members, including the host-stamped turn, must match the one canonical
     * durable record before it is observable this way.
     */
    private async hasExactRevokedRemoteMediationGrant(
        prepared: PreparedMediatedPermissionResponse,
        signal: AbortSignal | undefined,
    ): Promise<boolean> {
        const store = this.mediationRecordStore;
        if (!store) return false;
        const session = this.session;
        const sessionId = session.sessionId;
        const found = await store.read({
            identity: mediationRecordIdentity(prepared.input),
            ...(signal ? { signal } : {}),
        });
        if (
            signal?.aborted
            || !this.isCurrentRemoteMediationLedger({ store, session, sessionId })
            || found.status !== 'found'
        ) {
            return false;
        }
        const outcome = this.resolveRemoteMediationRecordOutcome(
            found.stored,
            prepared.input,
            prepared.mediator,
            'alreadyApplied',
        );
        return outcome.status === 'rejected' && outcome.code === 'requestNotPending';
    }

    private isCompletedMediatedPermissionRequestVisible(params: Readonly<{
        input: SessionPermissionRemoteRespondInputV1;
        mediatorPluginId: string;
    }>): boolean {
        const completed = this.session.getAgentStateSnapshot?.()?.completedRequests?.[params.input.requestId];
        if (!completed || typeof completed !== 'object' || Array.isArray(completed)) return false;
        const entry = completed as Readonly<Record<string, unknown>>;
        if (typeof entry.tool !== 'string' || resolveAgentRequestKind(entry.tool) !== 'permission') return false;
        if (!matchesMediatedPermissionTurnId(entry.turnId, params.input)) return false;
        const owner = normalizePermissionRequestOwner(entry.owner, 'stored');
        return matchesRemoteMediationSourceAuthority(
            owner?.sourceAuthority,
            params.input,
            params.mediatorPluginId,
        );
    }

    /**
     * A row that committed after its request/policy became stale must not be
     * left as a future replay or restart authority. Reuse the fixed record
     * lifecycle: settlements are inactive and may be pruned; grants retain
     * their audit row through the existing host revocation CAS.
     */
    private async neutralizeStaleMediatedPermissionRecord(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        stored: PermissionMediationStoredRecord;
    }>): Promise<boolean> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (!this.isCurrentRemoteMediationLedger(ledger)) return false;

        if (params.stored.kind === 'remote_settlement.v1') {
            const pruned = await params.store.pruneInactive({
                identity: params.stored.identity,
                expectedRevision: params.stored.revision,
            });
            if (!this.isCurrentRemoteMediationLedger(ledger)) return false;
            if (pruned.status === 'pruned') return true;
            if (pruned.status !== 'conflict') return false;
            const afterConflict = await params.store.read({ identity: params.stored.identity });
            return this.isCurrentRemoteMediationLedger(ledger) && afterConflict.status === 'absent';
        }

        if (params.stored.record.effect.kind !== 'sessionGrant') return false;
        const revoked = await this.revokeMediatedPermissionGrantClaimHeld({
            identity: params.stored.identity,
            grantId: params.stored.record.effect.grantId,
            caller: { kind: 'host' },
        }, ledger);
        return this.isCurrentRemoteMediationLedger(ledger)
            && (revoked.status === 'revoked' || revoked.status === 'alreadyRevoked');
    }

    private async respondToMediatedPendingPermissionUnclaimed(
        params: MediatedPermissionResponseInput,
        prepared: PreparedMediatedPermissionResponse,
        rejoinedExistingClaim: boolean,
        requestWasNotPending: boolean,
        onSettlementPersisted: () => void,
        onSettlementNeutralized: () => void,
    ): Promise<SessionPermissionRemoteRespondOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };

        const { input, mediator, actor } = prepared;

        const recordStore = this.mediationRecordStore;
        if (!recordStore) return { status: 'rejected', code: 'mediationStateUnavailable' };
        const recordSession = this.session;
        const recordSessionId = recordSession.sessionId;
        const identity = mediationRecordIdentity(input);

        const existing = await recordStore.read({ identity, signal: params.signal });
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger({
            store: recordStore,
            session: recordSession,
            sessionId: recordSessionId,
        })) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (existing.status === 'unavailable') {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (existing.status === 'found') {
            const outcome = this.resolveRemoteMediationRecordOutcome(existing.stored, input, mediator, 'alreadyApplied');
            if (outcome.status === 'rejected') return outcome;
            onSettlementPersisted();
            const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
                stored: existing.stored,
                input,
                mediator,
                outcome,
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
                mustComplete: false,
                onGrantNeutralized: onSettlementNeutralized,
            });
            return replayRejection ?? outcome;
        }

        // A rejoined remote claim without its companion System Record is an
        // ambiguous prior terminal attempt. In particular, this is the state
        // left after pruning a stale allow settlement. Finish that claimed
        // operation non-authorizing rather than minting a fresh row or leaving
        // its original provider waiter stranded.
        if (rejoinedExistingClaim) {
            onSettlementPersisted();
            const settlement = await this.requestCoordinator.withResponseClaim(
                input.requestId,
                async () => await this.settleMediatedPermissionNonAuthorizing({ requestId: input.requestId }),
            );
            if (settlement === 'unavailable') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if (requestWasNotPending) {
            return this.isCompletedMediatedPermissionRequestVisible({
                input,
                mediatorPluginId: mediator.pluginId,
            })
                ? { status: 'rejected', code: 'requestNotPending' }
                : { status: 'rejected', code: 'requestNotFound' };
        }

        const legacyPending = this.pendingRequests.get(input.requestId);
        const context = this.requestCoordinator.getResponseContext(input.requestId)
            ?? (legacyPending
                ? {
                    requestId: input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (
            !context
            || resolveAgentRequestKind(context.toolName) !== 'permission'
            || !matchesMediatedPermissionTurnId(context.turnId, input)
        ) {
            return this.isCompletedMediatedPermissionRequestVisible({
                input,
                mediatorPluginId: mediator.pluginId,
            })
                ? { status: 'rejected', code: 'requestNotPending' }
                : { status: 'rejected', code: 'requestNotFound' };
        }
        const sourceAuthority = context.owner?.sourceAuthority;
        if (!sourceAuthority || !matchesRemoteMediationSourceAuthority(sourceAuthority, input, mediator.pluginId)) {
            // Deliberately do not reveal whether another mediator owns the
            // request or whether its source authority changed.
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (sourceAuthority.remoteApprovalMaxScope === 'off') {
            return { status: 'rejected', code: 'remoteApprovalDisabled' };
        }
        if (input.decision === 'allow' && input.scope === 'session') {
            if (sourceAuthority.remoteApprovalMaxScope !== 'session'
                || context.source === NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE) {
                return { status: 'rejected', code: 'scopeExceedsPolicy' };
            }
        }
        const causalPermissionContext = legacyPending?.causalPermissionContext ?? {
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1' as const,
                admittedPermissionCeiling: sourceAuthority.admittedPermissionCeiling,
                sourceAuthority,
            },
        };
        if (
            input.decision === 'allow'
            && !this.isCurrentRemoteMediationAllowEligible({
                requestId: input.requestId,
                toolName: context.toolName,
                input: context.toolInput,
                causalPermissionContext,
            })
        ) {
            return { status: 'rejected', code: 'permissionCeilingExceeded' };
        }

        const recordPayload = {
            version: 1,
            settlementId: randomUUID(),
            turnId: input.turnId,
            requestId: input.requestId,
            mediatorPluginId: mediator.pluginId,
            idempotencyKey: input.idempotencyKey,
            sourceAuthority,
            actor,
            decision: input.decision,
            requestedScope: input.scope,
            effect: input.decision === 'allow' && input.scope === 'session'
                ? {
                    kind: 'sessionGrant',
                    grantId: randomUUID(),
                    rule: {
                        kind: 'exactTool',
                        identifier: makeToolIdentifier(context.toolName, context.toolInput),
                    },
                }
                : input.decision === 'allow' ? { kind: 'allowOnce' } : { kind: 'deny' },
            createdAtMs: Date.now(),
        } as const;
        let recordWrite: PermissionMediationRecordWrite;
        if (input.decision === 'allow' && input.scope === 'session') {
            const grant = SessionPermissionRemoteGrantRecordV1Schema.safeParse(recordPayload);
            if (grant.success === false) {
                // A request the host cannot express as a canonical exact-tool
                // rule has no Session scope. That is a permanent property of
                // this request, not a transient ledger failure: telling the
                // mediator so is what keeps request scope usable.
                if (grant.error.issues.some((issue) => (
                    issue.path[0] === 'effect'
                    && issue.path[1] === 'rule'
                    && issue.path[2] === 'identifier'
                ))) {
                    return { status: 'rejected', code: 'sessionScopeUnsupported' };
                }
                logger.debug(`${this.getLogPrefix()} Failed to construct a valid remote permission grant`, grant.error);
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            recordWrite = { kind: 'remote_grant.v1', record: grant.data };
        } else {
            const settlement = SessionPermissionRemoteSettlementRecordV1Schema.safeParse(recordPayload);
            if (!settlement.success) {
                logger.debug(`${this.getLogPrefix()} Failed to construct a valid remote permission settlement`, settlement.error);
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            recordWrite = { kind: 'remote_settlement.v1', record: settlement.data };
        }

        // Hydration can neutralize a stale grant through the same incumbent
        // ledger-mutation owner used below. Finish that recovery before taking
        // the owner so neither side waits for the other while holding it.
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (
            !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        // The answer was admitted above. Later steps keep only request/turn/
        // source custody and the first-answer claim; they do not re-decide
        // policy, so an owner's later narrowing applies to the next admission.
        const creation = await this.withRemoteMediationLedgerMutation(async () => {
            const admission = await this.admitRemoteMediationLedgerWrite({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
                recordWrite,
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (admission.status !== 'ready') return { admission } as const;
            if (!this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })) {
                return { admission: { status: 'unavailable' } } as const;
            }
            const currentContext = this.requestCoordinator.getResponseContext(input.requestId);
            const currentSourceAuthority = currentContext?.owner?.sourceAuthority;
            if (
                params.signal?.aborted
                || !currentContext
                || !matchesMediatedPermissionTurnId(currentContext.turnId, input)
                || !currentSourceAuthority
                || !matchesRemoteMediationSourceAuthority(currentSourceAuthority, input, mediator.pluginId)
            ) {
                return { currentnessLost: true } as const;
            }
            const reaffirmedClaim = await this.requestCoordinator.rejoinResponseClaim({
                requestId: input.requestId,
                claim: prepared.claim,
            });
            if (reaffirmedClaim.status !== 'rejoined') {
                return { claimLost: reaffirmedClaim } as const;
            }
            const created = await recordStore.createExpectedAbsent({
                identity,
                ...recordWrite,
                ...(params.signal ? { signal: params.signal } : {}),
            });
            const claimAfterRecordCas = await this.requestCoordinator.rejoinResponseClaim({
                requestId: input.requestId,
                claim: prepared.claim,
            });
            if (claimAfterRecordCas.status !== 'rejoined') {
                if (created.status === 'created') {
                    onSettlementPersisted();
                    return {
                        staleCreated: created.stored,
                        staleRejection: claimAfterRecordCas.status === 'conflict'
                            ? { status: 'rejected' as const, code: 'decisionConflict' as const }
                            : { status: 'rejected' as const, code: 'requestNotPending' as const },
                    } as const;
                }
                return { claimLost: claimAfterRecordCas } as const;
            }
            if (created.status === 'created') {
                // The System Record is now the first-answer evidence. Retain
                // the coordinator claim until this exact row has been
                // neutralized or completed.
                onSettlementPersisted();
            }
            if (!this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })) {
                return { admission: { status: 'unavailable' } } as const;
            }
            return { created } as const;
        });
        if ('staleCreated' in creation && creation.staleCreated) {
            const neutralized = await this.requestCoordinator.withResponseClaim(
                input.requestId,
                async () => await this.neutralizeStaleMediatedPermissionRecord({
                    store: recordStore,
                    session: recordSession,
                    sessionId: recordSessionId,
                    stored: creation.staleCreated,
                }),
            );
            if (neutralized && creation.staleCreated.kind === 'remote_grant.v1') {
                // A revoked grant is its own durable replay barrier, so the
                // temporary coordinator claim can be released for reset and
                // ordinary cancellation without reopening authorization.
                onSettlementNeutralized();
            }
            if (neutralized && creation.staleCreated.kind === 'remote_settlement.v1') {
                const settlement = await this.requestCoordinator.withResponseClaim(
                    input.requestId,
                    async () => await this.settleMediatedPermissionNonAuthorizing({
                        requestId: input.requestId,
                        settlementId: creation.staleCreated.record.settlementId,
                    }),
                );
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
            }
            return neutralized
                ? creation.staleRejection
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if ('currentnessLost' in creation && creation.currentnessLost) {
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if ('claimLost' in creation && creation.claimLost) {
            return creation.claimLost.status === 'conflict'
                ? { status: 'rejected', code: 'decisionConflict' }
                : { status: 'rejected', code: 'requestNotPending' };
        }
        if ('admission' in creation && creation.admission) {
            return creation.admission.status === 'sessionGrantCapacityExceeded'
                ? { status: 'rejected', code: 'sessionGrantCapacityExceeded' }
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const created = creation.created;
        if (created.status === 'unavailable') {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (created.status === 'conflict') {
            const afterConflict = await recordStore.read({ identity, signal: params.signal });
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            if (afterConflict.status === 'found') {
                const outcome = this.resolveRemoteMediationRecordOutcome(
                    afterConflict.stored,
                    input,
                    mediator,
                    'alreadyApplied',
                );
                if (outcome.status === 'rejected') return outcome;
                onSettlementPersisted();
                const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
                    stored: afterConflict.stored,
                    input,
                    mediator,
                    outcome,
                    store: recordStore,
                    session: recordSession,
                    sessionId: recordSessionId,
                    mustComplete: false,
                    onGrantNeutralized: onSettlementNeutralized,
                });
                return replayRejection ?? outcome;
            }
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        const applied = this.resolveRemoteMediationRecordOutcome(created.stored, input, mediator, 'applied');
        if (applied.status === 'rejected') {
            logger.debug(`${this.getLogPrefix()} Remote permission record writer returned a non-matching created row`);
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
            stored: created.stored,
            input,
            mediator,
            outcome: applied,
            store: recordStore,
            session: recordSession,
            sessionId: recordSessionId,
            mustComplete: true,
            onGrantNeutralized: onSettlementNeutralized,
        });
        return replayRejection ?? applied;
    }

    /**
     * Hydration can recover the same durable response claim. Complete that
     * scan before taking the local response claim, then retain the captured
     * ledger through replay so a session swap fails closed rather than waiting
     * on its replacement hydration under the claim.
     */
    private async replayRemoteMediationCompletionAfterHydration(params: Readonly<{
        stored: PermissionMediationStoredRecord;
        input: SessionPermissionRemoteRespondInputV1;
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
        outcome: Exclude<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>;
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        /** A newly-created row must complete this still-live request. */
        mustComplete: boolean;
        /** A successful stale-grant revocation is durable without this claim. */
        onGrantNeutralized: () => void;
    }>): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (
            params.stored.kind === 'remote_grant.v1'
            && (
                !this.isCurrentRemoteMediationLedger(ledger)
                || !await this.ensureRemoteMediationGrantsHydrated()
                || !this.isCurrentRemoteMediationLedger(ledger)
            )
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return await this.requestCoordinator.withResponseClaim(
            params.input.requestId,
            async () => await this.replayRemoteMediationCompletionIfPending({
                ...params,
                ...(params.stored.kind === 'remote_grant.v1'
                    ? { skipRemoteMediationGrantHydration: true }
                    : {}),
            }),
        );
    }

    /**
     * A durable mediation row is the terminal decision claim, but it is not
     * itself the permission completion owner. If the process is interrupted
     * between creating that row and completing the coordinator, a retry must
     * drive the same coordinator path rather than reporting an idempotent
     * success while the original request remains pending.
     *
     * This is deliberately a no-op for an already-completed or no-longer-live
     * request. The stored row remains the idempotency result in that case; it
     * must not recreate a completion from stale state.
     */
    private async replayRemoteMediationCompletionIfPending(params: Readonly<{
        stored: PermissionMediationStoredRecord;
        input: SessionPermissionRemoteRespondInputV1;
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
        outcome: Exclude<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>;
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        /** A newly-created row must complete this still-live request. */
        mustComplete: boolean;
        /** Avoid waiting on the hydration promise that is replaying this row. */
        skipRemoteMediationGrantHydration?: boolean;
        /** Hydration publishes the fully reconciled active map as one step. */
        deferRemoteMediationGrantActivation?: boolean;
        /** A successful stale-grant revocation is durable without this claim. */
        onGrantNeutralized: () => void;
    }>): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        const staleRecordRejection = async (
            rejection: Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>,
        ): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> => {
            const live = this.requestCoordinator.getResponseContext(params.input.requestId);
            if (!live || resolveAgentRequestKind(live.toolName) !== 'permission') {
                return params.mustComplete
                    ? { status: 'rejected', code: 'requestNotPending' }
                    : null;
            }
            const neutralized = await this.neutralizeStaleMediatedPermissionRecord({
                ...ledger,
                stored: params.stored,
            });
            if (neutralized && params.stored.kind === 'remote_grant.v1') {
                params.onGrantNeutralized();
            }
            if (neutralized && params.stored.kind === 'remote_settlement.v1') {
                const settlement = await this.settleMediatedPermissionNonAuthorizing({
                    requestId: params.input.requestId,
                    settlementId: params.stored.record.settlementId,
                });
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
            }
            return neutralized
                ? rejection
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        };

        if (params.stored.kind === 'remote_grant.v1' && !params.skipRemoteMediationGrantHydration) {
            if (!await this.ensureRemoteMediationGrantsHydrated() || !this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
        }

        // The row records an admitted answer; it finishes without a fresh
        // policy decision. Resolve request/turn/source custody once, after
        // hydration, immediately before completion or grant activation.
        const legacyPending = this.pendingRequests.get(params.input.requestId);
        const context = this.requestCoordinator.getResponseContext(params.input.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context || resolveAgentRequestKind(context.toolName) !== 'permission') {
            return params.mustComplete
                ? { status: 'rejected', code: 'requestNotPending' }
                : null;
        }
        const sourceAuthority = context.owner?.sourceAuthority;
        if (!matchesMediatedPermissionTurnId(context.turnId, params.input) || !sourceAuthority || !matchesRemoteMediationSourceAuthority(
            sourceAuthority,
            params.input,
            params.mediator.pluginId,
        )) {
            return await staleRecordRejection({ status: 'rejected', code: 'requestNotFound' });
        }

        let completionStored = params.stored;
        if (params.stored.kind === 'remote_grant.v1') {
            // The record CAS and ordinary AgentState completion are separate
            // durable operations. Re-read the exact row while this request's
            // coordinator claim is held so a completed revoke cannot be
            // followed by activation from the stale create result.
            const current = await params.store.read({ identity: params.stored.identity });
            if (!this.isCurrentRemoteMediationLedger(ledger) || current.status === 'unavailable') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (current.status !== 'found' || current.stored.kind !== 'remote_grant.v1') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            const originalGrant = params.stored.record;
            const currentGrant = current.stored.record;
            if (
                originalGrant.effect.kind !== 'sessionGrant'
                || currentGrant.effect.kind !== 'sessionGrant'
                || currentGrant.settlementId !== originalGrant.settlementId
                || currentGrant.effect.grantId !== originalGrant.effect.grantId
            ) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (currentGrant.revoked) {
                const settlement = await this.settleMediatedPermissionNonAuthorizing({
                    requestId: currentGrant.requestId,
                    settlementId: currentGrant.settlementId,
                });
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
                params.onGrantNeutralized();
                return { status: 'rejected', code: 'requestNotPending' };
            }
            if (current.stored.revision !== params.stored.revision) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            completionStored = current.stored;
        }
        const completionIsCurrent = () => (
            completionStored.identity.sessionId === ledger.sessionId
            && this.isCurrentRemoteMediationLedger(ledger)
        );
        if (!completionIsCurrent()) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const completed = await this.handlePermissionResponseWithContext({
            response: {
                id: completionStored.record.requestId,
                approved: completionStored.record.decision === 'allow',
                decision: completionStored.record.decision === 'allow' ? 'approved' : 'denied',
            },
            context,
            legacyPending,
            remoteMediationSettlementId: params.outcome.settlementId,
            isCurrent: completionIsCurrent,
        });
        if (!completed && params.mustComplete) {
            // Lifecycle cancellation may win after the System Record CAS but
            // while the ordinary AgentState terminal write is in flight. The
            // coordinator's durable canceled result is then authoritative;
            // remove this newly-created nonauthorizing row through the same
            // ledger owner so an exact retry cannot report it as applied.
            const neutralized = await this.neutralizeStaleMediatedPermissionRecord({
                ...ledger,
                stored: completionStored,
            });
            if (neutralized) params.onGrantNeutralized();
            return neutralized
                ? { status: 'rejected', code: 'requestNotPending' }
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (!completionIsCurrent()) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (
            completed
            && completionStored.kind === 'remote_grant.v1'
            && !params.deferRemoteMediationGrantActivation
            && !this.addRemoteMediationGrant(completionStored, this.activeRemoteMediationGrants)
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return null;
    }

    private async settleMediatedPermissionNonAuthorizing(params: Readonly<{
        requestId: string;
        settlementId?: string;
    }>): Promise<'completed' | 'not_pending' | 'unavailable'> {
        const legacyPending = this.pendingRequests.get(params.requestId);
        const context = this.requestCoordinator.getResponseContext(params.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context || resolveAgentRequestKind(context.toolName) !== 'permission') return 'not_pending';

        const completed = await this.handlePermissionResponseWithContext({
            response: {
                id: params.requestId,
                approved: false,
                decision: 'denied',
            },
            context,
            legacyPending,
            ...(params.settlementId ? { remoteMediationSettlementId: params.settlementId } : {}),
        });
        if (completed) return 'completed';
        return this.requestCoordinator.getResponseContext(params.requestId) ? 'unavailable' : 'not_pending';
    }

    private resolveRemoteMediationRecordOutcome(
        stored: PermissionMediationStoredRecord,
        input: SessionPermissionRemoteRespondInputV1,
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>,
        status: 'applied' | 'alreadyApplied',
    ): SessionPermissionRemoteRespondOutputV1 {
        const record = stored.record;
        const expectedIdentity = mediationRecordIdentity(input);
        if (
            mediationRecordIdentityKey(stored.identity) !== mediationRecordIdentityKey(expectedIdentity)
            || record.turnId !== stored.identity.turnId
            || record.requestId !== stored.identity.requestId
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (!matchesRemoteMediationSourceAuthority(record.sourceAuthority, input, mediator.pluginId)) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (
            record.requestId !== input.requestId
            || record.turnId !== input.turnId
            || record.idempotencyKey !== input.idempotencyKey
            || record.decision !== input.decision
            || record.requestedScope !== input.scope
            || record.actor.namespace !== input.actor.namespace
            || record.actor.principalId !== input.actor.principalId
            || record.actor.assertedBy.pluginId !== mediator.pluginId
        ) {
            return { status: 'rejected', code: 'decisionConflict' };
        }
        if (stored.kind === 'remote_grant.v1' && record.revoked) {
            // A host-revoked stale grant remains durable audit evidence, but
            // no longer replays or activates through an exact retry.
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if (record.decision === 'deny') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'deny',
                effect: { kind: 'deny' },
            };
        }
        if (stored.kind === 'remote_settlement.v1' && record.effect.kind === 'allowOnce') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'allow',
                effect: { kind: 'allowOnce' },
            };
        }
        if (stored.kind === 'remote_grant.v1' && record.effect.kind === 'sessionGrant') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'allow',
                effect: {
                    kind: 'sessionGrant',
                    grantId: record.effect.grantId,
                    sourceRef: record.sourceAuthority.sourceRef,
                    sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
                    admittedPermissionCeiling: record.sourceAuthority.admittedPermissionCeiling,
                },
            };
        }
        return { status: 'rejected', code: 'decisionConflict' };
    }

    private resolvePresentUserPermissionActor(
        rpcContext: RpcHandlerContext | undefined,
    ): SocketRpcSessionPermissionRespondAuthorizationContext['actor'] | null {
        const authorization = parseSocketRpcAuthorizationContext(rpcContext?.authorization);
        if (
            !authorization
            || authorization.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND
            || authorization.sessionId !== this.session.sessionId
        ) {
            return null;
        }
        return authorization.actor;
    }

    private async handleIncomingPermissionResponse(
        response: PermissionResponse,
        options?: Readonly<{
            expectedRequestKind?: 'permission' | 'user_action';
            permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
            answeredBy?: SessionQuestionHandlerV1;
            isCurrent?: () => boolean;
        }>,
    ): Promise<PermissionResponseRoutingResult> {
        return await this.requestCoordinator.withResponseClaim(response.id, async () => {
            const actor = options?.permissionDecisionActorV1;
            const result = actor ? this.buildPermissionResult(response) : null;
            const context = actor ? this.requestCoordinator.getResponseContext(response.id) : null;
            const responseTurnId = TurnIdSchema.safeParse(response.turnId);
            const contextTurnId = context?.turnId;
            const hasMatchingTurnCustody = context
                ? contextTurnId
                    ? responseTurnId.success && responseTurnId.data === contextTurnId
                    : typeof response.turnId === 'undefined'
                : true;
            const claim: PermissionResponseClaim | null = actor && result && options?.expectedRequestKind !== 'user_action'
                ? {
                    version: 1,
                    origin: 'presentUser',
                    actor,
                    ...(contextTurnId
                        ? { turnId: contextTurnId }
                        : responseTurnId.success
                            ? { turnId: responseTurnId.data }
                            : {}),
                    decision: result.decision,
                    scope: result.decision === 'approved_for_session' ? 'session' : 'request',
                }
                : null;
            if (!context && claim) {
                const settled = this.requestCoordinator.readCompletedResponseClaim({
                    requestId: response.id,
                    claim,
                });
                if (settled.status === 'rejoined') return { status: 'resolved' };
                if (settled.status === 'conflict') return { status: 'not_found' };
            }
            const isPresentPermissionResponse = Boolean(
                actor
                && context
                && hasMatchingTurnCustody
                && options?.expectedRequestKind !== 'user_action'
                && resolveAgentRequestKind(context.toolName) === 'permission'
                && isPermissionResponseAuthorityValid({ response, context }),
            );
            if (actor && context && options?.expectedRequestKind !== 'user_action' && !hasMatchingTurnCustody) {
                return { status: 'not_found' };
            }
            if (!isPresentPermissionResponse || !actor || !claim) {
                return await this.handleIncomingPermissionResponseUnclaimed(response, options);
            }

            const acquisition = await this.requestCoordinator.acquireResponseClaim({
                requestId: response.id,
                claim,
            });
            if (acquisition.status === 'conflict') {
                return { status: 'not_found' };
            }
            if (acquisition.status === 'not_pending') {
                const settled = this.requestCoordinator.readCompletedResponseClaim({
                    requestId: response.id,
                    claim,
                });
                return settled.status === 'rejoined'
                    ? { status: 'resolved' }
                    : { status: 'not_found' };
            }

            let completed = false;
            try {
                const routed = await this.handleIncomingPermissionResponseUnclaimed(response, options);
                completed = routed.status === 'resolved';
                return routed;
            } finally {
                if (!completed) {
                    await this.requestCoordinator.releaseResponseClaim({
                        requestId: response.id,
                        claim,
                    });
                }
            }
        });
    }

    private async handleIncomingPermissionResponseUnclaimed(
        response: PermissionResponse,
        options?: Readonly<{
            expectedRequestKind?: 'permission' | 'user_action';
            permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
            answeredBy?: SessionQuestionHandlerV1;
            isCurrent?: () => boolean;
        }>,
    ): Promise<PermissionResponseRoutingResult> {
        const legacyPending = this.pendingRequests.get(response.id);
        const context = this.requestCoordinator.getResponseContext(response.id)
            ?? (legacyPending
                ? {
                    requestId: response.id,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context) {
            logger.debug(
                `${this.getLogPrefix()} Permission response received without pending request and without agentState request; ignored`,
            );
            return { status: 'not_found' };
        }
        const responseTurnId = response.turnId;
        if (responseTurnId !== undefined && responseTurnId !== context.turnId) {
            return { status: 'not_found' };
        }
        const isCurrent = responseTurnId !== undefined
            ? () => {
                if (options?.isCurrent && !options.isCurrent()) return false;
                // The terminal writer checks currentness before removing the request.
                const current = this.requestStore.readOutstandingRequest(response.id);
                return current?.turnId === responseTurnId;
            }
            : options?.isCurrent;
        if (
            options?.expectedRequestKind
            && resolveAgentRequestKind(context.toolName) !== options.expectedRequestKind
        ) {
            logger.debug(`${this.getLogPrefix()} Permission response arrived on the wrong RPC route; ignored`);
            return { status: 'not_found' };
        }
        if (!isPermissionResponseAuthorityValid({ response, context })) {
            logger.debug(`${this.getLogPrefix()} Permission response authority did not match the current request; ignored`);
            return { status: 'invalid' };
        }

        if (response.approved && isAgentStructuredQuestionRequest(context)) {
            const answers = normalizeStructuredQuestionPermissionAnswers({
                toolName: context.toolName, toolInput: context.toolInput, answers: response.answers ?? {},
            });
            if (!answers) return { status: 'invalid' };
            response = { ...response, answers };
        }

        const completed = await this.handlePermissionResponseWithContext({
            response,
            context,
            legacyPending,
            ...(options?.permissionDecisionActorV1 ? {
                permissionDecisionActorV1: options.permissionDecisionActorV1,
            } : {}),
            ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
            ...(isCurrent ? { isCurrent } : {}),
        });
        return completed ? { status: 'resolved' } : { status: 'not_found' };
    }

    private async handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        legacyPending: PendingRequest | undefined;
        permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
        answeredBy?: SessionQuestionHandlerV1;
        remoteMediationSettlementId?: string;
        isCurrent?: () => boolean;
    }>): Promise<boolean> {
        const {
            response,
            context,
            legacyPending,
            permissionDecisionActorV1,
            answeredBy,
            remoteMediationSettlementId,
            isCurrent,
        } = params;
        // One point-of-effect policy decision for an approval. A remote answer
        // (settlement id present) was already decided at its admission.
        const currentDecision = response.approved && remoteMediationSettlementId === undefined
            ? legacyPending?.resolveCurrentPermissionDecision?.()
                ?? (context.source !== HAPPIER_ACTION_REQUEST_SOURCE
                    && !legacyPending && context.status === 'agent_state_only'
                    ? this.resolveCurrentPermissionDecisionForOutstandingRequest(context)
                    : undefined)
            : undefined;
        const currentDecisionBlocksApproval =
            currentDecision?.decision === 'denied' || currentDecision?.decision === 'abort';
        const effectiveResponse: PermissionResponse = currentDecision && currentDecisionBlocksApproval
            ? {
                id: response.id,
                approved: false,
                decision: currentDecision.decision,
            }
            : response;
        const responseAllowedTools = effectiveResponse.allowedTools ?? effectiveResponse.allowTools;
        const updatedPermissions = effectiveResponse.updatedPermissions;
        const result = this.buildPermissionResult(effectiveResponse);
        if (!this.applyPermissionResponseAnswers(effectiveResponse, result)) {
            throw new Error('Invalid structured question answers');
        }

        const requestSource = { toolName: context.toolName, input: context.toolInput };
        const responseCompletion = this.buildCompletedRequestForResponse(
            effectiveResponse,
            result,
            responseAllowedTools,
            updatedPermissions,
            requestSource,
            permissionDecisionActorV1,
            remoteMediationSettlementId,
        );
        const orphanedQuestionAnswer = effectiveResponse.approved && isAgentStructuredQuestionRequest(context)
            && context.status !== 'live' && !context.responseTarget;
        const completedRequest = {
            ...responseCompletion,
            ...(result.answers ? { structuredAnswersV1: result.answers } : {}),
            ...(answeredBy ? { answeredBy } : {}),
            ...(orphanedQuestionAnswer ? { extraCompletedFields: {
                ...responseCompletion.extraCompletedFields,
                questionV1: context.questionV1 ?? { mode: 'wait', lasting: false, type: 'decision' },
                responseTarget: { kind: 'session_question_answer', sessionId: this.session.sessionId,
                    ...(context.turnId ? { sourceTurnId: context.turnId } : {}) },
            } } : {}),
            ...(isCurrent ? { isCurrent } : {}),
        };
        const completed = await this.completePendingPermissionRequest(
            effectiveResponse.id,
            context,
            result,
            completedRequest,
        );

        if (!completed && (!legacyPending || legacyPending.coordinatorManaged)) {
            logger.debug(`${this.getLogPrefix()} Permission response did not complete any pending request`);
            return false;
        }
        // `isCurrent` already fences the incumbent AgentState terminal write.
        // A successful completion removes the live request by design, so a
        // second check afterwards must not reinterpret that committed answer
        // as a stale rejection (notably for remote AskUserQuestion answers).
        if (!completed && isCurrent && !isCurrent()) return false;

        if (context.source !== HAPPIER_ACTION_REQUEST_SOURCE) this.applyPermissionResponseSideEffects({
            response: effectiveResponse,
            result,
            responseAllowedTools,
            updatedPermissions,
            requestSource,
            ...(context.owner ? { owner: context.owner } : {}),
            debugMessage:
                context.correlation === 'agent_state'
                    ? 'Permission response received without pending request; finalized agentState best-effort'
                    : `Permission ${effectiveResponse.approved ? 'approved' : 'denied'} for ${context.toolName}`,
        });

        if (!legacyPending?.coordinatorManaged && this.pendingRequests.has(effectiveResponse.id)) {
            this.pendingRequests.delete(effectiveResponse.id);
            legacyPending?.resolve(result);
        }

        if (effectiveResponse.approved && context.source !== HAPPIER_ACTION_REQUEST_SOURCE) {
            this.autoApproveNowAllowedPendingRequests(effectiveResponse.id);
        }

        return completed || Boolean(legacyPending && !legacyPending.coordinatorManaged);
    }

    private autoApproveNowAllowedPendingRequests(excludePermissionId: string): void {
        for (const [permissionId, pending] of this.pendingRequests.entries()) {
            if (permissionId === excludePermissionId) continue;
            if (resolveAgentRequestKind(pending.toolName) !== 'permission') continue;
            // A causal external source is its own permission authority. A
            // present-user session allowlist update for one prompt must not
            // silently settle a different mediated prompt outside that
            // source-owned request flow.
            if (pending.owner?.sourceAuthority) continue;
            if (!this.isAllowedForSessionForOwner(pending.toolName, pending.input, pending.owner)) continue;

            const resolveCurrentPermissionDecision = (): PermissionResult | null => {
                if (!this.isAllowedForSessionForOwner(pending.toolName, pending.input, pending.owner)) return null;
                return pending.resolveCurrentPermissionDecision?.() ?? { decision: 'approved' };
            };
            const currentResult = resolveCurrentPermissionDecision();
            if (!currentResult) continue;

            this.resolvePendingPermissionRequest(
                permissionId,
                currentResult,
                undefined,
                resolveCurrentPermissionDecision,
            );
        }
    }

    protected isAllowedForSession(toolName: string, input: unknown): boolean {
        return this.isAllowedForSessionForOwner(toolName, input, null);
    }

    protected recordAutoDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        decision: PermissionResult['decision'],
        options?: Readonly<{
            owner?: PermissionRequestOwner | null;
            source?: string | null;
            isCurrent?: () => boolean;
        }>,
    ): Promise<boolean> {
        const allowedTools = decision === 'approved_for_session'
            ? [makeToolIdentifier(toolName, input)]
            : undefined;
        const owner = normalizePermissionRequestOwner(options?.owner);
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        return this.requestStore.recordCompletedRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
            decision,
            allowedTools,
            ...(source ? { source } : {}),
            ...(owner ? { owner } : {}),
            ...(options?.isCurrent ? { isCurrent: options.isCurrent } : {}),
        });
    }

    /**
     * Direct automatic paths do not first create a pending request, but their
     * AgentState terminal write is still asynchronous. Reuse the pending
     * automatic path's current-decision callback at that writer boundary so
     * Agent-specific handlers only supply their existing policy resolver.
     */
    protected resolveAndRecordAutoDecision(params: Readonly<{
        toolCallId: string;
        toolName: string;
        input: unknown;
        resolve: () => PermissionResult | null;
        options?: Readonly<{ owner?: PermissionRequestOwner | null; source?: string | null }>;
    }>): Promise<PermissionResult | null> | null {
        // Keep the existing pending-request admission synchronous when this
        // policy has no automatic answer. Only a real automatic answer needs
        // the asynchronous AgentState terminal write/currentness loop.
        const initialCandidate = params.resolve();
        if (!initialCandidate) return null;

        return (async () => {
            let candidate = initialCandidate;
            while (true) {

                let candidateIsCurrent = true;
                const recorded = await this.recordAutoDecision(
                    params.toolCallId,
                    params.toolName,
                    params.input,
                    candidate.decision,
                    {
                        ...(params.options?.owner ? { owner: params.options.owner } : {}),
                        ...(params.options?.source ? { source: params.options.source } : {}),
                        isCurrent: () => {
                            const current = params.resolve();
                            candidateIsCurrent = current !== null && isDeepStrictEqual(current, candidate);
                            return candidateIsCurrent;
                        },
                    },
                );
                if (recorded) return candidate;
                // An opaque first-answer claim also makes the writer return false.
                // Only retry when the false result was caused by this automatic
                // decision losing currentness; otherwise leave the live request to
                // its existing terminal owner.
                if (candidateIsCurrent) return null;
                const nextCandidate = params.resolve();
                if (!nextCandidate) return null;
                candidate = nextCandidate;
            }
        })();
    }

    protected isUnlistedToolDenied(toolName: string, input: unknown): boolean {
        const metadata = this.session.getMetadataSnapshot?.();
        return metadata?.unlistedTools === 'deny'
            && !this.isAllowedBySessionToolPolicy(toolName, input);
    }

    protected isAllowedBySessionToolPolicy(toolName: string, input: unknown): boolean {
        return isToolAllowedForSession(this.session.getMetadataSnapshot?.()?.allowedTools ?? [], toolName, input);
    }

    protected isAllowedForSessionForOwner(
        toolName: string,
        input: unknown,
        owner: PermissionRequestOwner | null | undefined,
    ): boolean {
        const normalizedOwner = normalizePermissionRequestOwner(owner);
        const allowedIdentifiers = normalizedOwner
            ? this.getAllowedToolIdentifiersForOwner(normalizedOwner)
            : this.allowedToolIdentifiers;
        return isToolAllowedForSession(allowedIdentifiers, toolName, input);
    }

    private getAllowedToolIdentifiersForOwner(owner: unknown): Set<string> {
        const normalizedOwner = normalizePermissionRequestOwner(owner);
        if (!normalizedOwner) {
            return this.allowedToolIdentifiers;
        }
        const key = permissionRequestOwnerAllowlistKey(normalizedOwner);
        let allowedIdentifiers = this.allowedToolIdentifiersByOwner.get(key);
        if (!allowedIdentifiers) {
            allowedIdentifiers = new Set<string>();
            // The spawn seed belongs to the Session, unlike grants approved for
            // one plugin owner. Seed each incumbent owner allowlist without
            // borrowing another owner's later approvals.
            applyAllowedToolsToAllowlist(allowedIdentifiers, this.session.getMetadataSnapshot?.()?.allowedTools);
            this.allowedToolIdentifiersByOwner.set(key, allowedIdentifiers);
        }
        return allowedIdentifiers;
    }

    private async withPendingRequestPreparation<T>(params: Readonly<{
        requestId: string;
        toolName: string;
        input: unknown;
        owner?: PermissionRequestOwner;
        causalPermissionContext?: AcpPermissionCallContext;
        signal?: AbortSignal;
    }>, work: (assertCurrent: () => void) => Promise<T>): Promise<T> {
        let rejectPreparation!: (error: Error) => void;
        const cancellation = new Promise<never>((_, reject) => { rejectPreparation = reject; });
        const pending: PendingRequest = { toolName: params.toolName, input: params.input,
            ...(params.owner ? { owner: params.owner } : {}),
            ...(params.causalPermissionContext ? { causalPermissionContext: params.causalPermissionContext } : {}),
            resolve: () => rejectPreparation(new Error('Permission request aborted')), reject: rejectPreparation };
        this.pendingRequests.set(params.requestId, pending);
        const onAbort = () => rejectPreparation(new Error('Permission request aborted'));
        params.signal?.addEventListener('abort', onAbort, { once: true });
        if (params.signal?.aborted) onAbort();
        const assertCurrent = () => {
            if (this.pendingRequests.get(params.requestId) !== pending || params.signal?.aborted) {
                throw new Error('Permission request aborted');
            }
        };
        try {
            const preparation = (async () => {
                assertCurrent();
                return work(assertCurrent);
            })();
            return await Promise.race([preparation, cancellation]);
        } finally {
            params.signal?.removeEventListener('abort', onAbort);
            if (this.pendingRequests.get(params.requestId) === pending) this.pendingRequests.delete(params.requestId);
        }
    }

    /** Record only an owned native question or native tool result, without applying another choice. */
    async settleObservedDecision(params: Readonly<{
        requestId: string;
        source: string;
        owner: PermissionRequestOwner;
        decision: 'approved' | 'denied' | 'abort';
        answers?: StructuredQuestionAnswersV1;
    }>): Promise<boolean> {
        const pending = this.pendingRequests.get(params.requestId);
        const context = this.requestCoordinator.getResponseContext(params.requestId);
        const outstanding = this.requestStore.readOutstandingRequest(params.requestId);
        const occurrenceQuestion = pending?.causalPermissionContext?.origin === 'host_occurrence_question'
            && outstanding?.lifetime === 'occurrence'
            && context !== null && isAgentStructuredQuestionRequest(context);
        const nativeApproval = context !== null
            && (context.source === NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE
                || context.source === NATIVE_TOOL_APPROVAL_REQUEST_SOURCE)
            && (context.kind ?? resolveAgentRequestKind(context.toolName)) === 'permission';
        if (!pending || !context || !outstanding
            || (!occurrenceQuestion && !nativeApproval)
            || !params.source.trim() || context.source !== params.source.trim()
            || !permissionRequestOwnersEqual(
                normalizePermissionRequestOwnerWithoutSourceAuthority(context.owner),
                normalizePermissionRequestOwnerWithoutSourceAuthority(params.owner),
            )) return false;
        const answers = params.answers === undefined ? undefined : StructuredQuestionAnswersV1Schema.parse(params.answers);
        const result: PermissionResult = { decision: params.decision, ...(answers ? { answers } : {}) };
        return await this.requestCoordinator.completeObservedResponse({ context, completion: {
            result,
            completedRequest: {
                status: params.decision === 'abort' ? 'canceled' : params.decision,
                decision: params.decision,
                answeredBy: { kind: 'person' },
                ...(answers ? { structuredAnswersV1: answers } : {}),
            },
        } });
    }

    protected async requestPermissionDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: Readonly<{
            owner?: PermissionRequestOwner | null;
            source?: string | null;
            signal?: AbortSignal;
            causalPermissionContext?: AcpPermissionCallContext;
            resolveCurrentPermissionDecision?: () => PermissionResult;
            acknowledgeDecisionApplication?: (decision: PermissionResult) => Promise<void>;
            mcpTool?: import('@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1').ResolvedMcpToolIdentityV1;
        }>,
    ): Promise<PermissionResult> {
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        const existingQuestion = this.requestCoordinator.getResponseContext(toolCallId);
        const isQuestion = isAgentStructuredQuestionRequest({ toolName, source });
        const questionV1 = isQuestion
            ? existingQuestion?.questionV1 ?? { mode: 'wait' as const, lasting: false, type: 'decision' as const }
            : undefined;
        const currentHandler = isQuestion
            ? existingQuestion ? existingQuestion.currentHandler ?? { kind: 'person' as const }
                : { kind: 'person' as const }
            : undefined;
        const publish = (currentHandler: SessionQuestionHandlerV1 | undefined): Promise<PermissionResult> => {
            const hasExistingContext = this.requestCoordinator.getResponseContext(toolCallId) !== null;
            if (!hasExistingContext) {
                this.recordPermissionRequestTrace(toolCallId, toolName, input, source);
            }

            const owner = resolvePermissionRequestOwner({
                owner: options?.owner,
                causalPermissionContext: options?.causalPermissionContext,
            });
            const turnId = resolvePermissionRequestTurnId(options?.causalPermissionContext);
            let ownsPendingRecord = false;
            let pendingRecord = this.pendingRequests.get(toolCallId);
            if (!pendingRecord) {
                pendingRecord = {
                    toolName,
                    input,
                    ...(owner ? { owner } : {}),
                    ...(options?.causalPermissionContext ? { causalPermissionContext: options.causalPermissionContext } : {}),
                    ...(options?.resolveCurrentPermissionDecision
                        ? { resolveCurrentPermissionDecision: options.resolveCurrentPermissionDecision }
                        : {}),
                    ...(options?.acknowledgeDecisionApplication
                        ? { acknowledgeDecisionApplication: options.acknowledgeDecisionApplication }
                        : {}),
                    coordinatorManaged: true,
                    resolve: (value) => {
                        this.resolvePendingPermissionRequest(toolCallId, value);
                    },
                    reject: (error) => {
                        this.rejectPendingPermissionRequest(toolCallId, error);
                    },
                };
                this.pendingRequests.set(toolCallId, pendingRecord);
                ownsPendingRecord = true;
            }

            const pending = this.requestCoordinator.requestDecision({
                requestId: toolCallId,
                toolName,
                toolInput: input,
                createdAt: Date.now(),
                ...(options?.mcpTool ? { mcpTool: options.mcpTool } : {}),
                ...(turnId ? { turnId } : {}),
                ...(options?.causalPermissionContext?.lifetime ? { lifetime: options.causalPermissionContext.lifetime } : {}),
                ...(source ? { source } : {}),
                ...(questionV1 ? { questionV1, currentHandler, kind: 'user_action' } : {}),
                ...(owner ? { owner } : {}),
            }, { signal: options?.signal });

            if (ownsPendingRecord) void this.respondAsApprovalReviewer(toolCallId);

            return pending.finally(() => {
                if (ownsPendingRecord && this.pendingRequests.get(toolCallId) === pendingRecord) {
                    this.pendingRequests.delete(toolCallId);
                }
            });
        };
        if (!isQuestion || existingQuestion || typeof this.session.readQuestionSessionSnapshot !== 'function') {
            return publish(currentHandler);
        }
        const owner = resolvePermissionRequestOwner({ owner: options?.owner,
            causalPermissionContext: options?.causalPermissionContext });
        return this.withPendingRequestPreparation({ requestId: toolCallId, toolName, input,
            ...(owner ? { owner } : {}),
            ...(options?.causalPermissionContext ? { causalPermissionContext: options.causalPermissionContext } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
        }, async (assertCurrent) => {
            const handler = await resolveInitialQuestionHandler({ sessionId: this.session.sessionId,
                lasting: questionV1!.lasting,
                readSession: (sessionId) => this.session.readQuestionSessionSnapshot(sessionId) });
            assertCurrent();
            // Transfer the same preparation identity to the live coordinator
            // synchronously, without an unowned await before publication.
            this.pendingRequests.delete(toolCallId);
            return publish(handler);
        });
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.recordPermissionRequestTrace(toolCallId, toolName, input);
        this.requestStore.publishRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            createdAt: Date.now(),
        });
    }

    private recordPermissionRequestTrace(
        toolCallId: string,
        toolName: string,
        input: unknown,
        source?: string | null,
    ): void {
        if (this.toolTrace) {
            recordToolTraceEvent({
                direction: 'outbound',
                sessionId: this.session.sessionId,
                protocol: this.toolTrace.protocol,
                provider: this.toolTrace.provider,
                kind: 'permission-request',
                payload: {
                    type: 'permission-request',
                    permissionId: toolCallId,
                    toolName,
                    description: `${toolName} permission`,
                    options: { input: resolvePermissionRequestTraceInput({ input, source }) },
                },
            });
        }
    }

    protected resolvePendingPermissionRequest(
        requestId: string,
        result: PermissionResult,
        completedRequest?: PermissionRequestCoordinatorCompletedRequest,
        revalidate?: () => PermissionResult | null,
    ): void {
        void this.resolvePendingPermissionRequestDurably(requestId, result, completedRequest, revalidate).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to durably complete automatic permission request`, error);
            // `PermissionRequestCoordinator.completeResponse()` retains the
            // canonical live request and waiter after a terminal write error.
            // Do not cancel it here: a later policy transition or an explicit
            // response must use that same durable owner rather than reviving a
            // parallel permission path.
        });
    }

    private async resolvePendingPermissionRequestDurably(
        requestId: string,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest | undefined,
        revalidate: (() => PermissionResult | null) | undefined,
    ): Promise<void> {
        await this.requestCoordinator.withResponseClaim(requestId, async () => {
            const context = this.requestCoordinator.getResponseContext(requestId);
            if (!context) {
                logger.debug(`${this.getLogPrefix()} Automatic permission completion lacked a durable pending request`);
                return;
            }
            if (this.requestStore.hasPermissionResponseClaim(requestId)) return;

            // Decide once inside the response claim. The terminal write keeps
            // only first-answer custody: a person's claimed answer wins.
            const currentResult = revalidate ? revalidate() : result;
            if (!currentResult) return;
            const currentCompletedRequest = completedRequest && !revalidate
                ? completedRequest
                : {
                    status: currentResult.decision === 'denied' || currentResult.decision === 'abort'
                        ? 'denied'
                        : 'approved',
                    decision: currentResult.decision,
                    isCurrent: () => !this.requestStore.hasPermissionResponseClaim(requestId),
                };
            await this.completePendingPermissionRequest(
                requestId,
                context,
                currentResult,
                currentCompletedRequest,
            );
        });
    }

    private rejectPendingPermissionRequest(requestId: string, error: Error): void {
        this.pendingRequests.delete(requestId);
        this.requestCoordinator.cancelRequest(requestId, error.message);
    }

    private async completePendingPermissionRequest(
        requestId: string,
        context: PermissionRequestCoordinatorContext,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest,
    ): Promise<boolean> {
        const pending = this.pendingRequests.get(requestId);
        const completed = await this.requestCoordinator.completeResponse({
            context,
            ...(pending?.acknowledgeDecisionApplication
                ? { acknowledgeDecisionApplication: pending.acknowledgeDecisionApplication }
                : {}),
            completion: {
                result,
                completedRequest,
            },
        });
        if (pending && !pending.coordinatorManaged) {
            this.pendingRequests.delete(requestId);
            pending.resolve(result);
            return completed;
        }
        if (completed) {
            this.pendingRequests.delete(requestId);
        }
        return completed;
    }

    private cancelUncoordinatedPendingRequests(requests: Iterable<readonly [string, PendingRequest]>, reason: string): void {
        for (const [requestId, pending] of requests) {
            if (pending.coordinatorManaged || this.pendingRequests.get(requestId) !== pending) continue;
            this.pendingRequests.delete(requestId);
            try {
                pending.reject(new Error(reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy pending request:`, err);
            }
        }
    }

    private async cancelPendingRequests(reason: string, scope?: 'foreground', preserveQuestions = false): Promise<void> {
        const pendingSnapshot = Array.from(this.pendingRequests.entries()).filter(
            ([requestId]) => scope !== 'foreground' || !readRunScopedExecutionPermissionRequestIdentity(requestId),
        );
        // Retire preparation before awaiting durable cancellation, so shared
        // hydration cannot advance a cancelled request into publication.
        this.cancelUncoordinatedPendingRequests(pendingSnapshot, reason);
        // After rejoin the request, not host-local yield intent, retains the
        // waiting turn. Capture it before cancellation retires the request.
        const questionWaitTurnIds = preserveQuestions ? [] : this.requestStore.listOutstandingRequests()
            .filter(request => request.source === SESSION_NEEDS_YOU_REQUEST_SOURCE && request.questionV1?.mode === 'wait')
            .flatMap(request => request.turnId ? [request.turnId] : []);
        await Promise.all([
            this.requestCoordinator.cancelAll(reason, { ...(scope ? { scope } : {}), ...(preserveQuestions ? { preserveQuestions } : {}) }),
            ...(!preserveQuestions ? [this.session.clearQuestionWaitTurn?.(questionWaitTurnIds)] : []),
        ]);
        for (const [requestId, pending] of pendingSnapshot) {
            if (this.pendingRequests.get(requestId) === pending) this.pendingRequests.delete(requestId);
        }
    }

    async cancelByPluginTurn(pluginId: string, turnId: string, reason: string): Promise<void> {
        const pendingSnapshot = Array.from(this.pendingRequests.entries()).filter(([, pending]) => {
            const requestTurnId = resolvePermissionRequestTurnId(pending.causalPermissionContext);
            return isPermissionRequestOwnedByPluginTurn({ owner: pending.owner,
                ...(requestTurnId ? { turnId: requestTurnId } : {}), lifetime: pending.causalPermissionContext?.lifetime }, pluginId, turnId);
        });
        this.cancelUncoordinatedPendingRequests(pendingSnapshot, reason);
        await this.requestCoordinator.cancelByPluginTurn(pluginId, turnId, reason);
    }

    async cancelByPlugin(pluginId: string, reason: string = 'plugin_deactivated'): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;

        const legacyPendingSnapshot = Array.from(this.pendingRequests.entries()).filter(
            ([, pending]) => !pending.coordinatorManaged && isPermissionRequestOwnedByPlugin(pending.owner, normalizedPluginId),
        );
        this.cancelUncoordinatedPendingRequests(legacyPendingSnapshot, reason);
        await this.requestCoordinator.cancelByPlugin(normalizedPluginId, reason);
    }

    async abortPendingRequestsAndFlush(reason: string = 'Aborted by user', options?: Readonly<{ preserveQuestions?: boolean }>): Promise<void> {
        await this.cancelPendingRequests(reason, undefined, options?.preserveQuestions);
        try {
            await this.session.flush?.();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to flush session after permission abort (non-fatal)`, error);
        }
    }

    async abortPendingRequestAndFlush(requestId: string, reason: string = 'Aborted by user', options?: Readonly<{ preserveQuestions?: boolean }>): Promise<void> {
        const pending = this.pendingRequests.get(requestId);
        if (pending) this.cancelUncoordinatedPendingRequests([[requestId, pending]], reason);
        const request = this.requestStore.readOutstandingRequest(requestId) ?? pending;
        if (options?.preserveQuestions && request && isAgentStructuredQuestionRequest(request)) {
            this.requestCoordinator.cancelRequest(requestId, reason);
        } else await this.requestCoordinator.cancelRequests([requestId], reason);
        try {
            await this.session.flush?.();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to flush session after permission abort (non-fatal)`, error);
        }
    }

    /**
     * Reset state for new sessions. Foreground Stop only withdraws its prompts;
     * independent Runs retain the shared store and Session permission policy.
     * Whole-Session reset is idempotent - safe to call multiple times.
     */
    reset(options?: Readonly<{ scope: 'foreground' }>): Promise<void> {
        // Stop withdraws foreground prompts while shared Run/policy owners stay alive.
        if (options?.scope === 'foreground') return this.cancelPendingRequests('Foreground turn stopped', options.scope);
        if (this.resetPromise) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, awaiting active cleanup`);
            return this.resetPromise;
        }
        const resetPromise = this.performReset();
        this.resetPromise = resetPromise;
        return resetPromise;
    }

    private async performReset(): Promise<void> {
        try {
            await this.cancelPendingRequests('Session reset', undefined, true);

            this.allowedToolIdentifiers.clear();
            this.allowedToolIdentifiersByOwner.clear();
            this.requestStore.dispose();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.resetPromise = null;
        }
    }
}

function permissionRequestOwnerAllowlistKey(owner: PermissionRequestOwner): string {
    return `${owner.pluginId}\u0000${owner.runtimeId ?? ''}`;
}

function matchesRemoteMediationSourceAuthority(
    sourceAuthority: PermissionRequestOwner['sourceAuthority'] | undefined,
    input: Readonly<{
        sourceRef: string;
        sourceRevisionOrEpoch: string;
    }>,
    mediatorPluginId: string,
): boolean {
    return Boolean(
        sourceAuthority
        && sourceAuthority.mediatorPluginId === mediatorPluginId
        && sourceAuthority.sourceRef === input.sourceRef
        && sourceAuthority.sourceRevisionOrEpoch === input.sourceRevisionOrEpoch,
    );
}

/** A mediated row and its AgentState claim must carry the same causal turn. */
function matchesMediatedPermissionTurnId(
    value: unknown,
    input: Readonly<{ turnId: string }>,
): boolean {
    const turnId = TurnIdSchema.safeParse(value);
    return turnId.success && turnId.data === input.turnId;
}

/**
 * Request ownership can be supplied by a trusted runtime, but mediated source
 * authority is only valid when it came through the causal admitted-input
 * carrier. Keeping both facts in the incumbent owner makes reload-safe
 * pending projections possible without turning arbitrary request input into
 * remote approval authority.
 */
export function resolvePermissionRequestOwner(params: Readonly<{
    owner?: PermissionRequestOwner | null;
    causalPermissionContext?: AcpPermissionCallContext;
}>): PermissionRequestOwner | null {
    const owner = normalizePermissionRequestOwnerWithoutSourceAuthority(params.owner);
    const causalAuthority = params.causalPermissionContext?.causalPermissionAuthority;
    const parsedCausalAuthority = causalAuthority
        ? SessionInputCausalPermissionAuthorityV1Schema.safeParse(causalAuthority)
        : null;
    const sourceAuthority = parsedCausalAuthority?.success
        ? parsedCausalAuthority.data.sourceAuthority
        : undefined;
    if (!sourceAuthority) return owner;

    return normalizePermissionRequestOwner({
        ...(owner ?? {
            kind: 'plugin',
            pluginId: sourceAuthority.mediatorPluginId,
        }),
        sourceAuthority,
    });
}

/**
 * Turn custody is admitted only from the host-stamped causal carrier. Do not
 * derive it from a request ID, a mutable current turn, or plugin input.
 */
function resolvePermissionRequestTurnId(
    causalPermissionContext: AcpPermissionCallContext | undefined,
): string | null {
    const parsed = TurnIdSchema.safeParse(causalPermissionContext?.turnId);
    return parsed.success ? parsed.data : null;
}

function normalizePermissionRequestOwnerWithoutSourceAuthority(
    value: PermissionRequestOwner | null | undefined,
): PermissionRequestOwner | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return normalizePermissionRequestOwner(value);
    }
    const { sourceAuthority: _ignoredSourceAuthority, ...owner } = value;
    return normalizePermissionRequestOwner(owner);
}

function resolvePermissionRequestTraceInput(params: Readonly<{
    input: unknown;
    source?: string | null;
}>): unknown {
    if (params.source !== CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE) {
        return params.input;
    }

    const input = readPlainRecord(params.input);
    const dialogInput = readPlainRecord(input?.happierDialog);
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const optionCount = questions.reduce((count, question) => {
        const questionRecord = readPlainRecord(question);
        return count + (Array.isArray(questionRecord?.options) ? questionRecord.options.length : 0);
    }, 0);
    const dialog: Record<string, string> = {};
    if (dialogInput?.kind === 'recognized' || dialogInput?.kind === 'unrecognized') {
        dialog.kind = dialogInput.kind;
    }
    if (
        typeof dialogInput?.dialogId === 'string'
        && /^[a-z0-9_]{1,80}$/.test(dialogInput.dialogId)
    ) {
        dialog.dialogId = dialogInput.dialogId;
    }
    if (dialogInput?.mode === 'generic' || dialogInput?.mode === 'notice') {
        dialog.mode = dialogInput.mode;
    }

    return {
        redacted: true,
        ...(Object.keys(dialog).length > 0 ? { dialog } : {}),
        questionCount: questions.length,
        optionCount,
    };
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}
