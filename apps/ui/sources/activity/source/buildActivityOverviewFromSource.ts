import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { isSessionAdmittedToPersonalActivity } from '@/activity/attention/isSessionAdmittedToPersonalActivity';
import type {
    ActivityOverviewSnapshot,
    ActivitySurfaceTimingBySurface,
    ActivitySurfaceTimingFacts,
    SessionActivityAttention,
} from '@/activity/attention/activityAttentionTypes';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import type { Message } from "@happier-dev/session-core/messages";
import { readStoredSessionMessagesFromStateLike } from "@happier-dev/session-core/messages";
import {
    listSessionListLookupServerSessions,
    findSessionListLookupSession,
    resolveSessionListLookupSessionServerScopeFromState,
    type SessionServerLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { isSessionListQueryHomeCoverageComplete } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type { Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import {
    buildSessionFromListRenderable,
    isSessionListRenderableNewerThanSession,
} from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import {
    createActivitySurfaceSessionRoute,
    createActivitySurfaceSessionTarget,
} from '@/activity/actions/activitySurfaceTargets';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionPersonalAttentionExpirationsForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { classifyInboxSessionCandidate } from '@/activity/presentation/buildInboxSessionPresentation';
import {
    activityInstanceKey,
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

const NO_SOURCE_ATTENTION_MESSAGES: readonly Message[] = [];

export type ActivityOverviewSummary = Readonly<{
    totalAttentionCount: number;
    inboxContentCount: number;
    nextAttentionBoundaryMs: number | null;
    /** Sessions working right now (the full overview's `thinking`). */
    workingCount: number;
    /** Sessions waiting on the person: a permission, an action, or a blocked delivery. */
    needsYouCount: number;
}>;

export const DEFAULT_ACTIVITY_SURFACE_TIMING: ActivitySurfaceTimingBySurface = {
    desktopOverlay: {
        staleAfterMs: 120_000,
        dwellMs: 90_000,
    },
    liveActivity: {
        staleAfterMs: 1_800_000,
        dwellMs: 90_000,
    },
    homeWidget: {
        staleAfterMs: 1_800_000,
        dwellMs: 90_000,
    },
};

function isHydratedSessionInActivityCustody(session: Session): boolean {
    if (session.viewer?.attention.presentation === 'status_only' && session.viewer.attention.needsAttention) return true;
    const ownerMetadata = readSessionOwnerMetadataView(session);
    if (session.metadataLayoutVersion === 1 && ownerMetadata == null) {
        return false;
    }
    return (
        isUserFacingSession({
            metadata: ownerMetadata,
        })
        || isVoiceConversationCustodySessionMetadata(ownerMetadata)
    );
}

function isHydratedSessionUserFacing(session: Session): boolean {
    if (session.viewer?.attention.presentation === 'status_only' && session.viewer.attention.needsAttention) return true;
    const ownerMetadata = readSessionOwnerMetadataView(session);
    if (session.metadataLayoutVersion === 1 && ownerMetadata == null) {
        return false;
    }
    return isUserFacingSession({
        metadata: ownerMetadata,
    });
}

type ActivitySurfaceTimingInput = Partial<{
    [Surface in keyof ActivitySurfaceTimingBySurface]: Partial<ActivitySurfaceTimingFacts>;
}>;

function resolveActivitySurfaceTiming(input?: ActivitySurfaceTimingInput): ActivitySurfaceTimingBySurface {
    return {
        desktopOverlay: {
            ...DEFAULT_ACTIVITY_SURFACE_TIMING.desktopOverlay,
            ...input?.desktopOverlay,
        },
        liveActivity: {
            ...DEFAULT_ACTIVITY_SURFACE_TIMING.liveActivity,
            ...input?.liveActivity,
        },
        homeWidget: {
            ...DEFAULT_ACTIVITY_SURFACE_TIMING.homeWidget,
            ...input?.homeWidget,
        },
    };
}

function buildLookupState(source: ActivityAttentionSource): SessionServerLookupStateLike {
    return {
        sessions: source.sessionsById,
        sessionListRowsByServerId: source.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: source.ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId: source.sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: source.concurrentSessionListCacheByServerId,
    };
}

function collectLookupSessionAddresses(
    source: ActivityAttentionSource,
    includeWarmSourceWhenNotReady: boolean,
): readonly SessionAddress[] {
    if (!source.isDataReady && !includeWarmSourceWhenNotReady) {
        return [];
    }

    const lookupState = buildLookupState(source);
    const addresses: SessionAddress[] = [];
    const seenAddresses = new Set<string>();
    // Ordinary membership is intentionally last-known-good and may outlive a
    // viewer's Follow/relevance row. Only a fully drained strict query can
    // subtract from that retained corpus, and its authority is exact-Home: an
    // offline or partial sibling must keep rendering its truthful stale rows.
    const authoritativePersonalMembershipByServerId = new Map<string, ReadonlySet<string>>();
    for (const [serverId, membership] of Object.entries(
        source.personalSessionListMembershipByServerId ?? {},
    )) {
        const state = source.personalSessionListQueryStatesByServerId?.[serverId];
        if (!state || !isSessionListQueryHomeCoverageComplete({
            state,
            requestedQueryKey: state.requestedQueryKey,
        })) {
            continue;
        }
        authoritativePersonalMembershipByServerId.set(serverId, new Set(membership ?? []));
    }

    const addAddress = (serverId: unknown, sessionId: unknown) => {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address) return;
        const key = sessionAddressKey(address);
        if (seenAddresses.has(key)) return;
        seenAddresses.add(key);
        addresses.push(address);
    };

    for (const entry of listSessionListLookupServerSessions(lookupState)) {
        const authoritativeMembership = authoritativePersonalMembershipByServerId.get(entry.serverId);
        if (authoritativeMembership && !authoritativeMembership.has(entry.session.id)) {
            continue;
        }
        addAddress(entry.serverId, entry.session.id);
    }

    for (const [serverId, sessionIds] of Object.entries(
        source.personalSessionListMembershipByServerId ?? {},
    )) {
        for (const sessionId of sessionIds ?? []) {
            addAddress(serverId, sessionId);
        }
    }

    // User-facing indexes intentionally omit hidden system sessions, so the
    // canonical hydrated session map is the only complete discovery source for
    // post-Voice permission/result custody. Admit only the bounded Voice-owned
    // marker family here; unrelated hidden sessions remain excluded.
    for (const sessionIdKey in source.sessionsById) {
        if (!Object.prototype.hasOwnProperty.call(source.sessionsById, sessionIdKey)) {
            continue;
        }
        const session = source.sessionsById[sessionIdKey];
        const sessionId = session?.id?.trim() ?? '';
        if (
            !sessionId
            || !isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(session))
        ) {
            continue;
        }
        addAddress(session.serverId ?? (source.activeServer?.serverId ?? source.activeServerId), sessionId);
    }

    return addresses;
}

type ActivitySourceSessionEntry = Readonly<{
    address: SessionAddress;
    session: Session;
    hasHydratedMessages: boolean;
}>;

/**
 * The hydrated Session this address resolves to, or `null` when the source only
 * has a list renderable for it.
 *
 * Stored messages exist for the hydrated form alone, so this is also the rule
 * that decides whether attention was decided with them. One owner, because a
 * consumer that re-spells it can end up asking a question about a verdict the
 * projection reached from different inputs.
 */
function readHydratedSourceSession(
    source: ActivityAttentionSource,
    address: SessionAddress,
): Session | null {
    const directSession = source.sessionsById[address.sessionId];
    if (!directSession) return null;
    const directServerId = normalizeServerId(directSession.serverId)
        ?? normalizeServerId((source.activeServer?.serverId ?? source.activeServerId));
    return directServerId === address.serverId ? directSession : null;
}

/**
 * The exact stored messages this overview decided a candidate's attention with.
 *
 * Message-backed pending requests move `user_action_required`, so a consumer
 * asking when that verdict expires must ask with the same input the verdict
 * used. Asking without them reads a session as having no pending request at
 * all, returns no expiration, and strands a retired row with nothing scheduled
 * to clear it.
 */
export function readActivitySourceAttentionMessages(
    source: ActivityAttentionSource,
    address: SessionAddress | null | undefined,
): readonly Message[] | undefined {
    if (!address) return undefined;
    if (!readHydratedSourceSession(source, address)) return undefined;
    return readSourceSessionMessages(source, address.sessionId);
}

export function collectSourceSessions(
    source: ActivityAttentionSource,
    includeWarmSourceWhenNotReady: boolean,
    preferCurrentListProjection = false,
): readonly ActivitySourceSessionEntry[] {
    const sessions: ActivitySourceSessionEntry[] = [];
    const lookupState = buildLookupState(source);

    for (const address of collectLookupSessionAddresses(source, includeWarmSourceWhenNotReady)) {
        const session = readHydratedSourceSession(source, address);
        const lookupEntry = findSessionListLookupSession(lookupState, address);
        const renderable = lookupEntry?.session ?? null;
        if (session) {
            const summaryProjectionMatchesHydrated = preferCurrentListProjection
                && renderable !== null
                && renderable.metadataUnavailable !== true
                && renderable.seq === session.seq
                && renderable.agentStateVersion === session.agentStateVersion;
            const summaryProjectionIsNewer = preferCurrentListProjection
                && renderable !== null
                && renderable.metadataUnavailable !== true
                && renderable.seq >= session.seq
                && renderable.agentStateVersion >= session.agentStateVersion
                && !summaryProjectionMatchesHydrated;
            // A matching list row also carries transcript-derived pending counts.
            // A message-free summary must consume those facts, not the hydrated
            // agent-state copy or an ambient same-ID transcript from another Home.
            const summaryProjectionUsesMatchingRow = summaryProjectionMatchesHydrated
                && source.sessionMessagesById === undefined;
            let projectedSession = (summaryProjectionIsNewer || summaryProjectionUsesMatchingRow) && renderable
                ? buildSessionFromListRenderable(renderable, { serverId: address.serverId })
                : renderable
                && renderable.metadataUnavailable !== true
                && isSessionListRenderableNewerThanSession(renderable, session)
                ? buildSessionFromListRenderable(renderable, {
                    baseSession: session,
                    serverId: address.serverId,
                })
                : session;
            if (summaryProjectionUsesMatchingRow && renderable) {
                // A matching row's unread bit is not new ready-event evidence.
                // Keep the explicit ready fact while consuming its pending counts.
                projectedSession = {
                    ...projectedSession,
                    latestReadyEventSeq: renderable.latestReadyEventSeq === undefined
                        ? session.latestReadyEventSeq
                        : renderable.latestReadyEventSeq,
                };
            }
            if (isHydratedSessionInActivityCustody(projectedSession)) {
                sessions.push({
                    address,
                    session: projectedSession,
                    hasHydratedMessages: !(summaryProjectionMatchesHydrated || summaryProjectionIsNewer),
                });
            }
            continue;
        }
        if (
            renderable
            && (renderable.metadataUnavailable !== true || renderable.viewer?.attention.presentation === 'status_only')
            && (
                isUserFacingSession(renderable)
                || (renderable.viewer?.attention.presentation === 'status_only' && renderable.viewer.attention.needsAttention)
                || isVoiceConversationCustodySessionMetadata(renderable.metadata)
            )
        ) {
            sessions.push({
                address,
                session: buildSessionFromListRenderable(renderable, { serverId: address.serverId }),
                hasHydratedMessages: false,
            });
        }
    }

    return sessions;
}

function readSourceSessionMessages(
    source: ActivityAttentionSource,
    sessionId: string,
) {
    return readStoredSessionMessagesFromStateLike(source.sessionMessagesById?.[sessionId]);
}

function normalizeServerId(serverId: string | null | undefined): string | null {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized ? normalized : null;
}

function resolveServerProfile(
    source: ActivityAttentionSource,
    serverId: string | null,
) {
    return serverId ? source.serverProfilesById?.[serverId] ?? null : null;
}

function buildActivityInstanceKey(params: Readonly<{
    serverId: string | null;
    activityName: string | null;
    sessionId: string;
}>): string | null {
    if (!params.activityName) return null;
    return activityInstanceKey(
        { serverId: params.serverId, sessionId: params.sessionId },
        params.activityName,
    );
}

function enrichCandidateWithSourceFacts(params: Readonly<{
    source: ActivityAttentionSource;
    lookupState: SessionServerLookupStateLike;
    candidate: SessionActivityAttention;
    address: SessionAddress;
    activityName: string | null;
    directActionsEnabled: boolean;
    surfaceTiming: ActivitySurfaceTimingBySurface;
    nowMs: number;
}>): SessionActivityAttention {
    const sessionId = params.address.sessionId;
    const scope = resolveSessionListLookupSessionServerScopeFromState(params.lookupState, params.address);
    const serverId = params.address.serverId;
    const profile = resolveServerProfile(params.source, serverId);
    const serverUrl = profile?.serverUrl ?? (
        serverId && (params.source.activeServer?.serverId ?? params.source.activeServerId) === serverId ? params.source.activeServer?.serverUrl ?? null : null
    );
    const serverName = scope?.serverName ?? profile?.name ?? null;
    const route = createActivitySurfaceSessionRoute(sessionId, serverId);
    const target = createActivitySurfaceSessionTarget(sessionId, serverId);
    const isKnown = Boolean(serverId);
    const isSaved = Boolean(profile);
    const isActiveLocal = Boolean(serverId && (params.source.activeServer?.serverId ?? params.source.activeServerId) === serverId);
    const canExecute = params.directActionsEnabled && isKnown && isSaved && isActiveLocal;
    const disabledReason = !params.directActionsEnabled
        ? 'disabled'
        : !isKnown
            ? 'missing_target'
            : !isSaved
                ? 'server_not_saved'
                : !isActiveLocal
                    ? 'server_not_active'
                    : 'allowed';
    const ownerMetadata = readSessionOwnerMetadataView(params.candidate.session);
    const workspaceLabel = ownerMetadata && params.candidate.awareness.workspace
        ? resolveSessionWorkspaceDisplayPresentation({
            serverId,
            metadata: ownerMetadata,
            workspaceRefs: params.source.workspaceRefsV1 ?? [],
            workspacePathDisplayModeV1: params.source.workspacePathDisplayModeV1,
        }).displayTitle
        : null;

    return {
        ...params.candidate,
        address: params.address,
        context: projectSessionContextPresentation(buildSessionContextFacts({
            address: params.address,
            serverProfile: profile,
            homeName: serverName,
            // The candidate's awareness projection is built once by the attention owner; rebuilding
            // it here would let the context line disagree with the row it annotates.
            awareness: params.candidate.awareness,
            viewer: params.candidate.session.viewer,
            audienceContext: params.candidate.session.access?.audienceContext,
            audienceScope: params.source.audienceScopes?.get(serverId),
            // Consume the same workspace-display owner and Account facts as Session rows rather
            // than introducing an Activity-local path or label formatter.
            workspaceLabel,
            homeDir: ownerMetadata?.homeDir ?? null,
            // The same exact-Home currentness Session rows show. A retained offline Home must read
            // identically in Activity, so this is the list owner's observation, not a local clock.
            homeObservation: serverId
                ? params.source.sessionListHomeObservationByServerId?.[serverId] ?? null
                : null,
            nowMs: params.nowMs,
        })),
        serverId,
        serverUrl,
        serverName,
        route,
        target,
        activityName: params.activityName,
        activityInstanceKey: buildActivityInstanceKey({ serverId, activityName: params.activityName, sessionId }),
        serverFacts: {
            isKnown,
            isSaved,
            isActiveLocal,
        },
        directActionCapability: {
            canExecute,
            reason: canExecute ? 'allowed' : disabledReason,
        },
        surfaceTiming: params.surfaceTiming,
    };
}

export function buildActivityOverviewFromSource(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    sessionOptions?: SessionAttentionOptions;
    /**
     * Presentation policy for a corpus that spans Homes, resolved from each candidate's own exact
     * Home. `null` excludes that Home's candidates entirely, because a Home whose Account policy
     * this device cannot name must not borrow another Home's — switching the active Home would
     * otherwise change what a sibling Home is allowed to contribute.
     *
     * When supplied it replaces `sessionOptions` per candidate. The toggles stay here rather than
     * becoming a post-projection filter: the overview builder is the single owner that applies them
     * while preserving every other canonical attention reason, so a mixed candidate (unread *and*
     * failing) keeps the reason its Home still allows.
     */
    resolveSessionOptionsForServerId?: (serverId: string) => SessionAttentionOptions | null;
    activityName?: string | null;
    directActionsEnabled?: boolean;
    surfaceTiming?: ActivitySurfaceTimingInput;
    includeWarmSourceWhenNotReady?: boolean;
}>): ActivityOverviewSnapshot {
    const lookupState = buildLookupState(params.source);
    const surfaceTiming = resolveActivitySurfaceTiming(params.surfaceTiming);
    const resolveSessionOptions = params.resolveSessionOptionsForServerId;
    const candidates = collectSourceSessions(params.source, params.includeWarmSourceWhenNotReady === true)
        .filter((entry) => isSessionAdmittedToPersonalActivity(entry.session))
        .flatMap((entry) => {
            const sessionOptions = resolveSessionOptions
                ? resolveSessionOptions(entry.address.serverId)
                : params.sessionOptions;
            if (sessionOptions === null) return [];
            return [{
                entry,
                candidate: buildSessionActivityAttention({
                    session: entry.session,
                    sessionMessages: entry.hasHydratedMessages
                        ? readSourceSessionMessages(params.source, entry.address.sessionId)
                        : undefined,
                    sessionOptions,
                    nowMs: params.nowMs,
                }),
            }];
        })
        .filter(({ candidate }) => (
            isHydratedSessionUserFacing(candidate.session)
            || (
                isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(candidate.session))
                && candidate.hasAttention
            )
        ))
        .map(({ candidate, entry }) => enrichCandidateWithSourceFacts({
            source: params.source,
            lookupState,
            candidate,
            address: entry.address,
            activityName: typeof params.activityName === 'string' && params.activityName.trim()
                ? params.activityName.trim()
                : null,
            directActionsEnabled: params.directActionsEnabled === true,
            surfaceTiming,
            nowMs: params.nowMs,
        }));

    return buildActivityOverviewFromCandidates(candidates);
}

