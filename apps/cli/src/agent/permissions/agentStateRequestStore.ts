import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort, type AgentStateWriteOptions } from '@/api/session/sessionWritesBestEffort';
import { resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import {
    applyAgentStateRequestPushNotifiedAt,
    clonePlainObjectToNullProto,
    cloneStringKeyedRecordToNullProto,
} from '@/api/session/agentStateRecords';
import {
    getSessionNotificationAgentDisplayName,
    getSessionNotificationTitle,
} from '@/agent/runtime/readyNotificationContext';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import type { AccountSettings } from '@happier-dev/protocol';
import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
    isAgentStateRequestCoveredByCompletedRequests,
} from '@happier-dev/agents';
import { normalizeAskUserQuestionInputForPublication } from '@/agent/questions/normalizeAskUserQuestionInput';
import { logger } from '@/ui/logger';
import { deepEqual } from '@/utils/deterministicJson';
import { randomUUID } from 'node:crypto';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];
type AgentStateCompletedEntry = NonNullable<AgentState['completedRequests']>[string];

const PENDING_REQUEST_COVERAGE_OPTIONS = {
    equivalentSources: [CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE],
    equivalentCompletedStatuses: ['canceled'],
    equivalentCompletedReasons: [CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON],
} as const;

const PERMISSION_RESPONSE_CLAIM_V1 = 'permissionResponseClaimV1';

function hasOwnProperty(value: unknown, key: string): value is Record<string, unknown> {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, key);
}

export function hasPermissionResponseClaimV1(value: unknown): value is Record<typeof PERMISSION_RESPONSE_CLAIM_V1, unknown> {
    return hasOwnProperty(value, PERMISSION_RESPONSE_CLAIM_V1);
}

export function isSameAgentStateRequestOccurrence(left: unknown, right: unknown): boolean {
    if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
    const request = left as Record<string, unknown>;
    const expected = right as Record<string, unknown>;
    return request.createdAt === expected.createdAt && request.tool === expected.tool
        && deepEqual(request.arguments, expected.arguments)
        && (expected.source === undefined || request.source === expected.source);
}

export type AgentStateOutstandingRequest = Readonly<{
    requestId: string;
    occurrenceId?: string;
    toolName: string;
    toolInput: unknown;
    createdAt: number;
    kind?: string;
    source?: string;
    permissionSuggestions?: unknown;
}>;

type SessionLike = Readonly<{
    sessionId: string;
    updateAgentState: (updater: (state: AgentState) => AgentState, options?: AgentStateWriteOptions) => Promise<void> | void;
    updateAgentStateRequestSettlement: (updater: (state: AgentState) => AgentState) => Promise<void>;
    getAgentStateSnapshot?: () => AgentState | null | undefined;
    getMetadataSnapshot?: () => unknown;
    subscribeToSessionConnectionState?: (listener: (state: ManagedConnectionState) => void) => () => void;
}>;

type PendingRequestPublication = Readonly<{
    request: AgentStateRequestEntry;
    retry: () => void;
    cancel: () => void;
}>;

export class AgentStateRequestStore {
    private session: SessionLike;
    private readonly logPrefix: string;
    private readonly pushSender: PermissionRequestPushSender | null;
    private readonly getAccountSettings: () => AccountSettings | null;
    private readonly getAccountSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private readonly pendingPublications = new Map<string, PendingRequestPublication>();
    private unsubscribePublicationReconnect: (() => void) | null = null;

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
        this.cancelPendingPublications();
        this.session = session;
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    hasOutstandingRequest(requestId: string): boolean {
        return this.readOutstandingRequest(requestId) !== null;
    }

