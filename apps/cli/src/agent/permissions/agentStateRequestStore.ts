import type { AgentState } from '@/api/types';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { HAPPIER_ACTION_REQUEST_SOURCE, resolveAgentRequestKind } from '@/agent/permissions/requestKind';
import {
    applyAgentStateRequestPushNotifiedAt,
    clonePlainObjectToNullProto,
    cloneStringKeyedRecordToNullProto,
} from '@/api/session/agentStateRecords';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from '@/agent/permissions/BasePermissionHandler';
import { logger } from '@/ui/logger';
import { deepEqual } from '@/utils/deterministicJson';
import {
    isAgentStateRequestCoveredByCompletedRequests,
    resolveAgentStateRequestCoverageOptions,
} from '@happier-dev/agents';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { SessionPermissionApprovalReviewerClaimV1Schema, SessionPermissionAccountUserDecisionActorV1Schema, SessionPermissionExternalHumanDecisionActorV1Schema, SessionPermissionIdempotencyKeyV1Schema, SessionPermissionSourceRefV1Schema, SessionPermissionSourceRevisionOrEpochV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import { TurnIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import type { AccountSettings, SessionPermissionApprovalReviewerClaimV1, SessionPermissionAccountUserDecisionActorV1, SessionPermissionExternalHumanDecisionActorV1 } from '@happier-dev/protocol';
import {
    getSessionNotificationAgentDisplayName,
    getSessionNotificationTitle,
} from '@/agent/runtime/notifications/sessionNotificationContext';
import {
    isPermissionRequestOwnedByPlugin,
    normalizePermissionRequestOwner,
    type PermissionRequestOwner,
} from './permissionRequestOwner';

type AgentStateRequestEntry = NonNullable<AgentState['requests']>[string];
type AgentStateCompletedEntry = NonNullable<AgentState['completedRequests']>[string];

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
        actor: SessionPermissionAccountUserDecisionActorV1;
        /** Exact host turn for current stamped requests; absent only for released legacy rows. */
        turnId?: string;
        decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        scope: 'request' | 'session';
    }>
    | Readonly<{
        version: 1;
        origin: 'remoteMediation';
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

const PENDING_REQUEST_COVERAGE_OPTIONS = resolveAgentStateRequestCoverageOptions({
    kind: 'localPermissionBridge',
});

export type AgentStateRequestResponseTarget = Readonly<{ kind: string } & Record<string, unknown>>;

export type AgentStateResponseTargetDispatch = Readonly<{
    requestId: string;
    responseTarget: AgentStateRequestResponseTarget;
    completedRequest: Readonly<Record<string, unknown>>;
}>;

/**
 * A target handler may explicitly report an unsuccessful delivery. Legacy
 * handlers that return void remain compatible and are treated as having
 * accepted the dispatch.
 */
export type AgentStateResponseTargetHandler = (
    dispatch: AgentStateResponseTargetDispatch,
) => boolean | void | PromiseLike<boolean | void>;
export type AgentStateRequestStoreUnsubscribe = () => void;

/** Session-owned delivery registrations shared by permission store views. */
export class AgentStateResponseTargetDispatcher {
    private readonly handlers = new Map<string, AgentStateResponseTargetHandler>();

    register(kind: string, handler: AgentStateResponseTargetHandler): AgentStateRequestStoreUnsubscribe {
        const normalizedKind = kind.trim();
        if (!normalizedKind) throw new Error('Response target handler kind must be a non-empty string');
        if (this.handlers.has(normalizedKind)) {
            throw new Error(`Response target handler already registered for kind ${normalizedKind}`);
        }
        this.handlers.set(normalizedKind, handler);
        return () => {
            if (this.handlers.get(normalizedKind) === handler) this.handlers.delete(normalizedKind);
        };
    }

    kinds(): IterableIterator<string> {
        return this.handlers.keys();
    }

    dispose(): void {
        this.handlers.clear();
    }

    dispatch(dispatch: AgentStateResponseTargetDispatch | null, logPrefix: string): Promise<boolean> | null {
        if (!dispatch) return null;

        const handler = this.handlers.get(dispatch.responseTarget.kind);
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
    createdAt: number;
    /** Exact host turn that owns a source-mediated pending permission. */
    turnId?: string;
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
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    getAgentStateSnapshot?: () => AgentState | null | undefined;
    getMetadataSnapshot?: () => unknown;
    getAgentStateResponseTargetDispatcher?: () => AgentStateResponseTargetDispatcher;
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
    createdAt: number;
    turnId?: string;
    kind?: string;
    source?: string;
    responseTarget?: AgentStateRequestResponseTarget | null;
    subagentRef?: unknown;
    sidechainId?: string | null;
    permissionSuggestions?: readonly unknown[] | null;
    owner?: PermissionRequestOwner | null;
    updateState?: (state: AgentState) => AgentState;
}>;

function createSessionPersistenceTarget(session: SessionLike): AgentStateRequestPersistenceTarget {
    return Object.freeze({
        scopeId: session.sessionId,
        readState: () => session.getAgentStateSnapshot?.() ?? null,
        updateState: (updater) => session.updateAgentState(updater),
        ...(session.getAgentStateResponseTargetDispatcher
            ? { getResponseTargetDispatcher: () => session.getAgentStateResponseTargetDispatcher!() }
            : {}),
    });
}

export class AgentStateRequestStore {
    private target: AgentStateRequestPersistenceTarget;
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
    }>) {
        if ((params.session ? 1 : 0) + (params.target ? 1 : 0) !== 1) {
            throw new Error('AgentStateRequestStore requires exactly one persistence target');
        }
        this.session = params.session ?? null;
        this.target = params.target ?? createSessionPersistenceTarget(params.session!);
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
    }

    updateSession(session: SessionLike): void {
        const nextTarget = createSessionPersistenceTarget(session);
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
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;

        // Handlers outlive the transport reference. The completed projection
        // is the durable recovery source, so each authoritative rebind gets
        // one best-effort, at-least-once replay through the existing handler.
        for (const kind of [...this.responseTargetDispatcher.kinds()]) {
            this.replayCompletedResponseTargetsForHandler(kind);
        }
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
            const storedClaim = hasStoredClaim ? readPermissionResponseClaim(existing.permissionResponseClaimV1) : null;
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
            const storedClaim = readPermissionResponseClaim(existing.permissionResponseClaimV1);
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

            const storedClaim = readPermissionResponseClaim(existing.permissionResponseClaimV1);
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
        if (!entry || typeof entry.tool !== 'string' || resolveAgentRequestKind(entry.tool) !== 'permission') {
            return { status: 'not_settled' };
        }

        const hasActor = Object.prototype.hasOwnProperty.call(entry, 'permissionDecisionActorV1');
        if (!hasActor) return { status: 'not_settled' };
        const actor = SessionPermissionAccountUserDecisionActorV1Schema.safeParse(entry.permissionDecisionActorV1);
        if (!actor.success) return { status: 'conflict' };
        const turnId = TurnIdSchema.safeParse(entry.turnId);

        const completedClaim = readPermissionResponseClaim({
            version: 1,
            origin: 'presentUser',
            actor: actor.data,
            ...(turnId.success ? { turnId: turnId.data } : {}),
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
    ): AgentStateRequestStoreUnsubscribe {
        const unsubscribe = this.responseTargetDispatcher.register(kind, handler);
        this.replayCompletedResponseTargetsForHandler(kind.trim());
        return unsubscribe;
    }

    private beginRequestPublication(params: AgentStateRequestPublication): Readonly<{
        result: Promise<void> | void;
        notify: () => void;
    }> {
        let shouldNotify = false;
        let didRunUpdater = false;
        const notify = () => {
            if (!didRunUpdater || !shouldNotify) return;
            this.notifyPermissionRequestPushBestEffort({
                permissionId: params.requestId,
                toolName: params.toolName,
                toolInput: params.toolInput,
                createdAtMs: params.createdAt,
            });
        };

        const result = this.target.updateState((currentState) => {
            didRunUpdater = true;
            const requests = cloneStringKeyedRecordToNullProto<AgentStateRequestEntry>(currentState.requests);
            const completedRequests = cloneStringKeyedRecordToNullProto<AgentStateCompletedEntry>(currentState.completedRequests);
            const existingOutstanding = clonePlainObjectToNullProto(requests[params.requestId]);
            const entry = Object.create(null) as AgentStateRequestEntry & { source?: string; permissionSuggestions?: readonly unknown[] };
            entry.tool = params.toolName;
            entry.kind = params.kind ?? resolveAgentRequestKind(params.toolName);
            entry.arguments = params.toolInput;
            entry.createdAt = params.createdAt;
            if (existingOutstanding && Object.prototype.hasOwnProperty.call(existingOutstanding, 'permissionResponseClaimV1')) {
                // A restarted handler can republish the same canonical
                // outstanding request. Preserve even a malformed prior
                // value so acquisition continues to fail closed rather
                // than accidentally clearing a first-answer authority.
                entry.permissionResponseClaimV1 = existingOutstanding.permissionResponseClaimV1;
            }
            if (typeof params.source === 'string') {
                entry.source = params.source;
            }
            if (Array.isArray(params.permissionSuggestions) && params.permissionSuggestions.length > 0) {
                entry.permissionSuggestions = [...params.permissionSuggestions];
            }
            applyAgentStateRequestMetadata(entry, params);
            delete completedRequests[params.requestId];
            if (isAgentStateRequestCoveredByCompletedRequests({
                requestId: params.requestId,
                request: entry,
                completedRequests,
                options: PENDING_REQUEST_COVERAGE_OPTIONS,
            })) {
                const coveredState: AgentState = {
                    ...currentState,
                    completedRequests,
                };
                return typeof params.updateState === 'function' ? params.updateState(coveredState) : coveredState;
            }
            requests[params.requestId] = entry;
            shouldNotify = true;

            const nextState: AgentState = {
                ...currentState,
                requests,
                completedRequests,
            };
            return typeof params.updateState === 'function' ? params.updateState(nextState) : nextState;
        });
        return { result, notify };
    }

    publishRequest(params: AgentStateRequestPublication): void {
        try {
            const publication = this.beginRequestPublication(params);
            const { result } = publication;
            if (isPromiseLike(result)) {
                void Promise.resolve(result)
                    .then(publication.notify)
                    .catch((error) => {
                        logger.debug(`${this.logPrefix} Failed to update agent state (publish_request) (non-fatal)`, error);
                    });
                return;
            }

            publication.notify();
        } catch (error) {
            logger.debug(`${this.logPrefix} Failed to update agent state (publish_request) (non-fatal)`, error);
        }
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

    async completeRequest(params: Readonly<{
        requestId: string;
        status: string;
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
            toolInput: unknown;
            createdAt: number;
            turnId?: string;
            kind?: string;
            source?: string;
            responseTarget?: AgentStateRequestResponseTarget | null;
            subagentRef?: unknown;
            sidechainId?: string | null;
            permissionSuggestions?: readonly unknown[] | null;
            owner?: PermissionRequestOwner | null;
        }> | null;
        updateState?: (state: AgentState) => AgentState;
    }>): Promise<boolean> {
        const completedRequestIds = new Set<string>();
        let didCompleteRequest = false;
        await this.updateAgentStateWithResponseDispatch(
            (currentState) => {
                const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const existing = requests[params.requestId] as unknown;
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                if (!existing && (!params.fallback || completedRequests[params.requestId])) {
                    return { state: currentState };
                }
                const existingEntry = clonePlainObjectToNullProto(existing);
                if (params.isCurrent && !params.isCurrent()) {
                    return { state: currentState };
                }
                if (
                    params.status === 'canceled'
                    && existingEntry
                    && hasOpaquePermissionResponseClaim(existingEntry)
                ) {
                    // A persisted first-answer claim is an active terminal owner.
                    // Cancellation cannot turn it into a different terminal state
                    // while its owner may still be linearizing the response.
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

                removePermissionResponseClaim(completedEntry);

                completedRequests[params.requestId] = completedEntry as AgentStateCompletedEntry;
                removeRequestsCoveredByCompletedEntry({
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
                    state: finalState,
                    responseDispatch: createResponseTargetDispatchFromUnknown(params.requestId, finalCompletedEntry),
                };
            },
        );

        if (!didCompleteRequest) return false;
        completedRequestIds.add(params.requestId);
        for (const requestId of completedRequestIds) {
            this.markPermissionRequestCompletedBestEffort(requestId);
        }
        return true;
    }

    async retireCompletedRequestsForTurn(turnId: string): Promise<void> {
        const normalizedTurnId = turnId.trim();
        if (!normalizedTurnId) return;
        await this.updateAgentStateAndWait((currentState) => {
            const requests = cloneStringKeyedRecordToNullProto(currentState.requests);
            if (Object.values(requests).some((rawEntry) => (
                clonePlainObjectToNullProto(rawEntry)?.turnId === normalizedTurnId
            ))) return currentState;

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
                        mutableEntry[key] = value;
                    }
                }
                removePermissionResponseClaim(entry as Record<string, unknown>);
                completedRequests[params.requestId] = entry;
                removeRequestsCoveredByCompletedEntry({
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
        completedRequestIds.add(params.requestId);
        for (const requestId of completedRequestIds) {
            this.markPermissionRequestCompletedBestEffort(requestId);
        }
        return true;
    }

    async cancelAllRequests(params: Readonly<{
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<void> {
        await this.cancelRequests(params);
    }

    async cancelRequestsByOwner(params: Readonly<{
        owner: PermissionRequestOwner;
        reason: string;
        decision?: string;
        requestIds: readonly string[];
    }>): Promise<void> {
        await this.cancelRequests({
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
        reason: string;
        decision?: string;
        requestIds: readonly string[];
        pluginId?: string;
        source?: string;
    }>): Promise<void> {
        const completedRequestIds = new Set<string>();
        await this.updateAgentStateAndWait(
            (currentState) => {
                const pendingRequests = cloneStringKeyedRecordToNullProto(currentState.requests);
                const completedRequests = cloneStringKeyedRecordToNullProto(currentState.completedRequests);
                const now = Date.now();

                for (const [id, request] of Object.entries(pendingRequests)) {
                    const entry = clonePlainObjectToNullProto(request) ?? Object.create(null);
                    if (params.source !== undefined && entry.source !== params.source) continue;
                    if (
                        params.pluginId
                        && !isPermissionRequestOwnedByPlugin(
                            normalizePermissionRequestOwner(entry.owner),
                            params.pluginId,
                        )
                    ) {
                        continue;
                    }
                    delete pendingRequests[id];
                    entry.completedAt = now;
                    entry.status = 'canceled';
                    entry.reason = params.reason;
                    if (typeof params.decision === 'string') {
                        entry.decision = params.decision;
                    }
                    removePermissionResponseClaim(entry);
                    completedRequests[id] = entry as AgentStateCompletedEntry;
                    completedRequestIds.add(id);
                }

                // A caller includes an id here only when it admitted lifecycle
                // cancellation before an in-flight ordinary completion
                // persisted. A cancellation already written above (or by an
                // earlier repeat) is the sole durable terminal result.
                for (const id of params.requestIds) {
                    if (completedRequestIds.has(id)) continue;
                    const completed = completedRequests[id];
                    if (!completed) continue;
                    const entry = clonePlainObjectToNullProto(completed) ?? Object.create(null);
                    if (params.source !== undefined && entry.source !== params.source) continue;
                    if (entry.status === 'canceled') continue;
                    if (
                        params.pluginId
                        && !isPermissionRequestOwnedByPlugin(
                            normalizePermissionRequestOwner(entry.owner),
                            params.pluginId,
                        )
                    ) {
                        continue;
                    }
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
                    completedRequestIds.add(id);
                }

                return {
                    ...currentState,
                    requests: pendingRequests,
                    completedRequests,
                };
            },
        );
        for (const requestId of completedRequestIds) {
            this.markPermissionRequestCompletedBestEffort(requestId);
            this.dispatchResponseTargetBestEffort(this.readCompletedResponseTarget(requestId));
        }
    }

    dispose(): void {
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
        if (!notifier) return;

        try {
            const snapshot = this.target.readState() ?? null;
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

    /**
     * Terminal request mutations are not best-effort: callers must retain the
     * live request and avoid effects/waiter resolution when this write fails.
     */
    private async updateAgentStateWithResponseDispatch(
        updater: (state: AgentState) => AgentStateUpdateWithResponseDispatch,
    ): Promise<void> {
        let responseDispatch: AgentStateResponseTargetDispatch | null = null;
        let didRunUpdater = false;
        const result = this.target.updateState((currentState) => {
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
    }

    private dispatchResponseTargetBestEffort(dispatch: AgentStateResponseTargetDispatch | null): void {
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
            sessionId: session.sessionId,
            logPrefix: this.logPrefix,
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                updateAgentStateBestEffort(
                    session,
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
    turnId?: string;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
}>;

type AgentStateUpdateWithResponseDispatch = Readonly<{
    state: AgentState;
    responseDispatch?: AgentStateResponseTargetDispatch | null;
}>;

function readAgentStateRequestMetadata(entry: unknown): AgentStateRequestMetadata {
    const record = clonePlainObjectToNullProto(entry);
    if (!record) return {};

    const responseTarget = readResponseTarget(record.responseTarget);
    const turnId = TurnIdSchema.safeParse(record.turnId);
    const permissionSuggestions = Array.isArray(record.permissionSuggestions)
        ? [...record.permissionSuggestions]
        : undefined;
    const owner = normalizePermissionRequestOwner(record.owner);
    return {
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
        ...(turnId.success ? { turnId: turnId.data } : {}),
        ...(responseTarget ? { responseTarget } : {}),
        ...(typeof record.subagentRef !== 'undefined' ? { subagentRef: record.subagentRef } : {}),
        ...(typeof record.sidechainId === 'string' ? { sidechainId: record.sidechainId } : {}),
        ...(permissionSuggestions ? { permissionSuggestions } : {}),
        ...(owner ? { owner } : {}),
    };
}

function applyAgentStateRequestMetadata(
    entry: Record<string, unknown>,
    metadata: Readonly<{
        turnId?: string;
        responseTarget?: AgentStateRequestResponseTarget | null;
        subagentRef?: unknown;
        sidechainId?: string | null;
        permissionSuggestions?: readonly unknown[] | null;
        owner?: PermissionRequestOwner | null;
    }>,
): void {
    const turnId = TurnIdSchema.safeParse(metadata.turnId);
    if (turnId.success) {
        entry.turnId = turnId.data;
    }
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
            options: PENDING_REQUEST_COVERAGE_OPTIONS,
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

function readPermissionResponseClaim(value: unknown): PermissionResponseClaim | null {
    const record = clonePlainObjectToNullProto(value);
    if (!record || record.version !== 1 || typeof record.origin !== 'string') return null;

    if (record.origin === 'approvalReviewer') {
        const parsed = SessionPermissionApprovalReviewerClaimV1Schema.safeParse(record);
        return parsed.success ? parsed.data : null;
    }

    if (record.origin === 'automaticPolicy') {
        return hasExactlyKeys(record, ['version', 'origin'])
            ? { version: 1, origin: 'automaticPolicy' }
            : null;
    }

    if (record.origin === 'presentUser') {
        const hasTurnId = Object.prototype.hasOwnProperty.call(record, 'turnId');
        if (!hasExactlyKeys(
            record,
            hasTurnId
                ? ['version', 'origin', 'actor', 'turnId', 'decision', 'scope']
                : ['version', 'origin', 'actor', 'decision', 'scope'],
        )) return null;
        const actor = SessionPermissionAccountUserDecisionActorV1Schema.safeParse(record.actor);
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
            actor: actor.data,
            ...(turnId?.success ? { turnId: turnId.data } : {}),
            decision: record.decision,
            scope: record.scope,
        };
    }

    if (record.origin !== 'remoteMediation') return null;
    if (!hasExactlyKeys(record, [
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
    ])) return null;
    const actor = SessionPermissionExternalHumanDecisionActorV1Schema.safeParse(record.actor);
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
        return left.actor.accountId === right.actor.accountId
            && left.actor.relationship === right.actor.relationship
            && left.turnId === right.turnId;
    }
    if (left.origin !== 'remoteMediation' || right.origin !== 'remoteMediation') return false;
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
