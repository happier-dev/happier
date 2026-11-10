import {
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiReadSessionRequestV1Schema,
    PluginUiRespondToSessionPermissionRequestV1Schema,
    PluginUiSessionStateV1Schema,
    PluginUiWatchSessionRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSessionPermissionAnswerV1,
    type PluginUiSessionStateV1,
} from '@happier-dev/protocol/plugins/ui';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, isBundledAgentId } from '@happier-dev/agents/agent-ids';
import { resolveAgentExecutionTargetFromSessionMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { AccountEncryptionMaterialUnavailableError } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { HappyError } from '@/utils/errors/errors';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { readAgentSessionCompactionAvailability, readCurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionAcceptedWorkspace } from '@/sync/domains/session/sessionAcceptedWorkspace';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjection';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { serverFetch } from '@/sync/http/client';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    answerSessionPermission,
    type SessionPermissionAnswerPolicy,
} from '@/sync/ops/sessionPermissionAnswers';
import { listSessionPendingPermissions } from '@/sync/ops/sessionPendingPermissions';
import type { NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { NativePermissionChoiceV1Schema } from '@happier-dev/protocol/sessions/permissions/nativeChoicesV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { createAppSessionTranscriptActions } from '@/components/sessions/transcript/source/appSessionTranscriptActions';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { deriveSessionListRenderableHasUnreadMessagesFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionLatestExternalShareableActivity } from '@/sync/api/session/sessionLatestExternalShareableActivity';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

/**
 * The mounted plugin UI host's linked-Session capability (r0.42):
 * `readSession`, `watchSession` and `respondToSessionPermission`.
 *
 * It owns no Session state. Lifecycle, runtime and operational state come from
 * the canonical awareness projection (`getSessionStatus`), pending requests
 * from the canonical pending-request owner, the viewer's approval capability
 * from the transcript-interaction owner, and answers go through the one
 * permission-answer owner the Session footer uses. Scope is the mounted
 * Account's own Session store: a plugin reaches exactly the Sessions this
 * client can already open, and nothing else.
 *
 * A watch is the same bounded invalidation signal as a Resource watch; it is
 * delivered through the mount's existing invalidation fan-out, so no second
 * subscription channel or registry exists.
 */

type ProjectedPendingPermission = Readonly<{
    toolName: string;
    turnId?: string;
    source?: string;
    nativeChoices?: NativePermissionChoicesV1;
    canApprove: boolean;
    policy: SessionPermissionAnswerPolicy;
    answers: readonly PluginUiSessionPermissionAnswerV1[];
}>;

type ProjectedSession = Readonly<{
    state: PluginUiSessionStateV1;
    requests: ReadonlyMap<string, ProjectedPendingPermission>;
}>;

function projectSession(session: Session, accountScope: ServerAccountScope | null): ProjectedSession {
    const status = getSessionStatus(session, Date.now(), { vibingIndex: 0 });
    const { awareness } = status;
    const agentId = readSessionPresentationAgentId(session);
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const capabilityAgentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
    const agentTarget = resolveAgentExecutionTargetFromSessionMetadata(ownerMetadata ?? session.metadata, agentId,
        readExternalSessionLink(ownerMetadata ?? session.metadata));
    const acceptedWorkspace = readSessionAcceptedWorkspace(session, accountScope, storage.getState());
    const cached = readCachedDaemonMergedProjectionCacheEntry({
        sections: ['agentsById'],
        machineId: awareness.workspace?.machineId,
        serverId: accountScope?.serverId,
    });
    const inputs = cached && areServerAccountScopesEqual(cached.accountScope, accountScope)
        && (cached.kind === 'ready' || cached.kind === 'error') ? cached.inputs : null;
    const catalog = agentId === null ? null : resolveAgentCatalogProjection(agentId, {
        enabledAgentIds: [],
        mergedBackendProjectionById: inputs?.mergedBackendProjectionById,
        mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
    });
    const identity = catalog?.identity ?? (catalog?.isBuiltIn && isBundledAgentId(catalog.agentId)
        ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[catalog.agentId] : null);
    const workStatus = resolveWorkStatusTone({
        kind: 'session',
        facts: sessionWorkStatusFactsFromStatus(session, status),
    }) satisfies PluginUiSessionStateV1['workStatus'];
    const requests = new Map<string, ProjectedPendingPermission>();
    const pendingPermissions: PluginUiSessionStateV1['pendingPermissions'][number][] = [];
    for (const pending of listSessionPendingPermissions(session, accountScope)) {
        requests.set(pending.requestId, {
            toolName: pending.toolName,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.source ? { source: pending.source } : {}),
            ...(pending.nativeChoices !== undefined ? { nativeChoices: pending.nativeChoices } : {}),
            canApprove: pending.canApprove,
            policy: pending.policy,
            answers: pending.answers,
        });
        pendingPermissions.push({
            requestId: pending.requestId,
            toolName: pending.toolName,
            summary: pending.summary,
            ...(pending.command ? { command: pending.command } : {}),
            ...(pending.createdAtMs !== undefined ? { createdAtMs: pending.createdAtMs } : {}),
            answers: [...pending.answers],
            ...(pending.nativeChoices !== undefined ? { nativeChoices: { ...pending.nativeChoices, choices: [...pending.nativeChoices.choices] } } : {}),
            ...(pending.nativeChoiceAvailability ? { nativeChoiceAvailability: [...pending.nativeChoiceAvailability] } : {}),
            ...(pending.permissionOwnerLabel ? { permissionOwnerLabel: pending.permissionOwnerLabel } : {}),
        });
    }
    const state = PluginUiSessionStateV1Schema.parse({
        sessionId: session.id,
        compaction: readAgentSessionCompactionAvailability({ agentId: capabilityAgentId, metadata: ownerMetadata,
            currentAgentCapabilities: cached?.kind === 'ready' ? readCurrentProjectedAgentCapabilities({
                projection: inputs?.pluginProjectionV2, agentId: capabilityAgentId,
            }) : null }),
        ...(accountScope ? { serverId: accountScope.serverId } : {}),
        ...(agentTarget ? { agentTarget } : {}),
        ...(acceptedWorkspace ? { acceptedWorkspace } : {}),
        title: getSessionName(session, accountScope?.serverId),
        ...(catalog ? { agent: {
            agentId: catalog.agentId,
            displayName: catalog.title,
            ...(identity ? { brand: { pluginId: identity.pluginId } } : {}),
        } } : {}),
        lifecycle: awareness.lifecycle,
        runtime: awareness.runtime,
        operational: awareness.operational.primary,
        workStatus,
        ...(awareness.workspace ? { workspace: awareness.workspace } : {}),
        pendingPermissions,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromSession(session),
        latestActivity: { kind: session.access?.capabilities.readTranscript === true ? 'unavailable' : 'hidden' },
    });
    return { state, requests };
}

