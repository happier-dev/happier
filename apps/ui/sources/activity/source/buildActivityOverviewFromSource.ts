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
    type SessionServerLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import {
    createSessionListPresentationSource,
    readSessionListPresentationOwnerMetadata,
    readSessionListRenderableOwnerMetadataView,
    type SessionPresentationRecord,
    type SessionListPresentationSource,
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
import { resolveInboxItemAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import {
    activityInstanceKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { sessionFollowSourceRuntimeStateLabel } from '@/components/sessions/follow/sessionFollowSourcePresentation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { readActivitySessionRuleMatches } from './readActivitySessionRulePolicies';
import { collectActivitySourceSessionAddresses } from './activitySourceSessionAddresses';

const NO_SOURCE_ATTENTION_MESSAGES: readonly Message[] = [];

export type ActivityOverviewSummary = Readonly<{
    isDataReady: boolean;
    totalAttentionCount: number;
    inboxContentCount: number;
    /** The Inbox's "Needs you" sessions (`classifyInboxSessionCandidate` section `needs_attention`). */
    inboxNeedsYouCount: number;
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

function readSourceOwnerMetadata(session: SessionPresentationRecord, source?: SessionListPresentationSource) {
    return source ? readSessionListPresentationOwnerMetadata(source) : 'agentState' in session
        ? readSessionOwnerMetadataView(session) : readSessionListRenderableOwnerMetadataView(session);
}

function isHydratedSessionInActivityCustody(session: SessionPresentationRecord, source?: SessionListPresentationSource): boolean {
    if (session.viewer?.attention.presentation === 'status_only' && session.viewer.attention.needsAttention) return true;
    const ownerMetadata = readSourceOwnerMetadata(session, source);
    if ((source?.metadataLayoutVersion ?? session.metadataLayoutVersion) === 1 && ownerMetadata == null) {
        return false;
    }
    return (
        isUserFacingSession({
            metadata: ownerMetadata,
        })
        || isVoiceConversationCustodySessionMetadata(ownerMetadata)
    );
}

function isHydratedSessionUserFacing(session: SessionPresentationRecord, source?: SessionListPresentationSource): boolean {
    if (session.viewer?.attention.presentation === 'status_only' && session.viewer.attention.needsAttention) return true;
    const ownerMetadata = readSourceOwnerMetadata(session, source);
    if ((source?.metadataLayoutVersion ?? session.metadataLayoutVersion) === 1 && ownerMetadata == null) {
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

export type ActivitySourceSessionEntry = Readonly<{
    address: SessionAddress;
    session: SessionPresentationRecord;
    presentationSource?: SessionListPresentationSource;
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
    /** An exact subset previously collected by this source's address owner. */
    addresses?: readonly SessionAddress[],
): readonly ActivitySourceSessionEntry[] {
    const sessions: ActivitySourceSessionEntry[] = [];

    for (const address of addresses ?? collectActivitySourceSessionAddresses(source, includeWarmSourceWhenNotReady)) {
        const session = readHydratedSourceSession(source, address);
        // Attention needs the keyed row, never the presentation index's server-label scan.
        const renderable = readSessionListRowForServerId(source.sessionListRowsByServerId, address.serverId, address.sessionId) ?? null;
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
            const presentationSource = (summaryProjectionIsNewer || summaryProjectionUsesMatchingRow) && renderable
                ? createSessionListPresentationSource(renderable, { serverId: address.serverId,
                    ...(summaryProjectionUsesMatchingRow ? { readyEvent: { latestReadyEventSeq:
                        renderable.latestReadyEventSeq === undefined ? session.latestReadyEventSeq : renderable.latestReadyEventSeq } } : {}),
                })
                : renderable
                && renderable.metadataUnavailable !== true
                && isSessionListRenderableNewerThanSession(renderable, session)
                ? createSessionListPresentationSource(renderable, {
                    baseSession: session,
                    serverId: address.serverId,
                })
                : undefined;
            const projectedSession = presentationSource?.row ?? session;
            if (isHydratedSessionInActivityCustody(projectedSession, presentationSource)) {
                sessions.push({
                    address,
                    session: projectedSession,
                    presentationSource,
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
                session: renderable,
                presentationSource: createSessionListPresentationSource(renderable, { serverId: address.serverId }),
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
    const serverId = params.address.serverId;
    const profile = resolveServerProfile(params.source, serverId);
    const serverUrl = profile?.serverUrl ?? (
        serverId && (params.source.activeServer?.serverId ?? params.source.activeServerId) === serverId ? params.source.activeServer?.serverUrl ?? null : null
    );
    const serverName = resolveHomeDisplayLabel(profile, serverId);
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
    const ownerMetadata = readSourceOwnerMetadata(params.candidate.session, params.candidate.presentationSource);
    const receiverRuleEvaluation = params.source.receiverRuleEvaluationByServerId?.[serverId];
    const audienceScope = params.source.audienceScopes?.get(serverId);
    const followRuleEvaluationState = receiverRuleEvaluation && audienceScope
        && receiverRuleEvaluation.accountId === audienceScope.accountId
        && areServerProfileIdentifiersEquivalent(audienceScope.serverId, serverId)
        ? receiverRuleEvaluation.pendingBySourceSessionId[sessionId] : undefined;
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
        ...(followRuleEvaluationState ? {
            followRuleEvaluationState,
            subtitle: sessionFollowSourceRuntimeStateLabel(followRuleEvaluationState),
        } : {}),
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
    /** Exact addresses supplied by the source owner's changed-row publication. */
    addresses?: readonly SessionAddress[];
}>): ActivityOverviewSnapshot {
    const lookupState = buildLookupState(params.source);
    const surfaceTiming = resolveActivitySurfaceTiming(params.surfaceTiming);
    const resolveSessionOptions = params.resolveSessionOptionsForServerId;
    const candidates = collectSourceSessions(params.source, params.includeWarmSourceWhenNotReady === true, false, params.addresses)
        .flatMap((entry) => {
            const followRuleMatches = readActivitySessionRuleMatches(params.source, entry.address, entry.session, params.nowMs, entry.presentationSource);
            const followRulePolicies = followRuleMatches.map(match => match.policy);
            if (!isSessionAdmittedToPersonalActivity(entry.session, followRulePolicies)) return [];
            const sessionOptions = resolveSessionOptions
                ? resolveSessionOptions(entry.address.serverId)
                : params.sessionOptions;
            if (sessionOptions === null) return [];
            return [{
                entry,
                candidate: buildSessionActivityAttention({
                    session: entry.session,
                    presentationSource: entry.presentationSource,
                    sessionMessages: entry.hasHydratedMessages
                        ? readSourceSessionMessages(params.source, entry.address.sessionId)
                        : undefined,
                    sessionOptions,
                    followRulePolicies,
                    followRuleMatches,
                    nowMs: params.nowMs,
                }),
            }];
        })
        .filter(({ candidate }) => (
            isHydratedSessionUserFacing(candidate.session, candidate.presentationSource)
            || (
                isVoiceConversationCustodySessionMetadata(readSourceOwnerMetadata(candidate.session, candidate.presentationSource))
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

/** One personal, user-facing session as the summary owner classified it. */
export type ActivitySummaryCandidate = Readonly<{
    entry: ActivitySourceSessionEntry;
    candidate: ReturnType<typeof buildSessionActivityAttention>;
    messages: readonly Message[];
}>;

/**
 * The summary owner's one walk over the canonical source: every session admitted to personal
 * Activity, classified by the per-session attention owner, kept only when it is user-facing (or a
 * voice conversation that has attention). Each summary projection (the fleet totals below, the
 * per-machine working counts) reads this same walk, so none decides "working" a second way.
 */
export function forEachActivitySummaryCandidate(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    sessionOptions?: SessionAttentionOptions;
    /** Same exact-Home policy and null exclusion as the detail owner. */
    resolveSessionOptionsForServerId?: (serverId: string) => SessionAttentionOptions | null;
    /** Badges retain opened-transcript pending evidence; list-only summaries omit that detail. */
    includeHydratedMessages?: boolean;
    includeWarmSourceWhenNotReady?: boolean;
    /** Exact changed addresses from collectActivitySourceSessionAddresses; classification stays here. */
    addresses?: readonly SessionAddress[];
}>, visit: (candidate: ActivitySummaryCandidate) => void): void {
    for (const entry of collectSourceSessions(
        params.source,
        params.includeWarmSourceWhenNotReady === true,
        params.includeHydratedMessages !== true,
        params.addresses,
    )) {
        const followRuleMatches = readActivitySessionRuleMatches(params.source, entry.address, entry.session, params.nowMs, entry.presentationSource);
        const followRulePolicies = followRuleMatches.map(match => match.policy);
        if (!isSessionAdmittedToPersonalActivity(entry.session, followRulePolicies)) continue;
        const sessionOptions = params.resolveSessionOptionsForServerId
            ? params.resolveSessionOptionsForServerId(entry.address.serverId)
            : params.sessionOptions;
        if (sessionOptions === null) continue;
        const messages = entry.hasHydratedMessages
            ? readSourceSessionMessages(params.source, entry.address.sessionId) ?? NO_SOURCE_ATTENTION_MESSAGES
            : NO_SOURCE_ATTENTION_MESSAGES;
        const candidate = buildSessionActivityAttention({
            session: entry.session,
            presentationSource: entry.presentationSource,
            sessionMessages: messages,
            sessionOptions,
            nowMs: params.nowMs,
            presentation: 'summary',
            followRulePolicies,
            followRuleMatches,
        });
        if (
            !isHydratedSessionUserFacing(candidate.session, candidate.presentationSource)
            && !(
                isVoiceConversationCustodySessionMetadata(readSourceOwnerMetadata(candidate.session, candidate.presentationSource))
                && candidate.hasAttention
            )
        ) {
            continue;
        }
        visit({ entry, candidate, messages });
    }
}

/** C1 owns whether an admitted candidate is waiting on the person, rather than viewer news. */
export function isActivityCandidateAwaitingPerson(candidate: Pick<SessionActivityAttention, 'workStatus'>): boolean {
    const type = candidate.workStatus.attentionType;
    return type !== null && resolveInboxItemAttentionV1(type).interrupt;
}

/** What the always-mounted summary counts for one classified candidate. */
export type ActivitySummaryFacts = Readonly<{
    attention: boolean;
    inbox: boolean;
    inboxNeedsYou: boolean;
    working: boolean;
    needsYou: boolean;
    /** The soonest future instant this candidate's attention expires on its own. */
    nextAttentionBoundaryMs: number | null;
}>;

/** The summary's one reading of a candidate; the complete and the changed-address summaries share it. */
export function readActivitySummaryFacts({ entry, candidate, messages }: ActivitySummaryCandidate, nowMs: number): ActivitySummaryFacts {
    let nextAttentionBoundaryMs: number | null = null;
    for (const expiresAtMs of readSessionPersonalAttentionExpirationsForViewer(entry.session, nowMs, messages, entry.presentationSource)) {
        if (expiresAtMs <= nowMs) continue;
        if (nextAttentionBoundaryMs === null || expiresAtMs < nextAttentionBoundaryMs) nextAttentionBoundaryMs = expiresAtMs;
    }
    const inboxSection = classifyInboxSessionCandidate(candidate).section;
    return {
        attention: candidate.hasAttention,
        inbox: inboxSection !== null,
        inboxNeedsYou: inboxSection === 'needs_attention',
        working: candidate.reasons.isThinking,
        needsYou: isActivityCandidateAwaitingPerson(candidate),
        nextAttentionBoundaryMs,
    };
}

export function areActivitySummaryFactsEqual(left: ActivitySummaryFacts, right: ActivitySummaryFacts): boolean {
    return left.attention === right.attention && left.inbox === right.inbox && left.inboxNeedsYou === right.inboxNeedsYou
        && left.working === right.working
        && left.needsYou === right.needsYou && left.nextAttentionBoundaryMs === right.nextAttentionBoundaryMs;
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
    resolveSessionOptionsForServerId?: (serverId: string) => SessionAttentionOptions | null;
    includeHydratedMessages?: boolean;
    includeWarmSourceWhenNotReady?: boolean;
}>): ActivityOverviewSummary {
    let totalAttentionCount = 0;
    let inboxContentCount = 0;
    let inboxNeedsYouCount = 0;
    let workingCount = 0;
    let needsYouCount = 0;
    let nextAttentionBoundaryMs: number | null = null;

    forEachActivitySummaryCandidate(params, (visited) => {
        const facts = readActivitySummaryFacts(visited, params.nowMs);
        if (facts.attention) totalAttentionCount += 1;
        if (facts.inbox) inboxContentCount += 1;
        if (facts.inboxNeedsYou) inboxNeedsYouCount += 1;
        if (facts.working) workingCount += 1;
        if (facts.needsYou) needsYouCount += 1;
        if (facts.nextAttentionBoundaryMs !== null
            && (nextAttentionBoundaryMs === null || facts.nextAttentionBoundaryMs < nextAttentionBoundaryMs)) {
            nextAttentionBoundaryMs = facts.nextAttentionBoundaryMs;
        }
    });

    return { isDataReady: params.source.isDataReady, totalAttentionCount, inboxContentCount, inboxNeedsYouCount, nextAttentionBoundaryMs, workingCount, needsYouCount };
}
