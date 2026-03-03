/**
 * Permission Handler for canCallTool integration
 * 
 * Replaces the MCP permission server with direct SDK integration.
 * Handles tool permission requests, responses, and state management.
 */

import { isDeepStrictEqual } from 'node:util';
import { logger } from "@/lib";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "../sdk";
import { PermissionResult } from "../sdk/types";
import { Session } from "../session";
import { getToolName } from "./getToolName";
import { EnhancedMode, PermissionMode } from "../loop";
import { getToolDescriptor } from "./getToolDescriptor";
import { delay } from "@/utils/time";
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { extractAgentIdFromTaskResultText } from '@/backends/claude/remote/sidechains/extractAgentIdFromTaskResult';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from '@/backends/claude/utils/permissionMode';
import type { PermissionRpcPayload } from './permissionRpc';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { configuration } from '@/configuration';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import { applyAgentStateRequestPushNotifiedAt, clonePlainObjectToNullProto, cloneStringKeyedRecordToNullProto } from '@/api/session/agentStateRecords';
import type { AgentState, Metadata } from '@/api/types';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist, seedAllowlistFromCompletedRequests } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';

type PermissionResponse = PermissionRpcPayload;

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];

function isInteractiveTool(toolName: string): boolean {
    return (
        toolName === 'AskUserQuestion' ||
        toolName === 'ask_user_question' ||
        toolName === 'ExitPlanMode' ||
        toolName === 'exit_plan_mode'
    );
}

interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    sourceLocalId: string | null;
}

export class PermissionHandler {
    private toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private session: Session;
    private allowedToolIdentifiers = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    private agentIdByTaskId = new Map<string, string>();
    private exitedPlanModeLocalIds = new Map<string, number>();
    private exitedPlanModeFallbackUntilMs: number = 0;

    constructor(session: Session) {
        this.session = session;
        this.session.getOrCreatePermissionRpcRouter().registerConsumer({
            name: 'claude-remote-permission-handler',
            tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
        });
        this.advertiseCapabilities();
        this.seedAllowlistFromAgentState();
    }

    private isToolExplicitlyAllowed(toolName: string, input: unknown): boolean {
        return isToolAllowedForSession(this.allowedToolIdentifiers, toolName, input);
    }

    private tryAutoApprovePendingRequests(): void {
        if (this.pendingRequests.size === 0) return;

        const idsToApprove: string[] = [];
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (isInteractiveTool(pending.toolName)) continue;
            if (this.isToolExplicitlyAllowed(pending.toolName, pending.input)) {
                idsToApprove.push(id);
            }
        }

