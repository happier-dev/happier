import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import type {
    ActivityOverviewSnapshot,
    ActivitySurfaceTimingBySurface,
    ActivitySurfaceTimingFacts,
    SessionActivityAttention,
} from '@/activity/attention/activityAttentionTypes';
import type { SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import {
    listSessionListLookupActiveSessionIds,
    listSessionListLookupServerSessions,
    findSessionListLookupSession,
    resolveSessionListLookupSessionServerScopeFromState,
    type SessionServerLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import type { AgentState, Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    createActivitySurfaceSessionRoute,
    createActivitySurfaceSessionTarget,
} from '@/activity/actions/activitySurfaceTargets';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';

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

function sortCandidates(left: SessionActivityAttention, right: SessionActivityAttention): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    if (left.session.updatedAt !== right.session.updatedAt) {
        return right.session.updatedAt - left.session.updatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
}

function buildLookupState(source: ActivityAttentionSource): SessionServerLookupStateLike {
    return {
        sessions: source.sessionsById,
        sessionListRenderables: source.sessionListRenderablesById,
        sessionListIndexByServerId: source.sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: source.concurrentSessionListCacheByServerId,
    };
}

function collectLookupSessionIds(
    source: ActivityAttentionSource,
    includeWarmSourceWhenNotReady: boolean,
): readonly string[] {
    if (!source.isDataReady && !includeWarmSourceWhenNotReady) {
        return [];
    }

    const lookupState = buildLookupState(source);
    const sessionIds: string[] = [];
    const seenSessionIds = new Set<string>();

    for (const sessionId of listSessionListLookupActiveSessionIds(lookupState)) {
        if (!sessionId || seenSessionIds.has(sessionId)) {
            continue;
        }
        seenSessionIds.add(sessionId);
        sessionIds.push(sessionId);
    }

    for (const items of Object.values(source.sessionListIndexByServerId)) {
        if (!Array.isArray(items)) {
            continue;
        }
        for (const item of items) {
            if (item.type !== 'session') {
                continue;
            }
            const sessionId = item.sessionId.trim();
            if (!sessionId || seenSessionIds.has(sessionId)) {
                continue;
            }
            seenSessionIds.add(sessionId);
            sessionIds.push(sessionId);
        }
    }

    for (const entry of listSessionListLookupServerSessions(lookupState)) {
        const sessionId = entry.session.id.trim();
        if (!sessionId || seenSessionIds.has(sessionId)) {
            continue;
        }
        seenSessionIds.add(sessionId);
        sessionIds.push(sessionId);
    }

    return sessionIds;
}

function buildSessionFromRenderable(
    renderable: SessionListRenderableSession,
    serverId?: string | null,
): Session {
    const seq = Math.max(0, Math.trunc(renderable.seq ?? 0));
    const normalizedServerId = typeof serverId === 'string' && serverId.trim() ? serverId.trim() : undefined;
    const pendingRequestObservedAt = typeof renderable.pendingRequestObservedAt === 'number'
        && Number.isFinite(renderable.pendingRequestObservedAt)
        && renderable.pendingRequestObservedAt > 0
        ? renderable.pendingRequestObservedAt
        : null;
    const agentState = buildRenderablePendingAgentState(renderable, pendingRequestObservedAt);

    return {
        id: renderable.id,
        serverId: normalizedServerId,
        seq: renderable.hasUnreadMessages === true ? Math.max(1, seq) : seq,
        createdAt: renderable.createdAt,
        updatedAt: renderable.updatedAt,
        active: renderable.active,
        activeAt: renderable.activeAt,
        archivedAt: renderable.archivedAt ?? null,
        meaningfulActivityAt: renderable.meaningfulActivityAt ?? null,
        pendingVersion: renderable.pendingVersion,
        pendingCount: renderable.pendingCount,
        lastViewedSessionSeq: renderable.hasUnreadMessages === true ? 0 : seq,
        pendingPermissionRequestCount: renderable.hasPendingPermissionRequests === true ? 1 : 0,
        pendingUserActionRequestCount: renderable.hasPendingUserActionRequests === true ? 1 : 0,
        latestReadyEventSeq: renderable.hasUnreadMessages === true ? Math.max(1, seq) : renderable.latestReadyEventSeq,
        latestTurnStatus: renderable.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: renderable.latestTurnStatusObservedAt ?? null,
        lastRuntimeIssue: renderable.lastRuntimeIssue ?? null,
        lastTurnCompletedAt: renderable.lastTurnCompletedAt ?? null,
        metadata: renderable.metadata as Session['metadata'],
        metadataVersion: renderable.metadataVersion,
        agentState,
        agentStateVersion: renderable.agentStateVersion,
        thinking: renderable.thinking,
        thinkingAt: renderable.thinkingAt,
        presence: renderable.presence,
        optimisticThinkingAt: renderable.optimisticThinkingAt,
        thinkingGraceUntil: renderable.thinkingGraceUntil,
        owner: renderable.owner,
        accessLevel: renderable.accessLevel,
        canApprovePermissions: renderable.canApprovePermissions,
    };
}

function buildRenderablePendingAgentState(
    renderable: SessionListRenderableSession,
    pendingRequestObservedAt: number | null,
): AgentState | null {
    if (pendingRequestObservedAt === null) return null;

    const requests: NonNullable<AgentState['requests']> = {};
    if (renderable.hasPendingPermissionRequests === true) {
        requests.permission = {
            tool: 'PendingPermission',
            kind: 'permission',
            arguments: {},
            createdAt: pendingRequestObservedAt,
        };
    }
    if (renderable.hasPendingUserActionRequests === true) {
        requests.user_action = {
            tool: 'PendingUserAction',
            kind: 'user_action',
            arguments: {},
            createdAt: pendingRequestObservedAt,
        };
    }

    return Object.keys(requests).length > 0
        ? { controlledByUser: null, requests }
        : null;
}

function collectSourceSessions(
    source: ActivityAttentionSource,
    includeWarmSourceWhenNotReady: boolean,
): readonly Session[] {
    const sessions: Session[] = [];
    const lookupState = buildLookupState(source);

    for (const sessionId of collectLookupSessionIds(source, includeWarmSourceWhenNotReady)) {
        const session = source.sessionsById[sessionId];
        if (session) {
            if (isUserFacingSession(session)) {
                sessions.push(session);
            }
            continue;
        }
        const lookupEntry = findSessionListLookupSession(lookupState, sessionId);
        const renderable = lookupEntry?.session ?? source.sessionListRenderablesById[sessionId];
        if (renderable && isUserFacingSession(renderable)) {
            sessions.push(buildSessionFromRenderable(renderable, lookupEntry?.serverId ?? null));
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
    return `${params.serverId ?? 'local'}:${params.activityName}:${params.sessionId}`;
}

function enrichCandidateWithSourceFacts(params: Readonly<{
    source: ActivityAttentionSource;
    lookupState: SessionServerLookupStateLike;
    candidate: SessionActivityAttention;
    activityName: string | null;
    directActionsEnabled: boolean;
    surfaceTiming: ActivitySurfaceTimingBySurface;
}>): SessionActivityAttention {
    const sessionId = params.candidate.sessionId;
    const scope = resolveSessionListLookupSessionServerScopeFromState(params.lookupState, sessionId);
    const serverId = normalizeServerId(scope?.serverId) ?? normalizeServerId(params.candidate.session.serverId);
    const profile = resolveServerProfile(params.source, serverId);
    const serverUrl = profile?.serverUrl ?? (
        serverId && params.source.activeServer?.serverId === serverId ? params.source.activeServer.serverUrl : null
    );
    const serverName = scope?.serverName ?? profile?.name ?? null;
    const route = createActivitySurfaceSessionRoute(sessionId, serverId);
    const target = createActivitySurfaceSessionTarget(sessionId, serverId);
    const isKnown = Boolean(serverId);
    const isSaved = Boolean(profile);
    const isActiveLocal = Boolean(serverId && params.source.activeServer?.serverId === serverId);
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

    return {
        ...params.candidate,
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
    activityName?: string | null;
    directActionsEnabled?: boolean;
    surfaceTiming?: ActivitySurfaceTimingInput;
    includeWarmSourceWhenNotReady?: boolean;
}>): ActivityOverviewSnapshot {
    const lookupState = buildLookupState(params.source);
    const surfaceTiming = resolveActivitySurfaceTiming(params.surfaceTiming);
    const candidates = collectSourceSessions(params.source, params.includeWarmSourceWhenNotReady === true)
        .map((session) => buildSessionActivityAttention({
            session,
            sessionMessages: readSourceSessionMessages(params.source, session.id),
            sessionOptions: params.sessionOptions,
            nowMs: params.nowMs,
        }))
        .map((candidate) => enrichCandidateWithSourceFacts({
            source: params.source,
            lookupState,
            candidate,
            activityName: typeof params.activityName === 'string' && params.activityName.trim()
                ? params.activityName.trim()
                : null,
            directActionsEnabled: params.directActionsEnabled === true,
            surfaceTiming,
        }))
        .sort(sortCandidates);

    let unread = 0;
    let permissionRequired = 0;
    let actionRequired = 0;
    let queuedInput = 0;
    let thinking = 0;
    let totalAttention = 0;

    for (const candidate of candidates) {
        if (candidate.reasons.hasUnread) unread += 1;
        if (candidate.reasons.hasPendingPermissionRequests) permissionRequired += 1;
        if (candidate.reasons.hasPendingUserActionRequests) actionRequired += 1;
        if (candidate.reasons.isThinking) thinking += 1;
        if (candidate.hasAttention) totalAttention += 1;
    }

    const overview: ActivityOverviewSnapshot = {
        counts: {
            unread,
            permissionRequired,
            actionRequired,
            queuedInput,
            thinking,
            totalAttention,
        },
        candidates,
    };
    return {
        ...overview,
        fingerprint: buildStableActivityOverviewFingerprint(overview),
    };
}

export function buildStableActivityOverviewFingerprint(overview: ActivityOverviewSnapshot): string {
    return JSON.stringify({
        counts: overview.counts,
        candidates: overview.candidates.map((candidate) => ({
            sessionId: candidate.sessionId,
            serverId: candidate.serverId ?? null,
            route: candidate.route ?? null,
            target: candidate.target ?? null,
            activityName: candidate.activityName ?? null,
            activityInstanceKey: candidate.activityInstanceKey ?? null,
            canExecuteDirectAction: candidate.directActionCapability?.canExecute ?? false,
            surfaceTiming: candidate.surfaceTiming ?? null,
            attentionState: candidate.attentionState,
            priority: candidate.priority,
            updatedAt: candidate.session.updatedAt,
            lastTurnCompletedAt: candidate.lastTurnCompletedAt,
            reasons: candidate.reasons,
        })),
    });
}
