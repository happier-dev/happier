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
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import type {
    PermissionRequestPushSender as PermissionRequestPushSenderFromSettings,
} from '@/settings/notifications/permissionRequestPush';
import { applyAgentStateRequestPushNotifiedAt, cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import { resolveAgentRequestKind } from './requestKind';

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

type AgentStateRequestsRecord = NonNullable<AgentState['requests']>;
type AgentStateRequestEntry = AgentStateRequestsRecord[string];
type AgentStateCompletedRequestsRecord = NonNullable<AgentState['completedRequests']>;
type AgentStateCompletedRequestEntry = AgentStateCompletedRequestsRecord[string];

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
    private readonly pushSender: PermissionRequestPushSender | null;
    private readonly getAccountSettings: () => AccountSettings | null;
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private readonly onAbortRequested: (() => void | Promise<void>) | null;
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
            onAbortRequested?: (() => void | Promise<void>) | null;
            toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
            triggerAbortCallbackOnAbortDecision?: boolean;
        }
    ) {
        this.session = session;
        this.pushSender = opts?.pushSender ?? null;
        this.getAccountSettings = typeof opts?.getAccountSettings === 'function' ? opts.getAccountSettings : (() => null);
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

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        // Prevent per-session allowlists from leaking across session references.
        // The new session snapshot will re-seed any persisted per-session approvals.
        this.allowedToolIdentifiers.clear();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
        this.seedAllowedToolsFromAgentState();

        // If we were mid-permission when the session reference swapped (offline reconnect),
        // ensure we re-attempt permission-request push notifications for still-pending items.
        for (const [id, pending] of this.pendingRequests.entries()) {
            this.notifyPermissionRequestPushBestEffort(id, pending.toolName, pending.input);
        }
    }

    private notifyPermissionRequestPushBestEffort(permissionId: string, toolName: string, toolInput?: unknown): void {
        const notifier = this.getOrCreatePermissionRequestPushNotifier();
        if (!notifier) return;
        let resolvedToolInput: unknown = toolInput;
        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const existing = (snapshot as any)?.requests?.[permissionId];
            const notifiedAt = typeof existing?.pushNotifiedAt === 'number' ? existing.pushNotifiedAt : null;
            if (resolvedToolInput === undefined) {
                resolvedToolInput = (existing as any)?.arguments;
            }
            if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt) && notifiedAt > 0) {
                notifier.markAlreadyNotified(permissionId);
                return;
            }
        } catch {
            // ignore
        }
        notifier.notify({ permissionId, toolName, toolInput: resolvedToolInput, requestKind: resolveAgentRequestKind(toolName) });
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        if (!this.pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;
        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender: this.pushSender,
            getSettings: () => this.getAccountSettings(),
            sessionId: this.session.sessionId,
            logPrefix: this.getLogPrefix(),
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                this.updateAgentStateBestEffort(
                    (currentState) =>
                        applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs }),
                    'permission request push notifiedAt',
                );
            },
        });
        return this.permissionRequestPushNotifier;
    }

    private markPermissionRequestCompletedBestEffort(permissionId: string): void {
        try {
            this.permissionRequestPushNotifier?.markCompleted(permissionId);
        } catch {
            // ignore
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

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, void>(
            'permission',
            async (response) => {
                const responseAllowedTools = response.allowedTools ?? response.allowTools;
                const updatedPermissions = (response as any).updatedPermissions;
                const pending = this.pendingRequests.get(response.id);
                if (!pending) {
                    // Lifecycle mismatch / race: UI responded, but the in-memory pending promise is gone
                    // (reconnect/reset/race). Still finalize agent state best-effort so the UI doesn't
                    // leave a stuck permission prompt forever.
                    let result: PermissionResult;
                    if (response.approved) {
                        const wantsExecpolicyAmendment = response.decision === 'approved_execpolicy_amendment'
                            && Boolean(response.execPolicyAmendment?.command?.length);

                        if (wantsExecpolicyAmendment) {
                            result = {
                                decision: 'approved_execpolicy_amendment',
                                execPolicyAmendment: response.execPolicyAmendment,
                            };
                        } else if (response.decision === 'approved_for_session') {
                            result = { decision: 'approved_for_session' };
                        } else {
                            result = { decision: 'approved' };
                        }
                    } else {
                        result = { decision: response.decision === 'denied' ? 'denied' : 'abort' };
                    }

                    if (response.approved) {
                        applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, updatedPermissions);
                        applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, responseAllowedTools);
                        if (!Array.isArray(responseAllowedTools) && result.decision === 'approved_for_session') {
                            try {
                                const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
                                const request = snapshot?.requests?.[response.id] ?? null;
                                if (request?.tool) {
                                    this.allowedToolIdentifiers.add(makeToolIdentifier(request.tool, request.arguments));
                                }
                            } catch (error) {
                                logger.debug(`${this.getLogPrefix()} Failed to derive per-session allowlist (non-fatal)`, error);
                            }
                        }
                    }

                    if (response.approved) {
                        this.autoApproveNowAllowedPendingRequests(response.id);
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

                        this.updateAgentStateBestEffort((currentState) => {
                            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                            const request = requests[response.id];
                            if (!request) return currentState;

                            delete requests[response.id];
                            const wantsDerivedAllowTools =
                                response.approved
                                    && !Array.isArray(responseAllowedTools)
                                    && result.decision === 'approved_for_session';
                            const derivedAllowTools =
                                Array.isArray(responseAllowedTools)
                                    ? responseAllowedTools
                                    : (wantsDerivedAllowTools ? [makeToolIdentifier(request.tool, request.arguments)] : undefined);

                            const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedRequestEntry>(currentState.completedRequests);
                        const completedEntry = Object.create(null) as AgentStateCompletedRequestEntry;
                        completedEntry.tool = request.tool;
                        completedEntry.kind = request.kind ?? resolveAgentRequestKind(request.tool);
                        completedEntry.arguments = request.arguments;
                        completedEntry.createdAt = request.createdAt;
                        completedEntry.completedAt = Date.now();
                        completedEntry.status = response.approved ? 'approved' : 'denied';
                        completedEntry.decision = result.decision;
                        if (derivedAllowTools) completedEntry.allowedTools = derivedAllowTools;
                        if (typeof updatedPermissions !== 'undefined') completedEntry.updatedPermissions = updatedPermissions;
                        completedRequests[response.id] = completedEntry;

                            return { ...currentState, requests, completedRequests } satisfies AgentState;
                        }, 'permission response completion (stale)');
                    this.markPermissionRequestCompletedBestEffort(response.id);

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

                    logger.debug(`${this.getLogPrefix()} Permission response received without pending request; finalized agentState best-effort`);
                    return;
                }

                // Remove from pending
                this.pendingRequests.delete(response.id);
                this.markPermissionRequestCompletedBestEffort(response.id);

                // Resolve the permission request
                let result: PermissionResult;

                if (response.approved) {
                    const wantsExecpolicyAmendment = response.decision === 'approved_execpolicy_amendment'
                        && Boolean(response.execPolicyAmendment?.command?.length);

                    if (wantsExecpolicyAmendment) {
                        result = {
                            decision: 'approved_execpolicy_amendment',
                            execPolicyAmendment: response.execPolicyAmendment,
                        };
                    } else if (response.decision === 'approved_for_session') {
                        result = { decision: 'approved_for_session' };
                    } else {
                        result = { decision: 'approved' };
                    }
                } else {
                    result = { decision: response.decision === 'denied' ? 'denied' : 'abort' };
                }

                if (response.approved) {
                    const answersRaw = (response as any).answers;
                    if (answersRaw && typeof answersRaw === 'object' && !Array.isArray(answersRaw)) {
                        const normalized = Object.create(null) as Record<string, string>;
                        for (const [k, v] of Object.entries(answersRaw as Record<string, unknown>)) {
                            if (typeof k !== 'string' || !k) continue;
                            if (typeof v === 'string') normalized[k] = v;
                        }
                        if (Object.keys(normalized).length > 0) {
                            result.answers = normalized;
                        }
                    }
                }

                // Per-session allowlist: if user chooses "approved_for_session", remember this tool (and for
                // shell/exec tools, remember the exact command) so future prompts can auto-approve.
                if (response.approved) {
                    applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, updatedPermissions);
                    applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, responseAllowedTools);
                    if (!Array.isArray(responseAllowedTools) && result.decision === 'approved_for_session') {
                        this.allowedToolIdentifiers.add(makeToolIdentifier(pending.toolName, pending.input));
                    }
                }

                pending.resolve(result);

                if (response.approved) {
                    this.autoApproveNowAllowedPendingRequests(response.id);
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

                const derivedAllowTools =
                    Array.isArray(responseAllowedTools)
                        ? responseAllowedTools
                        : (result.decision === 'approved_for_session'
                            ? [makeToolIdentifier(pending.toolName, pending.input)]
                            : undefined);

                    // Move request to completed in agent state
                    this.updateAgentStateBestEffort((currentState) => {
                        const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                        const request = requests[response.id];
                        if (!request) return currentState;

                        delete requests[response.id];

                        const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedRequestEntry>(currentState.completedRequests);
                    const completedEntry = Object.create(null) as AgentStateCompletedRequestEntry;
                    completedEntry.tool = request.tool;
                    completedEntry.kind = request.kind ?? resolveAgentRequestKind(request.tool);
                    completedEntry.arguments = request.arguments;
                    completedEntry.createdAt = request.createdAt;
                    completedEntry.completedAt = Date.now();
                    completedEntry.status = response.approved ? 'approved' : 'denied';
                    completedEntry.decision = result.decision;
                    if (derivedAllowTools) completedEntry.allowedTools = derivedAllowTools;
                    if (typeof updatedPermissions !== 'undefined') completedEntry.updatedPermissions = updatedPermissions;
                    completedRequests[response.id] = completedEntry;

                    return { ...currentState, requests, completedRequests } satisfies AgentState;
                }, 'permission response completion');

                logger.debug(`${this.getLogPrefix()} Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);
            }
        );
    }

    private autoApproveNowAllowedPendingRequests(excludePermissionId: string): void {
        for (const [permissionId, pending] of this.pendingRequests.entries()) {
            if (permissionId === excludePermissionId) continue;
            if (resolveAgentRequestKind(pending.toolName) !== 'permission') continue;
            if (!this.isAllowedForSession(pending.toolName, pending.input)) continue;

            this.pendingRequests.delete(permissionId);
            this.markPermissionRequestCompletedBestEffort(permissionId);

            pending.resolve({ decision: 'approved' });

            this.updateAgentStateBestEffort((currentState) => {
                const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                const request = requests[permissionId];
                if (!request) return currentState;

                delete requests[permissionId];

                const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedRequestEntry>(currentState.completedRequests);
                const completedEntry = Object.create(null) as AgentStateCompletedRequestEntry;
                completedEntry.tool = request.tool;
                completedEntry.kind = request.kind ?? resolveAgentRequestKind(request.tool);
                completedEntry.arguments = request.arguments;
                completedEntry.createdAt = request.createdAt;
                completedEntry.completedAt = Date.now();
                completedEntry.status = 'approved';
                completedEntry.decision = 'approved';
                completedRequests[permissionId] = completedEntry;

                return { ...currentState, requests, completedRequests } satisfies AgentState;
            }, 'permission auto-approval (allowlist)');
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
                this.updateAgentStateBestEffort((currentState) => {
                    const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedRequestEntry>(currentState.completedRequests);
                const entry = Object.create(null) as AgentStateCompletedRequestEntry;
                entry.tool = toolName;
                entry.kind = resolveAgentRequestKind(toolName);
                entry.arguments = input;
                entry.createdAt = Date.now();
                entry.completedAt = Date.now();
                entry.status = decision === 'denied' || decision === 'abort' ? 'denied' : 'approved';
                entry.decision = decision;
                if (allowedTools) entry.allowedTools = allowedTools;
                completedRequests[toolCallId] = entry;
                return { ...currentState, completedRequests } satisfies AgentState;
            }, 'auto decision');
        this.markPermissionRequestCompletedBestEffort(toolCallId);
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
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

                this.updateAgentStateBestEffort((currentState) => ({
                    ...currentState,
                    requests: (() => {
                        const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                    const entry = Object.create(null) as AgentStateRequestEntry;
                    entry.tool = toolName;
                    entry.kind = resolveAgentRequestKind(toolName);
                    entry.arguments = input;
                    entry.createdAt = Date.now();
                    requests[toolCallId] = entry;
                    return requests;
                })(),
        }), 'permission request add');

        this.notifyPermissionRequestPushBestEffort(toolCallId, toolName, input);
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
            const pendingSnapshot = Array.from(this.pendingRequests.entries());
            this.pendingRequests.clear(); // Clear immediately to prevent new entries being processed

            // Reject all pending requests from snapshot
            for (const [id, pending] of pendingSnapshot) {
                try {
                    pending.reject(new Error('Session reset'));
                } catch (err) {
                    logger.debug(`${this.getLogPrefix()} Error rejecting pending request ${id}:`, err);
                }
            }

                // Clear requests in agent state
                this.updateAgentStateBestEffort((currentState) => {
                    const pendingRequests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                    const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedRequestEntry>(currentState.completedRequests);

                    // Move all pending to completed as canceled
                    for (const id of Object.keys(pendingRequests)) {
                        const request = pendingRequests[id];
                        if (!request) continue;
                        const entry = Object.create(null) as AgentStateCompletedRequestEntry;
                        entry.tool = request.tool;
                        entry.kind = request.kind ?? resolveAgentRequestKind(request.tool);
                        entry.arguments = request.arguments;
                        entry.createdAt = request.createdAt;
                        entry.completedAt = Date.now();
                        entry.status = 'canceled';
                        entry.reason = 'Session reset';
                    completedRequests[id] = entry;
                }

                    return {
                        ...currentState,
                        requests: Object.create(null) as AgentStateRequestsRecord,
                        completedRequests,
                    };
                }, 'reset');

            this.allowedToolIdentifiers.clear();
            this.permissionRequestPushNotifier?.dispose();
            this.permissionRequestPushNotifier = null;
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.isResetting = false;
        }
    }
}