function readScopedSession(
    sessionId: string,
    accountScope: ServerAccountScope | null,
    state = storage.getState(),
): Session | undefined {
    const session = state.sessions[sessionId];
    return session && (!accountScope || !session.serverId
        || areServerProfileIdentifiersEquivalent(session.serverId, accountScope.serverId)) ? session : undefined;
}

function readProjectedSession(sessionId: string, accountScope: ServerAccountScope | null): ProjectedSession | null {
    const session = readScopedSession(sessionId, accountScope);
    return session ? projectSession(session, accountScope) : null;
}

function digestSessionState(state: PluginUiSessionStateV1): `sha256:${string}` {
    return `sha256:${bytesToHex(sha256(new TextEncoder().encode(stableJsonStringify(state))))}`;
}

function readPayloadRecord(payload: PluginUiJsonValueV1 | undefined): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Readonly<Record<string, PluginUiJsonValueV1>>
        : null;
}

type ActiveSessionWatch = Readonly<{ release: () => void }>;

export type PluginSurfaceSessionHandlers = Readonly<{
    /** The same exact-Account read without requiring a mounted transport envelope. */
    readSession: (sessionId: string, options?: PluginSurfaceHostApiRequestOptions) => Promise<PluginUiJsonValueV1>;
    handlers: Required<Pick<
        PluginSurfaceHostApiHandlers,
        'readSession' | 'watchSession' | 'respondToSessionPermission' | 'disposeHostResource'
    >>;
    dispose: () => void;
}>;

