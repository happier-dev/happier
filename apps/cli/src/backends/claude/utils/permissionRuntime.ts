import { logger } from '@/lib';
import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { shouldSuppressProviderPermissionForHappierApproval } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import { delay } from '@/utils/time';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2';

import type { PermissionResult } from '../sdk/types';
import type { Session } from '../runtime/session/ClaudeSession';
import type { EnhancedMode, PermissionMode } from '../runtime/claudeEnhancedMode';

import { getToolDescriptor } from './getToolDescriptor';
import { getToolName } from './getToolName';
import {
    clearClaudePendingRequestsBestEffort,
    completeClaudePermissionRequestBestEffort,
    hasOutstandingClaudeAgentStateRequest,
    publishClaudePermissionRequestBestEffort,
} from './permissionAgentState';
import { isInteractiveTool, type PendingRequest, type PermissionResponse } from './permissionCore';
import { isClaudeToolTraceEnabled, redactClaudePermissionTraceValue } from './permissionTrace';
import { rewriteClaudePermissionToolInput } from './permissionToolInput';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from './permissionMode';
import { ClaudePermissionToolCallLedger } from './permissionToolCallLedger';
import { ClaudePermissionApprovalState } from './permissionApprovalState';

export class ClaudePermissionRuntime {
    private pendingRequests = new Map<string, PendingRequest>();
    private onPermissionRequestCallback?: (toolCallId: string) => void;
    private readonly approvalState: ClaudePermissionApprovalState;

    constructor(
        private readonly session: Session,
        private readonly toolCallLedger: ClaudePermissionToolCallLedger,
    ) {
        this.approvalState = new ClaudePermissionApprovalState(this.session, (mode) => this.handleModeChange(mode));
    }

    approveToolCall(toolCallId: string, opts?: { answers?: Record<string, string> }): void {
        this.applyPermissionResponse({ id: toolCallId, approved: true, answers: opts?.answers });
    }

    setOnPermissionRequest(callback: (toolCallId: string) => void): void {
        this.onPermissionRequestCallback = callback;
    }

    handleModeChange(mode: PermissionMode): void {
        this.approvalState.handleModeChange(mode, this.pendingRequests, (response) => this.applyPermissionResponse(response));
    }