    isOutstandingRequestClaimed(requestId: string): boolean {
        const entry = this.session.getAgentStateSnapshot?.()?.requests?.[requestId];
        return hasPermissionResponseClaimV1(entry);
    }

    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null {
        const entry = this.session.getAgentStateSnapshot?.()?.requests?.[requestId];
        if (!entry) return null;

        const extendedEntry = entry as AgentStateRequestEntry & {
            source?: unknown;
            permissionSuggestions?: unknown;
        };

        return {
            requestId,
            ...(typeof extendedEntry.occurrenceId === 'string' ? { occurrenceId: extendedEntry.occurrenceId } : {}),
            toolName: entry.tool,
            toolInput: entry.arguments,
            createdAt: entry.createdAt,
            ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
            ...(typeof extendedEntry.source === 'string' ? { source: extendedEntry.source } : {}),
            ...(typeof extendedEntry.permissionSuggestions !== 'undefined'
                ? { permissionSuggestions: extendedEntry.permissionSuggestions }
                : {}),
        };
    }

    publishRequest(params: Readonly<{
        requestId: string;
        occurrenceId?: string;
        onOccurrenceAssigned?: (occurrenceId: string) => void;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
        kind?: string;
        source?: string;
        permissionSuggestions?: unknown[] | null;
        replaceCompletedRequest?: boolean;
        /** Persist the request but suppress push rendering when its input contains private context. */
        notifyPush?: boolean;
        updateState?: (state: AgentState) => AgentState;
    }>): void {
        const normalizedToolInput = normalizeAskUserQuestionInputForPublication(params.toolName, params.toolInput);
        const wasClaimedBeforePublication = this.isOutstandingRequestClaimed(params.requestId);
        const publicationSession = this.session;
        const entryTemplate = Object.create(null) as AgentStateRequestEntry & { source?: string; permissionSuggestions?: unknown[] };
        entryTemplate.tool = params.toolName;
        entryTemplate.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
        entryTemplate.arguments = normalizedToolInput;
        entryTemplate.createdAt = params.createdAt;
        if (typeof params.source === 'string') entryTemplate.source = params.source;
        const pendingRequest = this.pendingPublications.get(params.requestId)?.request;
        const candidateOccurrenceId = params.occurrenceId
            ?? (isSameAgentStateRequestOccurrence(pendingRequest, entryTemplate) ? pendingRequest?.occurrenceId : undefined)
            ?? randomUUID();
        entryTemplate.occurrenceId = candidateOccurrenceId;
        if (Array.isArray(params.permissionSuggestions) && params.permissionSuggestions.length > 0) {
            entryTemplate.permissionSuggestions = params.permissionSuggestions;
        }
        const replacedCompletion = publicationSession.getAgentStateSnapshot?.()?.completedRequests?.[params.requestId];
        const publication = this.publishRequestWithReconnectRetry(
            params.requestId,
            entryTemplate,
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
                const existingRequest = currentState.requests?.[params.requestId];
                if (params.replaceCompletedRequest && deepEqual(completedRequests[params.requestId], replacedCompletion)) {
                    delete completedRequests[params.requestId];
                }
                const entry = Object.assign(Object.create(null), entryTemplate) as typeof entryTemplate;
                entry.occurrenceId = isSameAgentStateRequestOccurrence(existingRequest, entry)
                    && typeof existingRequest?.occurrenceId === 'string'
                    ? existingRequest.occurrenceId
                    : candidateOccurrenceId;
                if (hasPermissionResponseClaimV1(existingRequest)) {
                    (entry as Record<string, unknown>)[PERMISSION_RESPONSE_CLAIM_V1] = existingRequest[PERMISSION_RESPONSE_CLAIM_V1];
                }
                if (isAgentStateRequestCoveredByCompletedRequests({
                    requestId: params.requestId,
                    request: entry,
                    completedRequests,
                    options: PENDING_REQUEST_COVERAGE_OPTIONS,
                })) {
                    return typeof params.updateState === 'function' ? params.updateState(currentState) : currentState;
                }
                requests[params.requestId] = entry;
                params.onOccurrenceAssigned?.(entry.occurrenceId);

                const nextState: AgentState = {
                    ...currentState,
                    requests,
                    completedRequests,
                };
                return typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
            },
        );

