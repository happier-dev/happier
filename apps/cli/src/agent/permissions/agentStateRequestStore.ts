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
import { logger } from '@/ui/logger';
import type { AccountSettings } from '@happier-dev/protocol';
import {
    getSessionNotificationAgentDisplayName,
    getSessionNotificationTitle,
} from '@/agent/runtime/notifications/sessionNotificationContext';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];
type AgentStateCompletedEntry = NonNullable<AgentState['completedRequests']>[string];

export type AgentStateRequestResponseTarget = Readonly<{ kind: string } & Record<string, unknown>>;

export type AgentStateResponseTargetDispatch = Readonly<{
    requestId: string;
    responseTarget: AgentStateRequestResponseTarget;
    completedRequest: Readonly<Record<string, unknown>>;
}>;

export type AgentStateResponseTargetHandler = (dispatch: AgentStateResponseTargetDispatch) => void | PromiseLike<void>;
export type AgentStateRequestStoreUnsubscribe = () => void;

export type AgentStateOutstandingRequest = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
}>;

type SessionLike = Readonly<{
    sessionId: string;
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    getAgentStateSnapshot?: () => AgentState | null | undefined;
    getMetadataSnapshot?: () => unknown;
}>;

export class AgentStateRequestStore {
    private session: SessionLike;
    private readonly logPrefix: string;
    private readonly getPushSender: () => PermissionRequestPushSender | null;
    private readonly getAccountSettings: () => AccountSettings | null;
    private readonly getAccountSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
    private readonly getSessionTitle: () => string | null;
    private readonly getAgentDisplayName: () => string | null;
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private readonly responseTargetHandlers = new Map<string, AgentStateResponseTargetHandler>();

    constructor(params: Readonly<{
        session: SessionLike;
        logPrefix: string;
        pushSender?: PermissionRequestPushSender | null;
        getPushSender?: (() => PermissionRequestPushSender | null) | null;
        getAccountSettings?: (() => AccountSettings | null) | null;
        getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
        getSessionTitle?: (() => string | null) | null;
        getAgentDisplayName?: (() => string | null) | null;
    }>) {
        this.session = params.session;
        this.logPrefix = params.logPrefix;
        this.getPushSender =
            typeof params.getPushSender === 'function'
                ? params.getPushSender
                : (() => params.pushSender ?? null);
        this.getAccountSettings = typeof params.getAccountSettings === 'function' ? params.getAccountSettings : (() => null);
        this.getAccountSettingsSecretsReadKeys =
            typeof params.getAccountSettingsSecretsReadKeys === 'function' ? params.getAccountSettingsSecretsReadKeys : (() => []);
        this.getSessionTitle = typeof params.getSessionTitle === 'function'
            ? params.getSessionTitle
            : (() => getSessionNotificationTitle(() => this.session.getMetadataSnapshot?.() ?? null));
        this.getAgentDisplayName = typeof params.getAgentDisplayName === 'function'
            ? params.getAgentDisplayName
            : (() => getSessionNotificationAgentDisplayName(() => this.session.getMetadataSnapshot?.() ?? null));
    }

