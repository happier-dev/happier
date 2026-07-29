import {
    isAgentStateRequestCoveredByCompletedRequests,
    resolveAgentStateRequestCoverageOptions,
} from '@happier-dev/agents';
import { compareToolCalls } from '../../../utils/tools/toolComparison';
import type { AgentState } from '../../domains/state/storageTypes';
import type { ToolCall } from '../../domains/messages/messageTypes';
import { isRequestInterruptedPlaceholder } from '../../domains/session/pending/requestInterruptedPlaceholder';
import { equalOptionalStringArrays } from '../helpers/arrays';
import type { ReducerState } from '../reducer';
import { drainAndApplyOrphanToolResultsToMessage } from '../helpers/drainAndApplyOrphanToolResultsToMessage';
import { setThinkingMergeCursor } from '../helpers/mergeCursors';
import {
    buildReducerStoredPermissionFromCompletedRequest,
    buildToolPermissionFromStored,
    getCompletedAllowedTools,
} from '../helpers/toolCallProjection';

const PENDING_REQUEST_COVERAGE_OPTIONS = resolveAgentStateRequestCoverageOptions({
    kind: 'localPermissionBridge',
});

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function buildCompletedRequestPlaceholderResult(completed: unknown): unknown {
    const completedRecord = asRecord(completed);
    const answerRecord = asRecord(completedRecord?.answers);
    if (!answerRecord) return 'Approved';

    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(answerRecord)) {
        if (typeof answer === 'string') {
            answers[question] = answer;
        }
    }
    return Object.keys(answers).length > 0 ? { answers } : 'Approved';
}

function mergePermissionRequestArgumentsPreservingExecpolicy(
    existing: unknown,
    incoming: unknown,
): unknown {
    const existingObj = asRecord(existing);
    const incomingObj = asRecord(incoming);
    if (!existingObj || !incomingObj) return incoming;

    // Preserve late-arriving fields that may be delivered outside AgentState.requests arguments,
    // and would otherwise get dropped when we refresh arguments from AgentState.
    const merged: Record<string, unknown> = { ...incomingObj };

    const execPolicyKeys: Array<'proposed_execpolicy_amendment' | 'proposedExecpolicyAmendment'> = [
        'proposed_execpolicy_amendment',
        'proposedExecpolicyAmendment',
    ];
    for (const key of execPolicyKeys) {
        if (!(key in incomingObj) && key in existingObj) {
            merged[key] = existingObj[key];
        }
    }

    return merged;
}

function shouldRestorePendingPermissionFromAgentState(message: Readonly<{ tool?: ToolCall | null }>): boolean {
    const permission = message.tool?.permission;
    if (!permission || permission.status === 'pending') return false;

    // Older reducer builds synthesized "Request interrupted" cancellations during reconnect/abort
    // flows. Those cached placeholders may be safely reopened if AgentState still advertises the
    // request as pending. Real terminal provider outcomes should not be resurrected by stale requests.
    return isRequestInterruptedPlaceholder({
        permission,
        result: message.tool?.result as { error?: unknown } | null | undefined,
    });
}

