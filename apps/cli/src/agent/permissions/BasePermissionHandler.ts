/**
 * Base Permission Handler
 *
 * Abstract base class for permission handlers that manage tool approval requests.
 * Shared by Codex and Gemini permission handlers.
 *
 * @module BasePermissionHandler
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/session/sessionClient";
import { AgentState } from "@/api/types";
import { updateAgentStateBestEffort as updateAgentStateBestEffortShared } from "@/api/session/sessionWritesBestEffort";
import { isToolAllowedForSession, makeToolIdentifier } from './permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist } from './applyPermissionAllowlistUpdates';
import { recordToolTraceEvent, type ToolTraceProtocol } from '@/agent/tools/trace/toolTrace';
import {
    PluginContributionLocalIdSchema,
    PluginIdSchema,
    SessionPermissionExternalHumanDecisionActorV1Schema,
    SessionInputCausalPermissionAuthorityV1Schema,
    SessionPermissionRemoteRespondInputV1Schema,
    SessionPermissionRemoteGrantRecordV1Schema,
    SessionPermissionRemoteSettlementRecordV1Schema,
    SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX,
    SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX,
    SessionPermissionRequestIdV1Schema,
    StructuredQuestionAnswersV1Schema,
    TurnIdSchema,
    type AccountSettings,
    type SessionPermissionRemoteRespondInputV1,
    type SessionPermissionRemoteRespondOutputV1,
    type SessionPermissionRemotePendingListOutputV1,
    type SessionPermissionRemoteGrantRecordV1,
    type SessionPermissionRemoteGrantsListOutputV1,
    type SessionPermissionRemoteGrantRevokeOutputV1,
    type SessionPermissionMediationRecordIdentityV1,
    type SessionPermissionExternalHumanDecisionActorV1,
    type SessionPermissionSourceAuthorityV1,
    type StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';
import { CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE } from '@happier-dev/protocol/agents/claude';
import {
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
    parseSocketRpcAuthorizationContext,
    type SocketRpcSessionPermissionRespondAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type {
    PermissionRequestPushSender as PermissionRequestPushSenderFromSettings,
} from '@/settings/notifications/permissionRequestPush';
import { resolveAgentRequestKind } from './requestKind';
import { AgentStateRequestStore } from './agentStateRequestStore';
import type {
    AgentStateOutstandingRequest,
    AgentStateRequestResponseTarget,
    PermissionResponseClaim,
} from './agentStateRequestStore';
import {
    createPermissionRequestCoordinator,
    type PermissionRequestCoordinator,
    type PermissionRequestCoordinatorCompletedRequest,
    type PermissionRequestCoordinatorContext,
} from './permissionRequestCoordinator';
import {
    isPermissionRequestOwnedByPlugin,
    normalizePermissionRequestOwner,
    type PermissionRequestOwner,
} from './permissionRequestOwner';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';
import type {
    PermissionMediationRecordStore,
    PermissionMediationStoredRecord,
    PermissionMediationRecordWrite,
} from './mediation/permissionMediationRecordStore';
import { createPermissionMediationRecordStore } from './mediation/permissionMediationRecordStore';

type AgentStateRequestStoreBindableSession = Readonly<{
    bindAgentStateRequestStore?: (store: AgentStateRequestStore) => void;
}>;

export type PermissionRequestPushSender = PermissionRequestPushSenderFromSettings;

/**
 * Permission response from the mobile app.
 */
export interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    // When the user chooses "don't ask again (session)", the UI may send a tool allowlist.
    allowedTools?: string[];
    allowTools?: string[]; // legacy alias
    // Claude Agent SDK / Claude Code hook responses may attach provider-specific permission updates.
    updatedPermissions?: unknown;
    /**
     * Structured user answers (AskUserQuestion user action).
     *
     * When present, the agent can complete the request without requiring an additional free-form user message.
     */
    answers?: StructuredQuestionAnswersV1 | Readonly<Record<string, string>>;
    execPolicyAmendment?: {
        command: string[];
    };
}

/**
 * Pending permission request stored while awaiting user response.
 */
export interface PendingRequest {
    resolve: (value: PermissionResult) => void;
    reject: (error: Error) => void;
    toolName: string;
    input: unknown;
    responseTarget?: AgentStateRequestResponseTarget;
    subagentRef?: unknown;
    sidechainId?: string;
    permissionSuggestions?: readonly unknown[];
    owner?: PermissionRequestOwner;
    causalPermissionContext?: AcpPermissionCallContext;
    /**
     * A handler-owned policy reread for this pending request. The permission
     * owner remains here; this callback can only preserve or narrow a terminal
     * result using the handler's current causal mode/ceiling.
     */
    resolveCurrentPermissionDecision?: () => PermissionResult;
    coordinatorManaged?: boolean;
}

/**
 * Result of a permission request.
 */
export interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
    answers?: StructuredQuestionAnswersV1;
}

/**
 * Outcome of routing an inbound permission/user-action response to a pending request.
 *
 * `not_found` means the explicit request id is unknown (never seen / already gone) — the caller must
 * surface a typed failure instead of a fabricated success (gap 28/29).
 */
export type PermissionResponseRoutingResult =
    | { status: 'resolved' }
    | { status: 'not_found' }
    | { status: 'invalid' };

/**
 * Typed RPC result for `session.permission.respond` / `session.user_action.answer` / `permission`.
 *
 * Resolving a pending request returns `void` (unchanged success contract). An unknown explicit id
 * returns a typed `permission_request_not_found` so a stale UI tap cannot read as silent success.
 */
export type PermissionRespondRpcResult =
    | void
    | Readonly<{
        ok: false;
        errorCode:
            | 'permission_request_not_found'
            | 'permission_actor_unattributable'
            | 'permission_response_invalid';
        requestId: string;
    }>;

type UnknownRecord = Readonly<Record<string, unknown>>;
type ActiveRemoteMediationGrant = Extract<
    PermissionMediationStoredRecord,
    Readonly<{ kind: 'remote_grant.v1' }>
>;

type RemoteMediationLedgerAdmission =
    | Readonly<{ status: 'ready' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'sessionGrantCapacityExceeded' }>;

function asUnknownRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function hasOnlyKeys(record: UnknownRecord, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(record).every((key) => allowed.has(key));
}

function normalizePermissionRuleIdentifier(rule: unknown): string | null {
    if (typeof rule === 'string') return rule.trim() || null;
    const record = asUnknownRecord(rule);
    if (!record || !hasOnlyKeys(record, ['toolName', 'ruleContent'])) return null;
    const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
    if (!toolName) return null;
    if (typeof record.ruleContent === 'undefined') return toolName;
    if (typeof record.ruleContent !== 'string') return null;
    const ruleContent = record.ruleContent.trim();
    return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

function remoteMediationSourceAuthoritiesEqual(
    left: SessionPermissionSourceAuthorityV1,
    right: SessionPermissionSourceAuthorityV1,
): boolean {
    return left.kind === right.kind
        && left.mediatorPluginId === right.mediatorPluginId
        && left.sourceRef === right.sourceRef
        && left.sourceRevisionOrEpoch === right.sourceRevisionOrEpoch
        && left.admittedPermissionCeiling === right.admittedPermissionCeiling
        && left.remoteApprovalMaxScope === right.remoteApprovalMaxScope;
}

function mediationRecordIdentity(input: Readonly<{
    sessionId: string;
    turnId: string;
    requestId: string;
}>): SessionPermissionMediationRecordIdentityV1 {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        requestId: input.requestId,
    };
}

function mediationRecordIdentityKey(identity: SessionPermissionMediationRecordIdentityV1): string {
    return JSON.stringify([identity.sessionId, identity.turnId, identity.requestId]);
}

function isExactPendingPermissionUpdate(params: Readonly<{
    update: unknown;
    toolName: string;
    toolInput: unknown;
    permissionSuggestions?: readonly unknown[];
}>): boolean {
    const update = asUnknownRecord(params.update);
    if (!update) return false;
    if (update.type === 'setMode') {
        const generatedCurrentUiUpdate = hasOnlyKeys(update, ['type', 'mode', 'destination'])
            && update.mode === 'acceptEdits'
            && update.destination === 'session';
        return generatedCurrentUiUpdate
            || Boolean(params.permissionSuggestions?.some((suggestion) => isDeepStrictEqual(params.update, suggestion)));
    }
    if (update.type === 'addRules') {
        if (
            update.behavior !== 'allow'
            || update.destination !== 'session'
            || !hasOnlyKeys(update, ['type', 'rules', 'behavior', 'destination'])
            || !Array.isArray(update.rules)
            || update.rules.length === 0
        ) {
            return false;
        }
        return update.rules.every((rule) => {
            const identifier = normalizePermissionRuleIdentifier(rule);
            return identifier !== null
                && isToolAllowedForSession([identifier], params.toolName, params.toolInput);
        });
    }

    return Boolean(params.permissionSuggestions?.some((suggestion) => isDeepStrictEqual(params.update, suggestion)));
}

function readProposedExecPolicyAmendment(input: unknown): readonly string[] | null {
    const record = asUnknownRecord(input);
    if (!record) return null;
    const camelProposal = record.proposedExecpolicyAmendment;
    const snakeProposal = record.proposed_execpolicy_amendment;
    if (
        typeof camelProposal !== 'undefined'
        && typeof snakeProposal !== 'undefined'
        && !isDeepStrictEqual(camelProposal, snakeProposal)
    ) {
        return null;
    }
    const proposal = camelProposal ?? snakeProposal;
    if (!Array.isArray(proposal) || proposal.length === 0) return null;
    if (!proposal.every((part) => typeof part === 'string' && part.length > 0)) return null;
    return proposal;
}

function isPermissionResponseAuthorityValid(params: Readonly<{
    response: PermissionResponse;
    context: Readonly<{
        toolName: string;
        toolInput: unknown;
        permissionSuggestions?: readonly unknown[];
    }>;
}>): boolean {
    const { response, context } = params;
    const requestKind = resolveAgentRequestKind(context.toolName);
    const hasAllowedTools = typeof response.allowedTools !== 'undefined' || typeof response.allowTools !== 'undefined';
    const hasUpdatedPermissions = typeof response.updatedPermissions !== 'undefined';
    const hasExecPolicyAmendment = typeof response.execPolicyAmendment !== 'undefined';
    const hasAnswers = typeof response.answers !== 'undefined';
    const approvedDecision = response.decision === 'approved'
        || response.decision === 'approved_for_session'
        || response.decision === 'approved_execpolicy_amendment';
    const deniedDecision = response.decision === 'denied' || response.decision === 'abort';

    if ((response.approved && deniedDecision) || (!response.approved && approvedDecision)) return false;

    if (!response.approved) {
        return !hasAllowedTools && !hasUpdatedPermissions && !hasExecPolicyAmendment && !hasAnswers;
    }
    if (requestKind === 'user_action') {
        return !hasAllowedTools && !hasUpdatedPermissions && !hasExecPolicyAmendment;
    }
    if (hasAnswers) return false;

    if (
        typeof response.allowedTools !== 'undefined'
        && typeof response.allowTools !== 'undefined'
        && !isDeepStrictEqual(response.allowedTools, response.allowTools)
    ) {
        return false;
    }
    const allowedTools = response.allowedTools ?? response.allowTools;
    if (typeof allowedTools !== 'undefined') {
        if (!Array.isArray(allowedTools) || allowedTools.length === 0) return false;
        if (!allowedTools.every((identifier) => (
            typeof identifier === 'string'
            && identifier.trim().length > 0
            && isToolAllowedForSession([identifier.trim()], context.toolName, context.toolInput)
        ))) {
            return false;
        }
    }

    if (hasUpdatedPermissions) {
        if (!Array.isArray(response.updatedPermissions) || response.updatedPermissions.length === 0) return false;
        if (!response.updatedPermissions.every((update) => isExactPendingPermissionUpdate({
            update,
            toolName: context.toolName,
            toolInput: context.toolInput,
            ...(Array.isArray(context.permissionSuggestions)
                ? { permissionSuggestions: context.permissionSuggestions }
                : {}),
        }))) {
            return false;
        }
    }

    if (response.decision === 'approved_execpolicy_amendment') {
        const proposal = readProposedExecPolicyAmendment(context.toolInput);
        const amendment = asUnknownRecord(response.execPolicyAmendment);
        return Boolean(
            proposal
            && amendment
            && hasOnlyKeys(amendment, ['command'])
            && isDeepStrictEqual(amendment.command, proposal),
        );
    }
    return !hasExecPolicyAmendment;
}

/**
 * Host-stamped mediation response. The action layer supplies the exact
 * plugin contribution identity; external identity is persisted only in the
 * encrypted host-owned mediation record.
 */
export type MediatedPermissionResponseInput = Readonly<{
    /**
     * Exact caller-supplied Session custody. The handler rejects a response
     * routed to a different Session before it can claim a request by ID.
     */
    sessionId: string;
    /** Exact host-stamped turn custody; never inferred by the response path. */
    turnId: string;
    requestId: string;
    sourceRef: string;
    sourceRevisionOrEpoch: string;
    idempotencyKey: string;
    actor: Readonly<{ namespace: string; principalId: string }>;
    decision: 'allow' | 'deny';
    scope: 'request' | 'session';
    mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    signal?: AbortSignal;
}>;

type PreparedMediatedPermissionResponse = Readonly<{
    input: SessionPermissionRemoteRespondInputV1;
    mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    actor: SessionPermissionExternalHumanDecisionActorV1;
    claim: PermissionResponseClaim;
}>;

/**
 * Abstract base class for permission handlers.
 *
 * Subclasses must implement:
 * - `getLogPrefix()` - returns the log prefix (e.g., '[Codex]')
 */
export abstract class BasePermissionHandler {
    protected pendingRequests = new Map<string, PendingRequest>();
    protected session: ApiSessionClient;
    private resetPromise: Promise<void> | null = null;
    private allowedToolIdentifiers = new Set<string>();
    private readonly allowedToolIdentifiersByOwner = new Map<string, Set<string>>();
    private readonly requestStore: AgentStateRequestStore;
    private readonly requestCoordinator: PermissionRequestCoordinator<PermissionResult>;
    private readonly onAbortRequested: (() => void | Promise<void>) | null;
    private readonly getAccountSettingsSnapshotFn: () => AccountSettings | null;
    private readonly toolTrace: { protocol: ToolTraceProtocol; provider: string } | null;
    private readonly triggerAbortCallbackOnAbortDecision: boolean;
    /** Runtime-registry currentness for a mediator whose grant may have survived admission. */
    private readonly isMediatorPluginCurrent: (pluginId: string) => boolean;
    /** Runtime-registry currentness for the exact mediator contribution that asserted a grant. */
    private readonly isMediatorContributionCurrent: (mediator: Readonly<{
        pluginId: string;
        contributionLocalId: string;
    }>) => boolean;
    private mediationRecordStore: PermissionMediationRecordStore | null;
    /** An injected store is test/host-owned and must survive a session swap. */
    private readonly injectedMediationRecordStore: PermissionMediationRecordStore | null | undefined;
    private readonly activeRemoteMediationGrants = new Map<string, ActiveRemoteMediationGrant>();
    /**
     * A hydrated terminal mediation row without its first-answer claim is a
     * permanent non-authorizing barrier for that exact request tuple. This is
     * derived only from canonical record reconciliation; it neither owns
     * request readiness nor replaces AgentState custody.
     */
    private readonly inertRemoteMediationRequestIdentities = new Set<string>();
    private remoteMediationGrantHydration: Promise<boolean> | null = null;
    /**
     * Serializes only this handler instance's capacity scan, exact-revision
     * prune, and create. It is neither a plugin-wide lock nor persisted
     * coordination: it prevents two local responses from both seeing slot
     * 1,024 before either creates row 1,025.
     */
    private remoteMediationLedgerMutation: Promise<void> = Promise.resolve();
    /**
     * A policy change invalidates an in-flight remote allow before its row
     * CAS. This is owner-local currentness only: the coordinator claim and
     * mediation row remain the sole durable terminal owners.
     */
    private remoteMediationAllowCurrentness = new AbortController();