    updateSession(session: SessionLike): void {
        this.session = session;
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    hasOutstandingRequest(requestId: string): boolean {
        return this.readOutstandingRequest(requestId) !== null;
    }

    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null {
        const entry = this.session.getAgentStateSnapshot?.()?.requests?.[requestId];
        if (!entry) return null;

        const metadata = readAgentStateRequestMetadata(entry);

        return {
            requestId,
            toolName: entry.tool,
            toolInput: entry.arguments,
            createdAt: entry.createdAt,
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...metadata,
        };
    }

    registerResponseTargetHandler(
        kind: string,
        handler: AgentStateResponseTargetHandler,
    ): AgentStateRequestStoreUnsubscribe {
        const normalizedKind = kind.trim();
        if (!normalizedKind) {
            throw new Error('Response target handler kind must be a non-empty string');
        }
        if (this.responseTargetHandlers.has(normalizedKind)) {
            throw new Error(`Response target handler already registered for kind ${normalizedKind}`);
        }

        this.responseTargetHandlers.set(normalizedKind, handler);
        return () => {
            if (this.responseTargetHandlers.get(normalizedKind) === handler) {
                this.responseTargetHandlers.delete(normalizedKind);
            }
        };
    }

    publishRequest(params: Readonly<{
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        kind?: string;
        source?: string;
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        updateState?: (state: AgentState) => AgentState;
    }>): void {
        updateAgentStateBestEffort(
            this.session,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                const entry = Object.create(null) as AgentStateRequestEntry & { source?: string; permissionSuggestions?: readonly unknown[] };
                entry.tool = params.toolName;
                entry.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
                entry.arguments = params.toolInput;
                entry.createdAt = params.createdAt;
                if (typeof params.source === 'string') {
                    entry.source = params.source;
                }
                if (Array.isArray(params.permissionSuggestions) && params.permissionSuggestions.length > 0) {
                    entry.permissionSuggestions = [...params.permissionSuggestions];
                }
                applyAgentStateRequestMetadata(entry, params);
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
        fallback?: Readonly<{
            toolName: string;
            toolInput: unknown;
            createdAt: number;
            kind?: string;
            source?: string;
            responseTarget?: AgentStateRequestResponseTarget | null;
            subagentRef?: unknown;
            sidechainId?: string | null;
            permissionSuggestions?: readonly unknown[] | null;
        }> | null;
        updateState?: (state: AgentState) => AgentState;
    }>): void {
        this.updateAgentStateWithResponseDispatchBestEffort(
            'complete_request',
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const existing = requests[params.requestId] as unknown;
                if (!existing && !params.fallback) {
                    return { state: currentState };
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
                    applyAgentStateRequestMetadata(completedEntry, params.fallback);
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
                const finalState = typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
                const finalCompletedEntry = finalState.completedRequests?.[params.requestId] as unknown;

                return {
                    state: finalState,
                    responseDispatch: createResponseTargetDispatchFromUnknown(params.requestId, finalCompletedEntry),
                };
            },
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
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        reason?: string;
    }>): void {
        this.updateAgentStateWithResponseDispatchBestEffort(
            'record_completed_request',
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
                applyAgentStateRequestMetadata(entry, params);
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
                return {
                    state: { ...currentState, completedRequests } satisfies AgentState,
                    responseDispatch: createResponseTargetDispatch(params.requestId, entry),
                };
            },
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
        this.responseTargetHandlers.clear();
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

    private updateAgentStateWithResponseDispatchBestEffort(
        reason: string,
        updater: (state: AgentState) => AgentStateUpdateWithResponseDispatch,
    ): void {
        let responseDispatch: AgentStateResponseTargetDispatch | null = null;
        let didRunUpdater = false;

        try {
            const result = this.session.updateAgentState((currentState) => {
                const next = updater(currentState);
                responseDispatch = next.responseDispatch ?? null;
                didRunUpdater = true;
                return next.state;
            });

            if (isPromiseLike(result)) {
                void Promise.resolve(result)
                    .then(() => {
                        if (didRunUpdater) {
                            this.dispatchResponseTargetBestEffort(responseDispatch);
                        }
                    })
                    .catch((error) => {
                        logger.debug(`${this.logPrefix} Failed to update agent state (${reason}) (non-fatal)`, error);
                    });
                return;
            }

            if (didRunUpdater) {
                this.dispatchResponseTargetBestEffort(responseDispatch);
            }
        } catch (error) {
            logger.debug(`${this.logPrefix} Failed to update agent state (${reason}) (non-fatal)`, error);
        }
    }

    private dispatchResponseTargetBestEffort(dispatch: AgentStateResponseTargetDispatch | null): void {
        if (!dispatch) return;

        const handler = this.responseTargetHandlers.get(dispatch.responseTarget.kind);
        if (!handler) {
            logger.debug(
                `${this.logPrefix} No response target handler registered for kind ${dispatch.responseTarget.kind} (non-fatal)`,
            );
            return;
        }

        try {
            const result = handler(dispatch);
            if (isPromiseLike(result)) {
                void Promise.resolve(result).catch((error) => {
                    logger.debug(
                        `${this.logPrefix} Response target handler failed for kind ${dispatch.responseTarget.kind} (non-fatal)`,
                        error,
                    );
                });
            }
        } catch (error) {
            logger.debug(
                `${this.logPrefix} Response target handler failed for kind ${dispatch.responseTarget.kind} (non-fatal)`,
                error,
            );
        }
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        const pushSender = this.getPushSender();
        if (!pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;

        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender,
            getSettings: () => this.getAccountSettings(),
            getSettingsSecretsReadKeys: () => this.getAccountSettingsSecretsReadKeys(),
            getSessionTitle: () => this.getSessionTitle(),
            getAgentDisplayName: () => this.getAgentDisplayName(),
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

type AgentStateRequestMetadata = Readonly<{
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
}>;

type AgentStateUpdateWithResponseDispatch = Readonly<{
    state: AgentState;
    responseDispatch?: AgentStateResponseTargetDispatch | null;
}>;

function readAgentStateRequestMetadata(entry: unknown): AgentStateRequestMetadata {
    const record = clonePlainObjectToNullProto(entry);
    if (!record) return {};

    const responseTarget = readResponseTarget(record.responseTarget);
    const permissionSuggestions = Array.isArray(record.permissionSuggestions)
        ? [...record.permissionSuggestions]
        : undefined;
    return {
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
        ...(responseTarget ? { responseTarget } : {}),
        ...(typeof record.subagentRef !== 'undefined' ? { subagentRef: record.subagentRef } : {}),
        ...(typeof record.sidechainId === 'string' ? { sidechainId: record.sidechainId } : {}),
        ...(permissionSuggestions ? { permissionSuggestions } : {}),
    };
}

function applyAgentStateRequestMetadata(
    entry: Record<string, unknown>,
    metadata: Readonly<{
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
    }>,
): void {
    const responseTarget = readResponseTarget(metadata.responseTarget);
    if (responseTarget) {
        entry.responseTarget = responseTarget;
    }
    if (typeof metadata.subagentRef !== 'undefined') {
        entry.subagentRef = metadata.subagentRef;
    }
    if (typeof metadata.sidechainId === 'string') {
        entry.sidechainId = metadata.sidechainId;
    }
    if (Array.isArray(metadata.permissionSuggestions) && metadata.permissionSuggestions.length > 0) {
        entry.permissionSuggestions = [...metadata.permissionSuggestions];
    }
}

function readResponseTarget(value: unknown): AgentStateRequestResponseTarget | null {
    const record = clonePlainObjectToNullProto(value);
    if (!record) return null;

    const kind = record.kind;
    if (typeof kind !== 'string' || kind.trim().length === 0) return null;
    record.kind = kind.trim();
    return record as AgentStateRequestResponseTarget;
}

function createResponseTargetDispatch(
    requestId: string,
    completedRequest: Record<string, unknown>,
): AgentStateResponseTargetDispatch | null {
    const responseTarget = readResponseTarget(completedRequest.responseTarget);
    if (!responseTarget) return null;

    return {
        requestId,
        responseTarget,
        completedRequest: clonePlainObjectToNullProto(completedRequest) ?? Object.create(null),
    };
}

function createResponseTargetDispatchFromUnknown(
    requestId: string,
    completedRequest: unknown,
): AgentStateResponseTargetDispatch | null {
    const record = clonePlainObjectToNullProto(completedRequest);
    if (!record) return null;
    return createResponseTargetDispatch(requestId, record);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}
