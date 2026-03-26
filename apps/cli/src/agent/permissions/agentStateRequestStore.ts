import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import {
    applyAgentStateRequestPushNotifiedAt,
    clonePlainObjectToNullProto,
    cloneStringKeyedRecordToNullProto,
} from '@/api/session/agentStateRecords';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import type { AccountSettings } from '@happier-dev/protocol';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];
type AgentStateCompletedEntry = NonNullable<AgentState['completedRequests']>[string];

type SessionLike = Readonly<{
    sessionId: string;
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    getAgentStateSnapshot?: () => AgentState | null | undefined;
}>;

export class AgentStateRequestStore {
    private session: SessionLike;
    private readonly logPrefix: string;
    private readonly pushSender: PermissionRequestPushSender | null;
    private readonly getAccountSettings: () => AccountSettings | null;
    private readonly getAccountSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;

    constructor(params: Readonly<{
        session: SessionLike;
        logPrefix: string;
        pushSender?: PermissionRequestPushSender | null;
        getAccountSettings?: (() => AccountSettings | null) | null;
        getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
    }>) {
        this.session = params.session;
        this.logPrefix = params.logPrefix;
        this.pushSender = params.pushSender ?? null;
        this.getAccountSettings = typeof params.getAccountSettings === 'function' ? params.getAccountSettings : (() => null);
        this.getAccountSettingsSecretsReadKeys =
            typeof params.getAccountSettingsSecretsReadKeys === 'function' ? params.getAccountSettingsSecretsReadKeys : (() => []);
    }

    updateSession(session: SessionLike): void {
        this.session = session;
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    publishRequest(params: Readonly<{
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        kind?: string;
        source?: string;
        permissionSuggestions?: unknown[] | null;
        updateState?: (state: AgentState) => AgentState;
    }>): void {
        updateAgentStateBestEffort(
            this.session,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                const entry = Object.create(null) as AgentStateRequestEntry & { source?: string; permissionSuggestions?: unknown[] };
                entry.tool = params.toolName;
                entry.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
                entry.arguments = params.toolInput;
                entry.createdAt = params.createdAt;
                if (typeof params.source === 'string') {
                    entry.source = params.source;
                }
                if (Array.isArray(params.permissionSuggestions) && params.permissionSuggestions.length > 0) {
                    entry.permissionSuggestions = params.permissionSuggestions;
                }
                requests[params.requestId] = entry;

                const nextState: AgentState = {
                    ...currentState,
                    requests,
                };
                return typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
            },
            this.logPrefix,
            'publish_request',
        );

        this.notifyPermissionRequestPushBestEffort({
            permissionId: params.requestId,
            toolName: params.toolName,
            toolInput: params.toolInput,
            createdAtMs: params.createdAt,
        });
    }