    async handleToolCall(
        toolName: string,
        input: unknown,
        mode: EnhancedMode,
        options: {
            signal: AbortSignal;
            toolUseId?: string | null;
            agentId?: string | null;
            suggestions?: unknown;
            blockedPath?: string | null;
            decisionReason?: string | null;
        },
    ): Promise<PermissionResult> {
        const rewrittenInput = rewriteClaudePermissionToolInput({
            toolName,
            input,
            agentIdByTaskId: this.toolCallLedger.getAgentIdByTaskId(),
        });

        if (this.approvalState.isToolExplicitlyAllowed(toolName, rewrittenInput)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        if (isChangeTitleToolLikeName(toolName)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        if (shouldSuppressProviderPermissionForHappierApproval({
            toolName,
            input: rewrittenInput,
            accountSettings: this.session.accountSettings ?? null,
            surface: 'session_agent',
        }).suppress) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        const descriptor = getToolDescriptor(toolName);
        const agentModeId =
            mode?.agentModeId === 'plan' && this.approvalState.shouldIgnorePlanModeForCall(mode?.localId ?? null)
                ? null
                : mode?.agentModeId;
        const effectiveMode = resolveClaudeSdkPermissionModeFromEnhancedMode({
            permissionMode: mode?.permissionMode ?? this.approvalState.getPermissionMode(),
            agentModeId,
        });

        if (effectiveMode === 'bypassPermissions' && !isInteractiveTool(toolName)) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        if ((effectiveMode === 'acceptEdits' || effectiveMode === 'auto') && descriptor.edit) {
            return { behavior: 'allow', updatedInput: rewrittenInput as Record<string, unknown> };
        }

        const providedToolUseId = typeof options?.toolUseId === 'string' ? options.toolUseId.trim() : '';
        let toolCallId = providedToolUseId.length > 0 ? providedToolUseId : this.toolCallLedger.resolveToolCallId(toolName, input);
        if (!toolCallId) {
            await delay(1000);
            toolCallId = providedToolUseId.length > 0 ? providedToolUseId : this.toolCallLedger.resolveToolCallId(toolName, input);
            if (!toolCallId) {
                throw new Error(`Could not resolve tool call ID for ${toolName}`);
            }
        }

        return this.handlePermissionRequest(toolCallId, toolName, rewrittenInput, options.signal, {
            suggestions: options.suggestions,
            sourceLocalId: mode?.localId ?? null,
        });
    }

    tryHandlePermissionRpc(message: PermissionResponse): boolean {
        const id = typeof message?.id === 'string' ? message.id : '';
        if (!id) {
            return false;
        }
        if (this.pendingRequests.has(id)) {
            this.applyPermissionResponse(message);
            return true;
        }

        if (!this.hasOutstandingAgentStateRequest(id)) {
            return false;
        }

        this.applyLatePermissionResponse(message);
        return true;
    }

    reset(): void {
        this.approvalState.reset();

        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session reset'));
        }
        this.pendingRequests.clear();

        this.clearPendingRequestsToCompleted('Session switched to local mode', 'reset_pending_requests');
    }

    dispose(): void {
        this.approvalState.dispose();
        for (const [, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error('Session disposed'));
        }
        this.pendingRequests.clear();
        this.clearPendingRequestsToCompleted('Session disposed', 'dispose_pending_requests');
    }

    private isToolTraceEnabled(): boolean {
        return isClaudeToolTraceEnabled(process.env);
    }

    private redactToolTraceValue(value: unknown, key?: string): unknown {
        return redactClaudePermissionTraceValue(value, key);
    }

    private hasOutstandingAgentStateRequest(id: string): boolean {
        try {
            return hasOutstandingClaudeAgentStateRequest(this.session.client, id);
        } catch {
            return false;
        }
    }

    private applyLatePermissionResponse(message: PermissionResponse): void {
        const id = message.id;
        this.approvalState.markPermissionCompleted(id);
        this.toolCallLedger.notePermissionResponse(message);
        const snapshot = (this.session.client as any).getAgentStateSnapshot?.() ?? null;
        const request = snapshot?.requests?.[id] ?? null;
        const toolName = request && typeof request.tool === 'string' ? request.tool : null;

        this.approvalState.applyPermissionResponseSideEffects({
            response: message,
            toolName,
            sourceLocalId: null,
            pendingRequests: this.pendingRequests,
            applyPermissionResponse: (response) => this.applyPermissionResponse(response),
        });

        completeClaudePermissionRequestBestEffort({
            sessionClient: this.session.client,
            id,
            response: message,
            answers: message.answers,
            logReason: 'complete_permission_request_late',
        });
    }

    private applyPermissionResponse(message: PermissionResponse): void {
        const id = message.id;
        this.approvalState.markPermissionCompleted(id);
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

        this.toolCallLedger.notePermissionResponse(message);
        this.pendingRequests.delete(id);
        this.handlePermissionResponse(message, pending);

        completeClaudePermissionRequestBestEffort({
            sessionClient: this.session.client,
            id,
            response: message,
            logReason: 'complete_permission_request',
        });
    }

    private tryAutoApprovePendingRequestsForPermissionMode(mode: PermissionMode): void {
        this.approvalState.handleModeChange(mode, this.pendingRequests, (response) => this.applyPermissionResponse(response));
    }

    private handlePermissionResponse(response: PermissionResponse, pending: PendingRequest): void {
        this.approvalState.applyPermissionResponseSideEffects({
            response,
            toolName: pending.toolName,
            sourceLocalId: pending.sourceLocalId,
            pendingRequests: this.pendingRequests,
            applyPermissionResponse: (nextResponse) => this.applyPermissionResponse(nextResponse),
        });

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
                ...(typeof response.updatedPermissions !== 'undefined' ? { updatedPermissions: response.updatedPermissions } : {}),
            }
            : {
                behavior: 'deny',
                message:
                    response.reason ||
                    `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`,
            };

        pending.resolve(result);
    }

    private async handlePermissionRequest(
        id: string,
        toolName: string,
        input: unknown,
        signal: AbortSignal,
        opts?: { suggestions?: unknown; sourceLocalId?: string | null },
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            const abortHandler = () => {
                this.pendingRequests.delete(id);
                reject(new Error('Permission request aborted'));
            };
            signal.addEventListener('abort', abortHandler, { once: true });

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

            this.onPermissionRequestCallback?.(id);

            publishClaudePermissionRequestBestEffort({
                sessionClient: this.session.client,
                id,
                toolName,
                input,
                suggestions: opts?.suggestions,
            });

            const notifier = this.approvalState.getOrCreatePermissionRequestPushNotifier();
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

    private clearPendingRequestsToCompleted(reason: string, logReason: string): void {
        clearClaudePendingRequestsBestEffort({
            sessionClient: this.session.client,
            reason,
            logReason,
        });
    }
}