        for (const id of idsToApprove) {
            // The request may have been resolved while we were iterating.
            if (!this.pendingRequests.has(id)) continue;
            this.applyPermissionResponse({ id, approved: true });
        }
    }

    private applyUpdatedPermissionsAllowlist(updatedPermissions: unknown): void {
        applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, updatedPermissions);
    }

    private pruneExitPlanModeLocalIds(nowMs: number): void {
        const ttlMs = configuration.claudeExitPlanModeLatchMs;
        for (const [localId, approvedAt] of this.exitedPlanModeLocalIds.entries()) {
            if (nowMs - approvedAt > ttlMs) {
                this.exitedPlanModeLocalIds.delete(localId);
            }
        }

        const maxEntries = configuration.claudeExitPlanModeLatchMaxEntries;
        if (this.exitedPlanModeLocalIds.size <= maxEntries) return;

        const entries = Array.from(this.exitedPlanModeLocalIds.entries());
        entries.sort((a, b) => a[1] - b[1]);
        const overflow = entries.length - maxEntries;
        for (let i = 0; i < overflow; i++) {
            this.exitedPlanModeLocalIds.delete(entries[i]![0]);
        }
    }

    private noteExitPlanModeApproved(sourceLocalId: string | null): void {
        const nowMs = Date.now();
        const localId = typeof sourceLocalId === 'string' ? sourceLocalId.trim() : '';
        if (localId.length > 0) {
            this.exitedPlanModeLocalIds.set(localId, nowMs);
            this.pruneExitPlanModeLocalIds(nowMs);
            return;
        }

        const ttlMs = configuration.claudeExitPlanModeLatchMs;
        this.exitedPlanModeFallbackUntilMs = Math.max(this.exitedPlanModeFallbackUntilMs, nowMs + ttlMs);
    }

    private shouldIgnorePlanModeForCall(localId: string | null): boolean {
        const nowMs = Date.now();
        this.pruneExitPlanModeLocalIds(nowMs);

        const normalized = typeof localId === 'string' ? localId.trim() : '';
        if (normalized.length > 0) {
            const approvedAt = this.exitedPlanModeLocalIds.get(normalized);
            if (!approvedAt) return false;
            return nowMs - approvedAt <= configuration.claudeExitPlanModeLatchMs;
        }

        return nowMs <= this.exitedPlanModeFallbackUntilMs;
    }

    private clearAcpSessionModeOverrideBestEffort(): void {
        const updatedAt = Date.now();
        updateMetadataBestEffort(
            this.session.client,
            (metadata): Metadata =>
                computeNextMetadataStringOverrideV1({
                    metadata: cloneStringKeyedRecordToNullProto(metadata),
                    overrideKey: 'acpSessionModeOverrideV1',
                    valueKey: 'modeId',
                    value: '',
                    updatedAt,
                }) as unknown as Metadata,
            '[Claude]',
            'exit_plan_mode_clear_session_mode_override',
        );
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        if (!this.session.pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;
        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender: this.session.pushSender,
            getSettings: () => this.session.accountSettings ?? null,
            sessionId: this.session.client.sessionId,
            logPrefix: '[Claude]',
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                updateAgentStateBestEffort(
                    this.session.client,
                    (currentState) =>
                        applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs }),
                    '[Claude]',
                    'permission_request_push_notified_at',
                );
            },
        });
        return this.permissionRequestPushNotifier;
    }

    private isToolTraceEnabled(): boolean {
        const isTruthy = (value: string | undefined): boolean =>
            typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
        return isTruthy(process.env.HAPPIER_STACK_TOOL_TRACE);
    }

    private redactToolTraceValue(value: unknown, key?: string): unknown {
        const REDACT_KEYS = new Set(['content', 'text', 'old_string', 'new_string', 'oldText', 'newText', 'oldContent', 'newContent']);

        if (typeof value === 'string') {
            if (key && REDACT_KEYS.has(key)) return `[redacted ${value.length} chars]`;
            if (value.length <= 1_000) return value;
            return `${value.slice(0, 1_000)}…(truncated ${value.length - 1_000} chars)`;
        }

        if (typeof value !== 'object' || value === null) return value;

        if (Array.isArray(value)) {
            const sliced = value.slice(0, 50).map((v) => this.redactToolTraceValue(v));
            if (value.length <= 50) return sliced;
            return [...sliced, `…(truncated ${value.length - 50} items)`];
        }

        const entries = Object.entries(value as Record<string, unknown>);
        const out: Record<string, unknown> = {};
        const sliced = entries.slice(0, 200);
        for (const [k, v] of sliced) out[k] = this.redactToolTraceValue(v, k);
        if (entries.length > 200) out._truncatedKeys = entries.length - 200;
        return out;
    }

    private seedAllowlistFromAgentState(): void {
        try {
            const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;
            seedAllowlistFromCompletedRequests(this.allowedToolIdentifiers, completed);
        } catch (error) {
            logger.debug('[Claude] Failed to seed allowlist from agentState', error);
        }
    }

    private advertiseCapabilities(): void {
        // Capability negotiation for app ↔ agent compatibility.
        // Older agents won't set this, so clients can safely fall back to legacy behavior.
        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const currentCaps = (currentState as any).capabilities;
                if (currentCaps && currentCaps.askUserQuestionAnswersInPermission === true) {
                    return currentState;
                }
                return {
                    ...currentState,
                    capabilities: {
                        ...(currentCaps && typeof currentCaps === 'object' ? currentCaps : {}),
                        askUserQuestionAnswersInPermission: true,
                    },
                };
            },
            '[Claude]',
            'advertise_capabilities',
        );
    }

    approveToolCall(toolCallId: string, opts?: { answers?: Record<string, string> }): void {
        this.applyPermissionResponse({ id: toolCallId, approved: true, answers: opts?.answers });
    }

    private tryHandlePermissionRpc(message: PermissionResponse): boolean {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id) {
            return false;
        }
        if (this.pendingRequests.has(id)) {
            this.applyPermissionResponse(message);
            return true;
        }

        // Late/deduped response handling:
        // Mobile approvals can arrive after the in-memory pending map was cleared (abort/reconnect paths).
        // We still want to resolve the *UI* state surface (agentState requests -> completedRequests)
        // so the app doesn't get stuck showing an unresolvable prompt.
        if (!this.hasOutstandingAgentStateRequest(id)) {
            return false;
        }

        this.applyLatePermissionResponse(message);
        return true;
    }

    private hasOutstandingAgentStateRequest(id: string): boolean {
        try {
            const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
            const requests = snapshot?.requests;
            if (!requests || typeof requests !== 'object') return false;
            return id in (requests as Record<string, unknown>);
        } catch {
            return false;
        }
    }

    private applyLatePermissionResponse(message: PermissionResponse): void {
        const id = message.id;
        this.permissionRequestPushNotifier?.markCompleted(id);
        this.responses.set(id, { ...message, receivedAt: Date.now() });

        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const request = requests[id] as unknown;
                if (!request) return currentState;
                delete requests[id];
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const completedEntry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                completedEntry['completedAt'] = Date.now();
                completedEntry['status'] = message.approved ? 'approved' : 'denied';
                completedEntry['reason'] = message.reason;
                completedEntry['mode'] = message.mode;
                const allowed = message.allowedTools ?? message.allowTools;
                if (Array.isArray(allowed)) completedEntry['allowedTools'] = allowed;
                if (message.answers && typeof message.answers === 'object') completedEntry['answers'] = message.answers;
                if (typeof message.updatedPermissions !== 'undefined') completedEntry['updatedPermissions'] = message.updatedPermissions;
                completedRequests[id] = completedEntry;
                return {
                    ...currentState,
                    requests,
                    completedRequests,
                };
            },
            '[Claude]',
            'complete_permission_request_late',
        );
    }

    private applyPermissionResponse(message: PermissionResponse): void {
        const id = message.id;
        this.permissionRequestPushNotifier?.markCompleted(id);
        logger.debug('[Claude] Permission response received', {
            id,
            approved: message.approved,
            mode: message.mode,
            hasReason: typeof message.reason === 'string' && message.reason.length > 0,
            allowedToolsCount: Array.isArray(message.allowedTools ?? message.allowTools)
                ? (message.allowedTools ?? message.allowTools)!.length
                : 0,
            answersCount: message.answers ? Object.keys(message.answers).length : 0,
        });

        if (this.isToolTraceEnabled()) {
            recordToolTraceEvent({
                direction: 'inbound',
                sessionId: this.session.client.sessionId,
                protocol: 'claude',
                provider: 'claude',
                kind: 'permission-response',
                payload: {
                    type: 'permission-response',
                    permissionId: id,
                    approved: message.approved,
                    reason: typeof message.reason === 'string' ? message.reason : undefined,
                    mode: message.mode,
                    allowedTools: this.redactToolTraceValue(message.allowedTools ?? message.allowTools, 'allowedTools'),
                    answers: this.redactToolTraceValue(message.answers, 'answers'),
                    updatedPermissions: this.redactToolTraceValue(message.updatedPermissions, 'updatedPermissions'),
                },
            });
        }

        const pending = this.pendingRequests.get(id);

        if (!pending) {
            logger.debug('Permission request not found or already resolved');
            return;
        }

        // Store the response with timestamp
        this.responses.set(id, { ...message, receivedAt: Date.now() });
        this.pendingRequests.delete(id);

        // Handle the permission response based on tool type
        this.handlePermissionResponse(message, pending);

        // Move processed request to completedRequests
        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const request = requests[id] as unknown;
                if (!request) return currentState;
                delete requests[id];
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const completedEntry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                completedEntry['completedAt'] = Date.now();
                completedEntry['status'] = message.approved ? 'approved' : 'denied';
                completedEntry['reason'] = message.reason;
                completedEntry['mode'] = message.mode;
                const allowed = message.allowedTools ?? message.allowTools;
                if (Array.isArray(allowed)) completedEntry['allowedTools'] = allowed;
                if (typeof message.updatedPermissions !== 'undefined') completedEntry['updatedPermissions'] = message.updatedPermissions;
                completedRequests[id] = completedEntry;
                return {
                    ...currentState,
                    requests,
                    completedRequests,
                };
            },
            '[Claude]',
            'complete_permission_request',
        );
    }
    
    /**
     * Set callback to trigger when permission request is made
     */
    setOnPermissionRequest(callback: (toolCallId: string) => void) {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode) {
        this.permissionMode = mode;
        this.session.setLastPermissionMode(mode);
    }

    /**
     * Handler response
     */
    private handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingRequest
    ): void {

        const updatedPermissions = response.updatedPermissions;
        this.applyUpdatedPermissionsAllowlist(updatedPermissions);

        // Update allowed tools
        const allowedTools = response.allowedTools ?? response.allowTools;
        applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, allowedTools);

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
            this.session.setLastPermissionMode(response.mode);
        }

        if (response.approved) {
            this.tryAutoApprovePendingRequests();
        }

        if (pending.toolName === 'ExitPlanMode' && response.approved) {
            this.noteExitPlanModeApproved(pending.sourceLocalId);
            this.clearAcpSessionModeOverrideBestEffort();
        }

        // Handle default case for all tools
        if (pending.toolName === 'AskUserQuestion' && response.approved && response.answers) {
            const baseInput =
                pending.input && typeof pending.input === 'object' && !Array.isArray(pending.input)
                    ? (pending.input as Record<string, unknown>)
                    : {};
            logger.debug(
                `[AskUserQuestion] Resolving canCallTool with ${Object.keys(response.answers).length} answer(s) via updatedInput`,
            );
            pending.resolve({
                behavior: 'allow',
                updatedInput: {
                    ...baseInput,
                    answers: response.answers,
                },
            });
            return;
        }

        const result: PermissionResult = response.approved
            ? {
                behavior: 'allow',
                updatedInput: (pending.input as Record<string, unknown>) || {},
                ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            }
            : {
                behavior: 'deny',
                message:
                    response.reason ||
                    `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`,
            };

        pending.resolve(result);
    }

    /**
     * Creates the canCallTool callback for the SDK
     */
    handleToolCall = async (
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: {
            signal: AbortSignal;
            /**
             * Optional tool use id supplied by upstream runtimes (e.g. Agent SDK).
             * When provided, we must use it directly instead of trying to infer it
             * from transcript/tool_use events (which may not have been observed yet).
             */
            toolUseId?: string | null;
            agentId?: string | null;
            suggestions?: unknown;
            blockedPath?: string | null;
            decisionReason?: string | null;
        },
    ): Promise<PermissionResult> => {
        const rewrittenInput = this.rewriteToolInput(toolName, input);

        // Check if tool is explicitly allowed
        if (this.isToolExplicitlyAllowed(toolName, rewrittenInput)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        // Use the per-message mode to avoid races where the handler's instance mode
        // hasn't been updated yet (e.g. metadata update arrives slightly later).
        const agentModeId =
            mode?.agentModeId === 'plan' && this.shouldIgnorePlanModeForCall(mode?.localId ?? null)
                ? null
                : mode?.agentModeId;
        const effectiveMode = resolveClaudeSdkPermissionModeFromEnhancedMode({
            permissionMode: mode?.permissionMode ?? this.permissionMode,
            agentModeId,
        });

        if (effectiveMode === 'plan' && !isInteractiveTool(toolName)) {
            return {
                behavior: 'deny',
                message:
                    'Plan mode is enabled, so tool execution is disabled. Continue by providing a plan, clarifying questions, or ask the user to switch to Build mode before attempting tool use.',
            };
        }

        if (effectiveMode === 'bypassPermissions' && !isInteractiveTool(toolName)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        if (effectiveMode === 'acceptEdits' && descriptor.edit) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        //
        // Approval flow
        //

        const providedToolUseId = typeof options?.toolUseId === 'string' ? options.toolUseId.trim() : '';
        let toolCallId = providedToolUseId.length > 0 ? providedToolUseId : this.resolveToolCallId(toolName, input);
        if (!toolCallId) { // What if we got permission before tool call
            await delay(1000);
            toolCallId = providedToolUseId.length > 0 ? providedToolUseId : this.resolveToolCallId(toolName, input);
            if (!toolCallId) {
                throw new Error(`Could not resolve tool call ID for ${toolName}`);
            }
        }
        return this.handlePermissionRequest(toolCallId, toolName, rewrittenInput, options.signal, {
            suggestions: options.suggestions,
            sourceLocalId: mode?.localId ?? null,
        });
    }

    private rewriteToolInput(toolName: string, input: unknown): unknown {
        if (toolName === 'Task' || toolName === 'task') {
            if (configuration.claudeTaskAllowRunInBackground) return input;
            if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

            const record = input as Record<string, unknown>;
            const requestedBackground =
                record.run_in_background === true || (record as any).runInBackground === true;
            if (!requestedBackground) return input;

            const next: Record<string, unknown> = { ...record, run_in_background: false };
            if ('runInBackground' in next) {
                delete (next as any).runInBackground;
            }
            return next;
        }

        // TaskOutput is a provider tool; models sometimes pass TaskOutput the Task's "taskId" instead of its "agentId".
        // We can deterministically rewrite when we observed the Task tool_result that includes both ids.
        if (toolName !== 'TaskOutput' && toolName !== 'task_output') return input;
        if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

        const record = input as Record<string, unknown>;
        const taskIdRaw = typeof record.task_id === 'string' ? record.task_id.trim() : '';
        if (!taskIdRaw) return input;

        const agentId = this.agentIdByTaskId.get(taskIdRaw) ?? null;
        if (!agentId || agentId === taskIdRaw) return input;

        return { ...record, task_id: agentId };
    }

    private coerceToolResultText(content: unknown): string {
        if (typeof content === 'string') return content;
        if (content == null) return '';

        if (Array.isArray(content)) {
            const chunks: string[] = [];
            for (const item of content) {
                if (!item || typeof item !== 'object') continue;
                if ((item as any).type !== 'text') continue;
                const text = (item as any).text;
                if (typeof text === 'string' && text.trim().length > 0) {
                    chunks.push(text);
                }
            }
            return chunks.join('\n');
        }

        return '';
    }

    /**
     * Handles individual permission requests
     */
    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal,
        opts?: { suggestions?: unknown; sourceLocalId?: string | null }
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            // Set up abort signal handling
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

            // Store the pending request
            this.pendingRequests.set(id, {
                resolve: (result: PermissionResult) => {
                    signal.removeEventListener('abort', abortHandler);
                    resolve(result);
                },
                reject: (error: Error) => {
                    signal.removeEventListener('abort', abortHandler);
                    reject(error);
                },
                toolName,
                input,
                sourceLocalId: typeof opts?.sourceLocalId === 'string' ? opts.sourceLocalId : null,
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }

                // Update agent state
                        updateAgentStateBestEffort(
                            this.session.client,
                            (currentState) => {
                                const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                                const entry = Object.create(null) as AgentStateRequestEntry;
                                entry.tool = toolName;
                                entry.kind = resolveAgentRequestKind(toolName);
                                entry.arguments = input;
                                entry.createdAt = Date.now();
                                const suggestions = opts?.suggestions;
                                if (Array.isArray(suggestions) && suggestions.length > 0) {
                                    entry.permissionSuggestions = suggestions;
                                }
                                requests[id] = entry;
                                return {
                                    ...currentState,
                                    capabilities: {
                                        ...(currentState.capabilities && typeof currentState.capabilities === 'object'
                                            ? currentState.capabilities
                                            : {}),
                                        askUserQuestionAnswersInPermission: true,
                                    },
                                    requests,
                                };
                            },
                            '[Claude]',
                            'publish_permission_request',
                        );

            // Send push notification (best-effort; bounded retries; gated by per-account preferences).
            const notifier = this.getOrCreatePermissionRequestPushNotifier();
            if (notifier) {
                try {
                    const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
                    const existing = snapshot?.requests?.[id] ?? null;
                    const notifiedAt = typeof (existing as any)?.pushNotifiedAt === 'number' ? (existing as any).pushNotifiedAt : null;
                    if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt) && notifiedAt > 0) {
                        notifier.markAlreadyNotified(id);
                    } else {
                        notifier.notify({
                            permissionId: id,
                            toolName: getToolName(toolName),
                            toolInput: input,
                            requestKind: resolveAgentRequestKind(toolName),
                        });
                    }
                } catch {
                    notifier.notify({
                        permissionId: id,
                        toolName: getToolName(toolName),
                        toolInput: input,
                        requestKind: resolveAgentRequestKind(toolName),
                    });
                }
            }

            if (this.isToolTraceEnabled()) {
                recordToolTraceEvent({
                    direction: 'outbound',
                    sessionId: this.session.client.sessionId,
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'permission-request',
                    payload: {
                        type: 'permission-request',
                        permissionId: id,
                        toolName,
                        input: this.redactToolTraceValue(input),
                    },
                });
            }

            logger.debug(`Permission request sent for tool call ${id}: ${toolName}`);
        });
    }
    /**
     * Resolves tool call ID based on tool name and input
     */
    private resolveToolCallId(name: string, args: any): string | null {
        // Search in reverse (most recent first)
        for (let i = this.toolCalls.length - 1; i >= 0; i--) {
            const call = this.toolCalls[i];
            if (call.name === name && isDeepStrictEqual(call.input, args)) {
                if (call.used) {
                    return null;
                }
                // Found unused match - mark as used and return
                call.used = true;
                return call.id;
            }
        }

        return null;
    }

    /**
     * Handles messages to track tool calls
     */
    onMessage(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use') {
                        this.toolCalls.push({
                            id: block.id!,
                            name: block.name!,
                            input: block.input,
                            used: false
                        });
                    }
                }
            }
        }
        if (message.type === 'user') {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && userMsg.message.content && Array.isArray(userMsg.message.content)) {
                for (const block of userMsg.message.content) {
                    if (block.type === 'tool_result' && block.tool_use_id) {
                        const toolCall = this.toolCalls.find(tc => tc.id === block.tool_use_id);
                        if (toolCall && !toolCall.used) {
                            toolCall.used = true;
                        }
                        if (toolCall && (toolCall.name === 'Task' || toolCall.name === 'task')) {
                            const text = this.coerceToolResultText((block as any).content);
                            const ids = extractAgentIdFromTaskResultText(text);
                            if (ids.agentId && ids.taskId) {
                                this.agentIdByTaskId.set(ids.taskId, ids.agentId);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Checks if a tool call is rejected
     */
    isAborted(toolCallId: string): boolean {

        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && isInteractiveTool(toolCall.name)) {
            return false;
        }

        // If tool not approved, it's aborted
        if (this.responses.get(toolCallId)?.approved === false) {
            return true;
        }

        // Tool call is not aborted
        return false;
    }

    /**
     * Resets all state for new sessions
     */
    reset(): void {
        this.toolCalls = [];
        this.responses.clear();
        this.allowedToolIdentifiers.clear();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
        this.permissionMode = 'default';
        this.exitedPlanModeLocalIds.clear();
        this.exitedPlanModeFallbackUntilMs = 0;

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);

                // Move each pending request to completed with canceled status
                for (const [id, request] of Object.entries(pendingRequests)) {
                    const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                    entry['completedAt'] = Date.now();
                    entry['status'] = 'canceled';
                    entry['reason'] = 'Session switched to local mode';
                    completedRequests[id] = entry;
                }

                return {
                    ...currentState,
                    requests: Object.create(null), // Clear all pending requests
                    completedRequests,
                };
            },
            '[Claude]',
            'reset_pending_requests',
        );
    }

    /**
     * Gets the responses map (for compatibility with existing code)
     */
    getResponses(): Map<string, PermissionResponse> {
        return this.responses;
    }
}
