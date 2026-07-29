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
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist } from './applyPermissionAllowlistUpdates';
import { recordToolTraceEvent, type ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import {
    StructuredQuestionAnswersV1Schema,
    type AccountSettings,
    type StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/agents';
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
import {
    isPermissionRequestOwnedByPlugin,
    normalizePermissionRequestOwner,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

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
    answers?: StructuredQuestionAnswersV1 | Readonly<Record<string, string>>;
}

/**
 * Outcome of routing an inbound permission/user-action response to a pending request.
 *
 * `not_found` means the explicit request id is unknown (never seen / already gone) — the caller must
 * surface a typed failure instead of a fabricated success (gap 28/29).
 */
export type PermissionResponseRoutingResult =
    | { status: 'resolved' }
    | { status: 'not_found' };

/**
 * Typed RPC result for `session.permission.respond` / `session.user_action.answer` / `permission`.
 *
 * Resolving a pending request returns `void` (unchanged success contract). An unknown explicit id
 * returns a typed `permission_request_not_found` so a stale UI tap cannot read as silent success.
 */
export type PermissionRespondRpcResult =
    | void
    | Readonly<{ ok: false; errorCode: 'permission_request_not_found'; requestId: string }>;

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
        this.allowedToolIdentifiersByOwner.clear();
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
                    ...(priorOutstanding?.owner ?? pending.owner
                        ? { owner: priorOutstanding?.owner ?? pending.owner ?? null }
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
            const completedRecord = completed && typeof completed === 'object' && !Array.isArray(completed)
                ? completed as Record<string, unknown>
                : null;
            if (!completedRecord) return;

            for (const value of Object.values(completedRecord)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const entry = value as Record<string, unknown>;
                if (entry.status !== 'approved') continue;

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

    private applyPermissionResponseAnswers(response: PermissionResponse, result: PermissionResult): boolean {
        if (!response.approved || typeof response.answers === 'undefined') return true;

        const answersRaw = response.answers;
        if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) return false;

        const structured = StructuredQuestionAnswersV1Schema.safeParse(answersRaw);
        if (structured.success) {
            if (Object.keys(structured.data).length > 0) {
                result.answers = structured.data;
            }
            return true;
        }

        // Compatibility reader for UI/action clients through the released 0.2.2 preview,
        // which wrote question -> scalar answer. Remove after that preview is outside the
        // supported mixed-version window and stored/in-flight requests cannot carry it.
        const normalized = Object.create(null) as Record<string, string>;
        for (const [key, value] of Object.entries(answersRaw)) {
            if (!key || typeof value !== 'string') return false;
            normalized[key] = value;
        }

        if (Object.keys(normalized).length > 0) {
            result.answers = normalized;
        }
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

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        const handlePermissionResponse = async (response: PermissionResponse): Promise<PermissionRespondRpcResult> => {
            const outcome = await this.handleIncomingPermissionResponse(response);
            if (outcome.status === 'not_found') {
                return {
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: typeof response?.id === 'string' ? response.id : '',
                } as const;
            }
            return undefined;
        };
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'session.permission.respond',
            handlePermissionResponse,
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'session.user_action.answer',
            handlePermissionResponse,
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'permission',
            handlePermissionResponse,
        );
    }

    /**
     * Route a permission/user-action response (e.g. forwarded by a runtime's `respondToPermission`)
     * to its pending coordinator request. Returns a typed `not_found` for unknown explicit ids so the
     * caller surfaces a typed failure instead of fabricating a success (gap 28/29).
     */
    respondToPendingPermission(response: PermissionResponse): Promise<PermissionResponseRoutingResult> {
        return this.handleIncomingPermissionResponse(response);
    }

    private async handleIncomingPermissionResponse(response: PermissionResponse): Promise<PermissionResponseRoutingResult> {
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

        const completed = await this.handlePermissionResponseWithContext({
            response,
            context,
            legacyPending,
        });
        return completed ? { status: 'resolved' } : { status: 'not_found' };
    }

    private async handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        legacyPending: PendingRequest | undefined;
    }>): Promise<boolean> {
        const { response, context, legacyPending } = params;
        const responseAllowedTools = response.allowedTools ?? response.allowTools;
        const updatedPermissions = response.updatedPermissions;
        const result = this.buildPermissionResult(response);
        if (!this.applyPermissionResponseAnswers(response, result)) {
            throw new Error('Invalid structured question answers');
        }

        const requestSource = { toolName: context.toolName, input: context.toolInput };
        const completed = await this.completePendingPermissionRequest(
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

        if (!completed && (!legacyPending || legacyPending.coordinatorManaged)) {
            logger.debug(`${this.getLogPrefix()} Permission response did not complete any pending request`);
            return false;
        }

        this.applyPermissionResponseSideEffects({
            response,
            result,
            responseAllowedTools,
            updatedPermissions,
            requestSource,
            ...(context.owner ? { owner: context.owner } : {}),
            debugMessage:
                context.correlation === 'agent_state'
                    ? 'Permission response received without pending request; finalized agentState best-effort'
                    : `Permission ${response.approved ? 'approved' : 'denied'} for ${context.toolName}`,
        });

        if (!legacyPending?.coordinatorManaged && this.pendingRequests.has(response.id)) {
            this.pendingRequests.delete(response.id);
            legacyPending?.resolve(result);
        }

        if (response.approved) {
            this.autoApproveNowAllowedPendingRequests(response.id);
        }

        return completed || Boolean(legacyPending && !legacyPending.coordinatorManaged);
    }

    private autoApproveNowAllowedPendingRequests(excludePermissionId: string): void {
        for (const [permissionId, pending] of this.pendingRequests.entries()) {
            if (permissionId === excludePermissionId) continue;
            if (resolveAgentRequestKind(pending.toolName) !== 'permission') continue;
            if (!this.isAllowedForSessionForOwner(pending.toolName, pending.input, pending.owner)) continue;

            this.resolvePendingPermissionRequest(permissionId, { decision: 'approved' }, {
                status: 'approved',
                decision: 'approved',
            });
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
        options?: Readonly<{ owner?: PermissionRequestOwner | null; source?: string | null }>,
    ): void {
        const allowedTools = decision === 'approved_for_session'
            ? [makeToolIdentifier(toolName, input)]
            : undefined;
        const owner = normalizePermissionRequestOwner(options?.owner);
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        this.requestStore.recordCompletedRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
            decision,
            allowedTools,
            ...(source ? { source } : {}),
            ...(owner ? { owner } : {}),
        });
    }

    protected isAllowedForSessionForOwner(
        toolName: string,
        input: unknown,
        owner: PermissionRequestOwner | null | undefined,
    ): boolean {
        const normalizedOwner = normalizePermissionRequestOwner(owner);
        const allowedIdentifiers = normalizedOwner
            ? this.allowedToolIdentifiersByOwner.get(permissionRequestOwnerAllowlistKey(normalizedOwner)) ?? []
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
            this.allowedToolIdentifiersByOwner.set(key, allowedIdentifiers);
        }
        return allowedIdentifiers;
    }

    protected requestPermissionDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: Readonly<{
            owner?: PermissionRequestOwner | null;
            source?: string | null;
            signal?: AbortSignal;
        }>,
    ): Promise<PermissionResult> {
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        const hasExistingContext = this.requestCoordinator.getResponseContext(toolCallId) !== null;
        if (!hasExistingContext) {
            this.recordPermissionRequestTrace(toolCallId, toolName, input, source);
        }

        const owner = normalizePermissionRequestOwner(options?.owner);
        let ownsPendingRecord = false;
        let pendingRecord = this.pendingRequests.get(toolCallId);
        if (!pendingRecord) {
            pendingRecord = {
                toolName,
                input,
                ...(owner ? { owner } : {}),
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
            ...(source ? { source } : {}),
            ...(owner ? { owner } : {}),
        }, { signal: options?.signal });

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
    ): void {
        const pending = this.pendingRequests.get(requestId);
        const context = this.requestCoordinator.getResponseContext(requestId);
        if (!context) {
            this.pendingRequests.delete(requestId);
            pending?.resolve(result);
            return;
        }

        void this.completePendingPermissionRequest(
            requestId,
            context,
            result,
            completedRequest ?? {
                status: result.decision === 'denied' || result.decision === 'abort' ? 'denied' : 'approved',
                decision: result.decision,
            },
        ).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to complete permission request (non-fatal)`, error);
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

    private async cancelPendingRequests(reason: string): Promise<void> {
        const pendingSnapshot = Array.from(this.pendingRequests.values());
        this.pendingRequests.clear();
        const cancellation = this.requestCoordinator.cancelAll(reason);

        for (const pending of pendingSnapshot) {
            if (pending.coordinatorManaged) continue;
            try {
                pending.reject(new Error(reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy pending request:`, err);
            }
        }
        await cancellation;
    }

    async cancelByPlugin(pluginId: string, reason: string = 'plugin_deactivated'): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;

        const legacyPendingSnapshot = Array.from(this.pendingRequests.entries()).filter(
            ([, pending]) => !pending.coordinatorManaged && isPermissionRequestOwnedByPlugin(pending.owner, normalizedPluginId),
        );
        await this.requestCoordinator.cancelByPlugin(normalizedPluginId, reason);

        for (const [requestId, pending] of legacyPendingSnapshot) {
            this.pendingRequests.delete(requestId);
            try {
                pending.reject(new Error(reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy plugin-owned request:`, err);
            }
        }
    }

    async abortPendingRequestsAndFlush(reason: string = 'Aborted by user'): Promise<void> {
        await this.cancelPendingRequests(reason);
        try {
            await this.session.flush?.();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to flush session after permission abort (non-fatal)`, error);
        }
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): Promise<void> {
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
            await this.cancelPendingRequests('Session reset');

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
