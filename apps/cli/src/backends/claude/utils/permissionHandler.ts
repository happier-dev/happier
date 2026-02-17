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
import { isShellCommandAllowed } from '@/agent/permissions/shellCommandAllowlist';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { extractAgentIdFromTaskResultText } from '@/backends/claude/remote/sidechains/extractAgentIdFromTaskResult';
import type { PermissionRpcPayload } from './permissionRpc';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { sendPermissionRequestPushNotificationForActiveAccount } from '@/settings/notifications/permissionRequestPush';
import { configuration } from '@/configuration';

type PermissionResponse = PermissionRpcPayload;


interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
}

export class PermissionHandler {
    private toolCalls: { id: string, name: string, input: any, used: boolean }[] = [];
    private responses = new Map<string, PermissionResponse>();
    private pendingRequests = new Map<string, PendingRequest>();
    private session: Session;
    private allowedTools = new Set<string>();
    private allowedBashLiterals = new Set<string>();
    private allowedBashPrefixes = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    private agentIdByTaskId = new Map<string, string>();

    constructor(session: Session) {
        this.session = session;
        this.session.getOrCreatePermissionRpcRouter().registerConsumer({
            name: 'claude-remote-permission-handler',
            tryHandlePermissionRpc: (payload) => this.tryHandlePermissionRpc(payload),
        });
        this.advertiseCapabilities();
        this.seedAllowlistFromAgentState();
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

            const isApprovedEntry = (value: unknown): value is { status: 'approved'; allowedTools?: unknown; allowTools?: unknown } => {
                if (!value || typeof value !== 'object') return false;
                return (value as any).status === 'approved';
            };

            for (const entry of Object.values(completed as Record<string, unknown>)) {
                if (!isApprovedEntry(entry)) continue;

                const list = entry.allowedTools ?? entry.allowTools;
                if (!Array.isArray(list)) continue;
                for (const tool of list) {
                    if (typeof tool !== 'string' || tool.length === 0) continue;
                    if (tool.startsWith('Bash(') || tool === 'Bash') {
                        this.parseBashPermission(tool);
                    } else {
                        this.allowedTools.add(tool);
                    }
                }
            }
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
        this.responses.set(id, { ...message, receivedAt: Date.now() });

        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                const nextRequests = { ...currentState.requests };
                delete nextRequests[id];
                return {
                    ...currentState,
                    requests: nextRequests,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: message.approved ? 'approved' : 'denied',
                            reason: message.reason,
                            mode: message.mode,
                            ...(Array.isArray(message.allowedTools ?? message.allowTools)
                                ? { allowedTools: (message.allowedTools ?? message.allowTools)! }
                                : null),
                            ...(message.answers && typeof message.answers === 'object' ? { answers: message.answers } : null),
                        },
                    },
                };
            },
            '[Claude]',
            'complete_permission_request_late',
        );
    }

    private applyPermissionResponse(message: PermissionResponse): void {
        const id = message.id;
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
                const request = currentState.requests?.[id];
                if (!request) return currentState;
                let r = { ...currentState.requests };
                delete r[id];
                return {
                    ...currentState,
                    requests: r,
                    completedRequests: {
                        ...currentState.completedRequests,
                        [id]: {
                            ...request,
                            completedAt: Date.now(),
                            status: message.approved ? 'approved' : 'denied',
                            reason: message.reason,
                            mode: message.mode,
                            ...(Array.isArray(message.allowedTools ?? message.allowTools)
                                ? { allowedTools: (message.allowedTools ?? message.allowTools)! }
                                : null),
                        }
                    }
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

        // Update allowed tools
        const allowedTools = response.allowedTools ?? response.allowTools;
        if (allowedTools && allowedTools.length > 0) {
            allowedTools.forEach(tool => {
                if (tool.startsWith('Bash(') || tool === 'Bash') {
                    this.parseBashPermission(tool);
                } else {
                    this.allowedTools.add(tool);
                }
            });
        }

        // Update permission mode
        if (response.mode) {
            this.permissionMode = response.mode;
            this.session.setLastPermissionMode(response.mode);
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
            ? { behavior: 'allow', updatedInput: (pending.input as Record<string, unknown>) || {} }
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
        if (toolName === 'Bash') {
            const inputObj = input as { command?: string };
            if (inputObj?.command) {
                const patterns: Array<{ kind: 'exact'; value: string } | { kind: 'prefix'; value: string }> = [];
                for (const literal of this.allowedBashLiterals) patterns.push({ kind: 'exact', value: literal });
                for (const prefix of this.allowedBashPrefixes) patterns.push({ kind: 'prefix', value: prefix });

                if (patterns.length > 0 && isShellCommandAllowed(inputObj.command, patterns)) {
                    return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
                }
            }
        } else if (this.allowedTools.has(toolName)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        // Calculate descriptor
        const descriptor = getToolDescriptor(toolName);

        //
        // Handle special cases
        //

        // Use the per-message mode to avoid races where the handler's instance mode
        // hasn't been updated yet (e.g. metadata update arrives slightly later).
        const effectiveMode: PermissionMode = mode?.permissionMode ?? this.permissionMode;

        if (effectiveMode === 'bypassPermissions') {
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
        return this.handlePermissionRequest(toolCallId, toolName, rewrittenInput, options.signal);
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
        signal: AbortSignal
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
                input
            });

            // Trigger callback to send delayed messages immediately
            if (this.onPermissionRequestCallback) {
                this.onPermissionRequestCallback(id);
            }
            
            // Send push notification (best-effort; gated by per-account preferences).
            if (this.session.pushSender) {
                try {
                    sendPermissionRequestPushNotificationForActiveAccount({
                        pushSender: this.session.pushSender,
                        sessionId: this.session.client.sessionId,
                        permissionId: id,
                        toolName: getToolName(toolName),
                    });
                } catch {
                    // ignore
                }
            }

            // Update agent state
            updateAgentStateBestEffort(
                this.session.client,
                (currentState) => ({
                    ...currentState,
                    capabilities: {
                        ...(currentState.capabilities && typeof currentState.capabilities === 'object'
                            ? currentState.capabilities
                            : {}),
                        askUserQuestionAnswersInPermission: true,
                    },
                    requests: {
                        ...currentState.requests,
                        [id]: {
                            tool: toolName,
                            arguments: input,
                            createdAt: Date.now()
                        }
                    }
                }),
                '[Claude]',
                'publish_permission_request',
            );

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
     * Parses Bash permission strings into literal and prefix sets
     */
    private parseBashPermission(permission: string): void {
        // Ignore plain "Bash"
        if (permission === 'Bash') {
            return;
        }

        // Match Bash(command) or Bash(command:*)
        const bashPattern = /^Bash\((.+?)\)$/;
        const match = permission.match(bashPattern);
        
        if (!match) {
            return;
        }

        const command = match[1];
        
        // Check if it's a prefix pattern (ends with :*)
        if (command.endsWith(':*')) {
            const prefix = command.slice(0, -2); // Remove :*
            this.allowedBashPrefixes.add(prefix);
        } else {
            // Literal match
            this.allowedBashLiterals.add(command);
        }
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

        // ExitPlanMode is used to negotiate a plan; even if the user rejects it (or requests changes),
        // Claude should be allowed to continue the current turn to revise the plan.
        const toolCall = this.toolCalls.find(tc => tc.id === toolCallId);
        if (toolCall && (toolCall.name === 'exit_plan_mode' || toolCall.name === 'ExitPlanMode')) {
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
        this.allowedTools.clear();
        this.allowedBashLiterals.clear();
        this.allowedBashPrefixes.clear();
        this.permissionMode = 'default';

        // Cancel all pending requests
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        // Move all pending requests to completedRequests with canceled status
        updateAgentStateBestEffort(
            this.session.client,
            (currentState) => {
                const pendingRequests = currentState.requests || {};
                const completedRequests = { ...currentState.completedRequests };

                // Move each pending request to completed with canceled status
                for (const [id, request] of Object.entries(pendingRequests)) {
                    completedRequests[id] = {
                        ...request,
                        completedAt: Date.now(),
                        status: 'canceled',
                        reason: 'Session switched to local mode'
                    };
                }

                return {
                    ...currentState,
                    requests: {}, // Clear all pending requests
                    completedRequests
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
