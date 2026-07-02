import type { AgentState, Metadata } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { writeSessionStateFieldWithMetadataPortBestEffort } from '@/agent/runtime/state/writeSessionStateFieldWithMetadataPort';
import {
    applyAgentStateRequestPushNotifiedAt,
    clonePlainObjectToNullProto,
    cloneStringKeyedRecordToNullProto,
} from '@/api/session/agentStateRecords';
import {
    isClaudeLocalPermissionBridgeAgentStateRequest,
} from '@happier-dev/plugins-claude/agent';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import { seedAllowlistFromCompletedRequests } from '@/agent/permissions/applyPermissionAllowlistUpdates';

import type { PermissionRpcPayload } from './permissionRpc';
import type { Session } from '../runtime/session/ClaudeSession';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];

type ClaudeSessionClient = Session['client'];

export function seedClaudePermissionAllowlistFromAgentState(
    sessionClient: ClaudeSessionClient,
    allowedToolIdentifiers: Set<string>,
): void {
    const snapshot = (sessionClient as any).getAgentStateSnapshot?.() ?? null;
    const completed = snapshot?.completedRequests;
    if (!completed) return;
    seedAllowlistFromCompletedRequests(allowedToolIdentifiers, completed);
}

export function advertiseClaudePermissionCapabilities(sessionClient: ClaudeSessionClient): void {
    updateAgentStateBestEffort(
        sessionClient,
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

export function hasOutstandingClaudeAgentStateRequest(sessionClient: ClaudeSessionClient, id: string): boolean {
    const snapshot = (sessionClient as any).getAgentStateSnapshot?.() ?? null;
    const requests = snapshot?.requests;
    if (!requests || typeof requests !== 'object') return false;
    const request = (requests as Record<string, unknown>)[id];
    if (!request) return false;
    return !isClaudeLocalPermissionBridgeAgentStateRequest(request);
}

export function publishClaudePermissionRequestBestEffort(params: Readonly<{
    sessionClient: ClaudeSessionClient;
    id: string;
    toolName: string;
    input: unknown;
    suggestions?: unknown;
}>): void {
    updateAgentStateBestEffort(
        params.sessionClient,
        (currentState) => {
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
            const entry = Object.create(null) as AgentStateRequestEntry;
            entry.tool = params.toolName;
            entry.kind = resolveAgentRequestKind(params.toolName);
            entry.arguments = params.input;
            entry.createdAt = Date.now();
            if (Array.isArray(params.suggestions) && params.suggestions.length > 0) {
                entry.permissionSuggestions = params.suggestions;
            }
            requests[params.id] = entry;
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
}

export function completeClaudePermissionRequestBestEffort(params: Readonly<{
    sessionClient: ClaudeSessionClient;
    id: string;
    response: PermissionRpcPayload;
    logReason: string;
    answers?: Record<string, string>;
}>): void {
    updateAgentStateBestEffort(
        params.sessionClient,
        (currentState) => {
            const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
            const request = requests[params.id] as unknown;
            if (!request) return currentState;
            delete requests[params.id];
            const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
            const completedEntry = clonePlainObjectToNullProto(request) ?? Object.create(null);
            completedEntry['completedAt'] = Date.now();
            completedEntry['status'] = params.response.approved ? 'approved' : 'denied';
            completedEntry['reason'] = params.response.reason;
            completedEntry['mode'] = params.response.mode;
            const allowed = params.response.allowedTools ?? params.response.allowTools;
            if (Array.isArray(allowed)) completedEntry['allowedTools'] = allowed;
            if (params.answers && typeof params.answers === 'object') completedEntry['answers'] = params.answers;
            if (typeof params.response.updatedPermissions !== 'undefined') {
                completedEntry['updatedPermissions'] = params.response.updatedPermissions;
            }
            completedRequests[params.id] = completedEntry;
            return {
                ...currentState,
                requests,
                completedRequests,
            };
        },
        '[Claude]',
        params.logReason,
    );
}

export function clearClaudePendingRequestsBestEffort(params: Readonly<{
    sessionClient: ClaudeSessionClient;
    reason: string;
    logReason: string;
}>): void {
    updateAgentStateBestEffort(
        params.sessionClient,
        (currentState) => {
            const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
            const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);

            for (const [id, request] of Object.entries(pendingRequests)) {
                const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                entry['completedAt'] = Date.now();
                entry['status'] = 'canceled';
                entry['reason'] = params.reason;
                completedRequests[id] = entry;
            }

            return {
                ...currentState,
                requests: Object.create(null),
                completedRequests,
            };
        },
        '[Claude]',
        params.logReason,
    );
}

export function clearClaudeSessionModeOverrideBestEffort(sessionClient: ClaudeSessionClient): void {
    const updatedAt = Date.now();
    writeSessionStateFieldWithMetadataPortBestEffort({
        sessionId: sessionClient.sessionId,
        fieldId: 'intent.acpSessionMode',
        value: {
            v: 1,
            modeId: null,
            updatedAt,
        },
        updateMetadata: (updater) =>
            sessionClient.updateMetadata((metadata) =>
                updater(cloneStringKeyedRecordToNullProto(metadata) as Metadata),
            ),
        reason: 'reconciliation',
        metadataReason: 'exit_plan_mode_clear_session_mode_override',
    });
}

export function applyClaudePermissionRequestPushNotifiedAt(
    sessionClient: ClaudeSessionClient,
    permissionId: string,
    notifiedAtMs: number,
): void {
    updateAgentStateBestEffort(
        sessionClient,
        (currentState) =>
            applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs }),
        '[Claude]',
        'permission_request_push_notified_at',
    );
}