/**
 * Minimal always-mounted Activity projection. It reuses the canonical source,
 * per-session attention owner, and Inbox classifier while avoiding candidate
 * enrichment, presentation strings, sorting, fingerprints, and detail arrays.
 */
export function buildActivityOverviewSummaryFromSource(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    sessionOptions?: SessionAttentionOptions;
    includeWarmSourceWhenNotReady?: boolean;
}>): ActivityOverviewSummary {
    let totalAttentionCount = 0;
    let inboxContentCount = 0;
    let workingCount = 0;
    let needsYouCount = 0;
    let nextAttentionBoundaryMs: number | null = null;

    for (const entry of collectSourceSessions(
        params.source,
        params.includeWarmSourceWhenNotReady === true,
        true,
    )) {
        if (!isSessionAdmittedToPersonalActivity(entry.session)) continue;
        const messages = entry.hasHydratedMessages
            ? readSourceSessionMessages(params.source, entry.address.sessionId) ?? NO_SOURCE_ATTENTION_MESSAGES
            : NO_SOURCE_ATTENTION_MESSAGES;
        const candidate = buildSessionActivityAttention({
            session: entry.session,
            sessionMessages: messages,
            sessionOptions: params.sessionOptions,
            nowMs: params.nowMs,
        });
        if (
            !isHydratedSessionUserFacing(candidate.session)
            && !(
                isVoiceConversationCustodySessionMetadata(readSessionOwnerMetadataView(candidate.session))
                && candidate.hasAttention
            )
        ) {
            continue;
        }
        if (candidate.hasAttention) totalAttentionCount += 1;
        if (classifyInboxSessionCandidate(candidate) !== null) inboxContentCount += 1;
        if (candidate.reasons.isThinking) workingCount += 1;
        if (
            candidate.reasons.hasPendingPermissionRequests
            || candidate.reasons.hasPendingUserActionRequests
            || candidate.reasons.hasBlockedPendingDelivery
        ) {
            needsYouCount += 1;
        }
        for (const expiresAtMs of readSessionPersonalAttentionExpirationsForViewer(
            entry.session,
            params.nowMs,
            messages,
        )) {
            if (expiresAtMs <= params.nowMs) continue;
            if (nextAttentionBoundaryMs === null || expiresAtMs < nextAttentionBoundaryMs) {
                nextAttentionBoundaryMs = expiresAtMs;
            }
        }
    }

    return { totalAttentionCount, inboxContentCount, nextAttentionBoundaryMs, workingCount, needsYouCount };
}