        if (params.notifyPush !== false && !wasClaimedBeforePublication) {
            void publication.then((published) => {
                if (!published) return;
                if (this.session !== publicationSession) return;
                const current = publicationSession.getAgentStateSnapshot?.()?.requests?.[params.requestId];
                if (hasPermissionResponseClaimV1(current)) return;
                if (!isSameAgentStateRequestOccurrence(current, {
                    tool: params.toolName, arguments: normalizedToolInput,
                    createdAt: params.createdAt, source: params.source,
                })) return;
                this.notifyPermissionRequestPushBestEffort({
                    permissionId: params.requestId,
                    toolName: params.toolName,
                    toolInput: normalizedToolInput,
                    createdAtMs: params.createdAt,
                });
            }).catch(() => {
                logger.infoFile(`${this.logPrefix} Request notification publication unavailable`);
            });
        }
    }

    private publishRequestWithReconnectRetry(
        requestId: string,
        request: AgentStateRequestEntry,
        updater: (state: AgentState) => AgentState,
    ): Promise<boolean> {
        this.pendingPublications.get(requestId)?.cancel();
        const session = this.session;
        let resolve!: (published: boolean) => void;
        const result = new Promise<boolean>((settle) => { resolve = settle; });
        let inFlight = false;
        let retryRequested = false;
        const retire = (published: boolean) => {
            if (this.pendingPublications.get(requestId) === publication) {
                this.pendingPublications.delete(requestId);
                if (this.pendingPublications.size === 0) {
                    this.unsubscribePublicationReconnect?.();
                    this.unsubscribePublicationReconnect = null;
                }
            }
            resolve(published);
        };
        const attempt = () => {
            if (this.pendingPublications.get(requestId) !== publication) return;
            if (inFlight) {
                // A reconnect can precede the failed ACK's rejection. Replay after it settles.
                retryRequested = true;
                return;
            }
            inFlight = true;
            let write: Promise<void>;
            try {
                write = Promise.resolve(session.updateAgentState((state) => (
                    this.pendingPublications.get(requestId) === publication ? updater(state) : state
                )));
            } catch (error) {
                write = Promise.reject(error);
            }
            void write.then(() => retire(true), (error: unknown) => {
                logger.infoFile(`${this.logPrefix} Request publication deferred until reconnect`, {
                    sessionId: session.sessionId,
                    operation: 'publish_request',
                    error: serializeAxiosErrorForLog(error),
                });
            }).finally(() => {
                inFlight = false;
                if (retryRequested) {
                    retryRequested = false;
                    attempt();
                }
            });
        };
        const publication: PendingRequestPublication = { request, retry: attempt, cancel: () => retire(false) };
        this.pendingPublications.set(requestId, publication);
        this.unsubscribePublicationReconnect ??= session.subscribeToSessionConnectionState?.((state) => {
            if (state.phase !== 'online') return;
            for (const pending of this.pendingPublications.values()) pending.retry();
        }) ?? null;
        attempt();
        return result;
    }

    private cancelPendingPublications(): void {
        for (const pending of this.pendingPublications.values()) pending.cancel();
    }

    async completeRequest(params: Readonly<{
        requestId: string;
        status: string;
        decision?: string;
        reason?: string;
        mode?: string;
        allowedTools?: readonly string[] | undefined;
        updatedPermissions?: unknown;
        extraCompletedFields?: Readonly<Record<string, unknown>> | null;
        fallback?: Readonly<{ occurrenceId?: string; toolName: string; toolInput: unknown; createdAt: number; kind?: string; source?: string }> | null;
        requireAck?: boolean;
        expectedOccurrenceId?: string;
        /** An actual provider effect was observed, such as Claude PostToolUse. */
        observedCompletion?: true;
    }>): Promise<void> {
        const publication = this.pendingPublications.get(params.requestId);
        const requireAck = params.requireAck === true
            || (params.status !== 'canceled' && params.observedCompletion !== true);
        let completedRequest = false;
        let expectedCompletion: AgentStateCompletedEntry | null = null;
        const completedAt = Date.now();
        const update = (currentState: AgentState): AgentState => {
            completedRequest = false;
            const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
            const existing = requests[params.requestId] as unknown;
            if (params.expectedOccurrenceId !== undefined) {
                if (existing) {
                    if (typeof existing !== 'object' || !('occurrenceId' in existing)
                        || existing.occurrenceId !== params.expectedOccurrenceId) return currentState;
                } else if (!expectedCompletion
                    || expectedCompletion.occurrenceId !== params.expectedOccurrenceId
                    || !deepEqual(currentState.completedRequests?.[params.requestId], expectedCompletion)) return currentState;
            }
            if (!existing && !params.fallback) {
                return currentState;
            }
            if (hasPermissionResponseClaimV1(existing)) {
                return currentState;
            }
            if (existing && params.fallback && !isSameAgentStateRequestOccurrence(existing, {
                tool: params.fallback.toolName, arguments: params.fallback.toolInput,
                createdAt: params.fallback.createdAt, source: params.fallback.source,
            })) return currentState;
            const previousCompletion = currentState.completedRequests?.[params.requestId];
            if (requireAck && !existing && previousCompletion) {
                // An ACK may have been lost after our exact write committed. A different
                // terminal outcome belongs to its writer and cannot be replaced by fallback.
                completedRequest = expectedCompletion !== null && deepEqual(previousCompletion, expectedCompletion);
                return currentState;
            }
            delete requests[params.requestId];

            const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
            const completedEntry = clonePlainObjectToNullProto(existing) ?? Object.create(null);

            if (!existing && params.fallback) {
                if (typeof params.fallback.occurrenceId === 'string') completedEntry.occurrenceId = params.fallback.occurrenceId;
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

            completedEntry.completedAt = completedAt;
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

            expectedCompletion = completedEntry as AgentStateCompletedEntry;
            completedRequests[params.requestId] = expectedCompletion;
            for (const [id, request] of Object.entries(requests)) {
                if (id === params.requestId) continue;
                if (!isAgentStateRequestCoveredByCompletedRequests({
                    requestId: id,
                    request,
                    completedRequests: {
                        [params.requestId]: completedEntry,
                    },
                    options: PENDING_REQUEST_COVERAGE_OPTIONS,
                })) continue;

                delete requests[id];
                const equivalentCompleted = clonePlainObjectToNullProto(request) ?? Object.create(null);
                equivalentCompleted.completedAt = completedEntry.completedAt;
                equivalentCompleted.status = completedEntry.status;
                if (typeof completedEntry.reason === 'string') equivalentCompleted.reason = completedEntry.reason;
                if (typeof completedEntry.decision === 'string') equivalentCompleted.decision = completedEntry.decision;
                completedRequests[id] = equivalentCompleted as AgentStateCompletedEntry;
                this.markPermissionRequestCompletedBestEffort(id);
            }

            const nextState: AgentState = {
                ...currentState,
                requests,
                completedRequests,
            };
            completedRequest = true;
            return nextState;
        };
        if (requireAck) await this.session.updateAgentState(update);
        else await this.settleRequests(update);
        if (!completedRequest) {
            throw new Error(`Permission request ${params.requestId} did not match an outstanding request settlement`);
        }
        if (requireAck) {
            const committed = this.session.getAgentStateSnapshot?.();
            if (!expectedCompletion || committed?.requests?.[params.requestId] !== undefined
                || !deepEqual(committed?.completedRequests?.[params.requestId], expectedCompletion)) {
                throw new Error(`Permission request ${params.requestId} was superseded before acknowledgement`);
            }
        }
        publication?.cancel();
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
    }>): Promise<void> {
        let recordedCompletion = false;
        return Promise.resolve(this.session.updateAgentState(
            (currentState) => {
                // Automatic history has no outstanding request authority. Existing requests settle
                // through completeRequest's exact occurrence and claim checks instead.
                if (currentState.requests?.[params.requestId] !== undefined) {
                    return currentState;
                }
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
                recordedCompletion = true;
                return { ...currentState, completedRequests } satisfies AgentState;
            },
            { retainPermissionCompletionsOnFailure: true },
        )).then(() => {
            if (recordedCompletion) {
                this.markPermissionRequestCompletedBestEffort(params.requestId);
            }
        }).catch(() => {
            logger.infoFile(`${this.logPrefix} Failed to publish automatic decision history`);
        });
    }

    cancelAllRequests(params: Readonly<{
        reason: string; decision?: string; requestIds?: readonly string[];
        shouldCancel?: (request: AgentStateRequestEntry) => boolean;
    }>): Promise<void> {
        const selected = new Map(Object.entries(this.session.getAgentStateSnapshot?.()?.requests ?? {})
            .filter(([id, request]) => (!params.requestIds || params.requestIds.includes(id))
                && (!params.shouldCancel || params.shouldCancel(request))));
        for (const [id, pending] of this.pendingPublications) {
            if (params.requestIds && !params.requestIds.includes(id)) continue;
            if (params.shouldCancel && !params.shouldCancel(pending.request)) continue;
            if (!selected.has(id)) selected.set(id, pending.request);
            pending.cancel();
        }
        return this.settleRequests(
            (currentState) => {
                const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const now = Date.now();

                for (const [id, request] of Object.entries(pendingRequests)) {
                    const expected = selected.get(id);
                    if (!expected || !isSameAgentStateRequestOccurrence(request, expected)) continue;
                    if (hasPermissionResponseClaimV1(request)) continue;
                    const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                    entry.completedAt = now;
                    entry.status = 'canceled';
                    entry.reason = params.reason;
                    if (typeof params.decision === 'string' && params.decision.length > 0) {
                        entry.decision = params.decision;
                    }
                    completedRequests[id] = entry as AgentStateCompletedEntry;
                    delete pendingRequests[id];
                    this.markPermissionRequestCompletedBestEffort(id);
                }

                return {
                    ...currentState,
                    requests: pendingRequests,
                    completedRequests,
                };
            },
        );
    }

    private settleRequests(updater: (state: AgentState) => AgentState): Promise<void> {
        try {
            const result = this.session.updateAgentStateRequestSettlement(updater);
            return Promise.resolve(result).catch((error) => {
                logger.infoFile(`${this.logPrefix} Request settlement failed; provider completion was not admitted`);
                throw error;
            });
        } catch (error) {
            logger.infoFile(`${this.logPrefix} Request settlement failed; provider completion was not admitted`);
            return Promise.reject(error);
        }
    }

    dispose(): void {
        this.cancelPendingPublications();
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

        let occurrenceId: string | undefined;
        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const existing = snapshot?.requests?.[params.permissionId];
            occurrenceId = existing?.occurrenceId;
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
            occurrenceId,
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
            getSessionTitle: () => getSessionNotificationTitle(this.session.getMetadataSnapshot?.bind(this.session)) ?? this.session.sessionId,
            getAgentDisplayName: () => getSessionNotificationAgentDisplayName(this.session.getMetadataSnapshot?.bind(this.session)),
            sessionId: this.session.sessionId,
            logPrefix: this.logPrefix,
            onNotifiedAt: (permissionId, notifiedAtMs, occurrenceId) => {
                updateAgentStateBestEffort(
                    this.session,
                    (currentState) => {
                        if (occurrenceId !== undefined && currentState.requests?.[permissionId]?.occurrenceId !== occurrenceId) return currentState;
                        return applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId, notifiedAtMs });
                    },
                    this.logPrefix,
                    'permission_request_push_notified_at',
                );
            },
        });

        return this.permissionRequestPushNotifier;
    }
}