export function runAgentStatePermissionsPhase(params: Readonly<{
    state: ReducerState;
    agentState?: AgentState | null;
    incomingToolIds: Set<string>;
    changed: Set<string>;
    allocateId: () => string;
    enableLogging: boolean;
}>): void {
    const { state, agentState, incomingToolIds, changed, allocateId, enableLogging } = params;

    //
    // Phase 0: Process AgentState permissions
    //

    if (enableLogging) {
        console.log(`[REDUCER] Phase 0: Processing AgentState`);
    }
    if (agentState) {
        // Track permission ids where a newer pending request should override an older completed entry.
        const pendingOverridesCompleted = new Set<string>();

        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // If this permission is also in completedRequests, use the shared coverage rule to decide
                // whether that terminal/equivalent completion really covers this exact pending request.
                // Some agents can re-prompt with the same permission id (same toolCallId) even after
                // a previous approval was recorded; in that case we must surface the new pending request.
                const existingCompleted = agentState.completedRequests?.[permId];
                if (existingCompleted) {
                    const isCoveredByCompletedRequest = isAgentStateRequestCoveredByCompletedRequests({
                        requestId: permId,
                        request,
                        completedRequests: agentState.completedRequests as Record<string, unknown>,
                        options: PENDING_REQUEST_COVERAGE_OPTIONS,
                    });
                    if (isCoveredByCompletedRequest) {
                        continue;
                    }
                    pendingOverridesCompleted.add(permId);
                }

                // Check if we already have a message for this permission ID
                const existingMessageId = state.toolIdToMessageId.get(permId);
                if (existingMessageId != null) {
                    // Update existing tool message with permission info and latest arguments
                    const message = state.messages.get(existingMessageId);
                    if (message?.tool) {
                        if (enableLogging) {
                            console.log(`[REDUCER] Updating existing tool ${permId} with permission`);
                        }
                        let hasChanged = false;
                        if (message.tool.id !== permId) {
                            message.tool.id = permId;
                            hasChanged = true;
                        }

                        // Update input only when it actually changed (keeps reducer idempotent).
                        // This still allows late-arriving fields (e.g. proposedExecpolicyAmendment)
                        // to update the existing permission message.
                        const inputUnchanged = compareToolCalls(
                            { name: request.tool, arguments: message.tool.input },
                            { name: request.tool, arguments: request.arguments }
                        );
                        if (!inputUnchanged) {
                            const merged = mergePermissionRequestArgumentsPreservingExecpolicy(
                                message.tool.input,
                                request.arguments,
                            );
                            const mergedUnchanged = compareToolCalls(
                                { name: request.tool, arguments: message.tool.input },
                                { name: request.tool, arguments: merged },
                            );
                            if (!mergedUnchanged) {
                                message.tool.input = merged;
                                hasChanged = true;
                            }
                        }
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: 'pending',
                                kind: typeof request.kind === 'string' ? request.kind : undefined,
                                suggestions: request.permissionSuggestions,
                            };
                            hasChanged = true;
                        }
                        if (message.tool.permission && shouldRestorePendingPermissionFromAgentState(message)) {
                            // AgentState.requests is the authoritative source of truth for pending user input.
                            // If a tool was previously marked canceled/denied due to a transient UI disconnect
                            // (e.g. web reload), restore it back to pending so the user can answer.
                            message.tool.permission.status = 'pending';
                            delete (message.tool.permission as any).reason;
                            delete (message.tool.permission as any).decision;
                            delete (message.tool.permission as any).mode;
                            delete (message.tool.permission as any).allowedTools;
                            delete (message.tool.permission as any).date;

                            // Reset tool execution state so the renderer can re-surface the interactive UI.
                            if (message.tool.state !== 'running') {
                                message.tool.state = 'running';
                            }
                            if (message.tool.completedAt !== null) {
                                message.tool.completedAt = null;
                            }
                            if (message.tool.result !== undefined) {
                                message.tool.result = undefined;
                            }
                            hasChanged = true;
                        }
                        if (message.tool.permission && typeof request.kind === 'string' && message.tool.permission.kind !== request.kind) {
                            message.tool.permission.kind = request.kind;
                            hasChanged = true;
                        }
                        if (message.tool.permission && request.permissionSuggestions !== undefined && message.tool.permission.suggestions !== request.permissionSuggestions) {
                            message.tool.permission.suggestions = request.permissionSuggestions;
                            hasChanged = true;
                        }
                        if (hasChanged) {
                            changed.add(existingMessageId);
                        }
                    }
                } else {
                    if (enableLogging) {
                        console.log(`[REDUCER] Creating new message for permission ${permId}`);
                    }

                    // Create a new tool message for the permission request
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        id: permId,
                        name: request.tool,
                        state: 'running' as const,
                        input: request.arguments,
                        createdAt: request.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: null,
                        description: null,
                        result: undefined,
                        permission: {
                            id: permId,
                            status: 'pending',
                            kind: typeof request.kind === 'string' ? request.kind : undefined,
                            suggestions: request.permissionSuggestions,
                        }
                    };

		                    state.messages.set(mid, {
		                        id: mid,
		                        realID: null,
		                        seq: null,
		                        localId: null,
		                        role: 'agent',
		                        createdAt: request.createdAt || Date.now(),
		                        text: null,
		                        tool: toolCall,
		                        event: null,
	                    });
	                    setThinkingMergeCursor(state, null, 'agentstate-permission-create');

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                    drainAndApplyOrphanToolResultsToMessage({
                        state,
                        toolUseId: permId,
                        messageId: mid,
                        changed,
                    });
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: 'pending',
                    kind: typeof request.kind === 'string' ? request.kind : undefined,
                    suggestions: request.permissionSuggestions,
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                // If we have a newer pending request for this id, do not let the older completed entry win.
                if (pendingOverridesCompleted.has(permId)) {
                    continue;
                }
                const storedPermission = buildReducerStoredPermissionFromCompletedRequest(completed);
                const completedAllowedTools = getCompletedAllowedTools(completed);
                // Check if we have a message for this permission ID
                const messageId = state.toolIdToMessageId.get(permId);
                if (messageId != null) {
                    const message = state.messages.get(messageId);
                    if (message?.tool) {
                        // Skip if tool has already started actual execution with approval
                        if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
                            continue;
                        }

                        // Skip if permission already has date (came from tool result - preferred over agentState)
                        if (message.tool.permission?.date) {
                            continue;
                        }

                        // Check if we need to update ANY field
                        const needsUpdate =
                            message.tool.permission?.status !== completed.status ||
                            (typeof completed.kind === 'string' && message.tool.permission?.kind !== completed.kind) ||
                            message.tool.permission?.reason !== completed.reason ||
                            message.tool.permission?.mode !== completed.mode ||
                            !equalOptionalStringArrays(message.tool.permission?.allowedTools, completedAllowedTools) ||
                            message.tool.permission?.decision !== completed.decision;

                        if (!needsUpdate) {
                            continue;
                        }

                        let hasChanged = false;

                        // Update permission status
                        if (!message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: completed.status,
                                kind: typeof completed.kind === 'string' ? completed.kind : undefined,
                                mode: completed.mode || undefined,
                                allowedTools: completedAllowedTools,
                                decision: completed.decision || undefined,
                                reason: completed.reason || undefined
                            };
                            hasChanged = true;
                        } else {
                            // Update all fields
                            message.tool.permission.status = completed.status;
                            if (typeof completed.kind === 'string') {
                                message.tool.permission.kind = completed.kind;
                            }
                            message.tool.permission.mode = completed.mode || undefined;
                            message.tool.permission.allowedTools = completedAllowedTools;
                            message.tool.permission.decision = completed.decision || undefined;
                            if (completed.reason) {
                                message.tool.permission.reason = completed.reason;
                            }
                            hasChanged = true;
                        }

                        // Update tool state based on permission status
                        if (completed.status === 'approved') {
                            const isTerminalState = message.tool.state === 'completed' || message.tool.state === 'error';
                            if (isTerminalState) {
                                // Keep terminal tool states intact when late AgentState permission updates arrive.
                            }
                            // Permission can be approved before the tool-call event arrives.
                            // Keep that placeholder as completed until execution actually starts,
                            // otherwise the UI can show an endless running timer after aborts.
                            else if (!message.tool.startedAt) {
                                const completedAt = completed.completedAt || Date.now();
                                if (message.tool.state !== 'completed') {
                                    message.tool.state = 'completed';
                                    hasChanged = true;
                                }
                                if (message.tool.completedAt !== completedAt) {
                                    message.tool.completedAt = completedAt;
                                    hasChanged = true;
                                }
                                if (!message.tool.result) {
                                    message.tool.result = buildCompletedRequestPlaceholderResult(completed);
                                    hasChanged = true;
                                }
                            } else if (message.tool.state !== 'running') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                if (message.tool.result === 'Approved') {
                                    message.tool.result = undefined;
                                }
                                hasChanged = true;
                            }
                        } else {
                            // denied or canceled
                            if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
                                message.tool.state = 'error';
                                message.tool.completedAt = completed.completedAt || Date.now();
                                if (!message.tool.result && completed.reason) {
                                    message.tool.result = { error: completed.reason };
                                }
                                hasChanged = true;
                            }
                        }

                        // Update stored permission
                        state.permissions.set(permId, storedPermission);

                        if (hasChanged) {
                            changed.add(messageId);
                        }
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        if (enableLogging) {
                            console.log(`[REDUCER] Storing permission ${permId} for incoming tool`);
                        }
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, storedPermission);
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        id: permId,
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? buildCompletedRequestPlaceholderResult(completed)
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: buildToolPermissionFromStored(permId, storedPermission),
                    };

		                    state.messages.set(mid, {
		                        id: mid,
		                        realID: null,
		                        seq: null,
		                        localId: null,
		                        role: 'agent',
		                        createdAt: completed.createdAt || Date.now(),
		                        text: null,
		                        tool: toolCall,
		                        event: null,
	                    });
	                    setThinkingMergeCursor(state, null, 'agentstate-permission-create');

                    state.toolIdToMessageId.set(permId, mid);

                    // Store permission details
                    state.permissions.set(permId, storedPermission);

                    changed.add(mid);
                    drainAndApplyOrphanToolResultsToMessage({
                        state,
                        toolUseId: permId,
                        messageId: mid,
                        changed,
                    });
                }
            }
        }
    }
}
