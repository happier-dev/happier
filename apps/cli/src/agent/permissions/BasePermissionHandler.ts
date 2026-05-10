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
import { resolveAgentRequestKind } from './requestKind';
import { AgentStateRequestStore } from './agentStateRequestStore';
import type {
    AgentStateOutstandingRequest,
    AgentStateRequestResponseTarget,
} from './agentStateRequestStore';
import {
    createPermissionRequestCoordinator,
    type PermissionRequestCoordinator,
    type PermissionRequestCoordinatorCompletedRequest,
    type PermissionRequestCoordinatorContext,
} from './permissionRequestCoordinator';

type AgentStateRequestStoreBindableSession = Readonly<{
    bindAgentStateRequestStore?: (store: AgentStateRequestStore) => void;
}>;

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

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
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
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
    answers?: Record<string, string>;
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
        this.bindRequestStoreToSession(session);
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
        const pendingMetadataById = new Map<string, AgentStateOutstandingRequest | null>();
        for (const id of this.pendingRequests.keys()) {
            pendingMetadataById.set(id, this.requestStore.readOutstandingRequest(id));
        }

        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        // Prevent per-session allowlists from leaking across session references.
        // The new session snapshot will re-seed any persisted per-session approvals.
        this.allowedToolIdentifiers.clear();
        this.requestStore.updateSession(newSession);
        this.bindRequestStoreToSession(newSession);
        this.seedAllowedToolsFromAgentState();

        // If we were mid-permission when the session reference swapped (offline reconnect),
        // republish still-pending items into the new agentState and re-attempt push notifications.
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (!this.requestStore.hasOutstandingRequest(id)) {
                const priorOutstanding = pendingMetadataById.get(id);
                this.requestStore.publishRequest({
                    requestId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                    createdAt: priorOutstanding?.createdAt ?? Date.now(),
                    ...(typeof priorOutstanding?.kind === 'string' ? { kind: priorOutstanding.kind } : {}),
                    ...(priorOutstanding?.responseTarget ?? pending.responseTarget
                        ? { responseTarget: priorOutstanding?.responseTarget ?? pending.responseTarget ?? null }
                        : {}),
                    ...(typeof priorOutstanding?.subagentRef !== 'undefined'
                        ? { subagentRef: priorOutstanding.subagentRef }
                        : typeof pending.subagentRef !== 'undefined'
                            ? { subagentRef: pending.subagentRef }
                            : {}),
                    ...(typeof priorOutstanding?.sidechainId === 'string'
                        ? { sidechainId: priorOutstanding.sidechainId }
                        : typeof pending.sidechainId === 'string'
                            ? { sidechainId: pending.sidechainId }
                            : {}),
                    ...(Array.isArray(priorOutstanding?.permissionSuggestions)
                        ? { permissionSuggestions: priorOutstanding.permissionSuggestions }
                        : Array.isArray(pending.permissionSuggestions)
                            ? { permissionSuggestions: pending.permissionSuggestions }
                            : {}),
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

    private bindRequestStoreToSession(session: ApiSessionClient): void {
        const binder = (session as AgentStateRequestStoreBindableSession).bindAgentStateRequestStore;
        if (typeof binder !== 'function') return;
        binder.call(session, this.requestStore);
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
            : (wantsDerivedAllowTools ? [makeToolIdentifier(requestSource.toolName, requestSource.input)] : undefined);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            ...(typeof derivedAllowTools !== 'undefined' ? { allowedTools: derivedAllowTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
        };
    }

    private applyPermissionResponseAnswers(response: PermissionResponse, result: PermissionResult): void {
        if (!response.approved) return;

        const answersRaw = response.answers;
        if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) return;

        const normalized = Object.create(null) as Record<string, string>;
        for (const [key, value] of Object.entries(answersRaw)) {
            if (!key) continue;
            if (typeof value === 'string') normalized[key] = value;
        }

        if (Object.keys(normalized).length > 0) {
            result.answers = normalized;
        }
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
        const handlePermissionResponse = async (response: PermissionResponse): Promise<void> => {
            this.handleIncomingPermissionResponse(response);
        };
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'session.permission.respond',
            handlePermissionResponse,
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'session.user_action.answer',
            handlePermissionResponse,
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            handlePermissionResponse,
        );
    }

    private handleIncomingPermissionResponse(response: PermissionResponse): void {
        const legacyPending = this.pendingRequests.get(response.id);
        const context = this.requestCoordinator.getResponseContext(response.id)
            ?? (legacyPending
                ? {
                    requestId: response.id,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context) {
            logger.debug(
                `${this.getLogPrefix()} Permission response received without pending request and without agentState request; ignored`,
            );
            return;
        }

        this.handlePermissionResponseWithContext({
            response,
            context,
            legacyPending,
        });
    }

    private handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        legacyPending: PendingRequest | undefined;
    }>): void {
        const { response, context, legacyPending } = params;
        const responseAllowedTools = response.allowedTools ?? response.allowTools;
        const updatedPermissions = response.updatedPermissions;
        const result = this.buildPermissionResult(response);
        this.applyPermissionResponseAnswers(response, result);

        const requestSource = { toolName: context.toolName, input: context.toolInput };
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

        const completed = this.completePendingPermissionRequest(
            response.id,
            context,
            result,
            this.buildCompletedRequestForResponse(
                response,
                result,
                responseAllowedTools,
                updatedPermissions,
                requestSource,
            ),
        );

        if (!legacyPending?.coordinatorManaged && this.pendingRequests.has(response.id)) {
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

    protected recordAutoDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        decision: PermissionResult['decision']
    ): void {
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
        const hasExistingContext = this.requestCoordinator.getResponseContext(toolCallId) !== null;
        if (!hasExistingContext) {
            this.recordPermissionRequestTrace(toolCallId, toolName, input);
        }

        let ownsPendingRecord = false;
        let pendingRecord = this.pendingRequests.get(toolCallId);
        if (!pendingRecord) {
            pendingRecord = {
                toolName,
                input,
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
        });

        return pending.finally(() => {
            if (ownsPendingRecord && this.pendingRequests.get(toolCallId) === pendingRecord) {
                this.pendingRequests.delete(toolCallId);
            }
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
        const pending = this.pendingRequests.get(requestId);
        const completed = this.requestCoordinator.completeResponse({
            context,
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

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): void {
        // Guard against re-entrant/concurrent resets
        if (this.isResetting) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, skipping`);
            return;
        }
        this.isResetting = true;

        try {
            // Snapshot pending requests to avoid Map mutation during iteration
            const pendingSnapshot = Array.from(this.pendingRequests.values());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed
            this.requestCoordinator.cancelAll('Session reset');

            // Reject all pending requests from snapshot
            for (const pending of pendingSnapshot) {
                if (pending.coordinatorManaged) continue;
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting legacy pending request:`, err);
                }
            }

            this.allowedToolIdentifiers.clear();
            this.requestStore.dispose();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