    /**
     * Returns the log prefix for this handler.
     */
    protected abstract getLogPrefix(): string;

    /**
     * The concrete permission-policy owner rechecks a remote allow against
     * its latest mutable policy immediately before the mediation row can
     * claim the decision. Base has no policy of its own, so an unimplemented
     * live handler fails closed rather than treating an old admission as a
     * continuing authorization.
     */
    protected isCurrentRemoteMediationAllowEligible(_params: Readonly<{
        requestId: string;
        toolName: string;
        input: unknown;
        causalPermissionContext: AcpPermissionCallContext;
    }>): boolean {
        return false;
    }

    /**
     * A restarted handler has only the durable AgentState projection. Concrete
     * policy owners may re-read their incumbent current policy before that
     * projection accepts an approval; Base has no independent policy to add.
     */
    protected resolveCurrentPermissionDecisionForOutstandingRequest(
        _context: PermissionRequestCoordinatorContext,
    ): PermissionResult | null {
        return null;
    }

    /**
     * Concrete policy owners call this whenever their current permission
     * decision changes. It cancels only pre-commit remote allows that captured
     * the prior policy; it neither releases a durable claim nor changes a
     * persisted mediation result.
     */
    protected invalidateRemoteMediationAllowCurrentness(): void {
        const prior = this.remoteMediationAllowCurrentness;
        this.remoteMediationAllowCurrentness = new AbortController();
        prior.abort();
    }

    private isRemoteMediationAllowCurrentnessCurrent(currentness: AbortController | null): boolean {
        return currentness === null || (
            this.remoteMediationAllowCurrentness === currentness
            && !currentness.signal.aborted
        );
    }

    protected updateAgentStateBestEffort(updater: (state: AgentState) => AgentState, reason: string): void {
        updateAgentStateBestEffortShared(this.session, updater, this.getLogPrefix(), reason);
    }

    constructor(
        session: ApiSessionClient,
        opts?: {
            pushSender?: PermissionRequestPushSender | null;
            getAccountSettings?: (() => AccountSettings | null) | null;
            getAccountSettingsSecretsReadKeys?: (() => ReadonlyArray<Uint8Array | null | undefined>) | null;
            onAbortRequested?: (() => void | Promise<void>) | null;
            toolTrace?: { protocol: ToolTraceProtocol; provider: string } | null;
            triggerAbortCallbackOnAbortDecision?: boolean;
            mediationRecordStore?: PermissionMediationRecordStore | null;
            isMediatorPluginCurrent?: ((pluginId: string) => boolean) | null;
            isMediatorContributionCurrent?: ((mediator: Readonly<{
                pluginId: string;
                contributionLocalId: string;
            }>) => boolean) | null;
        }
    ) {
        this.session = session;
        this.getAccountSettingsSnapshotFn = typeof opts?.getAccountSettings === 'function' ? opts.getAccountSettings : (() => null);
        // A remote grant is an external authorization effect. A host runtime
        // that has not supplied the registry-owned lifecycle read must not
        // continue using it after mediator state changes.
        this.isMediatorPluginCurrent = typeof opts?.isMediatorPluginCurrent === 'function'
            ? opts.isMediatorPluginCurrent
            : (() => false);
        this.isMediatorContributionCurrent = typeof opts?.isMediatorContributionCurrent === 'function'
            ? opts.isMediatorContributionCurrent
            : (() => false);
        this.requestStore = new AgentStateRequestStore({
            session,
            logPrefix: this.getLogPrefix(),
            pushSender: opts?.pushSender ?? null,
            getAccountSettings: this.getAccountSettingsSnapshotFn,
            getAccountSettingsSecretsReadKeys:
                typeof opts?.getAccountSettingsSecretsReadKeys === 'function'
                    ? opts.getAccountSettingsSecretsReadKeys
                    : (() => []),
        });
        this.bindRequestStoreToSession(session);
        this.requestCoordinator = createPermissionRequestCoordinator<PermissionResult>({
            store: this.requestStore,
        });
        this.onAbortRequested = typeof opts?.onAbortRequested === 'function' ? opts.onAbortRequested : null;
        this.triggerAbortCallbackOnAbortDecision = opts?.triggerAbortCallbackOnAbortDecision ?? true;
        this.injectedMediationRecordStore = opts?.mediationRecordStore;
        this.mediationRecordStore = this.injectedMediationRecordStore
            ?? createPermissionMediationRecordStore(session);
        this.startRemoteMediationGrantHydration();
        this.toolTrace =
            opts?.toolTrace && typeof opts.toolTrace === 'object'
                ? {
                    protocol: opts.toolTrace.protocol,
                    provider: opts.toolTrace.provider,
                }
                : null;
        this.setupRpcHandler();
        this.seedAllowedToolsFromAgentState();
    }