    completeRequest(params: Readonly<{
        requestId: string;
        status: string;
        decision?: string;
        reason?: string;
        mode?: string;
        allowedTools?: readonly string[] | undefined;
        updatedPermissions?: unknown;
        extraCompletedFields?: Readonly<Record<string, unknown>> | null;
        fallback?: Readonly<{ toolName: string; toolInput: unknown; createdAt: number; kind?: string; source?: string }> | null;
        updateState?: (state: AgentState) => AgentState;
    }>): void {
        updateAgentStateBestEffort(
            this.session,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const existing = requests[params.requestId] as unknown;
                if (!existing && !params.fallback) {
                    return currentState;
                }
                delete requests[params.requestId];

                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const completedEntry = clonePlainObjectToNullProto(existing) ?? Object.create(null);

                if (!existing && params.fallback) {
                    completedEntry.tool = params.fallback.toolName;
                    completedEntry.arguments = params.fallback.toolInput;
                    completedEntry.createdAt = params.fallback.createdAt;
                    if (typeof params.fallback.kind === 'string') completedEntry.kind = params.fallback.kind;
                    if (typeof params.fallback.source === 'string') completedEntry.source = params.fallback.source;
                }

                if (typeof completedEntry.kind !== 'string') {
                    const toolName =
                        typeof completedEntry.tool === 'string'
                            ? completedEntry.tool
                            : params.fallback?.toolName;
                    if (toolName) {
                        completedEntry.kind = resolveAgentRequestKind(toolName);
                    }
                }

                completedEntry.completedAt = Date.now();
                completedEntry.status = params.status;
                if (typeof params.decision === 'string') completedEntry.decision = params.decision;
                if (typeof params.reason === 'string' && params.reason.length > 0) completedEntry.reason = params.reason;
                if (typeof params.mode === 'string') completedEntry.mode = params.mode;
                if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
                    completedEntry.allowedTools = [...params.allowedTools];
                }
                if (typeof params.updatedPermissions !== 'undefined') {
                    completedEntry.updatedPermissions = params.updatedPermissions;
                }
                if (params.extraCompletedFields && typeof params.extraCompletedFields === 'object' && !Array.isArray(params.extraCompletedFields)) {
                    const extra = clonePlainObjectToNullProto(params.extraCompletedFields) ?? Object.create(null);
                    for (const [key, value] of Object.entries(extra)) {
                        if (!key) continue;
                        completedEntry[key] = value;
                    }
                }

                completedRequests[params.requestId] = completedEntry as AgentStateCompletedEntry;

                const nextState: AgentState = {
                    ...currentState,
                    requests,
                    completedRequests,
                };
                return typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
            },
            this.logPrefix,
            'complete_request',
        );

        this.markPermissionRequestCompletedBestEffort(params.requestId);
    }

    recordCompletedRequest(params: Readonly<{
        requestId: string;
        toolName: string;
        toolInput: unknown;
        status: string;
        decision?: string;
        allowedTools?: readonly string[] | undefined;
        updatedPermissions?: unknown;
        extraCompletedFields?: Readonly<Record<string, unknown>> | null;
        createdAt?: number | null;
        kind?: string;
        source?: string;
        reason?: string;
    }>): void {
        updateAgentStateBestEffort(
            this.session,
            (currentState) => {
                const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
                const entry = Object.create(null) as AgentStateCompletedEntry & { source?: string; reason?: string };
                entry.tool = params.toolName;
                entry.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
                entry.arguments = params.toolInput;
                entry.createdAt = typeof params.createdAt === 'number' ? params.createdAt : Date.now();
                entry.completedAt = Date.now();
                entry.status = params.status as AgentStateCompletedEntry['status'];
                if (typeof params.decision === 'string') entry.decision = params.decision as AgentStateCompletedEntry['decision'];
                if (typeof params.source === 'string') entry.source = params.source;
                if (typeof params.reason === 'string' && params.reason.length > 0) entry.reason = params.reason;
                if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
                    entry.allowedTools = [...params.allowedTools];
                }
                if (typeof params.updatedPermissions !== 'undefined') {
                    entry.updatedPermissions = params.updatedPermissions;
                }
                if (params.extraCompletedFields && typeof params.extraCompletedFields === 'object' && !Array.isArray(params.extraCompletedFields)) {
                    const extra = clonePlainObjectToNullProto(params.extraCompletedFields) ?? Object.create(null);
                    const mutableEntry = entry as Record<string, unknown>;
                    for (const [key, value] of Object.entries(extra)) {
                        if (!key) continue;
                        mutableEntry[key] = value;
                    }
                }
                completedRequests[params.requestId] = entry;
                return { ...currentState, completedRequests } satisfies AgentState;
            },
            this.logPrefix,
            'record_completed_request',
        );

        this.markPermissionRequestCompletedBestEffort(params.requestId);
    }

    cancelAllRequests(params: Readonly<{ reason: string }>): void {
        updateAgentStateBestEffort(
            this.session,
            (currentState) => {
                const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const now = Date.now();

                for (const [id, request] of Object.entries(pendingRequests)) {
                    const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                    entry.completedAt = now;
                    entry.status = 'canceled';
                    entry.reason = params.reason;
                    completedRequests[id] = entry as AgentStateCompletedEntry;
                    this.markPermissionRequestCompletedBestEffort(id);
                }

                return {
                    ...currentState,
                    requests: Object.create(null),
                    completedRequests,
                };
            },
            this.logPrefix,
            'cancel_all_requests',
        );
    }

    dispose(): void {
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    notifyPermissionRequestPushBestEffort(params: Readonly<{
        permissionId: string;
        toolName: string;
        toolInput: unknown;
        createdAtMs?: number;
    }>): void {
        const notifier = this.getOrCreatePermissionRequestPushNotifier();
        if (!notifier) return;

        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const existing = snapshot?.requests?.[params.permissionId];
            const notifiedAt = typeof existing?.pushNotifiedAt === 'number' ? existing.pushNotifiedAt : null;
            if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt) && notifiedAt > 0) {
                notifier.markAlreadyNotified(params.permissionId);
                return;
            }
        } catch {
            // ignore
        }

        notifier.notify({
            permissionId: params.permissionId,
            toolName: params.toolName,
            toolInput: params.toolInput,
            requestKind: resolveAgentRequestKind(params.toolName),
            ...(typeof params.createdAtMs === 'number' ? { createdAtMs: params.createdAtMs } : {}),
        });
    }

    markPermissionRequestCompletedBestEffort(permissionId: string): void {
        try {
            this.permissionRequestPushNotifier?.markCompleted(permissionId);
        } catch {
            // ignore
        }
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        if (!this.pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;

        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender: this.pushSender,
            getSettings: () => this.getAccountSettings(),
            getSettingsSecretsReadKeys: () => this.getAccountSettingsSecretsReadKeys(),
            sessionId: this.session.sessionId,
            logPrefix: this.logPrefix,
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                updateAgentStateBestEffort(
                    this.session,
                    (currentState) => applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs }),
                    this.logPrefix,
                    'permission_request_push_notified_at',
                );
            },
        });

        return this.permissionRequestPushNotifier;
    }
}
