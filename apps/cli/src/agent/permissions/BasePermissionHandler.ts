/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { logger } from "@/ui/logger";
import { isExecutionRunPermissionRequestId } from '@/agent/executionRuns/runtime/runScopedExecutionPermissionHandler';
import type { ApiSessionClient } from "@/api/session/sessionClient";
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
import type { SessionPermissionRpcPayload } from './sessionPermissionRpc';
import { getOrCreateSessionPermissionRpcRouter } from './sessionPermissionRpcRouter';

export type { PermissionResult } from './permissionResult';

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

type AgentStateRequestsRecord = NonNullable<AgentState['requests']>;
type AgentStateCompletedRequestsRecord = NonNullable<AgentState['completedRequests']>;
let permissionRpcConsumerSequence = 0;

/**
 * Permission response from the mobile app.
 */
export type PermissionResponse = SessionPermissionRpcPayload;

/**
 * Local routing and policy metadata; the coordinator owns request waiters.
 */
export interface PendingRequest {
    toolName: string;
    input: unknown;
    resolveDecisionIfPolicyChanges?: () => PermissionResult | null;
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
    private readonly requestScope: 'foreground' | 'execution_run';
    private allowedToolIdentifiers = new Set<string>();
    private readonly requestStore: AgentStateRequestStore;
    private readonly requestCoordinator: PermissionRequestCoordinator<PermissionResult>;
    private readonly onAbortRequested: (() => void | Promise<void>) | null;
    private readonly getAccountSettingsSnapshotFn: () => AccountSettings | null;
    private readonly toolTrace: { protocol: ToolTraceProtocol; provider: string } | null;
    private readonly triggerAbortCallbackOnAbortDecision: boolean;
    private readonly permissionRpcConsumerName = `permission-handler-${++permissionRpcConsumerSequence}`;
    private unregisterPermissionRpcConsumer: (() => void) | null = null;

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
            requestScope?: 'foreground' | 'execution_run';
        }
    ) {
        this.session = session;
        this.requestScope = opts?.requestScope ?? 'foreground';
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
        const pendingContexts = [...this.pendingRequests.keys()]
            .map((id) => this.requestCoordinator.getResponseContext(id));
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
        for (const context of pendingContexts) {
            if (!context) continue;
            const id = context.requestId;
            if (!this.requestStore.hasOutstandingRequest(id)) {
                this.requestStore.publishRequest(context);
            } else {
                this.requestStore.notifyPermissionRequestPushBestEffort({
                    permissionId: id,
                    toolName: context.toolName,
                    toolInput: context.toolInput,
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
        this.unregisterPermissionRpcConsumer?.();
        this.unregisterPermissionRpcConsumer = null;
        // The session's accessor is optional (the offline stub a provider starts on has none); the
        // fallback is the same manager-keyed router the live session client returns.
        const router = this.session.getOrCreatePermissionRpcRouter?.()
            ?? getOrCreateSessionPermissionRpcRouter(this.session.rpcHandlerManager);
        this.unregisterPermissionRpcConsumer = router.registerConsumer({
            name: this.permissionRpcConsumerName,
            tryHandlePermissionRpc: (response) => this.tryHandlePermissionRpc(response),
        });
    }

    private async tryHandlePermissionRpc(response: SessionPermissionRpcPayload): Promise<boolean> {
        const localPending = this.pendingRequests.get(response.id);
        if (!localPending) return false;
        const hasStructuredAnswers = response.answers !== undefined || response.structuredAnswersV1 !== undefined;
        const candidateContext = hasStructuredAnswers
            ? null
            : this.requestCoordinator.getResponseContext(response.id, response.occurrenceId);
        const requiresLocalQuestionOwner = hasStructuredAnswers
            || (candidateContext !== null && this.isStructuredQuestionContext(candidateContext));
        const context = requiresLocalQuestionOwner
            ? this.requireLocallyOwnedStructuredResponseContext(response.id, localPending, response.occurrenceId)
            : candidateContext;
        if (!context) {
            logger.debug(
                `${this.getLogPrefix()} Permission response received without pending request and without agentState request; ignored`,
            );
            return false;
        }

        const structuredAnswers = response.structuredAnswersV1 !== undefined
            ? normalizeStructuredQuestionAnswersV1(
                response.structuredAnswersV1,
                this.readStructuredQuestions(context),
            )
            : response.answers !== undefined
                ? normalizeLegacyStructuredQuestionAnswers({
                    answers: response.answers,
                    questions: this.readStructuredQuestions(context),
                })
                : undefined;

        return await this.handlePermissionResponseWithContext({
            response,
            context,
            localPending,
            structuredAnswers,
        });
    }

    private requireLocallyOwnedStructuredResponseContext(
        requestId: string,
        localPending: PendingRequest | undefined,
        expectedOccurrenceId?: string,
    ): PermissionRequestCoordinatorContext {
        const context = this.requestCoordinator.getLocallyOwnedLiveResponseContext(requestId, expectedOccurrenceId);
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

    private async handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        localPending: PendingRequest | undefined;
        structuredAnswers?: StructuredQuestionAnswersV1;
    }>): Promise<boolean> {
        const { response, context, localPending, structuredAnswers } = params;
        const responseAllowedTools = response.allowedTools ?? response.allowTools;
        const updatedPermissions = response.updatedPermissions;
        const result = this.buildPermissionResult(response);
        if (structuredAnswers) result.answers = structuredAnswers;

        const requestSource = { toolName: context.toolName, input: context.toolInput };
        if (this.requestCoordinator.isRequestClaimed(response.id)) {
            return false;
        }

        const completedRequest = this.buildCompletedRequestForResponse(
            response,
            result,
            responseAllowedTools,
            updatedPermissions,
            requestSource,
        );
        const onAdmitted = () => {
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

            if (response.approved) {
                this.autoApproveNowAllowedPendingRequests(response.id);
            }

        };
        const completed = await this.requestCoordinator.completeRpcResponse({
            context, completion: { result, completedRequest }, onAdmitted,
            expectedOccurrenceId: response.occurrenceId,
        });
        if (!completed && (structuredAnswers || context.status === 'live')) return false;
        if (completed) this.pendingRequests.delete(response.id);
        if (!completed && !localPending) {
            logger.debug(`${this.getLogPrefix()} Permission response did not complete any pending request`);
        }
        return true;
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
        void this.requestStore.recordCompletedRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
            decision,
            allowedTools,
        });
    }

    protected requestPermissionDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        resolveDecisionIfPolicyChanges?: () => PermissionResult | null,
    ): Promise<PermissionResult> {
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
                resolveDecisionIfPolicyChanges,
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
        const context = this.requestCoordinator.getResponseContext(requestId);
        if (!context) {
            this.pendingRequests.delete(requestId);
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

    private completePendingPermissionRequest(
        requestId: string,
        context: PermissionRequestCoordinatorContext,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest,
        onAdmitted?: () => void,
    ): boolean {
        const completed = this.requestCoordinator.completeResponse({
            context,
            completion: {
                result,
                completedRequest,
            },
            onAdmitted,
        });
        return completed;
    }

    private ownsPersistedRequest(requestId: string): boolean {
        return isExecutionRunPermissionRequestId(requestId) === (this.requestScope === 'execution_run');
    }

    cancelPendingRequest(requestId: string, reason: string): boolean {
        if (this.isPermissionRequestClaimed(requestId)) return false;
        const context = this.requestCoordinator.getResponseContext(requestId);
        if (!context || (context.correlation === 'agent_state' && !this.ownsPersistedRequest(requestId))) return false;
        return this.completePendingPermissionRequest(
            requestId,
            context,
            { decision: 'abort' },
            { status: 'canceled', decision: 'abort', reason },
        );
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    private async cancelPendingRequests(params: Readonly<{ reason: string }>): Promise<void> {
        const pendingSnapshot = Array.from(this.pendingRequests.entries());
        const requests = this.session.getAgentStateSnapshot?.()?.requests ?? {};
        const stateOnlyRequestIds = Object.keys(requests).filter((requestId) => (
            this.ownsPersistedRequest(requestId)
            && this.requestCoordinator.getResponseContext(requestId)?.correlation === 'agent_state'
        ));
        await Promise.all([
            this.requestCoordinator.cancelAll(params.reason),
            ...(stateOnlyRequestIds.length > 0 ? [this.requestStore.cancelAllRequests({
                reason: params.reason, decision: 'abort', requestIds: stateOnlyRequestIds,
            })] : []),
        ]);
        for (const [requestId, pending] of pendingSnapshot) {
            if (this.pendingRequests.get(requestId) === pending) {
                this.pendingRequests.delete(requestId);
            }
        }
    }

    async abortPendingRequestsAndFlush(reason: string = 'Aborted by user'): Promise<void> {
        try {
            await this.cancelPendingRequests({ reason });
        } catch (error) {
            // The coordinator retains the exact detached cancellation for retry.
            // A failed history write must not prevent the caller from stopping the provider.
            logger.infoFile(`${this.getLogPrefix()} Stop request settlement admission failed; continuing provider abort`, error);
        }
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
            void this.cancelPendingRequests({ reason: 'Session reset' }).catch(() => {
                logger.infoFile(`${this.getLogPrefix()} Reset request settlement admission failed`);
            });

            this.allowedToolIdentifiers.clear();
            // A turn reset can be followed by another request on this handler.
            // Keep its session RPC subscription; updateSession moves it when the session swaps.
            this.requestStore.dispose();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