    protected getAccountSettingsSnapshot(): AccountSettings | null {
        try {
            return this.getAccountSettingsSnapshotFn();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to read account settings`, error);
            return null;
        }
    }

    /**
     * Update the session reference (used after offline reconnection swaps sessions).
     * This is critical for avoiding stale session references after onSessionSwap.
     */
    updateSession(newSession: ApiSessionClient): void {
        const pendingMetadataById = new Map<string, AgentStateOutstandingRequest | null>();
        for (const id of this.pendingRequests.keys()) {
            pendingMetadataById.set(id, this.requestStore.readOutstandingRequest(id));
        }

        logger.debug(`${this.getLogPrefix()} Session reference updated`);
        this.session = newSession;
        if (this.injectedMediationRecordStore === undefined) {
            // A session swap changes both the bearer and encryption context;
            // retain neither a stale writer nor its decrypting key.
            this.mediationRecordStore = createPermissionMediationRecordStore(newSession);
        }
        this.startRemoteMediationGrantHydration();
        // Re-setup RPC handler with new session
        this.setupRpcHandler();
        // Prevent per-session allowlists from leaking across session references.
        // The new session snapshot will re-seed any persisted per-session approvals.
        this.allowedToolIdentifiers.clear();
        this.allowedToolIdentifiersByOwner.clear();
        this.requestStore.updateSession(newSession);
        this.bindRequestStoreToSession(newSession);
        this.seedAllowedToolsFromAgentState();

        // If we were mid-permission when the session reference swapped (offline reconnect),
        // republish still-pending items into the new agentState and re-attempt push notifications.
        for (const [id, pending] of this.pendingRequests.entries()) {
            if (!this.requestStore.hasOutstandingRequest(id)) {
                const priorOutstanding = pendingMetadataById.get(id);
                this.requestStore.publishRequest({
                    requestId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                    createdAt: priorOutstanding?.createdAt ?? Date.now(),
                    ...(typeof priorOutstanding?.turnId === 'string' ? { turnId: priorOutstanding.turnId } : {}),
                    ...(typeof priorOutstanding?.kind === 'string' ? { kind: priorOutstanding.kind } : {}),
                    ...(priorOutstanding?.responseTarget ?? pending.responseTarget
                        ? { responseTarget: priorOutstanding?.responseTarget ?? pending.responseTarget ?? null }
                        : {}),
                    ...(typeof priorOutstanding?.subagentRef !== 'undefined'
                        ? { subagentRef: priorOutstanding.subagentRef }
                        : typeof pending.subagentRef !== 'undefined'
                            ? { subagentRef: pending.subagentRef }
                            : {}),
                    ...(typeof priorOutstanding?.sidechainId === 'string'
                        ? { sidechainId: priorOutstanding.sidechainId }
                        : typeof pending.sidechainId === 'string'
                            ? { sidechainId: pending.sidechainId }
                            : {}),
                    ...(Array.isArray(priorOutstanding?.permissionSuggestions)
                        ? { permissionSuggestions: priorOutstanding.permissionSuggestions }
                        : Array.isArray(pending.permissionSuggestions)
                            ? { permissionSuggestions: pending.permissionSuggestions }
                            : {}),
                    ...(priorOutstanding?.owner ?? pending.owner
                        ? { owner: priorOutstanding?.owner ?? pending.owner ?? null }
                        : {}),
                });
            } else {
                this.requestStore.notifyPermissionRequestPushBestEffort({
                    permissionId: id,
                    toolName: pending.toolName,
                    toolInput: pending.input,
                });
            }
        }
    }

    /**
     * Restores only durable remote grants. The map is empty until a complete
     * bounded scan succeeds, so a transport, envelope or currentness failure
     * can never turn into an optimistic permission allow.
     */
    private startRemoteMediationGrantHydration(): void {
        this.activeRemoteMediationGrants.clear();
        this.inertRemoteMediationRequestIdentities.clear();
        const store = this.mediationRecordStore;
        const session = this.session;
        const sessionId = session.sessionId;
        this.remoteMediationGrantHydration = store
            ? this.hydrateRemoteMediationGrants({ store, session, sessionId })
            : Promise.resolve(false);
    }

    private async hydrateRemoteMediationGrants(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<boolean> {
        const records: PermissionMediationStoredRecord[] = [];
        let cursor: string | null = null;
        let scanned = 0;
        while (true) {
            if (!this.isCurrentRemoteMediationLedger(params)) return false;
            const page = await params.store.list({ cursor, limit: 500 });
            if (!this.isCurrentRemoteMediationLedger(params)) return false;
            if (page.status !== 'ready') return false;
            scanned += page.records.length;
            if (scanned > SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX) return false;
            records.push(...page.records);
            if (!page.hasNext) break;
            if (!page.nextCursor || page.nextCursor === cursor) return false;
            cursor = page.nextCursor;
        }
        if (!await this.reconcileCommittedRemoteMediationClaims({ ...params, records })) return false;

        const hydrated = new Map<string, ActiveRemoteMediationGrant>();
        for (const stored of records) {
            if (!this.addRemoteMediationGrant(stored, hydrated)) return false;
        }
        if (
            this.session !== params.session
            || this.session.sessionId !== params.sessionId
            || this.mediationRecordStore !== params.store
        ) {
            return false;
        }
        this.activeRemoteMediationGrants.clear();
        for (const [identityKey, grant] of hydrated) {
            this.activeRemoteMediationGrants.set(identityKey, grant);
        }
        return true;
    }

    /**
     * A System Record can commit before the ordinary AgentState completion.
     * On restart, recover only a matching durable first-answer claim through
     * the incumbent coordinator; a record without that claim remains inert.
     */
    private async reconcileCommittedRemoteMediationClaims(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        records: readonly PermissionMediationStoredRecord[];
    }>): Promise<boolean> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        for (const stored of params.records) {
            if (!this.isCurrentRemoteMediationLedger(ledger)) return false;
            // Historic rows ordinarily have no outstanding request. Avoid a
            // no-op AgentState mutation per retained audit row; a later race
            // can only leave the record inert, never authorize from it.
            const outstanding = this.requestStore.readOutstandingRequest(stored.identity.requestId);
            if (
                !outstanding
                || stored.identity.sessionId !== params.sessionId
                || stored.identity.turnId !== outstanding.turnId
            ) continue;

            const prepared = this.prepareMediatedPermissionRecovery(stored);
            if (!prepared) return false;
            const outcome = stored.kind === 'remote_grant.v1' && stored.record.revoked
                ? null
                : this.resolveRemoteMediationRecordOutcome(
                    stored,
                    prepared.input,
                    prepared.mediator,
                    'alreadyApplied',
                );
            if (outcome?.status === 'rejected') return false;

            const reconciled = await this.requestCoordinator.withResponseClaim(
                stored.identity.requestId,
                async () => {
                    const claim = await this.requestCoordinator.rejoinResponseClaim({
                        requestId: stored.identity.requestId,
                        claim: prepared.claim,
                    });
                    if (claim.status === 'unclaimed' || claim.status === 'not_pending') {
                        this.inertRemoteMediationRequestIdentities.add(
                            mediationRecordIdentityKey(stored.identity),
                        );
                        return true;
                    }
                    if (claim.status !== 'rejoined') return false;

                    if (stored.kind === 'remote_grant.v1' && stored.record.revoked) {
                        const settlement = await this.settleMediatedPermissionNonAuthorizing({
                            requestId: stored.identity.requestId,
                            settlementId: stored.record.settlementId,
                        });
                        return settlement !== 'unavailable';
                    }
                    if (!outcome) return false;

                    const rejection = await this.replayRemoteMediationCompletionIfPending({
                        stored,
                        input: prepared.input,
                        mediator: prepared.mediator,
                        outcome,
                        ...ledger,
                        mustComplete: true,
                        skipRemoteMediationGrantHydration: true,
                        deferRemoteMediationGrantActivation: true,
                        onGrantNeutralized: () => undefined,
                    });
                    return !rejection || rejection.code !== 'mediationStateUnavailable';
                },
            );
            if (!reconciled || !this.isCurrentRemoteMediationLedger(ledger)) return false;
        }
        return true;
    }

    private prepareMediatedPermissionRecovery(
        stored: PermissionMediationStoredRecord,
    ): PreparedMediatedPermissionResponse | null {
        const parsed = stored.kind === 'remote_grant.v1'
            ? SessionPermissionRemoteGrantRecordV1Schema.safeParse(stored.record)
            : SessionPermissionRemoteSettlementRecordV1Schema.safeParse(stored.record);
        if (!parsed.success) return null;
        const record = parsed.data;
        return this.prepareMediatedPermissionResponse({
            sessionId: stored.identity.sessionId,
            turnId: stored.identity.turnId,
            requestId: stored.identity.requestId,
            sourceRef: record.sourceAuthority.sourceRef,
            sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
            idempotencyKey: record.idempotencyKey,
            actor: {
                namespace: record.actor.namespace,
                principalId: record.actor.principalId,
            },
            decision: record.decision,
            scope: record.requestedScope,
            mediator: record.actor.assertedBy,
        });
    }

    private addRemoteMediationGrant(
        stored: PermissionMediationStoredRecord,
        destination: Map<string, ActiveRemoteMediationGrant>,
    ): boolean {
        if (stored.kind !== 'remote_grant.v1') return true;
        const parsed = SessionPermissionRemoteGrantRecordV1Schema.safeParse(stored.record);
        if (!parsed.success) return false;
        if (parsed.data.revoked) return true;
        // The System Record is the remote first-answer claim, not an active
        // permission grant by itself. Activation has one ordinary completion
        // owner: the matching AgentState terminal projection.
        if (!this.hasOrdinaryRemoteMediationGrantCompletion(parsed.data)) return true;
        const identityKey = mediationRecordIdentityKey(stored.identity);
        if (!destination.has(identityKey) && destination.size >= SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX) {
            return false;
        }
        destination.set(identityKey, {
            identity: stored.identity,
            kind: 'remote_grant.v1',
            record: parsed.data,
            revision: stored.revision,
        });
        return true;
    }

    private hasOrdinaryRemoteMediationGrantCompletion(
        record: SessionPermissionRemoteGrantRecordV1,
    ): boolean {
        const completed = this.session.getAgentStateSnapshot?.()?.completedRequests?.[record.requestId];
        const entry = asUnknownRecord(completed);
        return TurnIdSchema.safeParse(entry?.turnId).success
            && entry?.turnId === record.turnId
            && entry?.status === 'approved'
            && entry.remoteMediationSettlementId === record.settlementId;
    }

    private async ensureRemoteMediationGrantsHydrated(): Promise<boolean> {
        return await (this.remoteMediationGrantHydration ?? Promise.resolve(false));
    }

    private isCurrentRemoteMediationLedger(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): boolean {
        return this.session === params.session
            && this.session.sessionId === params.sessionId
            && this.mediationRecordStore === params.store;
    }

    private async withRemoteMediationLedgerMutation<T>(
        work: () => Promise<T>,
    ): Promise<T> {
        const previous = this.remoteMediationLedgerMutation;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.remoteMediationLedgerMutation = previous.then(() => held, () => held);
        await previous.catch(() => undefined);
        try {
            return await work();
        } finally {
            release();
        }
    }

    private async listCurrentRemoteMediationLedger(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        signal?: AbortSignal;
    }>): Promise<readonly PermissionMediationStoredRecord[] | null> {
        const records: PermissionMediationStoredRecord[] = [];
        let cursor: string | null = null;
        while (true) {
            if (params.signal?.aborted || !this.isCurrentRemoteMediationLedger(params)) return null;
            const remaining = SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX - records.length;
            if (remaining <= 0) return null;
            const page = await params.store.list({
                cursor,
                limit: Math.min(500, remaining),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                page.status !== 'ready'
                || params.signal?.aborted
                || !this.isCurrentRemoteMediationLedger(params)
                || records.length + page.records.length > SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX
            ) {
                return null;
            }
            records.push(...page.records);
            if (!page.hasNext) return records;
            // A next page after the 1,024th row proves the ledger exceeds its
            // bounded retention budget; never create into an unsafe ledger.
            if (
                records.length >= SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX
                || !page.nextCursor
                || page.nextCursor === cursor
            ) {
                return null;
            }
            cursor = page.nextCursor;
        }
    }

    private reconcileActiveRemoteMediationGrantsFromLedger(
        records: readonly PermissionMediationStoredRecord[],
        params: Readonly<{
            store: PermissionMediationRecordStore;
            session: ApiSessionClient;
            sessionId: string;
        }>,
    ): boolean {
        const active = new Map<string, ActiveRemoteMediationGrant>();
        for (const stored of records) {
            if (!this.addRemoteMediationGrant(stored, active)) return false;
        }
        if (!this.isCurrentRemoteMediationLedger(params)) return false;
        this.activeRemoteMediationGrants.clear();
        for (const [identityKey, grant] of active) {
            this.activeRemoteMediationGrants.set(identityKey, grant);
        }
        return true;
    }

    private oldestInactiveRemoteMediationRecord(
        records: readonly PermissionMediationStoredRecord[],
    ): PermissionMediationStoredRecord | null {
        const inactive = records.filter((stored) => (
            stored.kind !== 'remote_grant.v1' || stored.record.revoked
        ));
        if (inactive.length === 0) return null;
        inactive.sort((left, right) => {
            const createdAtDifference = left.record.createdAtMs - right.record.createdAtMs;
            if (createdAtDifference !== 0) return createdAtDifference;
            const settlementIdDifference = left.record.settlementId.localeCompare(right.record.settlementId);
            if (settlementIdDifference !== 0) return settlementIdDifference;
            return left.identity.turnId.localeCompare(right.identity.turnId)
                || left.identity.requestId.localeCompare(right.identity.requestId);
        });
        return inactive[0] ?? null;
    }

    private async admitRemoteMediationLedgerWrite(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        recordWrite: PermissionMediationRecordWrite;
        signal?: AbortSignal;
    }>): Promise<RemoteMediationLedgerAdmission> {
        if (
            params.signal?.aborted
            || !this.isCurrentRemoteMediationLedger(params)
            || !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(params)
        ) {
            return { status: 'unavailable' };
        }

        // One conflict gets a fresh, complete selection. A second conflict is
        // unsafe to guess through, so callers fail closed and leave the
        // request pending for a later retry.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const records = await this.listCurrentRemoteMediationLedger(params);
            if (!records || !this.reconcileActiveRemoteMediationGrantsFromLedger(records, params)) {
                return { status: 'unavailable' };
            }
            if (
                params.recordWrite.kind === 'remote_grant.v1'
                && this.activeRemoteMediationGrants.size >= SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX
            ) {
                return { status: 'sessionGrantCapacityExceeded' };
            }
            if (records.length < SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX) {
                return { status: 'ready' };
            }
            const oldestInactive = this.oldestInactiveRemoteMediationRecord(records);
            if (!oldestInactive) return { status: 'unavailable' };
            const pruned = await params.store.pruneInactive({
                identity: oldestInactive.identity,
                expectedRevision: oldestInactive.revision,
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || !this.isCurrentRemoteMediationLedger(params)
                || pruned.status === 'unavailable'
            ) {
                return { status: 'unavailable' };
            }
            if (pruned.status === 'pruned') return { status: 'ready' };
        }
        return { status: 'unavailable' };
    }

    /**
     * A remote session grant is bounded to the exact admitted causal source,
     * its revision and ceiling, and to one exact tool identifier. It never
     * consults or modifies the present-user `allowedTools` path.
     */
    protected isAllowedByRemoteMediationGrant(
        toolName: string,
        input: unknown,
        sourceAuthority: SessionPermissionSourceAuthorityV1 | undefined,
    ): boolean {
        if (!sourceAuthority) return false;
        const sessionId = this.session.sessionId;
        try {
            if (this.isMediatorPluginCurrent(sourceAuthority.mediatorPluginId) !== true) return false;
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to resolve remote mediator currentness`, error);
            return false;
        }
        const identifier = makeToolIdentifier(toolName, input);
        for (const grant of this.activeRemoteMediationGrants.values()) {
            if (grant.identity.sessionId !== sessionId) continue;
            const record = grant.record;
            try {
                if (this.isMediatorContributionCurrent(record.actor.assertedBy) !== true) continue;
            } catch (error) {
                logger.debug(`${this.getLogPrefix()} Failed to resolve remote mediator contribution currentness`, error);
                continue;
            }
            if (
                record.revoked
                || record.effect.kind !== 'sessionGrant'
                || record.effect.rule.kind !== 'exactTool'
                || record.effect.rule.identifier !== identifier
                || !remoteMediationSourceAuthoritiesEqual(record.sourceAuthority, sourceAuthority)
            ) {
                continue;
            }
            return true;
        }
        return false;
    }

    private bindRequestStoreToSession(session: ApiSessionClient): void {
        const binder = (session as AgentStateRequestStoreBindableSession).bindAgentStateRequestStore;
        if (typeof binder !== 'function') return;
        binder.call(session, this.requestStore);
    }

    private seedAllowedToolsFromAgentState(): void {
        try {
            const snapshot = this.session.getAgentStateSnapshot?.() ?? null;
            const completed = snapshot?.completedRequests;
            if (!completed) return;
            const completedRecord = completed && typeof completed === 'object' && !Array.isArray(completed)
                ? completed as Record<string, unknown>
                : null;
            if (!completedRecord) return;

            for (const value of Object.values(completedRecord)) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const entry = value as Record<string, unknown>;
                if (entry.status !== 'approved') continue;

                const toolName = typeof entry.tool === 'string' ? entry.tool : '';
                if (!toolName) continue;
                const decision = entry.decision === 'approved'
                    || entry.decision === 'approved_for_session'
                    || entry.decision === 'approved_execpolicy_amendment'
                    || entry.decision === 'denied'
                    || entry.decision === 'abort'
                    ? entry.decision
                    : undefined;
                const replayedResponse: PermissionResponse = {
                    id: 'completed-request-replay',
                    approved: true,
                    ...(decision ? { decision } : {}),
                    ...(Array.isArray(entry.allowedTools) ? { allowedTools: entry.allowedTools } : {}),
                    ...(Array.isArray(entry.allowTools) ? { allowTools: entry.allowTools } : {}),
                    ...(typeof entry.updatedPermissions !== 'undefined'
                        ? { updatedPermissions: entry.updatedPermissions }
                        : {}),
                    ...(entry.execPolicyAmendment && typeof entry.execPolicyAmendment === 'object'
                        ? { execPolicyAmendment: entry.execPolicyAmendment as PermissionResponse['execPolicyAmendment'] }
                        : {}),
                };
                if (!isPermissionResponseAuthorityValid({
                    response: replayedResponse,
                    context: {
                        toolName,
                        toolInput: entry.arguments,
                    },
                })) {
                    continue;
                }

                const allowedIdentifiers = this.getAllowedToolIdentifiersForOwner(entry.owner);
                applyUpdatedPermissionsToAllowlist(allowedIdentifiers, entry.updatedPermissions);
                applyAllowedToolsToAllowlist(allowedIdentifiers, entry.allowedTools ?? entry.allowTools);
            }
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to seed allowlist from agentState`, error);
        }
    }

    private buildPermissionResult(response: PermissionResponse): PermissionResult {
        if (response.approved) {
            const wantsExecpolicyAmendment =
                response.decision === 'approved_execpolicy_amendment' && Boolean(response.execPolicyAmendment?.command?.length);

            if (wantsExecpolicyAmendment) {
                return {
                    decision: 'approved_execpolicy_amendment',
                    execPolicyAmendment: response.execPolicyAmendment,
                };
            }

            if (response.decision === 'approved_for_session') {
                return { decision: 'approved_for_session' };
            }

            return { decision: 'approved' };
        }

        return { decision: response.decision === 'denied' ? 'denied' : 'abort' };
    }

    private buildCompletedRequestForResponse(
        response: PermissionResponse,
        result: PermissionResult,
        responseAllowedTools: readonly string[] | undefined,
        updatedPermissions: unknown,
        requestSource: Readonly<{ toolName: string; input: unknown }>,
        permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'],
        remoteMediationSettlementId?: string,
    ): PermissionRequestCoordinatorCompletedRequest {
        const wantsDerivedAllowTools =
            response.approved
            && !Array.isArray(responseAllowedTools)
            && result.decision === 'approved_for_session';
        const derivedAllowTools = Array.isArray(responseAllowedTools)
            ? responseAllowedTools
            : (wantsDerivedAllowTools ? [makeToolIdentifier(requestSource.toolName, requestSource.input)] : undefined);

        return {
            status: response.approved ? 'approved' : 'denied',
            decision: result.decision,
            ...(typeof derivedAllowTools !== 'undefined' ? { allowedTools: derivedAllowTools } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(permissionDecisionActorV1 ? {
                extraCompletedFields: { permissionDecisionActorV1 },
            } : remoteMediationSettlementId ? {
                // The encrypted, host-owned System Record is the sole place
                // that carries the asserted external person. AgentState keeps
                // only this non-authorizing correlation pointer.
                extraCompletedFields: { remoteMediationSettlementId },
            } : {}),
        };
    }

    private applyPermissionResponseAnswers(response: PermissionResponse, result: PermissionResult): boolean {
        if (!response.approved || typeof response.answers === 'undefined') return true;

        const answersRaw = response.answers;
        if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) return false;

        const structured = StructuredQuestionAnswersV1Schema.safeParse(answersRaw);
        if (structured.success) {
            if (Object.keys(structured.data).length > 0) {
                result.answers = structured.data;
            }
            return true;
        }

        // Compatibility reader for UI/action clients through the released 0.2.2 preview,
        // which wrote question -> scalar answer. Remove after that preview is outside the
        // supported mixed-version window and stored/in-flight requests cannot carry it.
        const normalized = Object.create(null) as Record<string, readonly string[]>;
        for (const [key, value] of Object.entries(answersRaw)) {
            if (!key || typeof value !== 'string') return false;
            normalized[key] = [value];
        }

        if (Object.keys(normalized).length > 0) {
            result.answers = normalized;
        }
        return true;
    }

    private applyPermissionResponseSideEffects(params: Readonly<{
        response: PermissionResponse;
        result: PermissionResult;
        responseAllowedTools: readonly string[] | undefined;
        updatedPermissions: unknown;
        requestSource: Readonly<{ toolName: string; input: unknown }>;
        owner?: PermissionRequestOwner;
        debugMessage: string;
    }>): void {
        const { response, result, responseAllowedTools, updatedPermissions, requestSource } = params;
        const allowedIdentifiers = this.getAllowedToolIdentifiersForOwner(params.owner);

        if (response.approved) {
            applyUpdatedPermissionsToAllowlist(allowedIdentifiers, updatedPermissions);
            applyAllowedToolsToAllowlist(allowedIdentifiers, responseAllowedTools);
            if (!Array.isArray(responseAllowedTools) && result.decision === 'approved_for_session') {
                allowedIdentifiers.add(makeToolIdentifier(requestSource.toolName, requestSource.input));
            }
        }

        if (this.toolTrace) {
            recordToolTraceEvent({
                direction: 'inbound',
                sessionId: this.session.sessionId,
                protocol: this.toolTrace.protocol,
                provider: this.toolTrace.provider,
                kind: 'permission-response',
                payload: {
                    type: 'permission-response',
                    permissionId: response.id,
                    approved: response.approved,
                    decision: result.decision,
                },
            });
        }

        if (result.decision === 'abort' && this.triggerAbortCallbackOnAbortDecision) {
            try {
                const cb = this.onAbortRequested;
                if (cb) {
                    Promise.resolve(cb()).catch((error) => {
                        logger.debug(`${this.getLogPrefix()} onAbortRequested failed (non-fatal)`, error);
                    });
                }
            } catch (error) {
                logger.debug(`${this.getLogPrefix()} onAbortRequested threw (non-fatal)`, error);
            }
        }

        logger.debug(`${this.getLogPrefix()} ${params.debugMessage}`);
    }

    /**
     * Setup RPC handler for permission responses.
     */
    protected setupRpcHandler(): void {
        const requestIdFor = (response: PermissionResponse): string => (
            typeof response?.id === 'string' ? response.id : ''
        );
        const handleAttributedPermissionResponse = async (
            response: PermissionResponse,
            rpcContext?: RpcHandlerContext,
            expectedRequestKind?: 'permission' | 'user_action',
        ): Promise<PermissionRespondRpcResult> => {
            const permissionDecisionActorV1 = this.resolvePresentUserPermissionActor(rpcContext);
            if (!permissionDecisionActorV1) {
                return {
                    ok: false,
                    errorCode: 'permission_actor_unattributable',
                    requestId: requestIdFor(response),
                } as const;
            }
            const outcome = await this.handleIncomingPermissionResponse(response, {
                ...(expectedRequestKind ? { expectedRequestKind } : {}),
                permissionDecisionActorV1,
            });
            if (outcome.status === 'not_found') {
                return {
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: requestIdFor(response),
                } as const;
            }
            if (outcome.status === 'invalid') {
                return {
                    ok: false,
                    errorCode: 'permission_response_invalid',
                    requestId: requestIdFor(response),
                } as const;
            }
            return undefined;
        };
        const handleUserActionAnswer = async (response: PermissionResponse): Promise<PermissionRespondRpcResult> => {
            const outcome = await this.handleIncomingPermissionResponse(response, {
                expectedRequestKind: 'user_action',
            });
            if (outcome.status === 'not_found') {
                return {
                    ok: false,
                    errorCode: 'permission_request_not_found',
                    requestId: requestIdFor(response),
                } as const;
            }
            if (outcome.status === 'invalid') {
                return {
                    ok: false,
                    errorCode: 'permission_response_invalid',
                    requestId: requestIdFor(response),
                } as const;
            }
            return undefined;
        };
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'session.permission.respond',
            (response, rpcContext) => handleAttributedPermissionResponse(response, rpcContext, 'permission'),
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'session.user_action.answer',
            handleUserActionAnswer,
        );
        this.session.rpcHandlerManager.registerHandler<PermissionResponse, PermissionRespondRpcResult>(
            'permission',
            // Compatibility adapter for released clients that used this one
            // legacy RPC for both permission and structured-question answers.
            // It has no independent completion logic and still requires the
            // server-derived actor before it can resolve either request shape.
            handleAttributedPermissionResponse,
        );
    }

    /**
     * Project only the source-bound IDs that a host-stamped mediator can
     * answer. This keeps live and AgentState-only correlation at the existing
     * request owner and deliberately excludes every permission payload field.
     */
    listMediatedPendingRequests(params: Readonly<{
        mediatorPluginId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
    }>): SessionPermissionRemotePendingListOutputV1 {
        const mediatorPluginId = params.mediatorPluginId.trim();
        const sourceRef = params.sourceRef.trim();
        const sourceRevisionOrEpoch = params.sourceRevisionOrEpoch.trim();
        if (!mediatorPluginId || !sourceRef || !sourceRevisionOrEpoch) {
            return { requests: [], truncated: false };
        }

        // A durable source-matched request can survive a handler restart before
        // its provider reattaches the live waiter. It is not yet answerable,
        // so omit it from the projection, but do not falsely certify an exact
        // negative list to a mediator that must retain its custody.
        let hasUnprojectedDurableRequest = false;
        const requests: SessionPermissionRemotePendingListOutputV1['requests'] = this.requestCoordinator.listResponseContexts()
            .flatMap((context) => {
                if (resolveAgentRequestKind(context.toolName) !== 'permission') return [];
                const sourceAuthority = context.owner?.sourceAuthority;
                if (
                    !sourceAuthority
                    || sourceAuthority.mediatorPluginId !== mediatorPluginId
                    || sourceAuthority.sourceRef !== sourceRef
                    || sourceAuthority.sourceRevisionOrEpoch !== sourceRevisionOrEpoch
                    || sourceAuthority.remoteApprovalMaxScope === 'off'
                    || !Number.isFinite(context.createdAt)
                ) {
                    return [];
                }
                // Do not trim or normalize the opaque request identity here:
                // it is one member of the exact durable tuple.
                const requestId = context.requestId;
                if (!SessionPermissionRequestIdV1Schema.safeParse(requestId).success) return [];
                // `requestId` is not sufficient custody for a remote
                // mediator. Old/corrupt records without a host-stamped turn
                // remain locally resolvable but are deliberately invisible to
                // this authority-bearing projection.
                const turnId = TurnIdSchema.safeParse(context.turnId);
                if (!turnId.success) return [];
                if (context.correlation !== 'record' || context.status !== 'live') {
                    const identity = mediationRecordIdentityKey({
                        sessionId: this.session.sessionId,
                        turnId: turnId.data,
                        requestId,
                    });
                    if (!this.inertRemoteMediationRequestIdentities.has(identity)) {
                        hasUnprojectedDurableRequest = true;
                    }
                    return [];
                }
                const allowedScopes = sourceAuthority.remoteApprovalMaxScope === 'session'
                    ? ['request', 'session'] as ['request', 'session']
                    : ['request'] as ['request'];
                return [{
                    requestId,
                    turnId: turnId.data,
                    createdAtMs: context.createdAt,
                    allowedScopes,
                }];
            })
            .sort((left, right) => (
                left.createdAtMs - right.createdAtMs
                || left.turnId.localeCompare(right.turnId)
                || left.requestId.localeCompare(right.requestId)
            ));
        return {
            requests: requests.slice(0, 32),
            // `truncated` is the existing protocol signal that this bounded
            // projection is not exhaustive. A caller can therefore never use
            // an empty result to suppress custody during restart hydration.
            truncated: hasUnprojectedDurableRequest || requests.length > 32,
        };
    }

    /**
     * Projects durable session grants without exposing encrypted record payloads
     * or generic System Records access. Plugin callers see only their own
     * grants; the host owner sees the exact rule and revocation provenance.
     */
    async listMediatedPermissionGrants(params: Readonly<{
        viewer: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        limit: number;
        cursor?: string | null;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionRemoteGrantsListOutputV1 | null> {
        const store = this.mediationRecordStore;
        if (!store) return null;
        const session = this.session;
        const sessionId = session.sessionId;
        const ledger = { store, session, sessionId } as const;
        if (
            params.signal?.aborted
            || !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(ledger)
        ) return null;
        const outputLimit = Math.min(200, Math.max(1, Math.floor(params.limit)));
        const grants: SessionPermissionRemoteGrantsListOutputV1['grants'] = [];

        const appendVisibleGrants = (records: readonly PermissionMediationStoredRecord[]): void => {
            for (const stored of records) {
                if (stored.kind !== 'remote_grant.v1') continue;
                const record = stored.record;
                if (record.effect.kind !== 'sessionGrant') continue;
                if (
                    params.viewer.kind === 'mediatorPlugin'
                    && record.mediatorPluginId !== params.viewer.pluginId
                ) {
                    continue;
                }
                grants.push({
                    turnId: stored.identity.turnId,
                    requestId: record.requestId,
                    settlementId: record.settlementId,
                    grantId: record.effect.grantId,
                    sourceRef: record.sourceAuthority.sourceRef,
                    sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
                    admittedPermissionCeiling: record.sourceAuthority.admittedPermissionCeiling,
                    actor: {
                        namespace: record.actor.namespace,
                        principalId: record.actor.principalId,
                    },
                    createdAtMs: record.createdAtMs,
                    ...(record.revoked ? { revokedAtMs: record.revoked.atMs } : {}),
                    projection: params.viewer.kind === 'mediatorPlugin'
                        ? { kind: 'mediator' as const }
                        : {
                            kind: 'owner' as const,
                            rule: record.effect.rule,
                            ...(record.revoked ? { revocationActor: record.revoked.actor } : {}),
                        },
                });
            }
        };

        if (params.viewer.kind === 'host') {
            const page = await store.list({
                limit: outputLimit,
                ...(params.cursor ? { cursor: params.cursor } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || page.status !== 'ready'
                || !this.isCurrentRemoteMediationLedger(ledger)
            ) return null;
            appendVisibleGrants(page.records);
            return {
                grants: grants.slice(0, outputLimit),
                nextCursor: page.hasNext ? page.nextCursor : null,
            };
        }

        // A plugin can see only its own rows.  Continue canonical pages until
        // the requested output is filled, the source ends, or the bounded
        // 500-record scan budget is exhausted; each batch is no larger than
        // the output still needed, so the returned cursor skips no row that
        // this invocation has not examined.
        let cursor = params.cursor ?? null;
        let scanned = 0;
        while (grants.length < outputLimit && scanned < 500) {
            const page = await store.list({
                limit: Math.min(outputLimit - grants.length, 500 - scanned),
                ...(cursor ? { cursor } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (
                params.signal?.aborted
                || page.status !== 'ready'
                || !this.isCurrentRemoteMediationLedger(ledger)
            ) return null;
            scanned += page.records.length;
            appendVisibleGrants(page.records);
            if (!page.hasNext) {
                return { grants, nextCursor: null };
            }
            if (!page.nextCursor || page.nextCursor === cursor || page.records.length === 0) {
                return null;
            }
            cursor = page.nextCursor;
        }
        return {
            grants,
            nextCursor: cursor,
        };
    }

    /** CAS-only durable revocation. It never deletes the audit record. */
    async revokeMediatedPermissionGrant(params: Readonly<{
        turnId: string;
        requestId: string;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        const store = this.mediationRecordStore;
        if (!store) return { status: 'rejected', code: 'mediationStateUnavailable' };
        const session = this.session;
        const sessionId = session.sessionId;
        const identity = mediationRecordIdentity({
            sessionId,
            turnId: params.turnId,
            requestId: params.requestId,
        });
        const ledger = { store, session, sessionId } as const;
        // Hydration can rejoin this request's response claim. Wait for it
        // before taking that claim, then carry the exact ledger through the
        // serialized CAS so a session swap cannot mutate its replacement.
        if (
            !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger(ledger)
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        // A grant's final ordinary completion and its revoke CAS share the
        // per-request and ledger-mutation owners. Otherwise a stale created
        // row can activate after a newer durable revocation has succeeded.
        return await this.requestCoordinator.withResponseClaim(
            identity.requestId,
            async () => await this.revokeMediatedPermissionGrantClaimHeld({
                identity,
                grantId: params.grantId,
                caller: params.caller,
                ...(params.signal ? { signal: params.signal } : {}),
            }, ledger),
        );
    }

    /** Caller already owns this request's coordinator response claim and completed its hydration precondition. */
    private async revokeMediatedPermissionGrantClaimHeld(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>, ledger: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        return await this.withRemoteMediationLedgerMutation(
            async () => await this.revokeMediatedPermissionGrantClaimHeldWithinLedgerMutation(params, ledger),
        );
    }

    private async revokeMediatedPermissionGrantClaimHeldWithinLedgerMutation(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        grantId: string;
        caller: Readonly<{ kind: 'host' } | { kind: 'mediatorPlugin'; pluginId: string }>;
        signal?: AbortSignal;
    }>, ledger: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
    }>): Promise<SessionPermissionRemoteGrantRevokeOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const found = await ledger.store.read({ identity: params.identity, ...(params.signal ? { signal: params.signal } : {}) });
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (found.status === 'unavailable') return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (found.status !== 'found' || found.stored.kind !== 'remote_grant.v1') {
            return { status: 'rejected', code: 'notFound' };
        }
        const record = found.stored.record;
        if (record.effect.kind !== 'sessionGrant' || record.effect.grantId !== params.grantId) {
            return { status: 'rejected', code: 'notFound' };
        }
        let actor: { kind: 'accountUser'; accountId: string } | { kind: 'mediatorPlugin'; pluginId: string };
        if (params.caller.kind === 'mediatorPlugin') {
            if (record.mediatorPluginId !== params.caller.pluginId) return { status: 'rejected', code: 'notFound' };
            actor = { kind: 'mediatorPlugin', pluginId: params.caller.pluginId };
        } else {
            const accountId = await ledger.session.getAuthenticatedAccountId?.();
            if (!accountId || !this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            actor = { kind: 'accountUser', accountId };
        }
        if (record.revoked) {
            this.activeRemoteMediationGrants.delete(mediationRecordIdentityKey(found.stored.identity));
            return { status: 'alreadyRevoked', grantId: record.effect.grantId };
        }
        const nextRecord = SessionPermissionRemoteGrantRecordV1Schema.safeParse({
            ...record,
            revoked: { atMs: Date.now(), actor },
        });
        if (!nextRecord.success) return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const updated = await ledger.store.compareAndSet({
            identity: params.identity,
            expectedRevision: found.stored.revision,
            kind: 'remote_grant.v1',
            record: nextRecord.data,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        const ledgerStillCurrent = this.isCurrentRemoteMediationLedger(ledger);
        // A CAS may have committed even when its result is unavailable, and
        // every conflicting writer is another revocation. While this ledger
        // remains current, all such outcomes must fail closed in memory before
        // cancellation or transport status is reported.
        if (ledgerStillCurrent) this.activeRemoteMediationGrants.delete(mediationRecordIdentityKey(found.stored.identity));
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!ledgerStillCurrent) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (updated.status === 'unavailable') return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (updated.status === 'conflict') {
            const afterConflict = await ledger.store.read({ identity: params.identity, ...(params.signal ? { signal: params.signal } : {}) });
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            if (!this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (
                afterConflict.status === 'found'
                && afterConflict.stored.kind === 'remote_grant.v1'
                && afterConflict.stored.record.effect.kind === 'sessionGrant'
                && afterConflict.stored.record.effect.grantId === params.grantId
                && afterConflict.stored.record.revoked
            ) {
                return { status: 'alreadyRevoked', grantId: params.grantId };
            }
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return { status: 'revoked', grantId: params.grantId };
    }

    /**
     * Settles a source-bound pending permission through the host-owned remote
     * mediation record. This is the only owner-local path that may turn a
     * plugin-attributed external decision into a terminal permission result.
     */
    async respondToMediatedPendingPermission(
        params: MediatedPermissionResponseInput,
    ): Promise<SessionPermissionRemoteRespondOutputV1> {
        const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
        if (!SessionPermissionRequestIdV1Schema.safeParse(requestId).success) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        const prepared = this.prepareMediatedPermissionResponse(params);
        if (!prepared) return { status: 'rejected', code: 'actorUnattributable' };
        // `requestId` is Session-local. Claim it only after all three public
        // custody members identify this handler's live Session and turn.
        if (prepared.input.sessionId !== this.session.sessionId) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (!this.isMediatedPermissionResponseAddressable(prepared)) {
            // A stale session grant remains as exact durable audit evidence
            // after the host revokes it. A replacement handler may report
            // that exact retry as non-pending, but may not use the row to
            // replay, authorize, or mint a response claim.
            if (await this.hasExactRevokedRemoteMediationGrant(prepared, params.signal)) {
                return { status: 'rejected', code: 'requestNotPending' };
            }
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            return { status: 'rejected', code: 'requestNotFound' };
        }

        const acquisition = await this.requestCoordinator.acquireResponseClaim({
            requestId,
            claim: prepared.claim,
        }).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to durably claim remote permission response`, error);
            return null;
        });
        if (!acquisition) return { status: 'rejected', code: 'mediationStateUnavailable' };
        if (acquisition.status === 'conflict') {
            return { status: 'rejected', code: 'decisionConflict' };
        }

        let settlementPersisted = false;
        try {
            return await this.respondToMediatedPendingPermissionUnclaimed(
                params,
                prepared,
                acquisition.status === 'rejoined',
                acquisition.status === 'not_pending',
                () => {
                    settlementPersisted = true;
                },
                () => {
                    settlementPersisted = false;
                },
            );
        } finally {
            // If no remote row/effect exists, a later valid response must
            // remain admissible (for example after a narrowed allow is
            // rejected). Once a row has existed, retain the first-answer
            // claim through completion or a deliberate stale-row
            // neutralization; an exact retry must not turn that invalid
            // external decision into a fresh terminal owner.
            if (acquisition.status !== 'not_pending' && !settlementPersisted) {
                await this.requestCoordinator.releaseResponseClaim({
                    requestId,
                    claim: prepared.claim,
                });
            }
        }
    }

    private prepareMediatedPermissionResponse(
        params: MediatedPermissionResponseInput,
    ): PreparedMediatedPermissionResponse | null {
        const inputResult = SessionPermissionRemoteRespondInputV1Schema.safeParse({
            sessionId: params.sessionId,
            turnId: params.turnId,
            requestId: params.requestId,
            sourceRef: params.sourceRef,
            sourceRevisionOrEpoch: params.sourceRevisionOrEpoch,
            idempotencyKey: params.idempotencyKey,
            actor: params.actor,
            decision: params.decision,
            scope: params.scope,
        });
        if (!inputResult.success) return null;
        const mediatorPluginId = PluginIdSchema.safeParse(params.mediator?.pluginId);
        const mediatorContributionLocalId = PluginContributionLocalIdSchema.safeParse(
            params.mediator?.contributionLocalId,
        );
        if (!mediatorPluginId.success || !mediatorContributionLocalId.success) return null;
        const mediator = {
            pluginId: mediatorPluginId.data,
            contributionLocalId: mediatorContributionLocalId.data,
        } as const;
        const actor = SessionPermissionExternalHumanDecisionActorV1Schema.safeParse({
            kind: 'externalHuman',
            assurance: 'pluginAsserted',
            namespace: inputResult.data.actor.namespace,
            principalId: inputResult.data.actor.principalId,
            assertedBy: mediator,
        });
        if (!actor.success) return null;

        return {
            input: inputResult.data,
            mediator,
            actor: actor.data,
            claim: {
                version: 1,
                origin: 'remoteMediation',
                actor: actor.data,
                mediatorPluginId: mediator.pluginId,
                turnId: inputResult.data.turnId,
                sourceRef: inputResult.data.sourceRef,
                sourceRevisionOrEpoch: inputResult.data.sourceRevisionOrEpoch,
                idempotencyKey: inputResult.data.idempotencyKey,
                decision: inputResult.data.decision,
                scope: inputResult.data.scope,
            },
        };
    }

    /**
     * A new remote answer may enter the terminal-claim path only through this
     * handler's live coordinator record. Durable claims and completed
     * projections remain addressable for their existing recovery/retry paths;
     * a raw AgentState-only outstanding request must first reattach through
     * the incumbent request owner.
     */
    private isMediatedPermissionResponseAddressable(
        prepared: PreparedMediatedPermissionResponse,
    ): boolean {
        const context = this.requestCoordinator.getResponseContext(prepared.input.requestId);
        if (
            context
            && context.correlation === 'record'
            && context.status === 'live'
            && resolveAgentRequestKind(context.toolName) === 'permission'
            && matchesMediatedPermissionTurnId(context.turnId, prepared.input)
            && matchesRemoteMediationSourceAuthority(
                context.owner?.sourceAuthority,
                prepared.input,
                prepared.mediator.pluginId,
            )
        ) {
            return true;
        }
        const outstanding = this.requestStore.readOutstandingRequest(prepared.input.requestId);
        const hasMatchingOutstandingClaim = Boolean(
            outstanding
            && resolveAgentRequestKind(outstanding.toolName) === 'permission'
            && matchesMediatedPermissionTurnId(outstanding.turnId, prepared.input)
            && matchesRemoteMediationSourceAuthority(
                outstanding.owner?.sourceAuthority,
                prepared.input,
                prepared.mediator.pluginId,
            )
            && this.requestStore.hasPermissionResponseClaim(prepared.input.requestId),
        );
        return hasMatchingOutstandingClaim
            || this.isCompletedMediatedPermissionRequestVisible({
                input: prepared.input,
                mediatorPluginId: prepared.mediator.pluginId,
            });
    }

    /**
     * A revoked session-grant row is a non-authorizing exact-retry barrier.
     * This deliberately admits no live response path: it only preserves the
     * stable `requestNotPending` result after a handler restart. All payload
     * members, including the host-stamped turn, must match the one canonical
     * durable record before it is observable this way.
     */
    private async hasExactRevokedRemoteMediationGrant(
        prepared: PreparedMediatedPermissionResponse,
        signal: AbortSignal | undefined,
    ): Promise<boolean> {
        const store = this.mediationRecordStore;
        if (!store) return false;
        const session = this.session;
        const sessionId = session.sessionId;
        const found = await store.read({
            identity: mediationRecordIdentity(prepared.input),
            ...(signal ? { signal } : {}),
        });
        if (
            signal?.aborted
            || !this.isCurrentRemoteMediationLedger({ store, session, sessionId })
            || found.status !== 'found'
        ) {
            return false;
        }
        const outcome = this.resolveRemoteMediationRecordOutcome(
            found.stored,
            prepared.input,
            prepared.mediator,
            'alreadyApplied',
        );
        return outcome.status === 'rejected' && outcome.code === 'requestNotPending';
    }

    /**
     * Re-resolves the live request and policy immediately before an opened
     * mediation row can produce a provider completion or in-memory grant.
     * The row is durable idempotency evidence, never independent authority.
     */
    private revalidateMediatedPermissionRecordCurrentness(params: Readonly<{
        input: SessionPermissionRemoteRespondInputV1;
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
    }>): Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null {
        const legacyPending = this.pendingRequests.get(params.input.requestId);
        const context = this.requestCoordinator.getResponseContext(params.input.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (
            !context
            || resolveAgentRequestKind(context.toolName) !== 'permission'
            || !matchesMediatedPermissionTurnId(context.turnId, params.input)
        ) {
            return { status: 'rejected', code: 'requestNotFound' };
        }

        const sourceAuthority = context.owner?.sourceAuthority;
        if (!sourceAuthority || !matchesRemoteMediationSourceAuthority(
            sourceAuthority,
            params.input,
            params.mediator.pluginId,
        )) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (sourceAuthority.remoteApprovalMaxScope === 'off') {
            return { status: 'rejected', code: 'remoteApprovalDisabled' };
        }
        if (
            params.input.decision === 'allow'
            && params.input.scope === 'session'
            && sourceAuthority.remoteApprovalMaxScope !== 'session'
        ) {
            return { status: 'rejected', code: 'scopeExceedsPolicy' };
        }

        const causalPermissionContext = legacyPending?.causalPermissionContext ?? {
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1' as const,
                admittedPermissionCeiling: sourceAuthority.admittedPermissionCeiling,
                sourceAuthority,
            },
        };
        if (
            params.input.decision === 'allow'
            && !this.isCurrentRemoteMediationAllowEligible({
                requestId: params.input.requestId,
                toolName: context.toolName,
                input: context.toolInput,
                causalPermissionContext,
            })
        ) {
            return { status: 'rejected', code: 'permissionCeilingExceeded' };
        }
        return null;
    }

    private isCompletedMediatedPermissionRequestVisible(params: Readonly<{
        input: SessionPermissionRemoteRespondInputV1;
        mediatorPluginId: string;
    }>): boolean {
        const completed = this.session.getAgentStateSnapshot?.()?.completedRequests?.[params.input.requestId];
        if (!completed || typeof completed !== 'object' || Array.isArray(completed)) return false;
        const entry = completed as Readonly<Record<string, unknown>>;
        if (typeof entry.tool !== 'string' || resolveAgentRequestKind(entry.tool) !== 'permission') return false;
        if (!matchesMediatedPermissionTurnId(entry.turnId, params.input)) return false;
        const owner = normalizePermissionRequestOwner(entry.owner);
        return matchesRemoteMediationSourceAuthority(
            owner?.sourceAuthority,
            params.input,
            params.mediatorPluginId,
        );
    }

    /**
     * A row that committed after its request/policy became stale must not be
     * left as a future replay or restart authority. Reuse the fixed record
     * lifecycle: settlements are inactive and may be pruned; grants retain
     * their audit row through the existing host revocation CAS.
     */
    private async neutralizeStaleMediatedPermissionRecord(params: Readonly<{
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        stored: PermissionMediationStoredRecord;
    }>): Promise<boolean> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (!this.isCurrentRemoteMediationLedger(ledger)) return false;

        if (params.stored.kind === 'remote_settlement.v1') {
            const pruned = await params.store.pruneInactive({
                identity: params.stored.identity,
                expectedRevision: params.stored.revision,
            });
            if (!this.isCurrentRemoteMediationLedger(ledger)) return false;
            if (pruned.status === 'pruned') return true;
            if (pruned.status !== 'conflict') return false;
            const afterConflict = await params.store.read({ identity: params.stored.identity });
            return this.isCurrentRemoteMediationLedger(ledger) && afterConflict.status === 'absent';
        }

        if (params.stored.record.effect.kind !== 'sessionGrant') return false;
        const revoked = await this.revokeMediatedPermissionGrantClaimHeld({
            identity: params.stored.identity,
            grantId: params.stored.record.effect.grantId,
            caller: { kind: 'host' },
        }, ledger);
        return this.isCurrentRemoteMediationLedger(ledger)
            && (revoked.status === 'revoked' || revoked.status === 'alreadyRevoked');
    }

    private async respondToMediatedPendingPermissionUnclaimed(
        params: MediatedPermissionResponseInput,
        prepared: PreparedMediatedPermissionResponse,
        rejoinedExistingClaim: boolean,
        requestWasNotPending: boolean,
        onSettlementPersisted: () => void,
        onSettlementNeutralized: () => void,
    ): Promise<SessionPermissionRemoteRespondOutputV1> {
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };

        const { input, mediator, actor } = prepared;

        const recordStore = this.mediationRecordStore;
        if (!recordStore) return { status: 'rejected', code: 'mediationStateUnavailable' };
        const recordSession = this.session;
        const recordSessionId = recordSession.sessionId;
        const identity = mediationRecordIdentity(input);

        const existing = await recordStore.read({ identity, signal: params.signal });
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (!this.isCurrentRemoteMediationLedger({
            store: recordStore,
            session: recordSession,
            sessionId: recordSessionId,
        })) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (existing.status === 'unavailable') {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (existing.status === 'found') {
            const outcome = this.resolveRemoteMediationRecordOutcome(existing.stored, input, mediator, 'alreadyApplied');
            if (outcome.status === 'rejected') return outcome;
            onSettlementPersisted();
            const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
                stored: existing.stored,
                input,
                mediator,
                outcome,
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
                mustComplete: false,
                onGrantNeutralized: onSettlementNeutralized,
            });
            return replayRejection ?? outcome;
        }

        // A rejoined remote claim without its companion System Record is an
        // ambiguous prior terminal attempt. In particular, this is the state
        // left after pruning a stale allow settlement. Finish that claimed
        // operation non-authorizing rather than minting a fresh row or leaving
        // its original provider waiter stranded.
        if (rejoinedExistingClaim) {
            onSettlementPersisted();
            const settlement = await this.requestCoordinator.withResponseClaim(
                input.requestId,
                async () => await this.settleMediatedPermissionNonAuthorizing({ requestId: input.requestId }),
            );
            if (settlement === 'unavailable') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if (requestWasNotPending) {
            return this.isCompletedMediatedPermissionRequestVisible({
                input,
                mediatorPluginId: mediator.pluginId,
            })
                ? { status: 'rejected', code: 'requestNotPending' }
                : { status: 'rejected', code: 'requestNotFound' };
        }

        const legacyPending = this.pendingRequests.get(input.requestId);
        const context = this.requestCoordinator.getResponseContext(input.requestId)
            ?? (legacyPending
                ? {
                    requestId: input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (
            !context
            || resolveAgentRequestKind(context.toolName) !== 'permission'
            || !matchesMediatedPermissionTurnId(context.turnId, input)
        ) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        const sourceAuthority = context.owner?.sourceAuthority;
        if (!sourceAuthority || !matchesRemoteMediationSourceAuthority(sourceAuthority, input, mediator.pluginId)) {
            // Deliberately do not reveal whether another mediator owns the
            // request or whether its source authority changed.
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (sourceAuthority.remoteApprovalMaxScope === 'off') {
            return { status: 'rejected', code: 'remoteApprovalDisabled' };
        }
        if (input.decision === 'allow' && input.scope === 'session') {
            if (sourceAuthority.remoteApprovalMaxScope !== 'session') {
                return { status: 'rejected', code: 'scopeExceedsPolicy' };
            }
        }
        const causalPermissionContext = legacyPending?.causalPermissionContext ?? {
            causalPermissionAuthority: {
                kind: 'admittedSessionInputV1' as const,
                admittedPermissionCeiling: sourceAuthority.admittedPermissionCeiling,
                sourceAuthority,
            },
        };
        if (
            input.decision === 'allow'
            && !this.isCurrentRemoteMediationAllowEligible({
                requestId: input.requestId,
                toolName: context.toolName,
                input: context.toolInput,
                causalPermissionContext,
            })
        ) {
            return { status: 'rejected', code: 'permissionCeilingExceeded' };
        }

        const recordPayload = {
            version: 1,
            settlementId: randomUUID(),
            turnId: input.turnId,
            requestId: input.requestId,
            mediatorPluginId: mediator.pluginId,
            idempotencyKey: input.idempotencyKey,
            sourceAuthority,
            actor,
            decision: input.decision,
            requestedScope: input.scope,
            effect: input.decision === 'allow' && input.scope === 'session'
                ? {
                    kind: 'sessionGrant',
                    grantId: randomUUID(),
                    rule: {
                        kind: 'exactTool',
                        identifier: makeToolIdentifier(context.toolName, context.toolInput),
                    },
                }
                : input.decision === 'allow' ? { kind: 'allowOnce' } : { kind: 'deny' },
            createdAtMs: Date.now(),
        } as const;
        let recordWrite: PermissionMediationRecordWrite;
        if (input.decision === 'allow' && input.scope === 'session') {
            const grant = SessionPermissionRemoteGrantRecordV1Schema.safeParse(recordPayload);
            if (!grant.success) {
                logger.debug(`${this.getLogPrefix()} Failed to construct a valid remote permission grant`, grant.error);
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            recordWrite = { kind: 'remote_grant.v1', record: grant.data };
        } else {
            const settlement = SessionPermissionRemoteSettlementRecordV1Schema.safeParse(recordPayload);
            if (!settlement.success) {
                logger.debug(`${this.getLogPrefix()} Failed to construct a valid remote permission settlement`, settlement.error);
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            recordWrite = { kind: 'remote_settlement.v1', record: settlement.data };
        }

        const allowCurrentness = input.decision === 'allow'
            ? this.remoteMediationAllowCurrentness
            : null;
        const recordSignal = allowCurrentness
            ? params.signal
                ? AbortSignal.any([params.signal, allowCurrentness.signal])
                : allowCurrentness.signal
            : params.signal;

        // Hydration can neutralize a stale grant through the same incumbent
        // ledger-mutation owner used below. Finish that recovery before taking
        // the owner so neither side waits for the other while holding it.
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if (
            !await this.ensureRemoteMediationGrantsHydrated()
            || !this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        const creation = await this.withRemoteMediationLedgerMutation(async () => {
            if (!this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)) {
                return { policyNarrowed: true } as const;
            }
            const admission = await this.admitRemoteMediationLedgerWrite({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
                recordWrite,
                ...(params.signal ? { signal: params.signal } : {}),
            });
            if (!this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)) {
                return { policyNarrowed: true } as const;
            }
            if (admission.status !== 'ready') return { admission } as const;
            if (!this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })) {
                return { admission: { status: 'unavailable' } } as const;
            }
            const currentContext = this.requestCoordinator.getResponseContext(input.requestId);
            const currentSourceAuthority = currentContext?.owner?.sourceAuthority;
            if (
                params.signal?.aborted
                || !currentContext
                || !matchesMediatedPermissionTurnId(currentContext.turnId, input)
                || !currentSourceAuthority
                || !matchesRemoteMediationSourceAuthority(currentSourceAuthority, input, mediator.pluginId)
            ) {
                return { currentnessLost: true } as const;
            }
            if (!this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)) {
                return { policyNarrowed: true } as const;
            }
            if (
                input.decision === 'allow'
                && !this.isCurrentRemoteMediationAllowEligible({
                    requestId: input.requestId,
                    toolName: currentContext.toolName,
                    input: currentContext.toolInput,
                    causalPermissionContext,
                })
            ) {
                return { policyNarrowed: true } as const;
            }
            const reaffirmedClaim = await this.requestCoordinator.acquireResponseClaim({
                requestId: input.requestId,
                claim: prepared.claim,
            });
            if (reaffirmedClaim.status !== 'rejoined') {
                return { claimLost: reaffirmedClaim } as const;
            }
            if (!this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)) {
                return { policyNarrowed: true } as const;
            }
            const created = await recordStore.createExpectedAbsent({
                identity,
                ...recordWrite,
                ...(recordSignal ? { signal: recordSignal } : {}),
            });
            if (created.status === 'created') {
                // The System Record is now the first-answer evidence even if
                // the policy changed while an abort-ignoring transport was in
                // flight. Retain the coordinator claim until this exact row
                // has been neutralized or completed.
                onSettlementPersisted();
                const staleRejection = !this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)
                    ? { status: 'rejected' as const, code: 'permissionCeilingExceeded' as const }
                    : this.revalidateMediatedPermissionRecordCurrentness({ input, mediator });
                if (staleRejection) {
                    return { staleCreated: created.stored, staleRejection } as const;
                }
            } else if (
                created.status !== 'conflict'
                && !this.isRemoteMediationAllowCurrentnessCurrent(allowCurrentness)
            ) {
                return { policyNarrowed: true } as const;
            }
            if (!this.isCurrentRemoteMediationLedger({
                store: recordStore,
                session: recordSession,
                sessionId: recordSessionId,
            })) {
                return { admission: { status: 'unavailable' } } as const;
            }
            return { created } as const;
        });
        if ('staleCreated' in creation && creation.staleCreated) {
            const neutralized = await this.requestCoordinator.withResponseClaim(
                input.requestId,
                async () => await this.neutralizeStaleMediatedPermissionRecord({
                    store: recordStore,
                    session: recordSession,
                    sessionId: recordSessionId,
                    stored: creation.staleCreated,
                }),
            );
            if (neutralized && creation.staleCreated.kind === 'remote_grant.v1') {
                // A revoked grant is its own durable replay barrier, so the
                // temporary coordinator claim can be released for reset and
                // ordinary cancellation without reopening authorization.
                onSettlementNeutralized();
            }
            if (neutralized && creation.staleCreated.kind === 'remote_settlement.v1') {
                const settlement = await this.requestCoordinator.withResponseClaim(
                    input.requestId,
                    async () => await this.settleMediatedPermissionNonAuthorizing({
                        requestId: input.requestId,
                        settlementId: creation.staleCreated.record.settlementId,
                    }),
                );
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
            }
            return neutralized
                ? creation.staleRejection
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
        if ('currentnessLost' in creation && creation.currentnessLost) {
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if ('policyNarrowed' in creation && creation.policyNarrowed) {
            return { status: 'rejected', code: 'permissionCeilingExceeded' };
        }
        if ('claimLost' in creation && creation.claimLost) {
            return creation.claimLost.status === 'conflict'
                ? { status: 'rejected', code: 'decisionConflict' }
                : { status: 'rejected', code: 'requestNotPending' };
        }
        if ('admission' in creation && creation.admission) {
            return creation.admission.status === 'sessionGrantCapacityExceeded'
                ? { status: 'rejected', code: 'sessionGrantCapacityExceeded' }
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const created = creation.created;
        if (created.status === 'unavailable') {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (created.status === 'conflict') {
            const afterConflict = await recordStore.read({ identity, signal: params.signal });
            if (params.signal?.aborted) return { status: 'rejected', code: 'canceled' };
            if (afterConflict.status === 'found') {
                const outcome = this.resolveRemoteMediationRecordOutcome(
                    afterConflict.stored,
                    input,
                    mediator,
                    'alreadyApplied',
                );
                if (outcome.status === 'rejected') return outcome;
                onSettlementPersisted();
                const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
                    stored: afterConflict.stored,
                    input,
                    mediator,
                    outcome,
                    store: recordStore,
                    session: recordSession,
                    sessionId: recordSessionId,
                    mustComplete: false,
                    onGrantNeutralized: onSettlementNeutralized,
                });
                return replayRejection ?? outcome;
            }
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        const applied = this.resolveRemoteMediationRecordOutcome(created.stored, input, mediator, 'applied');
        if (applied.status === 'rejected') {
            logger.debug(`${this.getLogPrefix()} Remote permission record writer returned a non-matching created row`);
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const replayRejection = await this.replayRemoteMediationCompletionAfterHydration({
            stored: created.stored,
            input,
            mediator,
            outcome: applied,
            store: recordStore,
            session: recordSession,
            sessionId: recordSessionId,
            mustComplete: true,
            onGrantNeutralized: onSettlementNeutralized,
        });
        return replayRejection ?? applied;
    }

    /**
     * Hydration can recover the same durable response claim. Complete that
     * scan before taking the local response claim, then retain the captured
     * ledger through replay so a session swap fails closed rather than waiting
     * on its replacement hydration under the claim.
     */
    private async replayRemoteMediationCompletionAfterHydration(params: Readonly<{
        stored: PermissionMediationStoredRecord;
        input: SessionPermissionRemoteRespondInputV1;
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
        outcome: Exclude<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>;
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        /** A newly-created row must complete this still-live request. */
        mustComplete: boolean;
        /** A successful stale-grant revocation is durable without this claim. */
        onGrantNeutralized: () => void;
    }>): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (
            params.stored.kind === 'remote_grant.v1'
            && (
                !this.isCurrentRemoteMediationLedger(ledger)
                || !await this.ensureRemoteMediationGrantsHydrated()
                || !this.isCurrentRemoteMediationLedger(ledger)
            )
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return await this.requestCoordinator.withResponseClaim(
            params.input.requestId,
            async () => await this.replayRemoteMediationCompletionIfPending({
                ...params,
                ...(params.stored.kind === 'remote_grant.v1'
                    ? { skipRemoteMediationGrantHydration: true }
                    : {}),
            }),
        );
    }

    /**
     * A durable mediation row is the terminal decision claim, but it is not
     * itself the permission completion owner. If the process is interrupted
     * between creating that row and completing the coordinator, a retry must
     * drive the same coordinator path rather than reporting an idempotent
     * success while the original request remains pending.
     *
     * This is deliberately a no-op for an already-completed or no-longer-live
     * request. The stored row remains the idempotency result in that case; it
     * must not recreate a completion from stale state.
     */
    private async replayRemoteMediationCompletionIfPending(params: Readonly<{
        stored: PermissionMediationStoredRecord;
        input: SessionPermissionRemoteRespondInputV1;
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>;
        outcome: Exclude<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>;
        store: PermissionMediationRecordStore;
        session: ApiSessionClient;
        sessionId: string;
        /** A newly-created row must complete this still-live request. */
        mustComplete: boolean;
        /** Avoid waiting on the hydration promise that is replaying this row. */
        skipRemoteMediationGrantHydration?: boolean;
        /** Hydration publishes the fully reconciled active map as one step. */
        deferRemoteMediationGrantActivation?: boolean;
        /** A successful stale-grant revocation is durable without this claim. */
        onGrantNeutralized: () => void;
    }>): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> {
        const ledger = {
            store: params.store,
            session: params.session,
            sessionId: params.sessionId,
        } as const;
        if (!this.isCurrentRemoteMediationLedger(ledger)) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }

        const staleRecordRejection = async (
            rejection: Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>>,
        ): Promise<Extract<SessionPermissionRemoteRespondOutputV1, Readonly<{ status: 'rejected' }>> | null> => {
            const live = this.requestCoordinator.getResponseContext(params.input.requestId);
            if (!live || resolveAgentRequestKind(live.toolName) !== 'permission') {
                return params.mustComplete
                    ? { status: 'rejected', code: 'requestNotPending' }
                    : null;
            }
            const neutralized = await this.neutralizeStaleMediatedPermissionRecord({
                ...ledger,
                stored: params.stored,
            });
            if (neutralized && params.stored.kind === 'remote_grant.v1') {
                params.onGrantNeutralized();
            }
            if (neutralized && params.stored.kind === 'remote_settlement.v1') {
                const settlement = await this.settleMediatedPermissionNonAuthorizing({
                    requestId: params.input.requestId,
                    settlementId: params.stored.record.settlementId,
                });
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
            }
            return neutralized
                ? rejection
                : { status: 'rejected', code: 'mediationStateUnavailable' };
        };

        const legacyPending = this.pendingRequests.get(params.input.requestId);
        let context = this.requestCoordinator.getResponseContext(params.input.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context || resolveAgentRequestKind(context.toolName) !== 'permission') {
            return params.mustComplete
                ? { status: 'rejected', code: 'requestNotPending' }
                : null;
        }

        const initialRejection = this.revalidateMediatedPermissionRecordCurrentness({
            input: params.input,
            mediator: params.mediator,
        });
        if (initialRejection) return await staleRecordRejection(initialRejection);

        if (params.stored.kind === 'remote_grant.v1' && !params.skipRemoteMediationGrantHydration) {
            if (!await this.ensureRemoteMediationGrantsHydrated() || !this.isCurrentRemoteMediationLedger(ledger)) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
        }

        // Hydration and session swaps are asynchronous. Re-resolve the live
        // request/source/policy immediately before a row can activate a grant
        // or dispatch a provider completion.
        context = this.requestCoordinator.getResponseContext(params.input.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.input.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context || resolveAgentRequestKind(context.toolName) !== 'permission') {
            return params.mustComplete
                ? { status: 'rejected', code: 'requestNotPending' }
                : null;
        }
        const finalRejection = this.revalidateMediatedPermissionRecordCurrentness({
            input: params.input,
            mediator: params.mediator,
        });
        if (finalRejection) return await staleRecordRejection(finalRejection);

        const sourceAuthority = context.owner?.sourceAuthority;
        if (!sourceAuthority || !matchesRemoteMediationSourceAuthority(
            sourceAuthority,
            params.input,
            params.mediator.pluginId,
        )) {
            return await staleRecordRejection({ status: 'rejected', code: 'requestNotFound' });
        }

        let completionStored = params.stored;
        if (params.stored.kind === 'remote_grant.v1') {
            // The record CAS and ordinary AgentState completion are separate
            // durable operations. Re-read the exact row while this request's
            // coordinator claim is held so a completed revoke cannot be
            // followed by activation from the stale create result.
            const current = await params.store.read({ identity: params.stored.identity });
            if (!this.isCurrentRemoteMediationLedger(ledger) || current.status === 'unavailable') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (current.status !== 'found' || current.stored.kind !== 'remote_grant.v1') {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            const originalGrant = params.stored.record;
            const currentGrant = current.stored.record;
            if (
                originalGrant.effect.kind !== 'sessionGrant'
                || currentGrant.effect.kind !== 'sessionGrant'
                || currentGrant.settlementId !== originalGrant.settlementId
                || currentGrant.effect.grantId !== originalGrant.effect.grantId
            ) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            if (currentGrant.revoked) {
                const settlement = await this.settleMediatedPermissionNonAuthorizing({
                    requestId: currentGrant.requestId,
                    settlementId: currentGrant.settlementId,
                });
                if (settlement === 'unavailable') {
                    return { status: 'rejected', code: 'mediationStateUnavailable' };
                }
                params.onGrantNeutralized();
                return { status: 'rejected', code: 'requestNotPending' };
            }
            if (current.stored.revision !== params.stored.revision) {
                return { status: 'rejected', code: 'mediationStateUnavailable' };
            }
            completionStored = current.stored;
        }
        const completionIsCurrent = () => (
            completionStored.identity.sessionId === ledger.sessionId
            && this.isCurrentRemoteMediationLedger(ledger)
        );
        if (!completionIsCurrent()) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        const completed = await this.handlePermissionResponseWithContext({
            response: {
                id: completionStored.record.requestId,
                approved: completionStored.record.decision === 'allow',
                decision: completionStored.record.decision === 'allow' ? 'approved' : 'denied',
            },
            context,
            legacyPending,
            remoteMediationSettlementId: params.outcome.settlementId,
            isCurrent: completionIsCurrent,
        });
        if (!completionIsCurrent()) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (
            completed
            && completionStored.kind === 'remote_grant.v1'
            && !params.deferRemoteMediationGrantActivation
            && !this.addRemoteMediationGrant(completionStored, this.activeRemoteMediationGrants)
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        return !completed && params.mustComplete
            ? { status: 'rejected', code: 'requestNotPending' }
            : null;
    }

    private async settleMediatedPermissionNonAuthorizing(params: Readonly<{
        requestId: string;
        settlementId?: string;
    }>): Promise<'completed' | 'not_pending' | 'unavailable'> {
        const legacyPending = this.pendingRequests.get(params.requestId);
        const context = this.requestCoordinator.getResponseContext(params.requestId)
            ?? (legacyPending
                ? {
                    requestId: params.requestId,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context || resolveAgentRequestKind(context.toolName) !== 'permission') return 'not_pending';

        const completed = await this.handlePermissionResponseWithContext({
            response: {
                id: params.requestId,
                approved: false,
                decision: 'denied',
            },
            context,
            legacyPending,
            ...(params.settlementId ? { remoteMediationSettlementId: params.settlementId } : {}),
        });
        if (completed) return 'completed';
        return this.requestCoordinator.getResponseContext(params.requestId) ? 'unavailable' : 'not_pending';
    }

    private resolveRemoteMediationRecordOutcome(
        stored: PermissionMediationStoredRecord,
        input: SessionPermissionRemoteRespondInputV1,
        mediator: Readonly<{ pluginId: string; contributionLocalId: string }>,
        status: 'applied' | 'alreadyApplied',
    ): SessionPermissionRemoteRespondOutputV1 {
        const record = stored.record;
        const expectedIdentity = mediationRecordIdentity(input);
        if (
            mediationRecordIdentityKey(stored.identity) !== mediationRecordIdentityKey(expectedIdentity)
            || record.turnId !== stored.identity.turnId
            || record.requestId !== stored.identity.requestId
        ) {
            return { status: 'rejected', code: 'mediationStateUnavailable' };
        }
        if (!matchesRemoteMediationSourceAuthority(record.sourceAuthority, input, mediator.pluginId)) {
            return { status: 'rejected', code: 'requestNotFound' };
        }
        if (
            record.requestId !== input.requestId
            || record.turnId !== input.turnId
            || record.idempotencyKey !== input.idempotencyKey
            || record.decision !== input.decision
            || record.requestedScope !== input.scope
            || record.actor.namespace !== input.actor.namespace
            || record.actor.principalId !== input.actor.principalId
            || record.actor.assertedBy.pluginId !== mediator.pluginId
        ) {
            return { status: 'rejected', code: 'decisionConflict' };
        }
        if (stored.kind === 'remote_grant.v1' && record.revoked) {
            // A host-revoked stale grant remains durable audit evidence, but
            // no longer replays or activates through an exact retry.
            return { status: 'rejected', code: 'requestNotPending' };
        }
        if (record.decision === 'deny') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'deny',
                effect: { kind: 'deny' },
            };
        }
        if (stored.kind === 'remote_settlement.v1' && record.effect.kind === 'allowOnce') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'allow',
                effect: { kind: 'allowOnce' },
            };
        }
        if (stored.kind === 'remote_grant.v1' && record.effect.kind === 'sessionGrant') {
            return {
                status,
                settlementId: record.settlementId,
                requestId: record.requestId,
                decision: 'allow',
                effect: {
                    kind: 'sessionGrant',
                    grantId: record.effect.grantId,
                    sourceRef: record.sourceAuthority.sourceRef,
                    sourceRevisionOrEpoch: record.sourceAuthority.sourceRevisionOrEpoch,
                    admittedPermissionCeiling: record.sourceAuthority.admittedPermissionCeiling,
                },
            };
        }
        return { status: 'rejected', code: 'decisionConflict' };
    }

    private resolvePresentUserPermissionActor(
        rpcContext: RpcHandlerContext | undefined,
    ): SocketRpcSessionPermissionRespondAuthorizationContext['actor'] | null {
        const authorization = parseSocketRpcAuthorizationContext(rpcContext?.authorization);
        if (
            !authorization
            || authorization.kind !== SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND
            || authorization.sessionId !== this.session.sessionId
        ) {
            return null;
        }
        return authorization.actor;
    }

    private async handleIncomingPermissionResponse(
        response: PermissionResponse,
        options?: Readonly<{
            expectedRequestKind?: 'permission' | 'user_action';
            permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
        }>,
    ): Promise<PermissionResponseRoutingResult> {
        return await this.requestCoordinator.withResponseClaim(response.id, async () => {
            const actor = options?.permissionDecisionActorV1;
            const result = actor ? this.buildPermissionResult(response) : null;
            const claim: PermissionResponseClaim | null = actor && result && options?.expectedRequestKind !== 'user_action'
                ? {
                    version: 1,
                    origin: 'presentUser',
                    actor,
                    decision: result.decision,
                    scope: result.decision === 'approved_for_session' ? 'session' : 'request',
                }
                : null;
            const context = actor ? this.requestCoordinator.getResponseContext(response.id) : null;
            if (!context && claim) {
                const settled = this.requestCoordinator.readCompletedResponseClaim({
                    requestId: response.id,
                    claim,
                });
                if (settled.status === 'rejoined') return { status: 'resolved' };
                if (settled.status === 'conflict') return { status: 'not_found' };
            }
            const isPresentPermissionResponse = Boolean(
                actor
                && context
                && options?.expectedRequestKind !== 'user_action'
                && resolveAgentRequestKind(context.toolName) === 'permission'
                && isPermissionResponseAuthorityValid({ response, context }),
            );
            if (!isPresentPermissionResponse || !actor || !claim) {
                return await this.handleIncomingPermissionResponseUnclaimed(response, options);
            }

            const acquisition = await this.requestCoordinator.acquireResponseClaim({
                requestId: response.id,
                claim,
            });
            if (acquisition.status === 'conflict') {
                return { status: 'not_found' };
            }
            if (acquisition.status === 'not_pending') {
                const settled = this.requestCoordinator.readCompletedResponseClaim({
                    requestId: response.id,
                    claim,
                });
                return settled.status === 'rejoined'
                    ? { status: 'resolved' }
                    : { status: 'not_found' };
            }

            let completed = false;
            try {
                const routed = await this.handleIncomingPermissionResponseUnclaimed(response, options);
                completed = routed.status === 'resolved';
                return routed;
            } finally {
                if (!completed) {
                    await this.requestCoordinator.releaseResponseClaim({
                        requestId: response.id,
                        claim,
                    });
                }
            }
        });
    }

    private async handleIncomingPermissionResponseUnclaimed(
        response: PermissionResponse,
        options?: Readonly<{
            expectedRequestKind?: 'permission' | 'user_action';
            permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
        }>,
    ): Promise<PermissionResponseRoutingResult> {
        const legacyPending = this.pendingRequests.get(response.id);
        const context = this.requestCoordinator.getResponseContext(response.id)
            ?? (legacyPending
                ? {
                    requestId: response.id,
                    toolName: legacyPending.toolName,
                    toolInput: legacyPending.input,
                    createdAt: Date.now(),
                    ...(legacyPending.owner ? { owner: legacyPending.owner } : {}),
                    sourceLocalId: null,
                    correlation: 'record' as const,
                    status: 'live' as const,
                }
                : null);
        if (!context) {
            logger.debug(
                `${this.getLogPrefix()} Permission response received without pending request and without agentState request; ignored`,
            );
            return { status: 'not_found' };
        }
        if (
            options?.expectedRequestKind
            && resolveAgentRequestKind(context.toolName) !== options.expectedRequestKind
        ) {
            logger.debug(`${this.getLogPrefix()} Permission response arrived on the wrong RPC route; ignored`);
            return { status: 'not_found' };
        }
        if (!isPermissionResponseAuthorityValid({ response, context })) {
            logger.debug(`${this.getLogPrefix()} Permission response authority did not match the current request; ignored`);
            return { status: 'invalid' };
        }

        const completed = await this.handlePermissionResponseWithContext({
            response,
            context,
            legacyPending,
            ...(options?.permissionDecisionActorV1 ? {
                permissionDecisionActorV1: options.permissionDecisionActorV1,
            } : {}),
        });
        return completed ? { status: 'resolved' } : { status: 'not_found' };
    }

    private async handlePermissionResponseWithContext(params: Readonly<{
        response: PermissionResponse;
        context: PermissionRequestCoordinatorContext;
        legacyPending: PendingRequest | undefined;
        permissionDecisionActorV1?: SocketRpcSessionPermissionRespondAuthorizationContext['actor'];
        remoteMediationSettlementId?: string;
        isCurrent?: () => boolean;
    }>): Promise<boolean> {
        const {
            response,
            context,
            legacyPending,
            permissionDecisionActorV1,
            remoteMediationSettlementId,
            isCurrent,
        } = params;
        const recoveredCurrentDecision = !legacyPending && context.status === 'agent_state_only'
            ? this.resolveCurrentPermissionDecisionForOutstandingRequest(context)
            : null;
        const resolveCurrentPermissionDecision = legacyPending?.resolveCurrentPermissionDecision
            ?? (recoveredCurrentDecision
                ? () => this.resolveCurrentPermissionDecisionForOutstandingRequest(context)
                : undefined);
        const currentDecision = response.approved
            ? legacyPending?.resolveCurrentPermissionDecision?.() ?? recoveredCurrentDecision ?? undefined
            : undefined;
        const currentDecisionBlocksApproval =
            currentDecision?.decision === 'denied' || currentDecision?.decision === 'abort';
        const effectiveResponse: PermissionResponse = currentDecision && currentDecisionBlocksApproval
            ? {
                id: response.id,
                approved: false,
                decision: currentDecision.decision,
            }
            : response;
        const responseAllowedTools = effectiveResponse.allowedTools ?? effectiveResponse.allowTools;
        const updatedPermissions = effectiveResponse.updatedPermissions;
        const result = this.buildPermissionResult(effectiveResponse);
        if (!this.applyPermissionResponseAnswers(effectiveResponse, result)) {
            throw new Error('Invalid structured question answers');
        }

        const requestSource = { toolName: context.toolName, input: context.toolInput };
        const completedRequest = {
            ...this.buildCompletedRequestForResponse(
                effectiveResponse,
                result,
                responseAllowedTools,
                updatedPermissions,
                requestSource,
                permissionDecisionActorV1,
                remoteMediationSettlementId,
            ),
            ...(isCurrent ? { isCurrent } : {}),
        };
        const completed = await this.completePendingPermissionRequest(
            effectiveResponse.id,
            context,
            result,
            effectiveResponse.approved && resolveCurrentPermissionDecision
                ? {
                    ...completedRequest,
                    isCurrent: () => {
                        if (completedRequest.isCurrent && !completedRequest.isCurrent()) return false;
                        const latest = resolveCurrentPermissionDecision();
                        return latest !== null && latest.decision !== 'denied' && latest.decision !== 'abort';
                    },
                }
                : completedRequest,
        );

        if (!completed && (!legacyPending || legacyPending.coordinatorManaged)) {
            logger.debug(`${this.getLogPrefix()} Permission response did not complete any pending request`);
            return false;
        }
        if (isCurrent && !isCurrent()) return false;

        this.applyPermissionResponseSideEffects({
            response: effectiveResponse,
            result,
            responseAllowedTools,
            updatedPermissions,
            requestSource,
            ...(context.owner ? { owner: context.owner } : {}),
            debugMessage:
                context.correlation === 'agent_state'
                    ? 'Permission response received without pending request; finalized agentState best-effort'
                    : `Permission ${effectiveResponse.approved ? 'approved' : 'denied'} for ${context.toolName}`,
        });

        if (!legacyPending?.coordinatorManaged && this.pendingRequests.has(effectiveResponse.id)) {
            this.pendingRequests.delete(effectiveResponse.id);
            legacyPending?.resolve(result);
        }

        if (effectiveResponse.approved) {
            this.autoApproveNowAllowedPendingRequests(effectiveResponse.id);
        }

        return completed || Boolean(legacyPending && !legacyPending.coordinatorManaged);
    }

    private autoApproveNowAllowedPendingRequests(excludePermissionId: string): void {
        for (const [permissionId, pending] of this.pendingRequests.entries()) {
            if (permissionId === excludePermissionId) continue;
            if (resolveAgentRequestKind(pending.toolName) !== 'permission') continue;
            // A causal external source is its own permission authority. A
            // present-user session allowlist update for one prompt must not
            // silently settle a different mediated prompt outside that
            // source-owned request flow.
            if (pending.owner?.sourceAuthority) continue;
            if (!this.isAllowedForSessionForOwner(pending.toolName, pending.input, pending.owner)) continue;

            const resolveCurrentPermissionDecision = (): PermissionResult | null => {
                if (!this.isAllowedForSessionForOwner(pending.toolName, pending.input, pending.owner)) return null;
                return pending.resolveCurrentPermissionDecision?.() ?? { decision: 'approved' };
            };
            const currentResult = resolveCurrentPermissionDecision();
            if (!currentResult) continue;

            this.resolvePendingPermissionRequest(
                permissionId,
                currentResult,
                undefined,
                resolveCurrentPermissionDecision,
            );
        }
    }

    protected isAllowedForSession(toolName: string, input: unknown): boolean {
        return this.isAllowedForSessionForOwner(toolName, input, null);
    }

    protected recordAutoDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        decision: PermissionResult['decision'],
        options?: Readonly<{
            owner?: PermissionRequestOwner | null;
            source?: string | null;
            isCurrent?: () => boolean;
        }>,
    ): Promise<boolean> {
        const allowedTools = decision === 'approved_for_session'
            ? [makeToolIdentifier(toolName, input)]
            : undefined;
        const owner = normalizePermissionRequestOwner(options?.owner);
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        return this.requestStore.recordCompletedRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            status: decision === 'denied' || decision === 'abort' ? 'denied' : 'approved',
            decision,
            allowedTools,
            ...(source ? { source } : {}),
            ...(owner ? { owner } : {}),
            ...(options?.isCurrent ? { isCurrent: options.isCurrent } : {}),
        });
    }

    /**
     * Direct automatic paths do not first create a pending request, but their
     * AgentState terminal write is still asynchronous. Reuse the pending
     * automatic path's current-decision callback at that writer boundary so
     * Agent-specific handlers only supply their existing policy resolver.
     */
    protected resolveAndRecordAutoDecision(params: Readonly<{
        toolCallId: string;
        toolName: string;
        input: unknown;
        resolve: () => PermissionResult | null;
        options?: Readonly<{ owner?: PermissionRequestOwner | null; source?: string | null }>;
    }>): Promise<PermissionResult | null> | null {
        // Keep the existing pending-request admission synchronous when this
        // policy has no automatic answer. Only a real automatic answer needs
        // the asynchronous AgentState terminal write/currentness loop.
        const initialCandidate = params.resolve();
        if (!initialCandidate) return null;

        return (async () => {
            let candidate = initialCandidate;
            while (true) {

                let candidateIsCurrent = true;
                const recorded = await this.recordAutoDecision(
                    params.toolCallId,
                    params.toolName,
                    params.input,
                    candidate.decision,
                    {
                        ...(params.options?.owner ? { owner: params.options.owner } : {}),
                        ...(params.options?.source ? { source: params.options.source } : {}),
                        isCurrent: () => {
                            const current = params.resolve();
                            candidateIsCurrent = current !== null && isDeepStrictEqual(current, candidate);
                            return candidateIsCurrent;
                        },
                    },
                );
                if (recorded) return candidate;
                // An opaque first-answer claim also makes the writer return false.
                // Only retry when the false result was caused by this automatic
                // decision losing currentness; otherwise leave the live request to
                // its existing terminal owner.
                if (candidateIsCurrent) return null;
                const nextCandidate = params.resolve();
                if (!nextCandidate) return null;
                candidate = nextCandidate;
            }
        })();
    }

    protected isAllowedForSessionForOwner(
        toolName: string,
        input: unknown,
        owner: PermissionRequestOwner | null | undefined,
    ): boolean {
        const normalizedOwner = normalizePermissionRequestOwner(owner);
        const allowedIdentifiers = normalizedOwner
            ? this.allowedToolIdentifiersByOwner.get(permissionRequestOwnerAllowlistKey(normalizedOwner)) ?? []
            : this.allowedToolIdentifiers;
        return isToolAllowedForSession(allowedIdentifiers, toolName, input);
    }

    private getAllowedToolIdentifiersForOwner(owner: unknown): Set<string> {
        const normalizedOwner = normalizePermissionRequestOwner(owner);
        if (!normalizedOwner) {
            return this.allowedToolIdentifiers;
        }
        const key = permissionRequestOwnerAllowlistKey(normalizedOwner);
        let allowedIdentifiers = this.allowedToolIdentifiersByOwner.get(key);
        if (!allowedIdentifiers) {
            allowedIdentifiers = new Set<string>();
            this.allowedToolIdentifiersByOwner.set(key, allowedIdentifiers);
        }
        return allowedIdentifiers;
    }

    protected requestPermissionDecision(
        toolCallId: string,
        toolName: string,
        input: unknown,
        options?: Readonly<{
            owner?: PermissionRequestOwner | null;
            source?: string | null;
            signal?: AbortSignal;
            causalPermissionContext?: AcpPermissionCallContext;
            resolveCurrentPermissionDecision?: () => PermissionResult;
        }>,
    ): Promise<PermissionResult> {
        const source = typeof options?.source === 'string' ? options.source.trim() : '';
        const hasExistingContext = this.requestCoordinator.getResponseContext(toolCallId) !== null;
        if (!hasExistingContext) {
            this.recordPermissionRequestTrace(toolCallId, toolName, input, source);
        }

        const owner = resolvePermissionRequestOwner({
            owner: options?.owner,
            causalPermissionContext: options?.causalPermissionContext,
        });
        const turnId = resolvePermissionRequestTurnId(options?.causalPermissionContext);
        let ownsPendingRecord = false;
        let pendingRecord = this.pendingRequests.get(toolCallId);
        if (!pendingRecord) {
            pendingRecord = {
                toolName,
                input,
                ...(owner ? { owner } : {}),
                ...(options?.causalPermissionContext ? { causalPermissionContext: options.causalPermissionContext } : {}),
                ...(options?.resolveCurrentPermissionDecision
                    ? { resolveCurrentPermissionDecision: options.resolveCurrentPermissionDecision }
                    : {}),
                coordinatorManaged: true,
                resolve: (value) => {
                    this.resolvePendingPermissionRequest(toolCallId, value);
                },
                reject: (error) => {
                    this.rejectPendingPermissionRequest(toolCallId, error);
                },
            };
            this.pendingRequests.set(toolCallId, pendingRecord);
            ownsPendingRecord = true;
        }

        const pending = this.requestCoordinator.requestDecision({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            createdAt: Date.now(),
            ...(turnId ? { turnId } : {}),
            ...(source ? { source } : {}),
            ...(owner ? { owner } : {}),
        }, { signal: options?.signal });

        return pending.finally(() => {
            if (ownsPendingRecord && this.pendingRequests.get(toolCallId) === pendingRecord) {
                this.pendingRequests.delete(toolCallId);
            }
        });
    }

    /**
     * Add a pending request to the agent state.
     */
    protected addPendingRequestToState(toolCallId: string, toolName: string, input: unknown): void {
        this.recordPermissionRequestTrace(toolCallId, toolName, input);
        this.requestStore.publishRequest({
            requestId: toolCallId,
            toolName,
            toolInput: input,
            createdAt: Date.now(),
        });
    }

    private recordPermissionRequestTrace(
        toolCallId: string,
        toolName: string,
        input: unknown,
        source?: string | null,
    ): void {
        if (this.toolTrace) {
            recordToolTraceEvent({
                direction: 'outbound',
                sessionId: this.session.sessionId,
                protocol: this.toolTrace.protocol,
                provider: this.toolTrace.provider,
                kind: 'permission-request',
                payload: {
                    type: 'permission-request',
                    permissionId: toolCallId,
                    toolName,
                    description: `${toolName} permission`,
                    options: { input: resolvePermissionRequestTraceInput({ input, source }) },
                },
            });
        }
    }

    protected resolvePendingPermissionRequest(
        requestId: string,
        result: PermissionResult,
        completedRequest?: PermissionRequestCoordinatorCompletedRequest,
        revalidate?: () => PermissionResult | null,
    ): void {
        void this.resolvePendingPermissionRequestDurably(requestId, result, completedRequest, revalidate).catch((error) => {
            logger.debug(`${this.getLogPrefix()} Failed to durably complete automatic permission request`, error);
            // `PermissionRequestCoordinator.completeResponse()` retains the
            // canonical live request and waiter after a terminal write error.
            // Do not cancel it here: a later policy transition or an explicit
            // response must use that same durable owner rather than reviving a
            // parallel permission path.
        });
    }

    private async resolvePendingPermissionRequestDurably(
        requestId: string,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest | undefined,
        revalidate: (() => PermissionResult | null) | undefined,
    ): Promise<void> {
        await this.requestCoordinator.withResponseClaim(requestId, async () => {
            const initialContext = this.requestCoordinator.getResponseContext(requestId);
            if (!initialContext) {
                logger.debug(`${this.getLogPrefix()} Automatic permission completion lacked a durable pending request`);
                return;
            }
            if (this.requestStore.hasPermissionResponseClaim(requestId)) return;

            // Preserve the pre-activation currentness boundary at the one
            // incumbent AgentState completion write without creating a new
            // durable first-answer claim.
            const context = this.requestCoordinator.getResponseContext(requestId);
            if (!context) return;
            const currentResult = revalidate ? revalidate() : result;
            if (!currentResult) return;
            const currentCompletedRequest = revalidate
                ? {
                    status: currentResult.decision === 'denied' || currentResult.decision === 'abort'
                        ? 'denied'
                        : 'approved',
                    decision: currentResult.decision,
                    isCurrent: () => {
                        if (this.requestStore.hasPermissionResponseClaim(requestId)) return false;
                        const latest = revalidate();
                        return latest !== null && isDeepStrictEqual(latest, currentResult);
                    },
                }
                : completedRequest ?? {
                    status: currentResult.decision === 'denied' || currentResult.decision === 'abort'
                        ? 'denied'
                        : 'approved',
                    decision: currentResult.decision,
                    isCurrent: () => !this.requestStore.hasPermissionResponseClaim(requestId),
                };
            await this.completePendingPermissionRequest(
                requestId,
                context,
                currentResult,
                currentCompletedRequest,
            );
        });
    }

    private rejectPendingPermissionRequest(requestId: string, error: Error): void {
        this.pendingRequests.delete(requestId);
        this.requestCoordinator.cancelRequest(requestId, error.message);
    }

    private async completePendingPermissionRequest(
        requestId: string,
        context: PermissionRequestCoordinatorContext,
        result: PermissionResult,
        completedRequest: PermissionRequestCoordinatorCompletedRequest,
    ): Promise<boolean> {
        const pending = this.pendingRequests.get(requestId);
        const completed = await this.requestCoordinator.completeResponse({
            context,
            completion: {
                result,
                completedRequest,
            },
        });
        if (pending && !pending.coordinatorManaged) {
            this.pendingRequests.delete(requestId);
            pending.resolve(result);
            return completed;
        }
        if (completed) {
            this.pendingRequests.delete(requestId);
        }
        return completed;
    }

    private async cancelPendingRequests(reason: string): Promise<void> {
        const pendingSnapshot = Array.from(this.pendingRequests.entries());
        await this.requestCoordinator.cancelAll(reason);

        for (const [requestId, pending] of pendingSnapshot) {
            if (this.pendingRequests.get(requestId) === pending) this.pendingRequests.delete(requestId);
            if (pending.coordinatorManaged) continue;
            try {
                pending.reject(new Error(reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy pending request:`, err);
            }
        }
    }

    async cancelByPlugin(pluginId: string, reason: string = 'plugin_deactivated'): Promise<void> {
        const normalizedPluginId = pluginId.trim();
        if (!normalizedPluginId) return;

        const legacyPendingSnapshot = Array.from(this.pendingRequests.entries()).filter(
            ([, pending]) => !pending.coordinatorManaged && isPermissionRequestOwnedByPlugin(pending.owner, normalizedPluginId),
        );
        await this.requestCoordinator.cancelByPlugin(normalizedPluginId, reason);

        for (const [requestId, pending] of legacyPendingSnapshot) {
            this.pendingRequests.delete(requestId);
            try {
                pending.reject(new Error(reason));
            } catch (err) {
                logger.debug(`${this.getLogPrefix()} Error rejecting legacy plugin-owned request:`, err);
            }
        }
    }

    async abortPendingRequestsAndFlush(reason: string = 'Aborted by user'): Promise<void> {
        await this.cancelPendingRequests(reason);
        try {
            await this.session.flush?.();
        } catch (error) {
            logger.debug(`${this.getLogPrefix()} Failed to flush session after permission abort (non-fatal)`, error);
        }
    }

    /**
     * Reset state for new sessions.
     * This method is idempotent - safe to call multiple times.
     */
    reset(): Promise<void> {
        if (this.resetPromise) {
            logger.debug(`${this.getLogPrefix()} Reset already in progress, awaiting active cleanup`);
            return this.resetPromise;
        }
        const resetPromise = this.performReset();
        this.resetPromise = resetPromise;
        return resetPromise;
    }

    private async performReset(): Promise<void> {
        try {
            await this.cancelPendingRequests('Session reset');

            this.allowedToolIdentifiers.clear();
            this.allowedToolIdentifiersByOwner.clear();
            this.requestStore.dispose();
            logger.debug(`${this.getLogPrefix()} Permission handler reset`);
        } finally {
            this.resetPromise = null;
        }
    }
}

function permissionRequestOwnerAllowlistKey(owner: PermissionRequestOwner): string {
    return `${owner.pluginId}\u0000${owner.runtimeId ?? ''}`;
}

function matchesRemoteMediationSourceAuthority(
    sourceAuthority: PermissionRequestOwner['sourceAuthority'] | undefined,
    input: SessionPermissionRemoteRespondInputV1,
    mediatorPluginId: string,
): boolean {
    return Boolean(
        sourceAuthority
        && sourceAuthority.mediatorPluginId === mediatorPluginId
        && sourceAuthority.sourceRef === input.sourceRef
        && sourceAuthority.sourceRevisionOrEpoch === input.sourceRevisionOrEpoch,
    );
}

/** A mediated row and its AgentState claim must carry the same causal turn. */
function matchesMediatedPermissionTurnId(
    value: unknown,
    input: SessionPermissionRemoteRespondInputV1,
): boolean {
    const turnId = TurnIdSchema.safeParse(value);
    return turnId.success && turnId.data === input.turnId;
}

/**
 * Request ownership can be supplied by a trusted runtime, but mediated source
 * authority is only valid when it came through the causal admitted-input
 * carrier. Keeping both facts in the incumbent owner makes reload-safe
 * pending projections possible without turning arbitrary request input into
 * remote approval authority.
 */
function resolvePermissionRequestOwner(params: Readonly<{
    owner?: PermissionRequestOwner | null;
    causalPermissionContext?: AcpPermissionCallContext;
}>): PermissionRequestOwner | null {
    const owner = normalizePermissionRequestOwnerWithoutSourceAuthority(params.owner);
    const causalAuthority = params.causalPermissionContext?.causalPermissionAuthority;
    const parsedCausalAuthority = causalAuthority
        ? SessionInputCausalPermissionAuthorityV1Schema.safeParse(causalAuthority)
        : null;
    const sourceAuthority = parsedCausalAuthority?.success
        ? parsedCausalAuthority.data.sourceAuthority
        : undefined;
    if (!sourceAuthority) return owner;

    return normalizePermissionRequestOwner({
        ...(owner ?? {
            kind: 'plugin',
            pluginId: sourceAuthority.mediatorPluginId,
        }),
        sourceAuthority,
    });
}

/**
 * Turn custody is admitted only from the host-stamped causal carrier. Do not
 * derive it from a request ID, a mutable current turn, or plugin input.
 */
function resolvePermissionRequestTurnId(
    causalPermissionContext: AcpPermissionCallContext | undefined,
): string | null {
    const parsed = TurnIdSchema.safeParse(causalPermissionContext?.turnId);
    return parsed.success ? parsed.data : null;
}

function normalizePermissionRequestOwnerWithoutSourceAuthority(
    value: PermissionRequestOwner | null | undefined,
): PermissionRequestOwner | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return normalizePermissionRequestOwner(value);
    }
    const { sourceAuthority: _ignoredSourceAuthority, ...owner } = value;
    return normalizePermissionRequestOwner(owner);
}

function resolvePermissionRequestTraceInput(params: Readonly<{
    input: unknown;
    source?: string | null;
}>): unknown {
    if (params.source !== CLAUDE_UNIFIED_TERMINAL_DIALOG_CHOICE_REQUEST_SOURCE) {
        return params.input;
    }

    const input = readPlainRecord(params.input);
    const dialogInput = readPlainRecord(input?.happierDialog);
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    const optionCount = questions.reduce((count, question) => {
        const questionRecord = readPlainRecord(question);
        return count + (Array.isArray(questionRecord?.options) ? questionRecord.options.length : 0);
    }, 0);
    const dialog: Record<string, string> = {};
    if (dialogInput?.kind === 'recognized' || dialogInput?.kind === 'unrecognized') {
        dialog.kind = dialogInput.kind;
    }
    if (
        typeof dialogInput?.dialogId === 'string'
        && /^[a-z0-9_]{1,80}$/.test(dialogInput.dialogId)
    ) {
        dialog.dialogId = dialogInput.dialogId;
    }
    if (dialogInput?.mode === 'generic' || dialogInput?.mode === 'notice') {
        dialog.mode = dialogInput.mode;
    }

    return {
        redacted: true,
        ...(Object.keys(dialog).length > 0 ? { dialog } : {}),
        questionCount: questions.length,
        optionCount,
    };
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}
