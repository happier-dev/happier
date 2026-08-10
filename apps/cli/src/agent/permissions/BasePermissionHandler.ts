/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/session/sessionClient";
import { AgentState } from "@/api/types";
import { updateAgentStateBestEffort as updateAgentStateBestEffortShared } from "@/api/session/sessionWritesBestEffort";
import { isToolAllowedForSession, makeToolIdentifier } from './permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist, seedAllowlistFromCompletedRequests } from './applyPermissionAllowlistUpdates';
import { recordToolTraceEvent, type ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import type { AccountSettings } from '@happier-dev/protocol';
import type {
    PermissionRequestPushSender as PermissionRequestPushSenderFromSettings,
} from '@/settings/notifications/permissionRequestPush';
import { cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { resolveAgentRequestKind } from './requestKind';
import {
    SESSION_RPC_METHODS,
    StructuredQuestionResponseV1Schema,
    isAskUserQuestionToolName,
    type StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';
import {
    PUBLIC_RPC_HANDLER_ERROR_CODES,
    PublicRpcHandlerError,
} from '@happier-dev/protocol/rpcErrors';
import {
    normalizeLegacyStructuredQuestionAnswers,
    normalizeStructuredQuestionAnswersV1,
    type StructuredQuestionLike,
} from '@/agent/questions/normalizeStructuredQuestionAnswersV1';
import { publishStructuredQuestionAnswersV1Capability } from '@/agent/questions/publishStructuredQuestionAnswersV1Capability';
import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';
import { AgentStateRequestStore } from './agentStateRequestStore';
import {
    createPermissionRequestCoordinator,
    type PermissionRequestCoordinator,
    type PermissionRequestCoordinatorCompletedRequest,
    type PermissionRequestCoordinatorContext,
} from './permissionRequestCoordinator';
import type { PermissionResult } from './permissionResult';

export type { PermissionResult } from './permissionResult';

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

type AgentStateRequestsRecord = NonNullable<AgentState['requests']>;
type AgentStateCompletedRequestsRecord = NonNullable<AgentState['completedRequests']>;

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
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
    answers?: Record<string, string>;
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
    coordinatorManaged?: boolean;
}

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private isResetting = false;
    private allowedToolIdentifiers = new Set<string>();
    private readonly requestStore: AgentStateRequestStore;
    private readonly requestCoordinator: PermissionRequestCoordinator<PermissionResult>;
    private readonly onAbortRequested: (() => void | Promise<void>) | null;
    private readonly getAccountSettingsSnapshotFn: () => AccountSettings | null;
    private readonly toolTrace: { protocol: ToolTraceProtocol; provider: string } | null;
    private readonly triggerAbortCallbackOnAbortDecision: boolean;

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    protected updateAgentStateBestEffort(updater: (state: AgentState) => AgentState, reason: string): void {
        updateAgentStateBestEffortShared(this.session, updater, this.getLogPrefix(), reason);
    }

    constructor(
        session: ApiSessionClient,
        opts?: {
            pushSender?: PermissionRequestPushSender | null;
            getAccountSettings?: (() => AccountSettings | null) | null;
            getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
            onAbortRequested?: (() => void | Promise<void>) | null;
            toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
            triggerAbortCallbackOnAbortDecision?: boolean;
        }
    ) {
        this.session = session;
        this.getAccountSettingsSnapshotFn = typeof opts?.getAccountSettings === 'function' ? opts.getAccountSettings : (() => null);
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
        this.requestCoordinator = createPermissionRequestCoordinator<PermissionResult>({
            store: this.requestStore,
        });
        this.onAbortRequested = typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null;
        this.triggerAbortCallbackOnAbortDecision = opts?.triggerAbortCallbackOnAbortDecision ?? true;
        this.toolTrace =
            opts?.toolTrace && typeof opts.toolTrace === 'object'
                ? {
                    protocol: opts.toolTrace.protocol,
                    provider: opts.toolTrace.provider,
                }
                : null;
        this.setupRpcHandler();
        this.publishStructuredQuestionCapability();
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

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        this.publishStructuredQuestionCapability();
        // Prevent per-session allowlists from leaking across session references.
        // The new session snapshot will re-seed any persisted per-session approvals.
        this.allowedToolIdentifiers.clear();
        this.requestStore.updateSession(newSession);
        this.seedAllowedToolsFromAgentState();

        // If we were mid-permission when the session reference swapped (offline reconnect),
        // republish still-pending items into the new agentState and re-attempt push notifications.
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (this.requestCoordinator.isRequestClaimed(id)) continue;
            if (!this.requestStore.hasOutstandingRequest(id)) {
                this.requestStore.publishRequest({
                    requestId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                    createdAt: Date.now(),
                });
            } else {
                this.requestStore.notifyPermissionRequestPushBestEffort({
                    permissionId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                });
            }
        }
    }

    private seedAllowedToolsFromAgentState(): void {
        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;
            seedAllowlistFromCompletedRequests(this.allowedToolIdentifiers, completed);
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
    ): PermissionRequestCoordinatorCompletedRequest {
        const wantsDerivedAllowTools =
            response.approved
            && !Array.isArray(responseAllowedTools)
            && result.decision === 'approved_for_session';
        const derivedAllowTools = Array.isArray(responseAllowedTools)
            ? responseAllowedTools
            : (wantsDerivedAllowTools
                ? [makeToolIdentifier(requestSource.toolName, requestSource.input)]
                : undefined);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            ...(typeof derivedAllowTools !== 'undefined' ? { allowedTools: derivedAllowTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(result.answers ? { extraCompletedFields: { structuredAnswersV1: result.answers } } : {}),
        };
    }

    private publishStructuredQuestionCapability(): void {
        this.updateAgentStateBestEffort(
            publishStructuredQuestionAnswersV1Capability,
            'publish structured question answer capability',
        );
    }

    private applyPermissionResponseSideEffects(params: Readonly<{
        response: PermissionResponse;
        result: PermissionResult;
        responseAllowedTools: readonly string[] | undefined;
        updatedPermissions: unknown;
        requestSource: Readonly<{ toolName: string; input: unknown }>;
        debugMessage: string;
    }>): void {
        const { response, result, responseAllowedTools, updatedPermissions, requestSource } = params;

        if (response.approved) {
            applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, updatedPermissions);
            applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, responseAllowedTools);
            if (!Array.isArray(responseAllowedTools) && result.decision === 'approved_for_session') {
                this.allowedToolIdentifiers.add(makeToolIdentifier(requestSource.toolName, requestSource.input));
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

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY,
            async (response) => {
                const legacyPending = this.pendingRequests.get(response.id);
                const hasStructuredAnswers = response.answers !== undefined;
                const candidateContext = hasStructuredAnswers
                    ? null
                    : this.requestCoordinator.getResponseContext(response.id);
                const requiresLocalQuestionOwner = hasStructuredAnswers
                    || (candidateContext !== null && this.isStructuredQuestionContext(candidateContext));
                const context = requiresLocalQuestionOwner
                    ? this.requireLocallyOwnedStructuredResponseContext(response.id, legacyPending)
                    : candidateContext;
                if (!context) {
                    logger.debug(
                        `${this.getLogPrefix()} Permission response received without pending request and without agentState request; ignored`,
                    );
                    return;
                }

                const structuredAnswers = hasStructuredAnswers
                    ? normalizeLegacyStructuredQuestionAnswers({
                        answers: response.answers!,
                        questions: this.readStructuredQuestions(context),
                    })
                    : undefined;

                this.handlePermissionResponseWithContext({
                    response,
                    context,
                    legacyPending,
                    structuredAnswers,
                });
            }
        );
        this.session.rpcHandlerManager.registerHandler<unknown, void>(
            SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
            async (rawResponse) => {
                const parsed = StructuredQuestionResponseV1Schema.safeParse(rawResponse);
                if (!parsed.success) {
                    throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID);
                }
                const legacyPending = this.pendingRequests.get(parsed.data.id);
                const context = this.requireLocallyOwnedStructuredResponseContext(parsed.data.id, legacyPending);
                this.handlePermissionResponseWithContext({
                    response: { id: parsed.data.id, approved: true },
                    context,
                    legacyPending,
                    structuredAnswers: normalizeStructuredQuestionAnswersV1(
                        parsed.data.structuredAnswersV1,
                        this.readStructuredQuestions(context),
                    ),
                });
            },
        );
    }

    private requireLocallyOwnedStructuredResponseContext(
        requestId: string,
        localPending: PendingRequest | undefined,
    ): PermissionRequestCoordinatorContext {
        const context = this.requestCoordinator.getLocallyOwnedLiveResponseContext(requestId);
        if (!context || !localPending || !this.isStructuredQuestionContext(context)) {
            throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER);
        }
        return context;
    }

    private isStructuredQuestionContext(context: PermissionRequestCoordinatorContext): boolean {
        return isAskUserQuestionToolName(context.toolName) && resolveAgentRequestKind(context.toolName) === 'user_action';
    }

    private readStructuredQuestions(context: PermissionRequestCoordinatorContext): readonly StructuredQuestionLike[] {
        if (!context.toolInput || typeof context.toolInput !== 'object' || Array.isArray(context.toolInput)) {
            throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
        }
        const questions = (context.toolInput as { questions?: unknown }).questions;
        if (!Array.isArray(questions)) {
            throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
        }
        return questions as readonly StructuredQuestionLike[];
    }

    private handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        legacyPending: PendingRequest | undefined;
        structuredAnswers?: StructuredQuestionAnswersV1;
    }>): void {
                const { response, context, legacyPending, structuredAnswers } = params;
                const responseAllowedTools = response.allowedTools ?? response.allowTools;
                const updatedPermissions = response.updatedPermissions;
                const result = this.buildPermissionResult(response);
                if (structuredAnswers) result.answers = structuredAnswers;

                const requestSource = { toolName: context.toolName, input: context.toolInput };
                if (this.requestCoordinator.isRequestClaimed(response.id)) {
                    return;
                }

                this.applyPermissionResponseSideEffects({
                    response,
                    result,
                    responseAllowedTools,
                    updatedPermissions,
                    requestSource,
                    debugMessage:
                        context.correlation === 'agent_state'
                            ? 'Permission response received without pending request; finalized agentState best-effort'
                            : `Permission ${response.approved ? 'approved' : 'denied'} for ${context.toolName}`,
                });

                const completed = this.completePendingPermissionRequest(response.id, context, result, this.buildCompletedRequestForResponse(
                    response,
                    result,
                    responseAllowedTools,
                    updatedPermissions,
                    requestSource,
                ));

                if (!legacyPending?.coordinatorManaged) {
                    this.pendingRequests.delete(response.id);
                    legacyPending?.resolve(result);
                }

                if (response.approved) {
                    this.autoApproveNowAllowedPendingRequests(response.id);
                }

                if (!completed && !legacyPending) {
                    logger.debug(`${this.getLogPrefix()} Permission response did not complete any pending request`);
                }
    }

    private autoApproveNowAllowedPendingRequests(excludePermissionId: string): void {
        for (const [permissionId, pending] of this.pendingRequests.entries()) {
            if (permissionId === excludePermissionId) continue;
            if (this.requestCoordinator.isRequestClaimed(permissionId)) continue;
            if (resolveAgentRequestKind(pending.toolName) !== 'permission') continue;
            if (!this.isAllowedForSession(pending.toolName, pending.input)) continue;

            this.resolvePendingPermissionRequest(permissionId, { decision: 'approved' }, {
                status: 'approved',
                decision: 'approved',
            });
        }
    }

    protected isAllowedForSession(toolName: string, input: unknown): boolean {
        return isToolAllowedForSession(this.allowedToolIdentifiers, toolName, input);
    }

    protected isPermissionRequestClaimed(requestId: string): boolean {
        return this.requestCoordinator.isRequestClaimed(requestId);
    }

    protected recordAutoDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        decision: PermissionResult['decision']
    ): void {
        if (this.isPermissionRequestClaimed(toolCallId)) {
            throw new Error(`Permission request ${toolCallId} is reserved by a newer runtime`);
        }
        const allowedTools = decision === 'approved_for_session'
            ? [makeToolIdentifier(toolName, input)]
            : undefined;
        this.requestStore.recordCompletedRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
            decision,
            allowedTools,
        });
    }

    protected requestPermissionDecision(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
        if (this.isPermissionRequestClaimed(toolCallId)) {
            return Promise.reject(new Error(`Permission request ${toolCallId} is reserved by a newer runtime`));
        }
        const normalizedInput = normalizeAskUserQuestionInputForPublication(toolName, input);
        const hasExistingContext = this.requestCoordinator.getResponseContext(toolCallId) !== null;
        if (!hasExistingContext) {
            this.recordPermissionRequestTrace(toolCallId, toolName, normalizedInput);
        }

        if (!this.pendingRequests.has(toolCallId)) {
            this.pendingRequests.set(toolCallId, {
                toolName,
                input: normalizedInput,
                coordinatorManaged: true,
                resolve: (value) => {
                    this.resolvePendingPermissionRequest(toolCallId, value);
                },
                reject: (error) => {
                    this.rejectPendingPermissionRequest(toolCallId, error);
                },
            });
        }

        const pending = this.requestCoordinator.requestDecision({
            requestId: toolCallId,
            toolName,
            toolInput: normalizedInput,
            createdAt: Date.now(),
        });

        return pending.finally(() => {
            this.pendingRequests.delete(toolCallId);
        });
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        if (this.isPermissionRequestClaimed(toolCallId)) return;
        this.recordPermissionRequestTrace(toolCallId, toolName, input);
        this.requestStore.publishRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            createdAt: Date.now(),
        });
    }

    private recordPermissionRequestTrace(toolCallId: string, toolName: string, input: unknown): void {
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
                    options: { input },
                },
            });
        }
    }

    protected resolvePendingPermissionRequest(
        requestId: string,
        result: PermissionResult,
        completedRequest?: PermissionRequestCoordinatorCompletedRequest,
    ): void {
        if (this.isPermissionRequestClaimed(requestId)) return;
        const pending = this.pendingRequests.get(requestId);
        const context = this.requestCoordinator.getResponseContext(requestId);
        if (!context) {
            this.pendingRequests.delete(requestId);
            pending?.resolve(result);
            return;
        }

        this.completePendingPermissionRequest(
            requestId,
            context,
            result,
            completedRequest ?? {
                status: result.decision === 'denied' || result.decision === 'abort' ? 'denied' : 'approved',
                decision: result.decision,
            },
        );
    }

    private rejectPendingPermissionRequest(requestId: string, error: Error): void {
        this.pendingRequests.delete(requestId);
        this.requestCoordinator.cancelRequest(requestId, error.message);
    }

    private completePendingPermissionRequest(
        requestId: string,
        context: PermissionRequestCoordinatorContext,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest,
    ): boolean {
        const completed = this.requestCoordinator.completeResponse({
            context,
            completion: {
                result,
                completedRequest,
            },
        });
        if (completed) {
            this.pendingRequests.delete(requestId);
        }
        return completed;
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    private cancelPendingRequests(params: Readonly<{ reason: string; decision?: 'abort' }>): void {
        const pendingSnapshot = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        this.requestCoordinator.cancelAll(params.reason);
        for (const pending of pendingSnapshot) {
            if (pending.coordinatorManaged) continue;
            try {
                pending.reject(new Error(params.reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy pending request:`, err);
            }
        }
    }

    async abortPendingRequestsAndFlush(reason: string = 'Aborted by user'): Promise<void> {
        this.cancelPendingRequests({ reason, decision: 'abort' });
        try {
            await this.session.flush?.();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to flush session after permission abort (non-fatal)`, error);
        }
    }

    reset(): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            this.cancelPendingRequests({ reason: 'Session reset' });

            this.allowedToolIdentifiers.clear();
            this.requestStore.dispose();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
