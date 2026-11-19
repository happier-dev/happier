import { resolveCatalogAgentRequestCoverageOptions } from '@/agent/catalog/registry';
import { NativePermissionChoiceAnswerV1Schema, NativePermissionChoicesV1Schema, type NativePermissionChoiceAnswerV1, type NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { readRunScopedExecutionPermissionRequestIdentity } from '@happier-dev/protocol/execution/runs/runPrimitives';
import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { HAPPIER_ACTION_REQUEST_SOURCE, isAgentStructuredQuestionRequest, isDurableAgentStructuredQuestionRequest, resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import {
    applyAgentStateRequestPushNotifiedAt,
    clonePlainObjectToNullProto,
    cloneStringKeyedRecordToNullProto,
} from '@/api/session/agentStateRecords';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { deepEqual } from '@/utils/deterministicJson';
import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';
import { isAgentStateRequestCoveredByCompletedRequests, type AgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionPermissionApprovalReviewerClaimV1Schema, SessionPermissionAccountUserDecisionActorV1Schema, SessionPermissionExternalHumanDecisionActorV1Schema, SessionPermissionIdempotencyKeyV1Schema, SessionPermissionSourceRefV1Schema, SessionPermissionSourceRevisionOrEpochV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE, NATIVE_TOOL_APPROVAL_REQUEST_SOURCE, SessionQuestionContextV1Schema, SessionQuestionHandlerV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import { readForegroundAgentRequestFollowEvent as readRequestFollowEvent } from './activeForegroundRequests';
import type { FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';
import { SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1, projectSessionFollowRuleSharedSourceEvidenceV1, SessionFollowRuleSourceEvidenceV1Schema, type SessionFollowRuleSourceEvidenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { SessionQuestionContextV1, SessionQuestionHandlerV1 } from '@happier-dev/protocol/sessions/permissions/v1';
import type { StructuredQuestionAnswerDetailsV1, StructuredQuestionAnswersV1 } from '@happier-dev/protocol/tools/structuredQuestionAnswersV1';
import { ResolvedMcpToolIdentityV1Schema, type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { AccountSettings, SessionPermissionApprovalReviewerClaimV1, SessionPermissionAccountUserDecisionActorV1, SessionPermissionExternalHumanDecisionActorV1 } from '@happier-dev/protocol';
import {
    getSessionNotificationAgentDisplayName,
    getSessionNotificationTitle,
} from '@/agent/runtime/notifications/sessionNotificationContext';
import {
    isPermissionRequestOwnedByPlugin,
    isPermissionRequestOwnedByPluginTurn,
    normalizePermissionRequestOwner,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];
type AgentStateCompletedEntry = NonNullable<AgentState['completedRequests']>[string];

function readStoredQuestionClassification(entry: Readonly<Record<string, unknown>>) {
    return { toolName: typeof entry.tool === 'string' ? entry.tool : '', lifetime: entry.lifetime,
        ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
        ...(typeof entry.source === 'string' ? { source: entry.source } : {}) };
}

function isStoredQuestion(entry: Readonly<Record<string, unknown>>): boolean {
    return isAgentStructuredQuestionRequest(readStoredQuestionClassification(entry));
}

/**
 * The one persisted first-answer-wins claim for an outstanding permission.
 *
 * It lives only on the private, outstanding Agent State entry.  Terminal
 * entries remove the claim.  A completed present-user entry separately keeps
 * the bounded account actor already written by the canonical response path so
 * an exact retry can rejoin; remote source and effect details remain owned by
 * the remote System Record.
 */
export type PermissionResponseClaim =
    | SessionPermissionApprovalReviewerClaimV1
    | Readonly<{
        version: 1;
        /**
         * The incumbent permission-policy owner, not a second actor arm.
         * Its decision is deliberately recomputed after the async claim write.
         */
        origin: 'automaticPolicy';
    }>
    | Readonly<{
        version: 1;
        origin: 'presentUser';
        nativeChoice?: NativePermissionChoiceAnswerV1;
        actor: SessionPermissionAccountUserDecisionActorV1;
        /** Exact host turn for current stamped requests; absent only for released legacy rows. */
        turnId?: string;
        decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        scope: 'request' | 'session';
    }>
    | Readonly<{
        version: 1;
        origin: 'remoteMediation';
        nativeChoice?: NativePermissionChoiceAnswerV1;
        actor: SessionPermissionExternalHumanDecisionActorV1;
        mediatorPluginId: string;
        /** Exact host-stamped turn custody for this Session-scoped request key. */
        turnId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
        idempotencyKey: string;
        decision: 'allow' | 'deny';
        scope: 'request' | 'session';
    }>;

export type PermissionResponseClaimAcquisition =
    | Readonly<{ status: 'acquired' }>
    | Readonly<{ status: 'rejoined' }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'not_pending' }>;

/**
 * Recovery may join only an already-persisted first-answer claim.  It must
 * never mint a claim from a System Record alone: that would give the record
 * a second terminal-authority path after a restart.
 */
export type PermissionResponseClaimRejoin =
    | Readonly<{ status: 'rejoined' }>
    | Readonly<{ status: 'unclaimed' }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'not_pending' }>;

export type PermissionResponseClaimSettlement =
    | Readonly<{ status: 'rejoined' }>
    | Readonly<{ status: 'conflict' }>
    | Readonly<{ status: 'not_settled' }>;

export type AgentStateRequestResponseTarget = Readonly<{ kind: string } & Record<string, unknown>>;

export type AgentStateResponseTargetDispatch = Readonly<{
    requestId: string;
    responseTarget: AgentStateRequestResponseTarget;
    completedRequest: Readonly<Record<string, unknown>>;
}>;

export type AgentStateRequestCancellation = Pick<AgentStateResponseTargetDispatch, 'requestId' | 'completedRequest'>;

/**
 * A target handler may explicitly report an unsuccessful delivery. Legacy
 * handlers that return void remain compatible and are treated as having
 * accepted the dispatch.
 */
export type AgentStateResponseTargetHandler = (
    dispatch: AgentStateResponseTargetDispatch,
) => boolean | void | PromiseLike<boolean | void>;
export type AgentStateRequestStoreUnsubscribe = () => void;
export type AgentStateResponseTargetRegistration = Readonly<{ application?: 'beforeCompletion' }>;

/** Session-owned delivery registrations shared by permission store views. */
export class AgentStateResponseTargetDispatcher {
    private readonly handlers = new Map<string, Readonly<{
        handler: AgentStateResponseTargetHandler;
        application?: 'beforeCompletion';
    }>>();

    register(kind: string, handler: AgentStateResponseTargetHandler,
        options?: AgentStateResponseTargetRegistration): AgentStateRequestStoreUnsubscribe {
        const normalizedKind = kind.trim();
        if (!normalizedKind) throw new Error('Response target handler kind must be a non-empty string');
        if (this.handlers.has(normalizedKind)) {
            throw new Error(`Response target handler already registered for kind ${normalizedKind}`);
        }
        const registration = { handler, ...options };
        this.handlers.set(normalizedKind, registration);
        return () => {
            if (this.handlers.get(normalizedKind) === registration) this.handlers.delete(normalizedKind);
        };
    }

    readBeforeCompletionHandler(kind: string): AgentStateResponseTargetHandler | null {
        const registration = this.handlers.get(kind);
        return registration?.application === 'beforeCompletion' ? registration.handler : null;
    }

    kinds(): IterableIterator<string> {
        return this.handlers.keys();
    }

    dispose(): void {
        this.handlers.clear();
    }

    dispatch(dispatch: AgentStateResponseTargetDispatch | null, logPrefix: string): Promise<boolean> | null {
        if (!dispatch) return null;

        const handler = this.handlers.get(dispatch.responseTarget.kind)?.handler;
        if (!handler) {
            logger.debug(
                `${logPrefix} No response target handler registered for kind ${dispatch.responseTarget.kind} (non-fatal)`,
            );
            return null;
        }

        try {
            const result = handler(dispatch);
            if (isPromiseLike(result)) {
                return Promise.resolve(result).then((delivered) => {
                    if (delivered !== false) return true;
                    logger.debug(
                        `${logPrefix} Response target handler did not deliver kind ${dispatch.responseTarget.kind}; retained completed response target for recovery`,
                    );
                    return false;
                }).catch((error) => {
                    logger.debug(
                        `${logPrefix} Response target handler failed for kind ${dispatch.responseTarget.kind} (non-fatal)`,
                        error,
                    );
                    return false;
                });
            }
            if (result === false) {
                logger.debug(
                    `${logPrefix} Response target handler did not deliver kind ${dispatch.responseTarget.kind}; retained completed response target for recovery`,
                );
                return Promise.resolve(false);
            }
            return Promise.resolve(true);
        } catch (error) {
            logger.debug(
                `${logPrefix} Response target handler failed for kind ${dispatch.responseTarget.kind} (non-fatal)`,
                error,
            );
            return Promise.resolve(false);
        }
    }

}

export type AgentStateOutstandingRequest = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    createdAt: number;
    mcpTool?: ResolvedMcpToolIdentityV1;
    /** Exact host turn that owns a source-mediated pending permission. */
    turnId?: string;
    lifetime?: 'turn' | 'occurrence';
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
}>;

type SessionLike = Readonly<{
    sessionId: string;
    enqueueAgentMessageCommitted?: TranscriptSessionPort['enqueueAgentMessageCommitted'];
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    updateAgentStateRequestSettlement: (updater: (state: AgentState) => AgentState) => Promise<void>;
    getAgentStateSnapshot?: () => AgentState | null | undefined;
    getMetadataSnapshot?: () => unknown;
    subscribeToSessionConnectionState?: (listener: (state: Readonly<{ phase: string }>) => void) => () => void;
    getArchivedAtSnapshot?: () => number | null | undefined;
    onArchivedAtChange?: (listener: (archivedAt: number | null) => void) => () => void;
    getAgentStateResponseTargetDispatcher?: () => AgentStateResponseTargetDispatcher;
    captureSessionFollowRuleEvidence?: (event: FollowEventV1) => SessionFollowRuleSourceEvidenceV1 | null;
    notifySessionFollowRuleRequestCommitted?: (occurrence: Readonly<{
        requestId: string; createdAt: number; turnId?: string; evidence: SessionFollowRuleSourceEvidenceV1;
    }>) => Promise<SessionActivityChangedResult | null | void> | SessionActivityChangedResult | null | void;
}>;

/**
 * Canonical persistence boundary for permission request state. A Session is
 * one adapter for this contract; another execution scope can bind the same
 * request owner without manufacturing a Session or another permission store.
 */
export type AgentStateRequestPersistenceTarget = Readonly<{
    scopeId: string;
    readState: () => AgentState | null | undefined;
    updateState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    getResponseTargetDispatcher?: () => AgentStateResponseTargetDispatcher;
    notifyRequest?: (request: Readonly<{
        requestId: string;
        toolName: string;
        toolInput: unknown;
        createdAt: number;
    }>) => Promise<void> | void;
    markRequestCompleted?: (requestId: string) => Promise<void> | void;
}>;

type AgentStateRequestPublication = Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    createdAt: number;
    mcpTool?: import('@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1').ResolvedMcpToolIdentityV1;
    turnId?: string;
    lifetime?: 'turn' | 'occurrence';
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget | null;
    subagentRef?: unknown;
    sidechainId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
    owner?: PermissionRequestOwner | null;
    updateState?: (state: AgentState) => AgentState;
}>;

type AgentStateRequestPersistenceOwner = AgentStateRequestPersistenceTarget & Readonly<{
    settleRequests: (updater: (state: AgentState) => AgentState) => Promise<void>;
}>;

function createSessionPersistenceTarget(session: SessionLike): AgentStateRequestPersistenceOwner {
    return Object.freeze({
        scopeId: session.sessionId,
        readState: () => session.getAgentStateSnapshot?.() ?? null,
        updateState: (updater) => session.updateAgentState(updater),
        settleRequests: (updater) => session.updateAgentStateRequestSettlement(updater),
        ...(session.getAgentStateResponseTargetDispatcher
            ? { getResponseTargetDispatcher: () => session.getAgentStateResponseTargetDispatcher!() }
            : {}),
    });
}

export type AgentStateRequestApplication = Readonly<{ pending: AgentStateRequestEntry }>;

export type AgentStateQuestionHandlerChange = Readonly<{
    requestId: string;
    /** Existing request occurrence custody, captured before asynchronous answer admission. */
    expectedCreatedAt: number;
    expectedHandler: SessionQuestionHandlerV1;
    currentHandler: SessionQuestionHandlerV1;
}>;

export type AgentStateRequestCompletion = Readonly<{
    requestId: string;
    status: string;
    answeredBy?: SessionQuestionHandlerV1;
    structuredAnswersV1?: StructuredQuestionAnswersV1;
    answerDetails?: StructuredQuestionAnswerDetailsV1;
    decision?: string;
    reason?: string;
    mode?: string;
    allowedTools?: readonly string[] | undefined;
    updatedPermissions?: unknown;
    extraCompletedFields?: Readonly<Record<string, unknown>> | null;
    /**
     * Evaluated inside the AgentState terminal write so an asynchronous
     * automatic decision cannot commit after its policy has changed.
     */
    isCurrent?: () => boolean;
    fallback?: Readonly<{
        toolName: string;
        nativeChoices?: NativePermissionChoicesV1 | null;
        questionV1?: SessionQuestionContextV1;
        currentHandler?: SessionQuestionHandlerV1;
        mcpTool?: ResolvedMcpToolIdentityV1;
        toolInput: unknown;
        createdAt: number;
        turnId?: string;
        lifetime?: 'turn' | 'occurrence';
        kind?: string;
        source?: string;
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        owner?: PermissionRequestOwner | null;
    }> | null;
    updateState?: (state: AgentState) => AgentState;
    /** The external native choice has already been applied successfully. */
    applicationAcknowledged?: AgentStateRequestApplication;
    /** The last local waiter is already detached, so replay cannot authorize an effect. */
    observedRetirement?: true;
}>;

export type AppliedRequestCompletion = Readonly<{
    matches: boolean;
    acknowledgement: Promise<boolean>;
}>;

type RetainedAppliedCompletion = Readonly<{
    completion: Readonly<Record<string, unknown>>;
    rows: readonly Readonly<{ requestId: string; pending: AgentStateRequestEntry; completed: AgentStateCompletedEntry }>[];
    acknowledgement: Promise<boolean>;
    settle: (saved: boolean) => void;
}>;

function completionIdentity(params: AgentStateRequestCompletion): Readonly<Record<string, unknown>> {
    const { fallback: _fallback, isCurrent: _isCurrent, updateState: _updateState,
        applicationAcknowledged: _applicationAcknowledged, ...completion } = params;
    return completion;
}

function pendingIdentity(entry: unknown): unknown {
    const record = clonePlainObjectToNullProto(entry);
    if (record) delete record.pushNotifiedAt;
    return record;
}

export class AgentStateRequestStore {
    private readonly declaredRequestCoverage?: AgentStateRequestCoverageOptions;

    private readonly pendingPublications = new Map<string, Readonly<{
        request: AgentStateRequestEntry;
        completedBeforePublication: AgentStateCompletedEntry | undefined;
        retry: () => void;
        cancel: () => void;
    }>>();
    private unsubscribePublicationReconnect: (() => void) | null = null;
    private appliedCompletionOwner: AgentStateRequestStore = this;
    private appliedCompletions = new Map<string, RetainedAppliedCompletion>();
    private target: AgentStateRequestPersistenceOwner;
    private session: SessionLike | null;
    private readonly logPrefix: string;
    private readonly getPushSender: () => PermissionRequestPushSender | null;
    private readonly getAccountSettings: () => AccountSettings | null;
    private readonly getAccountSettingsSecretsReadKeys: () => ReadonlyArray<Uint8Array | null | undefined>;
    private readonly getSessionTitle: () => string | null;
    private readonly getAgentDisplayName: () => string | null;
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private responseTargetDispatcher: AgentStateResponseTargetDispatcher;
    private ownsResponseTargetDispatcher: boolean;
    private unsubscribeArchiveState: (() => void) | null = null;
    private archiveCleanup: Promise<void> | null = null;

    constructor(params: Readonly<{
        session?: SessionLike;
        target?: AgentStateRequestPersistenceTarget;
        logPrefix: string;
        pushSender?: PermissionRequestPushSender | null;
        getPushSender?: (() => PermissionRequestPushSender | null) | null;
        getAccountSettings?: (() => AccountSettings | null) | null;
        getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
        getSessionTitle?: (() => string | null) | null;
        getAgentDisplayName?: (() => string | null) | null;
        requestCoverage?: AgentStateRequestCoverageOptions;
    }>) {
        if ((params.session ? 1 : 0) + (params.target ? 1 : 0) !== 1) {
            throw new Error('AgentStateRequestStore requires exactly one persistence target');
        }
        this.session = params.session ?? null;
        this.declaredRequestCoverage = 'requestCoverage' in params
            ? params.requestCoverage
            : resolveCatalogAgentRequestCoverageOptions({ metadata: params.session?.getMetadataSnapshot?.() });
        this.target = params.target
            ? { ...params.target, settleRequests: async updater => { await params.target!.updateState(updater); } }
            : createSessionPersistenceTarget(params.session!);
        this.ownsResponseTargetDispatcher = !this.target.getResponseTargetDispatcher;
        this.responseTargetDispatcher = this.target.getResponseTargetDispatcher?.() ?? new AgentStateResponseTargetDispatcher();
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
            : (() => getSessionNotificationTitle(() => this.session?.getMetadataSnapshot?.() ?? null));
        this.getAgentDisplayName = typeof params.getAgentDisplayName === 'function'
            ? params.getAgentDisplayName
            : (() => getSessionNotificationAgentDisplayName(() => this.session?.getMetadataSnapshot?.() ?? null));
        this.observeSessionArchive();
    }

    updateSession(session: SessionLike): void {
        this.cancelPendingPublications();
        const nextTarget = createSessionPersistenceTarget(session);
        if (nextTarget.scopeId !== this.target.scopeId) {
            this.retireAppliedCompletions();
            this.appliedCompletions = new Map();
            this.archiveCleanup = null;
        }
        const nextDispatcher = nextTarget.getResponseTargetDispatcher?.();
        if (nextDispatcher) {
            this.responseTargetDispatcher = nextDispatcher;
            this.ownsResponseTargetDispatcher = false;
        } else if (this.target.scopeId !== nextTarget.scopeId || !this.ownsResponseTargetDispatcher) {
            this.responseTargetDispatcher = new AgentStateResponseTargetDispatcher();
            this.ownsResponseTargetDispatcher = true;
        }
        this.session = session;
        this.target = nextTarget;
        this.observeSessionArchive();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;

        // Handlers outlive the transport reference. The completed projection
        // is the durable recovery source, so each authoritative rebind gets
        // one best-effort, at-least-once replay through the existing handler.
        this.replayCompletedResponseTargets();
    }

    /** Reclaimed detached input keeps its live response handlers and exact persistence scope. */
    rebindPersistenceTargetFrom(next: unknown): boolean {
        if (!(next instanceof AgentStateRequestStore) || this.session || next.session
            || next.target.scopeId !== this.target.scopeId) return false;
        this.cancelPendingPublications();
        this.target = next.target;
        return true;
    }

    private isSessionArchived(): boolean {
        return this.session?.getArchivedAtSnapshot?.() != null;
    }

    private observeSessionArchive(): void {
        this.unsubscribeArchiveState?.();
        const reconcile = () => {
            void this.reconcileSessionArchive().catch(error => {
                logger.infoFile(`${this.logPrefix} Archived Session request withdrawal failed`, {
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            });
        };
        this.unsubscribeArchiveState = this.session?.onArchivedAtChange?.(reconcile) ?? null;
        reconcile();
    }

    /** Archive is an explicit withdrawal, including when a retained host is first rebound. */
    async reconcileSessionArchive(): Promise<void> {
        if (!this.isSessionArchived()) return;
        if (this.archiveCleanup) return await this.archiveCleanup;
        const cleanup = this.cancelAllRequests({ reason: 'Session archived', decision: 'abort', requestIds: [] }).then(() => undefined);
        this.archiveCleanup = cleanup;
        try { await cleanup; }
        finally { if (this.archiveCleanup === cleanup) this.archiveCleanup = null; }
    }

    /** A replacement view of the same live Session keeps one applied-fact owner. */
    adoptAppliedCompletions(previous: AgentStateRequestStore): void {
        if (previous.target.scopeId !== this.target.scopeId || previous === this) return;
        this.appliedCompletions = previous.appliedCompletions;
        previous.appliedCompletionOwner = this;
    }

    captureRequestApplication(requestId: string): AgentStateRequestApplication | null {
        const pending = this.target.readState()?.requests?.[requestId];
        if (pending && this.isSessionArchived() && isStoredQuestion(pending)) return null;
        return pending ? { pending: structuredClone(pending) } : null;
    }

    readAppliedCompletion(params: AgentStateRequestCompletion): AppliedRequestCompletion | null {
        const retained = this.appliedCompletions.get(params.requestId);
        return retained ? { matches: deepEqual(retained.completion, completionIdentity(params)),
            acknowledgement: retained.acknowledgement } : null;
    }

    /** Merge after the caller's mutation: newer terminal/claim/request identity wins. */
    applyAppliedCompletions(state: AgentState): AgentState {
        let next = state;
        for (const [requestId, fact] of this.appliedCompletions) {
            const primary = fact.rows.find((row) => row.requestId === requestId);
            if (!primary || state.completedRequests?.[requestId]
                || !deepEqual(pendingIdentity(state.requests?.[requestId]), pendingIdentity(primary.pending))) continue;
            const requests = cloneStringKeyedRecordToNullProto(next.requests);
            const completedRequests = cloneStringKeyedRecordToNullProto(next.completedRequests);
            for (const row of fact.rows) {
                if (completedRequests[row.requestId]
                    || !deepEqual(pendingIdentity(requests[row.requestId]), pendingIdentity(row.pending))) continue;
                delete requests[row.requestId];
                completedRequests[row.requestId] = row.completed;
            }
            next = { ...next, requests, completedRequests };
        }
        return next;
    }

    /** Called only after an acknowledged write, including a newer cancellation. */
    confirmAppliedCompletions(): void {
        const state = this.target.readState();
        if (!state) return;
        for (const [requestId, fact] of this.appliedCompletions) {
            const primary = fact.rows.find((row) => row.requestId === requestId);
            if (!primary) continue;
            const completed = state.completedRequests?.[requestId];
            const saved = deepEqual(completed, primary.completed);
            if (!saved && !completed
                && deepEqual(pendingIdentity(state.requests?.[requestId]), pendingIdentity(primary.pending))) continue;
            this.appliedCompletions.delete(requestId);
            fact.settle(saved);
            if (saved) for (const row of fact.rows) {
                this.markPermissionRequestCompletedBestEffort(row.requestId);
                this.dispatchResponseTargetBestEffort(this.readCompletedResponseTarget(row.requestId));
            }
        }
    }

    async recoverAppliedCompletions(): Promise<void> {
        await this.reconcileSessionArchive();
        if (this.appliedCompletions.size === 0) return;
        await Promise.resolve(this.target.updateState((state) => this.applyAppliedCompletions(state)));
        this.confirmAppliedCompletions();
    }

    retireAppliedCompletions(): void {
        for (const fact of this.appliedCompletions.values()) fact.settle(false);
        this.appliedCompletions.clear();
    }

    hasOutstandingRequest(requestId: string): boolean {
        return this.readOutstandingRequest(requestId) !== null;
    }

    readCompletedResponseTarget(requestId: string): AgentStateResponseTargetDispatch | null {
        return createResponseTargetDispatchFromUnknown(
            requestId,
            this.target.readState()?.completedRequests?.[requestId],
        );
    }

    hasPermissionResponseClaim(requestId: string): boolean {
        const request = this.target.readState()?.requests?.[requestId];
        const entry = clonePlainObjectToNullProto(request);
        return entry ? hasOpaquePermissionResponseClaim(entry) : false;
    }

    readOutstandingRequest(requestId: string): AgentStateOutstandingRequest | null {
        const entry = this.target.readState()?.requests?.[requestId];
        if (!entry) return null;
        if (this.isSessionArchived() && isStoredQuestion(entry)) return null;

        // Session adapters can expose raw AgentState before SessionCore's stored-read schema.
        // A malformed present context cannot acquire the absent legacy wait/person meaning.
        if (entry.questionV1 !== undefined && !SessionQuestionContextV1Schema.safeParse(entry.questionV1).success
            || entry.currentHandler !== undefined && !SessionQuestionHandlerV1Schema.safeParse(entry.currentHandler).success) {
            throw new Error('invalid_question_metadata');
        }

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

    listOutstandingRequests(): readonly AgentStateOutstandingRequest[] {
        const requests = this.target.readState()?.requests;
        if (!requests || typeof requests !== 'object' || Array.isArray(requests)) return [];
        const outstanding: AgentStateOutstandingRequest[] = [];
        for (const requestId of Object.keys(requests)) {
            const request = this.readOutstandingRequest(requestId);
            if (request) outstanding.push(request);
        }
        return outstanding;
    }

    /** Pass-up changes the same live question, without settling its answer or waiters. */
    async changeQuestionHandler(params: AgentStateQuestionHandlerChange): Promise<boolean> {
        if (this.isSessionArchived()) return false;
        const nextHandler = SessionQuestionHandlerV1Schema.parse(params.currentHandler);
        let changed: AgentStateRequestEntry | null = null;
        await Promise.resolve(this.target.updateState((state) => {
            // A discarded updater attempt cannot authorize a notification.
            changed = null;
            if (this.isSessionArchived()) return state;
            const pending = state.requests?.[params.requestId];
            if (!pending || !SessionQuestionContextV1Schema.safeParse(pending.questionV1).success
                || pending.createdAt !== params.expectedCreatedAt
                || !deepEqual(pending.currentHandler, params.expectedHandler)
                || deepEqual(pending.currentHandler, nextHandler)
                || isAgentStateRequestCoveredByCompletedRequests({ requestId: params.requestId,
                    request: pending, completedRequests: state.completedRequests,
                    options: this.declaredRequestCoverage })) return state;
            changed = { ...pending, currentHandler: nextHandler };
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(state.requests);
            requests[params.requestId] = changed;
            return { ...state, requests };
        }));
        if (!changed) return false;
        const pending = this.readOutstandingRequest(params.requestId);
        // The incumbent notifier sends Session handlers through source Follow
        // admission and person handlers through the existing push owner.
        if (pending?.createdAt === params.expectedCreatedAt && deepEqual(pending.currentHandler, nextHandler)) {
            this.notifyPermissionRequestPushBestEffort({ permissionId: params.requestId,
                toolName: pending.toolName, toolInput: pending.toolInput, createdAtMs: pending.createdAt });
        }
        return true;
    }

    /**
     * Atomically claims an existing outstanding request through the Session
     * client updater.  Unlike the coordinator's in-process serialization, this
     * survives a handler reload and races with another responder process.
     */
    async acquirePermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimAcquisition> {
        const claim = readPermissionResponseClaim(params.claim);
        if (!claim) {
            throw new Error('Permission response claim must satisfy the bounded v1 shape');
        }

        let outcome: PermissionResponseClaimAcquisition = { status: 'not_pending' };
        await Promise.resolve(this.target.updateState((currentState) => {
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
            const existing = clonePlainObjectToNullProto(requests[params.requestId]);
            if (!existing) {
                outcome = { status: 'not_pending' };
                return currentState;
            }

            if (existing.source === HAPPIER_ACTION_REQUEST_SOURCE && (
                claim.origin !== 'presentUser'
                || claim.scope !== 'request'
                || (claim.decision !== 'approved' && claim.decision !== 'denied' && claim.decision !== 'abort')
            )) {
                outcome = { status: 'conflict' };
                return currentState;
            }

            const hasStoredClaim = Object.prototype.hasOwnProperty.call(existing, 'permissionResponseClaimV1');
            const storedClaim = hasStoredClaim ? readPermissionResponseClaim(existing.permissionResponseClaimV1, 'stored') : null;
            if (hasStoredClaim && !storedClaim) {
                // A malformed persisted claim is an unknown prior responder, so
                // fail closed instead of overwriting it with a second authority.
                outcome = { status: 'conflict' };
                return currentState;
            }
            if (storedClaim) {
                outcome = permissionResponseClaimsEqual(storedClaim, claim)
                    ? { status: 'rejoined' }
                    : { status: 'conflict' };
                return currentState;
            }

            existing.permissionResponseClaimV1 = claim;
            requests[params.requestId] = existing as AgentStateRequestEntry;
            outcome = { status: 'acquired' };
            return {
                ...currentState,
                requests,
            };
        }));
        return outcome;
    }

    /**
     * Atomically verifies that a recovery operation is rejoining this exact
     * durable claim. Unlike acquisition, this method never writes a claim.
     */
    async rejoinPermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<PermissionResponseClaimRejoin> {
        const claim = readPermissionResponseClaim(params.claim);
        if (!claim) {
            throw new Error('Permission response claim must satisfy the bounded v1 shape');
        }

        let outcome: PermissionResponseClaimRejoin = { status: 'not_pending' };
        await Promise.resolve(this.target.updateState((currentState) => {
            const existing = clonePlainObjectToNullProto(currentState.requests?.[params.requestId]);
            if (!existing) {
                outcome = { status: 'not_pending' };
                return currentState;
            }

            const hasStoredClaim = Object.prototype.hasOwnProperty.call(existing, 'permissionResponseClaimV1');
            if (!hasStoredClaim) {
                outcome = { status: 'unclaimed' };
                return currentState;
            }
            const storedClaim = readPermissionResponseClaim(existing.permissionResponseClaimV1, 'stored');
            if (!storedClaim) {
                outcome = { status: 'conflict' };
                return currentState;
            }
            outcome = permissionResponseClaimsEqual(storedClaim, claim)
                ? { status: 'rejoined' }
                : { status: 'conflict' };
            return currentState;
        }));
        return outcome;
    }

    /**
     * Releases only this exact claim after a response was rejected before any
     * terminal effect was recorded.  A later claim is never removed here.
     */
    async releasePermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): Promise<void> {
        const claim = readPermissionResponseClaim(params.claim);
        if (!claim) {
            throw new Error('Permission response claim must satisfy the bounded v1 shape');
        }

        await Promise.resolve(this.target.updateState((currentState) => {
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
            const existing = clonePlainObjectToNullProto(requests[params.requestId]);
            if (!existing) return currentState;

            const storedClaim = readPermissionResponseClaim(existing.permissionResponseClaimV1, 'stored');
            if (!storedClaim || !permissionResponseClaimsEqual(storedClaim, claim)) return currentState;

            delete existing.permissionResponseClaimV1;
            requests[params.requestId] = existing as AgentStateRequestEntry;
            return {
                ...currentState,
                requests,
            };
        }));
    }

    /**
     * Completed Agent State retains the bounded present-user settlement identity
     * already written by the canonical response path.  It is sufficient to
     * rejoin a reload/retry without introducing a second settlement ledger.
     */
    readCompletedPermissionResponseClaim(params: Readonly<{
        requestId: string;
        claim: PermissionResponseClaim;
    }>): PermissionResponseClaimSettlement {
        const claim = readPermissionResponseClaim(params.claim);
        if (!claim) {
            throw new Error('Permission response claim must satisfy the bounded v1 shape');
        }
        if (claim.origin !== 'presentUser') return { status: 'not_settled' };

        const completed = this.target.readState()?.completedRequests?.[params.requestId];
        const entry = clonePlainObjectToNullProto(completed);
        if (!entry || typeof entry.tool !== 'string' || resolveAgentRequestKind(entry.tool, entry.kind) !== 'permission') {
            return { status: 'not_settled' };
        }

        const hasActor = Object.prototype.hasOwnProperty.call(entry, 'permissionDecisionActorV1');
        if (!hasActor) return { status: 'not_settled' };
        const actor = createStoredReadSchema(SessionPermissionAccountUserDecisionActorV1Schema).safeParse(entry.permissionDecisionActorV1);
        if (!actor.success) return { status: 'conflict' };
        const turnId = TurnIdSchema.safeParse(entry.turnId);

        const completedClaim = readPermissionResponseClaim({
            version: 1,
            origin: 'presentUser',
            actor: actor.data,
            ...(turnId.success ? { turnId: turnId.data } : {}),
            ...(entry.nativeChoice !== undefined ? { nativeChoice: entry.nativeChoice } : {}),
            decision: entry.decision,
            scope: entry.decision === 'approved_for_session' ? 'session' : 'request',
        });
        if (!completedClaim || completedClaim.origin !== 'presentUser') return { status: 'conflict' };
        const expectedStatus = completedClaim.decision === 'denied' || completedClaim.decision === 'abort'
            ? 'denied'
            : 'approved';
        if (entry.status !== expectedStatus) return { status: 'conflict' };
        return permissionResponseClaimsEqual(completedClaim, claim)
            ? { status: 'rejoined' }
            : { status: 'conflict' };
    }

    registerResponseTargetHandler(
        kind: string,
        handler: AgentStateResponseTargetHandler,
        options?: AgentStateResponseTargetRegistration,
    ): AgentStateRequestStoreUnsubscribe {
        const unsubscribe = this.responseTargetDispatcher.register(kind, handler, options);
        this.replayCompletedResponseTargetsForHandler(kind.trim());
        return unsubscribe;
    }

    /** A successful snapshot/reconnect retries retained source-owned deliveries. */
    replayCompletedResponseTargets(): void {
        for (const kind of [...this.responseTargetDispatcher.kinds()]) {
            this.replayCompletedResponseTargetsForHandler(kind);
        }
    }

    private beginRequestPublication(params: AgentStateRequestPublication, preserveExisting = false, retainUntilReconnect = false): Readonly<{
        result: Promise<void> | void;
        notify: () => void;
    }> {
        const assertActiveQuestion = () => {
            if (this.isSessionArchived() && isAgentStructuredQuestionRequest(params)) {
                throw Object.assign(new Error('session_archived'), { code: 'session_archived' });
            }
        };
        assertActiveQuestion();
        this.pendingPublications.get(params.requestId)?.cancel();
        const target = this.target;
        const replacedCompletion = target.readState()?.completedRequests?.[params.requestId];
        const entryTemplate = Object.create(null) as AgentStateRequestEntry & { source?: string; permissionSuggestions?: readonly unknown[] };
        entryTemplate.tool = params.toolName;
        entryTemplate.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
        entryTemplate.arguments = params.toolInput;
        entryTemplate.createdAt = params.createdAt;
        if (typeof params.source === 'string') entryTemplate.source = params.source;
        applyAgentStateRequestMetadata(entryTemplate, params);
        const followEvent = readRequestFollowEvent(entryTemplate);
        const evidence = !params.sidechainId && !readRunScopedExecutionPermissionRequestIdentity(params.requestId)
            && followEvent ? this.session?.captureSessionFollowRuleEvidence?.(followEvent) : null;
        let shouldNotify = false;
        let didRunUpdater = false;
        let publishedRequest: AgentStateRequestEntry | null = null;
        const notify = () => {
            if (!didRunUpdater || !shouldNotify) return;
            const current = this.target.readState()?.requests?.[params.requestId];
            if (!current || !publishedRequest || !isSameAgentStateRequestOccurrence(current, publishedRequest)) return;
            this.publishNativeEditTranscript(params.requestId, current);
            this.notifyPermissionRequestPushBestEffort({
                permissionId: params.requestId,
                toolName: params.toolName,
                toolInput: params.toolInput,
                createdAtMs: params.createdAt,
            });
        };

        const updater = (currentState: AgentState, replay = false) => {
            assertActiveQuestion();
            shouldNotify = false;
            didRunUpdater = true;
            // A reconnect retries the original occurrence; it cannot erase a
            // terminal answer that arrived after that publication was admitted.
            if (replay && currentState.completedRequests?.[params.requestId]
                && !deepEqual(currentState.completedRequests[params.requestId], replacedCompletion)) return currentState;
            // A transcript mirror has no new request tuple. It cannot replace
            // an owning producer's pending question or revive its completion.
            if (preserveExisting && (Object.hasOwn(currentState.requests ?? {}, params.requestId)
                || Object.hasOwn(currentState.completedRequests ?? {}, params.requestId))) return currentState;
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
            const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
            const existingOutstanding = clonePlainObjectToNullProto(requests[params.requestId]);
            const entry = Object.assign(Object.create(null), entryTemplate) as AgentStateRequestEntry;
            const sameOccurrence = existingOutstanding && isSameAgentStateRequestOccurrence(existingOutstanding, entry);
            if (sameOccurrence && Object.prototype.hasOwnProperty.call(existingOutstanding, 'permissionResponseClaimV1')) {
                // A restarted handler can republish the same canonical
                // outstanding request. Preserve even a malformed prior
                // value so acquisition continues to fail closed rather
                // than accidentally clearing a first-answer authority.
                entry.permissionResponseClaimV1 = existingOutstanding.permissionResponseClaimV1;
            }
            if (sameOccurrence) {
                // Native notifier acceptance belongs to the original request,
                // so a handler reload must not reopen its delivered alert.
                if (typeof existingOutstanding.pushNotifiedAt === 'number'
                    && Number.isFinite(existingOutstanding.pushNotifiedAt) && existingOutstanding.pushNotifiedAt > 0) {
                    entry.pushNotifiedAt = existingOutstanding.pushNotifiedAt;
                }
                // A rejoined request keeps its production-time facts, including
                // absence on historical requests; current metadata is not proof.
                if (Object.hasOwn(existingOutstanding, SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1)) {
                    entry[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1] = existingOutstanding[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1];
                }
            } else if (!params.sidechainId && !readRunScopedExecutionPermissionRequestIdentity(params.requestId)) {
                // Session request state is shared with Session readers. Account-
                // private project/tag evidence must remain at its private owner.
                if (evidence) entry[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1] = projectSessionFollowRuleSharedSourceEvidenceV1(evidence);
            }
            if (existingOutstanding) {
                const retained = readAgentStateRequestMetadata(existingOutstanding);
                const candidate = { ...entry,
                    ...(!entry.questionV1 && retained.questionV1 ? { questionV1: retained.questionV1 } : {}),
                };
                if (isSameAgentStateRequestOccurrence(existingOutstanding, candidate)) {
                    // Rebinding an existing host must not select the handler again.
                    if (retained.questionV1) entry.questionV1 = retained.questionV1;
                    if (retained.currentHandler) entry.currentHandler = retained.currentHandler;
                }
            }
            if (replay && existingOutstanding && !isSameAgentStateRequestOccurrence(existingOutstanding, entry)) return currentState;
            delete completedRequests[params.requestId];
            if (isAgentStateRequestCoveredByCompletedRequests({
                requestId: params.requestId,
                request: entry,
                completedRequests,
                options: this.declaredRequestCoverage,
            })) {
                const coveredState: AgentState = {
                    ...currentState,
                    completedRequests,
                };
                return typeof params.updateState === 'function' ? params.updateState(coveredState) : coveredState;
            }
            requests[params.requestId] = entry;
            publishedRequest = entry;
            shouldNotify = true;

            const nextState: AgentState = {
                ...currentState,
                requests,
                completedRequests,
            };
            return typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
        };
        const result = retainUntilReconnect
            ? this.publishRequestWithReconnectRetry(params.requestId, entryTemplate, replacedCompletion, updater, notify)
            : target.updateState(updater);
        return { result, notify };
    }

    private publishRequestWithReconnectRetry(requestId: string, request: AgentStateRequestEntry,
        completedBeforePublication: AgentStateCompletedEntry | undefined,
        updater: (state: AgentState, replay: boolean) => AgentState, notify: () => void): Promise<void> | void {
        const target = this.target;
        let inFlight = false;
        let retryRequested = false;
        let attempted = false;
        const retire = () => {
            if (this.pendingPublications.get(requestId) !== publication) return;
            this.pendingPublications.delete(requestId);
            if (this.pendingPublications.size === 0) {
                this.unsubscribePublicationReconnect?.();
                this.unsubscribePublicationReconnect = null;
            }
        };
        const attempt = (): Promise<void> | void => {
            if (this.pendingPublications.get(requestId) !== publication) return;
            if (inFlight) { retryRequested = true; return; }
            inFlight = true;
            const replay = attempted;
            attempted = true;
            const success = () => {
                if (this.pendingPublications.get(requestId) !== publication) return;
                retire();
                notify();
            };
            const failed = (error: unknown) => {
                logger.infoFile(`${this.logPrefix} Request publication deferred until reconnect`, {
                    scopeId: target.scopeId, operation: 'publish_request', error: serializeAxiosErrorForLog(error),
                });
                if (error && typeof error === 'object' && 'code' in error && error.code === 'session_archived') retire();
            };
            const finished = () => {
                inFlight = false;
                if (retryRequested) { retryRequested = false; void attempt(); }
            };
            try {
                const result = target.updateState(state => this.pendingPublications.get(requestId) === publication ? updater(state, replay) : state);
                if (isPromiseLike(result)) return Promise.resolve(result).then(success, failed).finally(finished);
                success();
            } catch (error) { failed(error); }
            finished();
        };
        const publication = { request, completedBeforePublication, retry: () => { void attempt(); }, cancel: retire };
        this.pendingPublications.set(requestId, publication);
        this.unsubscribePublicationReconnect ??= this.session?.subscribeToSessionConnectionState?.(state => {
            if (state.phase === 'online') for (const pending of this.pendingPublications.values()) pending.retry();
        }) ?? null;
        return attempt();
    }

    private cancelPendingPublications(): void {
        for (const publication of this.pendingPublications.values()) publication.cancel();
    }

    private publishRequestBestEffort(params: AgentStateRequestPublication, preserveExisting: boolean): void {
        try {
            this.beginRequestPublication(params, preserveExisting, true);
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'session_archived') throw error;
            logger.infoFile(`${this.logPrefix} Request publication failed`, {
                operation: 'publish_request', error: serializeAxiosErrorForLog(error),
            });
        }
    }

    publishRequest(params: AgentStateRequestPublication): void {
        this.publishRequestBestEffort(params, false);
    }

    /** Legacy transcript producers join the existing request owner; they never assert a replacement occurrence. */
    publishMirroredRequest(params: AgentStateRequestPublication): void {
        this.publishRequestBestEffort(params, true);
    }

    /**
     * Durable interaction producers use this form so they do not expose a
     * request until its owning persistence target has accepted the mutation.
     */
    async publishRequestAndWait(params: AgentStateRequestPublication): Promise<void> {
        const publication = this.beginRequestPublication(params);
        await publication.result;
        publication.notify();
    }

    async completeRequest(params: AgentStateRequestCompletion): Promise<boolean> {
        if (!params.applicationAcknowledged) {
            const state = this.target.readState();
            const responseTarget = readResponseTarget(state?.requests?.[params.requestId]?.responseTarget);
            const apply = responseTarget && this.responseTargetDispatcher.readBeforeCompletionHandler(responseTarget.kind);
            if (state && apply) {
                const acknowledged = { ...params,
                    extraCompletedFields: { ...params.extraCompletedFields, responseTarget: undefined } };
                const retained = this.readAppliedCompletion(acknowledged);
                if (retained) {
                    if (!retained.matches) return false;
                    await this.recoverAppliedCompletions();
                    return await retained.acknowledgement;
                }
                const application = this.captureRequestApplication(params.requestId);
                const preview = this.buildRequestCompletion(state, params, new Set());
                if (!application || !preview.didCompleteRequest) return false;
                if (preview.responseDispatch) {
                    // This target owns the native application. Refusal leaves the same
                    // outstanding occurrence answerable; only a positive ACK completes it.
                    if (await apply(preview.responseDispatch) !== true) return false;
                    return await this.completeRequest({ ...acknowledged, applicationAcknowledged: application });
                }
                // An explicit withdrawal cleared its answer target; there is no
                // native answer to apply before the ordinary terminal write.
            }
        }
        const publication = this.pendingPublications.get(params.requestId);
        if (params.applicationAcknowledged && !deepEqual(
            pendingIdentity(this.target.readState()?.requests?.[params.requestId]),
            pendingIdentity(params.applicationAcknowledged.pending),
        )) return false;
        const completedRequestIds = new Set<string>();
        let didCompleteRequest = false;
        if (this.session && params.applicationAcknowledged && !this.appliedCompletions.has(params.requestId)) {
            const currentState = this.target.readState();
            if (currentState) {
                const preview = this.buildRequestCompletion(currentState, params, new Set());
                if (preview.didCompleteRequest && currentState.requests?.[params.requestId]) {
                    let settle!: (saved: boolean) => void;
                    const acknowledgement = new Promise<boolean>((resolve) => { settle = resolve; });
                    const rows = Object.entries(preview.state.completedRequests ?? {}).flatMap(([requestId, completed]) => {
                        const pending = currentState.requests?.[requestId];
                        return pending && !preview.state.requests?.[requestId] ? [{ requestId, pending, completed }] : [];
                    });
                    this.appliedCompletions.set(params.requestId, {
                        completion: completionIdentity(params), rows, acknowledgement, settle,
                    });
                }
            }
        }
        const appliedCompletion = params.applicationAcknowledged
            ? this.appliedCompletions.get(params.requestId) : undefined;
        const current = clonePlainObjectToNullProto(this.target.readState()?.requests?.[params.requestId]);
        // Approvals retain the incumbent pre-effect ACK contract. The journal is
        // only for an already-decided cancellation without another live owner.
        const durableRetirement = params.observedRetirement === true && params.status === 'canceled' && !params.applicationAcknowledged
            && params.isCurrent === undefined && params.updateState === undefined
            && !readResponseTarget(params.fallback?.responseTarget)
            && !readResponseTarget(params.extraCompletedFields?.responseTarget)
            && this.canJournalRequestRetirement(params.requestId, current);
        await this.updateAgentStateWithResponseDispatch((currentState) => {
            if (params.applicationAcknowledged && this.appliedCompletions.has(params.requestId)) {
                const state = this.applyAppliedCompletions(currentState);
                didCompleteRequest = !!state.completedRequests?.[params.requestId] && !state.requests?.[params.requestId];
                return { state };
            }
            const next = this.buildRequestCompletion(currentState, params, completedRequestIds);
            didCompleteRequest = next.didCompleteRequest === true;
            return next;
        }, durableRetirement);
        this.confirmAppliedCompletions();

        if (appliedCompletion) return await appliedCompletion.acknowledgement;
        if (!didCompleteRequest) return false;
        publication?.cancel();
        completedRequestIds.add(params.requestId);
        for (const requestId of completedRequestIds) {
            this.markPermissionRequestCompletedBestEffort(requestId);
        }
        return true;
    }

    private buildRequestCompletion(currentState: AgentState, params: AgentStateRequestCompletion,
        completedRequestIds: Set<string>): AgentStateUpdateWithResponseDispatch & { didCompleteRequest?: boolean } {
        let didCompleteRequest = false;
        const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
        const existing = requests[params.requestId] as unknown;
        const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
        if (!existing && (!params.fallback || completedRequests[params.requestId])) {
            return { state: currentState };
        }
        const existingEntry = clonePlainObjectToNullProto(existing);
        if (this.isSessionArchived() && params.status !== 'canceled'
            && (existingEntry ? isStoredQuestion(existingEntry)
                : params.fallback && isAgentStructuredQuestionRequest(params.fallback))) {
            return { state: currentState };
        }
        if (params.observedRetirement && existingEntry) {
            const expected = params.fallback;
            // Observed retirement belongs to the detached local occurrence,
            // never a replacement that reused its request id while awaiting IO.
            if (!expected || !isSameAgentStateRequestOccurrence(existingEntry, {
                ...expected, tool: expected.toolName, arguments: expected.toolInput,
            })) return { state: currentState };
        }
        if (params.isCurrent && !params.isCurrent()) {
            return { state: currentState };
        }
        if (
            params.status === 'canceled'
            && !params.applicationAcknowledged
            && existingEntry
            && hasOpaquePermissionResponseClaim(existingEntry)
        ) {
            // A persisted first-answer claim is an active terminal owner.
            // Cancellation cannot turn it into a different terminal state
            // while its owner may still be linearizing the response. An acknowledged native
            // cancellation above records the already-applied fact rather than applying a choice.
            return { state: currentState };
        }
        didCompleteRequest = true;
        delete requests[params.requestId];

        const completedEntry = existingEntry ?? Object.create(null);

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
        if (params.answeredBy) completedEntry.answeredBy = SessionQuestionHandlerV1Schema.parse(params.answeredBy);
        if (params.structuredAnswersV1) completedEntry.structuredAnswersV1 = params.structuredAnswersV1;
        if (params.answerDetails !== undefined) completedEntry.answerDetails = params.answerDetails;
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
                if (value === undefined) delete completedEntry[key];
                else completedEntry[key] = value;
            }
        }

        removePermissionResponseClaim(completedEntry);

        completedRequests[params.requestId] = completedEntry as AgentStateCompletedEntry;
        removeRequestsCoveredByCompletedEntry({
            requestCoverage: this.declaredRequestCoverage,
            completedRequestId: params.requestId,
            completedEntry: completedEntry as AgentStateCompletedEntry,
            requests,
            completedRequests,
            markCompleted: (requestId) => completedRequestIds.add(requestId),
        });
        const nextState: AgentState = {
            ...currentState,
            requests,
            completedRequests,
        };
        const finalState = typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
        const finalCompletedEntry = finalState.completedRequests?.[params.requestId] as unknown;

        return {
            didCompleteRequest,
            state: finalState,
            responseDispatch: createResponseTargetDispatchFromUnknown(params.requestId, finalCompletedEntry),
        };
    }

    async retireCompletedRequestsForTurn(turnId: string): Promise<void> {
        const normalizedTurnId = turnId.trim();
        if (!normalizedTurnId) return;
        await this.updateAgentStateAndWait((currentState) => {
            const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
            if (Object.values(requests).some((rawEntry) => {
                const entry = clonePlainObjectToNullProto(rawEntry);
                return entry?.turnId === normalizedTurnId && !isStoredQuestion(entry);
            })) return currentState;

            const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
            let changed = false;
            for (const [requestId, rawEntry] of Object.entries(completedRequests)) {
                const entry = clonePlainObjectToNullProto(rawEntry);
                if (!entry || entry.turnId !== normalizedTurnId) continue;
                if (entry.responseTarget) {
                    if (entry.turnTerminalV1 !== true) {
                        entry.turnTerminalV1 = true;
                        completedRequests[requestId] = entry as AgentStateCompletedEntry;
                        changed = true;
                    }
                    continue;
                }
                if (retainsPermissionGrant(entry) || hasOpaquePermissionResponseClaim(entry)) continue;
                delete completedRequests[requestId];
                changed = true;
            }
            return changed ? { ...currentState, completedRequests } : currentState;
        });
    }

    async recordCompletedRequest(params: Readonly<{
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
        owner?: PermissionRequestOwner | null;
        reason?: string;
        /**
         * Evaluated inside the AgentState terminal write so an asynchronous
         * automatic decision cannot commit after its policy has changed.
         */
        isCurrent?: () => boolean;
    }>): Promise<boolean> {
        const completedRequestIds = new Set<string>();
        let didRecordCompletedRequest = false;
        const publication = this.pendingPublications.get(params.requestId);
        await this.updateAgentStateWithResponseDispatch(
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
                const existingRequest = clonePlainObjectToNullProto(requests[params.requestId]);
                if (!existingRequest && completedRequests[params.requestId]) {
                    // Terminal Agent State is the one durable request owner.
                    // A delayed automatic path cannot overwrite a cancellation
                    // (or any other already-settled response) for this request.
                    return { state: currentState };
                }
                if (existingRequest && hasOpaquePermissionResponseClaim(existingRequest)) {
                    // An outstanding first-answer claim has already admitted a
                    // terminal owner. Automatic policy must not overwrite it
                    // or produce an effect while that owner is still settling.
                    return { state: currentState };
                }
                if (params.isCurrent && !params.isCurrent()) {
                    return { state: currentState };
                }
                // A recovered unclaimed request is still the live request
                // projection. Replace it in this one owner write rather than
                // leaving a completed request reachable as outstanding.
                delete requests[params.requestId];
                didRecordCompletedRequest = true;
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
                        if (value === undefined) delete mutableEntry[key];
                        else mutableEntry[key] = value;
                    }
                }
                removePermissionResponseClaim(entry as Record<string, unknown>);
                completedRequests[params.requestId] = entry;
                removeRequestsCoveredByCompletedEntry({
                    requestCoverage: this.declaredRequestCoverage,
                    completedRequestId: params.requestId,
                    completedEntry: entry,
                    requests,
                    completedRequests,
                    markCompleted: (requestId) => completedRequestIds.add(requestId),
                });
                return {
                    state: {
                        ...currentState,
                        requests,
                        completedRequests,
                    } satisfies AgentState,
                    responseDispatch: createResponseTargetDispatch(params.requestId, entry),
                };
            },
        );
        if (!didRecordCompletedRequest) return false;
        publication?.cancel();
        completedRequestIds.add(params.requestId);
        for (const requestId of completedRequestIds) {
            this.markPermissionRequestCompletedBestEffort(requestId);
        }
        return true;
    }

    async cancelAllRequests(params: Readonly<{
        scope?: 'foreground';
        preserveQuestions?: boolean;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<readonly AgentStateRequestCancellation[]> {
        return await this.cancelRequests(params);
    }

    async cancelRequestsByOwner(params: Readonly<{
        owner: PermissionRequestOwner;
        turnId?: string;
        preserveQuestions?: boolean;
        observedRetirement?: true;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<readonly AgentStateRequestCancellation[]> {
        return await this.cancelRequests({
            ...params,
            pluginId: params.owner.pluginId,
        });
    }

    async cancelRequestsBySource(params: Readonly<{
        source: string;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<void> {
        if (!params.source.trim()) throw new Error('Request cancellation source must be non-empty');
        await this.cancelRequests(params);
    }

    private async cancelRequests(params: Readonly<{
        scope?: 'foreground';
        preserveQuestions?: boolean;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
        pluginId?: string;
        turnId?: string;
        source?: string;
        observedRetirement?: true;
    }>): Promise<readonly AgentStateRequestCancellation[]> {
        const completedRequestsById = new Map<string, AgentStateRequestCancellation>();
        const isSelected = (id: string, entry: Readonly<Record<string, unknown>>) => {
            if (params.scope === 'foreground' && readRunScopedExecutionPermissionRequestIdentity(id)) return false;
            if (params.preserveQuestions && isDurableAgentStructuredQuestionRequest(readStoredQuestionClassification(entry))) return false;
            if (params.turnId && !isPermissionRequestOwnedByPluginTurn({
                owner: normalizePermissionRequestOwner(entry.owner, 'stored'),
                ...(typeof entry.turnId === 'string' ? { turnId: entry.turnId } : {}),
                ...(entry.lifetime === 'occurrence' ? { lifetime: entry.lifetime } : {}),
            }, params.pluginId ?? '', params.turnId)) return false;
            if (params.source !== undefined && entry.source !== params.source) return false;
            return !params.pluginId || isPermissionRequestOwnedByPlugin(normalizePermissionRequestOwner(entry.owner, 'stored'), params.pluginId);
        };
        const selectedPublications = [...this.pendingPublications].filter(([id, publication]) => isSelected(id, publication.request));
        // This runner is the only writer of its Session's requests: every request it
        // publishes is either still a pending publication or already in its applied
        // snapshot. With neither selecting anything, a whole-Session cancellation has
        // nothing to retire, so Stop and "Send now" do not wait on a no-op Agent-state write.
        const localRequests = this.target.readState()?.requests ?? {};
        if (params.requestIds.length === 0 && selectedPublications.length === 0
            && !Object.entries(localRequests).some(([id, request]) =>
                isSelected(id, clonePlainObjectToNullProto(request) ?? Object.create(null)))) return [];
        // An already observed local retirement withdraws publication before IO.
        // Pre-effect cancellation keeps its ACK-before-retirement contract.
        if (params.observedRetirement) for (const [, publication] of selectedPublications) publication.cancel();
        // Classify each selected current row, not an unrelated Session claim.
        // Both persistence owners preserve ACK-before-return; only ordinary
        // cancellations additionally retain a private restart recovery intent.
        for (const durableRetirement of params.observedRetirement ? [true, false] : [false]) {
            const persist = durableRetirement ? this.target.settleRequests : this.target.updateState;
            const selectedRequests = new Map<string, AgentStateRequestCancellation>();
            await persist(
                (currentState) => {
                    // A CAS retry replaces the discarded attempt's selection.
                    selectedRequests.clear();
                    const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
                    const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                    const now = Date.now();

                    // A publication can reach Home without its ACK reaching this
                    // snapshot. Preserve the retired occurrence in the existing
                    // exact cancellation writer, without replacing newer answers.
                    if (params.observedRetirement) for (const [id, publication] of selectedPublications) {
                        if (!pendingRequests[id]
                            && deepEqual(completedRequests[id], publication.completedBeforePublication)
                            && this.canJournalRequestRetirement(id, publication.request) === durableRetirement) {
                            pendingRequests[id] = publication.request;
                        }
                    }

                    for (const [id, request] of Object.entries(pendingRequests)) {
                        const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                        if (!isSelected(id, entry)) continue;
                        if (params.observedRetirement && this.canJournalRequestRetirement(id, entry) !== durableRetirement) continue;
                        delete pendingRequests[id];
                        entry.completedAt = now;
                        entry.status = 'canceled';
                        entry.reason = params.reason;
                        if (typeof params.decision === 'string') {
                            entry.decision = params.decision;
                        }
                        removePermissionResponseClaim(entry);
                        completedRequests[id] = entry as AgentStateCompletedEntry;
                        selectedRequests.set(id, { requestId: id, completedRequest: entry });
                    }

                    // A caller includes an id here only when it admitted lifecycle
                    // cancellation before an in-flight ordinary completion
                    // persisted. A cancellation already written above (or by an
                    // earlier repeat) is the sole durable terminal result.
                    for (const id of params.requestIds) {
                        if (selectedRequests.has(id) || completedRequestsById.has(id)) continue;
                        const completed = completedRequests[id];
                        if (!completed) continue;
                        const entry = clonePlainObjectToNullProto(completed) ?? Object.create(null);
                        if (!isSelected(id, entry)) continue;
                        if (params.observedRetirement && this.canJournalRequestRetirement(id, entry) !== durableRetirement) continue;
                        if (entry.status === 'canceled') continue;
                        entry.completedAt = now;
                        entry.status = 'canceled';
                        entry.reason = params.reason;
                        if (typeof params.decision === 'string') {
                            entry.decision = params.decision;
                        } else {
                            delete entry.decision;
                        }
                        removePermissionResponseClaim(entry);
                        completedRequests[id] = entry as AgentStateCompletedEntry;
                        selectedRequests.set(id, { requestId: id, completedRequest: entry });
                    }

                    return {
                        ...currentState,
                        requests: pendingRequests,
                        completedRequests,
                    };
                },
            );
            for (const [id, subject] of selectedRequests) completedRequestsById.set(id, subject);
            this.confirmAppliedCompletions();
        }
        for (const requestId of completedRequestsById.keys()) {
            this.markPermissionRequestCompletedBestEffort(requestId);
            this.dispatchResponseTargetBestEffort(this.readCompletedResponseTarget(requestId));
        }
        for (const [, publication] of selectedPublications) publication.cancel();
        return [...completedRequestsById.values()];
    }

    dispose(): void {
        this.cancelPendingPublications();
        this.unsubscribeArchiveState?.();
        this.unsubscribeArchiveState = null;
        if (this.appliedCompletionOwner === this) this.retireAppliedCompletions();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
        if (this.ownsResponseTargetDispatcher) this.responseTargetDispatcher.dispose();
    }

    notifyPermissionRequestPushBestEffort(params: Readonly<{
        permissionId: string;
        toolName: string;
        toolInput: unknown;
        createdAtMs?: number;
    }>): void {
        if (this.target.readState()?.requests?.[params.permissionId]?.currentHandler?.kind === 'session') {
            void this.notifyRequestSourceCommitted(params.permissionId);
            return;
        }
        if (this.target.notifyRequest) {
            try {
                void Promise.resolve(this.target.notifyRequest({
                    requestId: params.permissionId,
                    toolName: params.toolName,
                    toolInput: params.toolInput,
                    createdAt: params.createdAtMs ?? Date.now(),
                })).catch((error) => {
                    logger.debug(`${this.logPrefix} Failed to notify permission request target (non-fatal)`, error);
                });
            } catch (error) {
                logger.debug(`${this.logPrefix} Failed to notify permission request target (non-fatal)`, error);
            }
            return;
        }
        const notifier = this.getOrCreatePermissionRequestPushNotifier();
        if (!notifier) {
            void this.notifyRequestSourceCommitted(params.permissionId);
            return;
        }

        try {
            const snapshot = this.target.readState() ?? null;
            const existing = snapshot?.requests?.[params.permissionId];
            const notifiedAt = typeof existing?.pushNotifiedAt === 'number' ? existing.pushNotifiedAt : null;
            if (typeof notifiedAt === 'number' && Number.isFinite(notifiedAt) && notifiedAt > 0) {
                notifier.markAlreadyNotified(params.permissionId);
                void this.notifyRequestSourceCommitted(params.permissionId);
                return;
            }
        } catch {
            // ignore
        }

        notifier.notify({
            permissionId: params.permissionId,
            toolName: params.toolName,
            toolInput: params.toolInput,
            requestKind: resolveAgentRequestKind(params.toolName, this.target.readState()?.requests?.[params.permissionId]?.kind),
            ...(typeof params.createdAtMs === 'number' ? { createdAtMs: params.createdAtMs } : {}),
        });
    }

    markPermissionRequestCompletedBestEffort(permissionId: string): void {
        const publication = this.pendingPublications.get(permissionId);
        const completed = this.target.readState()?.completedRequests?.[permissionId];
        if (publication && isSameAgentStateRequestOccurrence(publication.request, completed)) {
            publication.cancel();
        }
        if (completed) this.publishNativeEditTranscript(permissionId, completed);
        if (this.target.markRequestCompleted) {
            try {
                void Promise.resolve(this.target.markRequestCompleted(permissionId)).catch((error) => {
                    logger.debug(`${this.logPrefix} Failed to complete permission request target notification (non-fatal)`, error);
                });
            } catch (error) {
                logger.debug(`${this.logPrefix} Failed to complete permission request target notification (non-fatal)`, error);
            }
        }
        try {
            this.permissionRequestPushNotifier?.markCompleted(permissionId);
        } catch {
            // ignore
        }
    }

    private publishNativeEditTranscript(requestId: string, request: AgentStateRequestEntry | AgentStateCompletedEntry): void {
        const session = this.session;
        if (!session?.enqueueAgentMessageCommitted || request.sidechainId
            || readRunScopedExecutionPermissionRequestIdentity(requestId)) return;
        const { source, nativeChoices, turnId, createdAt, tool } = request;
        if ((source !== NATIVE_TOOL_APPROVAL_REQUEST_SOURCE && source !== NATIVE_TOOL_APPROVAL_ONCE_REQUEST_SOURCE)
            || tool.toLowerCase() !== 'edit' || !nativeChoices || typeof createdAt !== 'number') return;
        const operands: unknown = request.arguments;
        if (!operands || typeof operands !== 'object' || !('filepath' in operands) || !('diff' in operands)
            || typeof operands.filepath !== 'string' || typeof operands.diff !== 'string') return;

        const completed = 'status' in request ? request : undefined;
        const localId = `native-edit:${requestId}:${createdAt}:${completed ? 'settled' : 'pending'}`;
        const observationAt = completed?.completedAt ?? createdAt;
        const body: ACPMessageData = completed
            ? { type: 'tool-result', callId: requestId, id: localId, output: null, isError: completed.status !== 'approved',
                permissions: { date: observationAt, result: completed.status, ...(completed.decision ? { decision: completed.decision } : {}) } }
            : { type: 'tool-call', callId: requestId, id: localId, name: tool,
                input: { filepath: operands.filepath, diff: operands.diff },
                permission: { id: requestId, status: 'pending', source, ...(turnId ? { turnId } : {}), nativeChoices } };
        // Transcript readers get the offered operands, never a copy of the private request entry.
        void session.enqueueAgentMessageCommitted('happier', body, {
            localId, createdAt: observationAt, provenance: { kind: 'non_dependent', source: 'background' },
        }).then(result => {
            if (!result.persisted) logger.debug(`${this.logPrefix} Native Edit transcript observation was not persisted`);
        }, () => {
            logger.debug(`${this.logPrefix} Native Edit transcript observation failed`);
        });
    }

    /**
     * Terminal request mutations are not best-effort: callers must retain the
     * live request and avoid effects/waiter resolution when this write fails.
     */
    private canJournalRequestRetirement(requestId: string, entry: Record<string, unknown> | null): boolean {
        return !this.appliedCompletions.has(requestId)
            && !(entry && hasOpaquePermissionResponseClaim(entry))
            && !readResponseTarget(entry?.responseTarget);
    }

    private async updateAgentStateWithResponseDispatch(
        updater: (state: AgentState) => AgentStateUpdateWithResponseDispatch,
        durableRetirement = false,
    ): Promise<void> {
        let responseDispatch: AgentStateResponseTargetDispatch | null = null;
        let didRunUpdater = false;
        const persist = durableRetirement ? this.target.settleRequests : this.target.updateState;
        const result = persist((currentState) => {
            const next = updater(currentState);
            responseDispatch = next.responseDispatch ?? null;
            didRunUpdater = true;
            return next.state;
        });
        if (isPromiseLike(result)) {
            await Promise.resolve(result);
        }
        if (didRunUpdater) {
            this.dispatchResponseTargetBestEffort(responseDispatch);
        }
    }

    private async updateAgentStateAndWait(
        updater: (state: AgentState) => AgentState,
    ): Promise<void> {
        await Promise.resolve(this.target.updateState(updater));
        this.confirmAppliedCompletions();
    }

    private dispatchResponseTargetBestEffort(dispatch: AgentStateResponseTargetDispatch | null): void {
        if (dispatch && this.isSessionArchived() && isStoredQuestion(dispatch.completedRequest)) return;
        const delivery = this.responseTargetDispatcher.dispatch(dispatch, this.logPrefix);
        if (!dispatch || !delivery) return;
        void delivery.then(async (delivered) => {
            if (!delivered) return;
            await this.updateAgentStateAndWait((currentState) => {
                const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
                const entry = clonePlainObjectToNullProto(completedRequests[dispatch.requestId]);
                if (!entry || !deepEqual(entry.responseTarget, dispatch.responseTarget)) return currentState;
                delete entry.responseTarget;
                if (
                    entry.turnTerminalV1 === true
                    && !retainsPermissionGrant(entry)
                    && !hasOpaquePermissionResponseClaim(entry)
                ) {
                    delete completedRequests[dispatch.requestId];
                } else {
                    delete entry.turnTerminalV1;
                    completedRequests[dispatch.requestId] = entry as AgentStateCompletedEntry;
                }
                return { ...currentState, completedRequests };
            });
        }).catch((error) => {
            logger.debug(`${this.logPrefix} Failed to acknowledge delivered response target (non-fatal)`, error);
        });
    }

    private replayCompletedResponseTargetsForHandler(kind: string): void {
        const completedRequests = this.target.readState()?.completedRequests;
        if (!completedRequests || typeof completedRequests !== 'object' || Array.isArray(completedRequests)) return;

        for (const [requestId, completedRequest] of Object.entries(completedRequests)) {
            const dispatch = createResponseTargetDispatchFromUnknown(requestId, completedRequest);
            if (!dispatch || dispatch.responseTarget.kind !== kind) continue;
            this.dispatchResponseTargetBestEffort(dispatch);
        }
    }

    private getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        const session = this.session;
        if (!session) return null;
        const pushSender = this.getPushSender();
        if (!pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;

        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender,
            getSettings: () => this.getAccountSettings(),
            getSettingsSecretsReadKeys: () => this.getAccountSettingsSecretsReadKeys(),
            getSessionTitle: () => this.getSessionTitle(),
            getAgentDisplayName: () => this.getAgentDisplayName(),
            getRequestFollowEvent: (requestId) => {
                const request = this.target.readState()?.requests?.[requestId];
                return request ? readRequestFollowEvent(request) : null;
            },
            prepareRequestNotification: async (requestId) => {
                const request = this.target.readState()?.requests?.[requestId];
                if (!request || request.currentHandler?.kind === 'session') return null;
                const isCurrent = () => {
                    const current = this.target.readState()?.requests?.[requestId];
                    return Boolean(current && isSameAgentStateRequestOccurrence(current, request)
                        && deepEqual(current.currentHandler, request.currentHandler) && !this.isSessionArchived());
                };
                const result = await this.notifyRequestSourceCommitted(requestId);
                if (result === null || !isCurrent()) return null;
                const contribution = result?.personalFollow;
                const policies = contribution?.sourceSessionId === session.sessionId
                    ? contribution.requests?.find(candidate => candidate.requestId === requestId)?.policies : undefined;
                return { isCurrent, ...(request.turnId ? { turnId: request.turnId } : {}),
                    ...(policies ? { admittedRulePolicies: policies } : {}),
                    onNotifiedAt: (notifiedAtMs: number) => {
                        updateAgentStateBestEffort(
                            session,
                            (currentState) => {
                                if (!isSameAgentStateRequestOccurrence(currentState.requests?.[requestId], request)) return currentState;
                                return applyAgentStateRequestPushNotifiedAt({ state: currentState, permissionId: requestId, notifiedAtMs });
                            },
                            this.logPrefix,
                            'permission_request_push_notified_at',
                        );
                    },
                };
            },
            sessionId: session.sessionId,
            logPrefix: this.logPrefix,
        });

        return this.permissionRequestPushNotifier;
    }

    private async notifyRequestSourceCommitted(requestId: string): Promise<SessionActivityChangedResult | null | void> {
        const request = this.target.readState()?.requests?.[requestId];
        if (!request || request.sidechainId || readRunScopedExecutionPermissionRequestIdentity(requestId)) return;
        const evidence = SessionFollowRuleSourceEvidenceV1Schema.safeParse(request[SESSION_FOLLOW_RULE_EVIDENCE_META_KEY_V1]);
        if (!evidence.success) return;
        try {
            return await this.session?.notifySessionFollowRuleRequestCommitted?.({
                requestId, createdAt: request.createdAt,
                ...(request.turnId ? { turnId: request.turnId } : {}), evidence: evidence.data,
            });
        } catch (error) {
            logger.debug(`${this.logPrefix} Follow request notification failed; original request retained`, error);
        }
    }
}

type AgentStateRequestMetadata = Readonly<{
    nativeChoices?: NativePermissionChoicesV1 | null;
    questionV1?: SessionQuestionContextV1;
    currentHandler?: SessionQuestionHandlerV1;
    source?: string;
    turnId?: string;
    lifetime?: 'turn' | 'occurrence';
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
    mcpTool?: ResolvedMcpToolIdentityV1;
}>;

type AgentStateUpdateWithResponseDispatch = Readonly<{
    state: AgentState;
    responseDispatch?: AgentStateResponseTargetDispatch | null;
}>;

/**
 * Committed Agent state stores request arguments through the transcript redactor while a local
 * occurrence keeps the Agent's raw input, so arguments are compared in redacted form.
 */
export function isSameAgentStateRequestArguments(left: unknown, right: unknown): boolean {
    return deepEqual(redactTranscriptSecrets(left), redactTranscriptSecrets(right));
}

/** Compare occurrence custody across pending and completed request projections. */
export function isSameAgentStateRequestOccurrence(left: unknown, right: unknown): boolean {
    const first = clonePlainObjectToNullProto(left);
    const second = clonePlainObjectToNullProto(right);
    if (!first || !second) return false;
    const identity = (record: Record<string, unknown>) => {
        // Retirement lifetime does not mint a new occurrence; older stored rows omit it.
        const { currentHandler: _currentHandler, lifetime: _lifetime, ...metadata } = readAgentStateRequestMetadata(record);
        return {
            tool: record.tool, arguments: redactTranscriptSecrets(record.arguments), createdAt: record.createdAt,
            kind: typeof record.kind === 'string' ? record.kind
                : resolveAgentRequestKind(typeof record.tool === 'string' ? record.tool : ''),
            ...metadata,
        };
    };
    // Completion timestamps, decisions and delivery markers are not occurrence
    // identity. Native-effect application retains its stronger pendingIdentity fence.
    return deepEqual(identity(first), identity(second));
}

function readAgentStateRequestMetadata(entry: unknown): AgentStateRequestMetadata {
    const record = clonePlainObjectToNullProto(entry);
    if (!record) return {};

    const nativeChoices = NativePermissionChoicesV1Schema.safeParse(record.nativeChoices);
    const responseTarget = readResponseTarget(record.responseTarget);
    const turnId = TurnIdSchema.safeParse(record.turnId);
    const permissionSuggestions = Array.isArray(record.permissionSuggestions)
        ? [...record.permissionSuggestions]
        : undefined;
    const owner = normalizePermissionRequestOwner(record.owner, 'stored');
    const mcpTool = ResolvedMcpToolIdentityV1Schema.safeParse(record.mcpTool);
    const question = SessionQuestionContextV1Schema.safeParse(record.questionV1);
    const handler = SessionQuestionHandlerV1Schema.safeParse(record.currentHandler);
    return {
        ...(record.nativeChoices !== undefined ? { nativeChoices: nativeChoices.success ? nativeChoices.data : null } : {}),
        ...(question.success ? { questionV1: question.data } : {}),
        ...(handler.success ? { currentHandler: handler.data } : {}),
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
        ...(turnId.success ? { turnId: turnId.data } : {}),
        ...(record.lifetime === 'turn' || record.lifetime === 'occurrence' ? { lifetime: record.lifetime } : {}),
        ...(responseTarget ? { responseTarget } : {}),
        ...(typeof record.subagentRef !== 'undefined' ? { subagentRef: record.subagentRef } : {}),
        ...(typeof record.sidechainId === 'string' ? { sidechainId: record.sidechainId } : {}),
        ...(permissionSuggestions ? { permissionSuggestions } : {}),
        ...(owner ? { owner } : {}),
        ...(mcpTool.success ? { mcpTool: mcpTool.data } : {}),
    };
}

function applyAgentStateRequestMetadata(
    entry: Record<string, unknown>,
    metadata: Readonly<{
        nativeChoices?: NativePermissionChoicesV1 | null;
        questionV1?: SessionQuestionContextV1;
        currentHandler?: SessionQuestionHandlerV1;
        turnId?: string;
        lifetime?: 'turn' | 'occurrence';
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        owner?: PermissionRequestOwner | null;
        mcpTool?: ResolvedMcpToolIdentityV1;
    }>,
): void {
    if (metadata.nativeChoices !== undefined) entry.nativeChoices = metadata.nativeChoices;
    const turnId = TurnIdSchema.safeParse(metadata.turnId);
    const question = SessionQuestionContextV1Schema.safeParse(metadata.questionV1);
    const handler = SessionQuestionHandlerV1Schema.safeParse(metadata.currentHandler);
    if (question.success) entry.questionV1 = question.data;
    if (handler.success) entry.currentHandler = handler.data;
    const mcpTool = ResolvedMcpToolIdentityV1Schema.safeParse(metadata.mcpTool);
    if (mcpTool.success) entry.mcpTool = mcpTool.data;
    if (turnId.success) {
        entry.turnId = turnId.data;
    }
    if (metadata.lifetime !== undefined) entry.lifetime = metadata.lifetime;
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
    const owner = normalizePermissionRequestOwner(metadata.owner);
    if (owner) {
        entry.owner = owner;
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

function copyCompletedCoverageFields(
    target: Record<string, unknown>,
    completedEntry: Record<string, unknown>,
): void {
    const fields = [
        'completedAt',
        'status',
        'decision',
        'reason',
        'mode',
        'allowedTools',
        'updatedPermissions',
    ] as const;
    for (const field of fields) {
        if (typeof completedEntry[field] !== 'undefined') {
            target[field] = completedEntry[field];
        }
    }
}

function removeRequestsCoveredByCompletedEntry(params: Readonly<{
    requestCoverage?: AgentStateRequestCoverageOptions;
    completedRequestId: string;
    completedEntry: AgentStateCompletedEntry;
    requests: Record<string, AgentStateRequestEntry>;
    completedRequests: Record<string, AgentStateCompletedEntry>;
    markCompleted: (requestId: string) => void;
}>): void {
    const completedRequestsForCoverage: Record<string, unknown> = {
        [params.completedRequestId]: params.completedEntry,
    };

    for (const [requestId, request] of Object.entries(params.requests)) {
        if (requestId === params.completedRequestId) continue;
        if (!isAgentStateRequestCoveredByCompletedRequests({
            requestId,
            request,
            completedRequests: completedRequestsForCoverage,
            options: params.requestCoverage,
        })) {
            continue;
        }

        delete params.requests[requestId];
        const coveredEntry = clonePlainObjectToNullProto(request) ?? Object.create(null);
        removePermissionResponseClaim(coveredEntry);
        copyCompletedCoverageFields(coveredEntry, params.completedEntry as Record<string, unknown>);
        params.completedRequests[requestId] = coveredEntry as AgentStateCompletedEntry;
        params.markCompleted(requestId);
    }
}

function removePermissionResponseClaim(entry: Record<string, unknown>): void {
    delete entry.permissionResponseClaimV1;
}

function hasOpaquePermissionResponseClaim(entry: Record<string, unknown>): boolean {
    return Object.prototype.hasOwnProperty.call(entry, 'permissionResponseClaimV1');
}

function retainsPermissionGrant(entry: Record<string, unknown>): boolean {
    return entry.decision === 'approved_for_session'
        || entry.decision === 'approved_execpolicy_amendment'
        || entry.scope === 'session'
        || (Array.isArray(entry.allowedTools) && entry.allowedTools.length > 0)
        || typeof entry.updatedPermissions !== 'undefined';
}

function readPermissionResponseClaim(value: unknown, source: 'input' | 'stored' = 'input'): PermissionResponseClaim | null {
    const record = clonePlainObjectToNullProto(value);
    if (!record || record.version !== 1 || typeof record.origin !== 'string') return null;

    if (record.origin === 'approvalReviewer') {
        const parsed = (source === 'stored' ? createStoredReadSchema(SessionPermissionApprovalReviewerClaimV1Schema) : SessionPermissionApprovalReviewerClaimV1Schema).safeParse(record);
        return parsed.success ? parsed.data : null;
    }

    if (record.origin === 'automaticPolicy') {
        return source === 'stored' || hasExactlyKeys(record, ['version', 'origin'])
            ? { version: 1, origin: 'automaticPolicy' }
            : null;
    }

    const hasNativeChoice = record.nativeChoice !== undefined;
    const nativeChoice = hasNativeChoice ? NativePermissionChoiceAnswerV1Schema.safeParse(record.nativeChoice) : null;
    if (nativeChoice && !nativeChoice.success) return null;
    if (record.origin === 'presentUser') {
        const hasTurnId = Object.prototype.hasOwnProperty.call(record, 'turnId');
        if (source === 'input' && !hasExactlyKeys(
            record,
            [...(hasTurnId
                ? ['version', 'origin', 'actor', 'turnId', 'decision', 'scope']
                : ['version', 'origin', 'actor', 'decision', 'scope']), ...(hasNativeChoice ? ['nativeChoice'] : [])],
        )) return null;
        const actor = (source === 'stored' ? createStoredReadSchema(SessionPermissionAccountUserDecisionActorV1Schema) : SessionPermissionAccountUserDecisionActorV1Schema).safeParse(record.actor);
        const turnId = hasTurnId ? TurnIdSchema.safeParse(record.turnId) : null;
        if (!actor.success) return null;
        if (turnId && !turnId.success) return null;
        if (
            record.decision !== 'approved'
            && record.decision !== 'approved_for_session'
            && record.decision !== 'approved_execpolicy_amendment'
            && record.decision !== 'denied'
            && record.decision !== 'abort'
        ) return null;
        if (record.scope !== 'request' && record.scope !== 'session') return null;
        if (
            (record.decision === 'approved_for_session' && record.scope !== 'session')
            || (record.decision !== 'approved_for_session' && record.scope !== 'request')
        ) return null;
        return {
            version: 1,
            origin: 'presentUser',
            ...(nativeChoice?.success ? { nativeChoice: nativeChoice.data } : {}),
            actor: actor.data,
            ...(turnId?.success ? { turnId: turnId.data } : {}),
            decision: record.decision,
            scope: record.scope,
        };
    }

    if (record.origin !== 'remoteMediation') return null;
    if (source === 'input' && !hasExactlyKeys(record, [
        'version',
        'origin',
        'actor',
        'mediatorPluginId',
        'turnId',
        'sourceRef',
        'sourceRevisionOrEpoch',
        'idempotencyKey',
        'decision',
        'scope',
        ...(hasNativeChoice ? ['nativeChoice'] : []),
    ])) return null;
    const actor = (source === 'stored' ? createStoredReadSchema(SessionPermissionExternalHumanDecisionActorV1Schema) : SessionPermissionExternalHumanDecisionActorV1Schema).safeParse(record.actor);
    const mediatorPluginId = PluginIdSchema.safeParse(record.mediatorPluginId);
    const turnId = TurnIdSchema.safeParse(record.turnId);
    const sourceRef = SessionPermissionSourceRefV1Schema.safeParse(record.sourceRef);
    const sourceRevisionOrEpoch = SessionPermissionSourceRevisionOrEpochV1Schema.safeParse(record.sourceRevisionOrEpoch);
    const idempotencyKey = SessionPermissionIdempotencyKeyV1Schema.safeParse(record.idempotencyKey);
    if (
        !actor.success
        || !mediatorPluginId.success
        || !turnId.success
        || !sourceRef.success
        || !sourceRevisionOrEpoch.success
        || !idempotencyKey.success
        || actor.data.assertedBy.pluginId !== mediatorPluginId.data
        || (record.decision !== 'allow' && record.decision !== 'deny')
        || (record.scope !== 'request' && record.scope !== 'session')
    ) return null;
    return {
        version: 1,
        origin: 'remoteMediation',
        ...(nativeChoice?.success ? { nativeChoice: nativeChoice.data } : {}),
        actor: actor.data,
        mediatorPluginId: mediatorPluginId.data,
        turnId: turnId.data,
        sourceRef: sourceRef.data,
        sourceRevisionOrEpoch: sourceRevisionOrEpoch.data,
        idempotencyKey: idempotencyKey.data,
        decision: record.decision,
        scope: record.scope,
    };
}

function hasExactlyKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(record);
    return actualKeys.length === expectedKeys.length && actualKeys.every((key) => expectedKeys.includes(key));
}

function permissionResponseClaimsEqual(
    left: PermissionResponseClaim,
    right: PermissionResponseClaim,
): boolean {
    if (left.origin !== right.origin) return false;
    if (left.origin === 'automaticPolicy' && right.origin === 'automaticPolicy') return true;
    if (left.origin === 'automaticPolicy' || right.origin === 'automaticPolicy') return false;
    if (left.decision !== right.decision || left.scope !== right.scope) return false;
    if (left.origin === 'approvalReviewer' && right.origin === 'approvalReviewer') {
        return left.turnId === right.turnId;
    }
    if (left.origin === 'presentUser' && right.origin === 'presentUser') {
        if (!deepEqual(left.nativeChoice, right.nativeChoice)) return false;
        return left.actor.accountId === right.actor.accountId
            && left.actor.relationship === right.actor.relationship
            && left.turnId === right.turnId;
    }
    if (left.origin !== 'remoteMediation' || right.origin !== 'remoteMediation') return false;
    if (!deepEqual(left.nativeChoice, right.nativeChoice)) return false;
    return (
        left.actor.namespace === right.actor.namespace
        && left.actor.principalId === right.actor.principalId
        && left.actor.assertedBy.pluginId === right.actor.assertedBy.pluginId
        // Contribution-local identity is currentness evidence for the live
        // invocation, not durable retry identity. A contribution replacement
        // may rejoin this source-bound response tuple.
        && left.mediatorPluginId === right.mediatorPluginId
        && left.turnId === right.turnId
        && left.sourceRef === right.sourceRef
        && left.sourceRevisionOrEpoch === right.sourceRevisionOrEpoch
        && left.idempotencyKey === right.idempotencyKey
    );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return Boolean(value) && typeof (value as { then?: unknown }).then === 'function';
}