export function createPluginSurfaceSessionHandlers(input: Readonly<{
    accountScope: ServerAccountScope | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent: () => boolean;
    /** The mount's one invalidation fan-out, shared with Resource watches. */
    deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
}>): PluginSurfaceSessionHandlers {
    const watches = new Map<string, ActiveSessionWatch>();
    let disposed = false;
    const lifetime = new AbortController();

    const refusal = (options?: PluginSurfaceHostApiRequestOptions): PluginUiJsonValueV1 | null => {
        if (disposed || !input.isCurrent()) return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
        if (options?.signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['aborted']);
        return null;
    };

    const releaseWatch = (subscriptionId: string): void => {
        const watch = watches.get(subscriptionId);
        if (!watch) return;
        watches.delete(subscriptionId);
        watch.release();
    };

    // False is a positively classified terminal absence. Failures never establish absence.
    const hydrateSession = async (sessionId: string, options?: PluginSurfaceHostApiRequestOptions): Promise<boolean> => {
        const scope = input.accountScope;
        if (readScopedSession(sessionId, scope)) return true;
        if (!scope) throw new PluginError({ code: 'unavailable', retryable: false });
        // A linked Session may be outside the client's loaded list window. Use the ordinary exact-Account
        // hydration owner, including its in-flight sharing and currentness checks, before claiming absence.
        const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
        let result: EnsureSessionVisibleForRouteResult;
        try {
            result = await runWithServerRequestAuthorityForServerAccountScope({ scope, activeRequest: serverFetch,
                signal: cancellation.signal }, authority => sync.ensureSessionVisibleForMessageRoute(sessionId, {
                    serverId: scope.serverId,
                    authority,
                    scopeCurrentness: () => refusal(options) === null,
                    hydrateMessages: false,
                }));
        } catch (error) {
            // The caller settles retirement/cancellation through the existing refusal owner below.
            if (refusal(options)) return true;
            const code = isPluginError(error) ? error.code
                : error instanceof HappyError || error instanceof AccountEncryptionMaterialUnavailableError
                    ? error.code ?? 'unavailable' : 'unavailable';
            throw new PluginError({ code, retryable: shouldRetryError(error) });
        } finally { cancellation.dispose(); }
        if (refusal(options)) return true;
        if (result.kind === 'available') return true;
        if (result.kind === 'missing' && result.cause !== 'auth_unavailable') return false;
        throw new PluginError({ code: result.errorCode ?? result.cause,
            retryable: true });
    };

    const readSession = async (
        request: Pick<PluginUiHostApiRequestEnvelopeV1, 'payload'>,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const refused = refusal(options);
        if (refused) return refused;
        const parsed = PluginUiReadSessionRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['session_read_payload_invalid']);
        const available = await hydrateSession(parsed.data.sessionId, options);
        const retiredAfterHydration = refusal(options);
        if (retiredAfterHydration) return retiredAfterHydration;
        if (!available) return null;
        const session = readScopedSession(parsed.data.sessionId, input.accountScope);
        const agentId = session ? readSessionPresentationAgentId(session) : null;
        const machineId = session ? getSessionStatus(session).awareness.workspace?.machineId : null;
        // Built-ins have a local catalog. Installed Agents need the same cold,
        // exact-Account catalog loader used by Session chrome, not an ambient cache.
        if (agentId && !isBundledAgentId(agentId) && machineId) {
            const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
            try {
                await loadDaemonMergedProjectionCacheEntry({
                    machineId,
                    serverId: input.accountScope?.serverId,
                    accountLifetime: input.accountLifetime,
                    // The session projection reads only the Agent catalog (`projectSession`).
                    sections: DAEMON_AGENT_CATALOG_SECTIONS,
                    reuseFreshReady: true,
                    signal: cancellation.signal,
                });
            } finally { cancellation.dispose(); }
            const retired = refusal(options);
            if (retired) return retired;
        }
        const projected = readProjectedSession(parsed.data.sessionId, input.accountScope);
        if (!projected) return createPluginSurfaceHostApiError('unavailable', ['session_projection_unavailable'], undefined, { retryable: true });
        if (!input.accountScope || projected.state.latestActivity?.kind === 'hidden') return projected.state;
        const cancellation = mergeAbortSignals([lifetime.signal, options?.signal]);
        try {
            const latestActivity = await readSessionLatestExternalShareableActivity({
                scope: input.accountScope, sessionId: parsed.data.sessionId, signal: cancellation.signal,
                isCurrent: () => refusal(options) === null,
            });
            const retired = refusal(options);
            if (retired) return retired;
            // Reproject after the read so concurrent Work/read-state changes are current too.
            const current = readProjectedSession(parsed.data.sessionId, input.accountScope);
            return current ? PluginUiSessionStateV1Schema.parse({ ...current.state,
                latestActivity: current.state.latestActivity?.kind === 'hidden' ? { kind: 'hidden' } : latestActivity,
            }) : createPluginSurfaceHostApiError('unavailable', ['session_projection_unavailable'], undefined, { retryable: true });
        } finally { cancellation.dispose(); }
    };

    const watchSession = async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const refused = refusal(options);
        if (refused) return refused;
        const record = readPayloadRecord(request.payload);
        const subscriptionId = typeof record?.subscriptionId === 'string' ? record.subscriptionId.trim() : '';
        const parsed = PluginUiWatchSessionRequestV1Schema.safeParse(
            record ? { sessionId: record.sessionId } : undefined,
        );
        if (!subscriptionId || !parsed.success) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_watch_payload_invalid']);
        }
        const { sessionId } = parsed.data;
        await hydrateSession(sessionId, options);
        const retiredAfterHydration = refusal(options);
        if (retiredAfterHydration) return retiredAfterHydration;
        if (watches.has(subscriptionId)) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_watch_subscription_reused']);
        }
        const initial = readProjectedSession(sessionId, input.accountScope);
        if (!initial) return createPluginSurfaceHostApiError('unavailable', ['session_unavailable']);

        let lastDigest = digestSessionState(initial.state);
        let catalogMachineId: string | undefined;
        let unsubscribeCatalog = () => {};
        const bindCatalog = (state: PluginUiSessionStateV1) => {
            const machineId = state.workspace?.machineId;
            if (machineId === catalogMachineId) return;
            unsubscribeCatalog();
            catalogMachineId = machineId;
            unsubscribeCatalog = machineId ? subscribeMachineContributionRegistryProjectionInvalidation({
                machineId, serverId: input.accountScope?.serverId ?? null,
            }, () => {
                if (!input.isCurrent()) return;
                const current = readProjectedSession(sessionId, input.accountScope);
                if (current) input.deliver({
                    version: 1, subscriptionId, kind: 'invalidated', digest: digestSessionState(current.state),
                });
            }) : () => {};
        };
        bindCatalog(initial.state);
        const readInputs = (state: ReturnType<typeof storage.getState>) => ({
            session: readScopedSession(sessionId, input.accountScope, state),
            messages: state.sessionMessages?.[sessionId],
            displayRow: input.accountScope
                ? readSessionListRowForServerId(state.sessionListRowsByServerId, input.accountScope.serverId, sessionId)
                : undefined,
            locale: state.settings.preferredLanguage,
            workspaceRefs: readProjectAccountWorkspaceRefs(state),
        });
        let lastInputs = readInputs(storage.getState());
        const unsubscribe = storage.subscribe((state) => {
            const nextInputs = readInputs(state);
            const transcriptChanged = nextInputs.messages !== lastInputs.messages
                || nextInputs.session?.seq !== lastInputs.session?.seq
                || nextInputs.session?.sessionTurns !== lastInputs.session?.sessionTurns
                || nextInputs.session?.latestTurnStatusObservedAt !== lastInputs.session?.latestTurnStatusObservedAt
                || nextInputs.session?.publishedThroughServerSeq !== lastInputs.session?.publishedThroughServerSeq
                || nextInputs.session?.currentStorageState !== lastInputs.session?.currentStorageState;
            if (nextInputs.session === lastInputs.session && nextInputs.messages === lastInputs.messages
                && nextInputs.displayRow === lastInputs.displayRow
                && nextInputs.workspaceRefs === lastInputs.workspaceRefs
                && nextInputs.locale === lastInputs.locale) return;
            lastInputs = nextInputs;
            if (!input.isCurrent()) return;
            if (!nextInputs.session) {
                releaseWatch(subscriptionId);
                input.deliver({
                    version: 1,
                    subscriptionId,
                    kind: 'error',
                    code: 'unavailable',
                    diagnostics: ['session_unavailable'],
                });
                return;
            }
            const projected = projectSession(nextInputs.session, input.accountScope).state;
            bindCatalog(projected);
            const digest = digestSessionState(projected);
            if (digest === lastDigest && !transcriptChanged) return;
            lastDigest = digest;
            input.deliver({ version: 1, subscriptionId, kind: 'invalidated', digest });
        }, { sessions: [sessionId], sessionMessages: [sessionId], sessionListRowsByServerId: true,
            settings: ['preferredLanguage'], projectAccountRows: true, profileScope: true });
        watches.set(subscriptionId, { release: () => { unsubscribe(); unsubscribeCatalog(); } });
        return null;
    };

    const respondToSessionPermission = async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const refused = refusal(options);
        if (refused) return refused;
        const parsed = PluginUiRespondToSessionPermissionRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_permission_payload_invalid']);
        }
        const { sessionId, requestId } = parsed.data;
        const projected = readProjectedSession(sessionId, input.accountScope);
        if (!projected) return { status: 'refused', reason: 'sessionUnavailable' };
        const pending = projected.requests.get(requestId);
        if (!pending) return { status: 'refused', reason: 'requestNotPending' };
        if (!pending.canApprove) return { status: 'refused', reason: 'answerUnavailable' };
        const nativeChoice = parsed.data.nativeChoice;
        const answer = parsed.data.answer;
        if (pending.nativeChoices !== undefined ? !nativeChoice : !answer || !pending.answers.includes(answer)) {
            return { status: 'refused', reason: 'answerUnavailable' };
        }
        try {
            await answerSessionPermission({
                requestId,
                ...(pending.turnId ? { turnId: pending.turnId } : {}),
                ...(nativeChoice ? { nativeChoice } : {
                    ...(pending.source ? { source: pending.source } : {}),
                    toolName: pending.toolName,
                    answer: answer!,
                    policy: pending.policy,
                }),
                respondToPermission: createAppSessionTranscriptActions(sessionId, input.accountScope?.serverId ?? null).respondToPermission,
            });
        } catch (error) {
            const details = error instanceof HappyError ? readRecord(error.details) : {};
            const followUp = NativePermissionChoiceV1Schema.shape.followUp.safeParse(details.followUp);
            if (details.answered === true && followUp.success && followUp.data) {
                return { status: 'answered', followUp: followUp.data,
                    ...(error instanceof HappyError && error.code ? { errorCode: error.code } : {}) };
            }
            return createPluginSurfaceHostApiError('unavailable', ['session_permission_delivery_failed']);
        }
        return { status: 'answered' };
    };

    const disposeHostResource = (request: PluginUiHostApiRequestEnvelopeV1): PluginUiJsonValueV1 => {
        const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(request.payload);
        // Unknown ids belong to another installed disposer; generic disposal is idempotent.
        if (parsed.success) releaseWatch(parsed.data.subscriptionId);
        return null;
    };

    return Object.freeze({
        readSession: (sessionId: string, options?: PluginSurfaceHostApiRequestOptions) => readSession({ payload: { sessionId } }, options),
        handlers: Object.freeze({ readSession, watchSession, respondToSessionPermission, disposeHostResource }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            lifetime.abort();
            for (const subscriptionId of [...watches.keys()]) releaseWatch(subscriptionId);
        },
    });
}
