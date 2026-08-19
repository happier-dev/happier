import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    deriveSessionListAttentionState,
    deriveSessionListMeaningfulActivityAt,
    resolveSessionListUpdatedAt,
    resolveSessionListSecondaryLineMode,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionAttentionStanding } from '@/sync/domains/session/organization/attentionStanding';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    getSessionName,
    getSessionStatus,
    getSessionSubtitle,
} from '@/utils/sessions/sessionUtils';
import {
    resolveNextSessionRuntimePresentationFreshnessAtMs,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { countSessionAgentActivityFromMetadata } from '@/sync/domains/session/agentActivity/countSessionAgentActivityFromMetadata';
import type { AgentActivityCounts } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import {
    formatSessionAgentActivityLabel,
    resolveSessionActivityComposerTranslate,
} from '@/components/sessions/workState/sessionActivityPresentation';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';
import { sessionTagKey } from '../sessionTagUtils';
import { treeRowId } from '../drop-resolution/treeRowId';
import {
    resolveSessionRowAttentionState,
    resolveSessionRowPresentation,
} from './resolveSessionRowPresentation';
import type {
    SessionListRowModel,
    SessionListRowPresentationSettings,
    SessionListRowSessionItem,
    SessionListRowStateSnapshot,
} from './sessionListRowModelTypes';

export type BuildSessionListRowModelInput = Readonly<{
    item: SessionListRowSessionItem;
    state?: Partial<SessionListRowStateSnapshot>;
    dataIndex: number;
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
    settings: SessionListRowPresentationSettings;
}>;

type SessionStatusSource = Session | SessionListRenderableSession;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeFiniteTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function normalizeFiniteCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function readPendingCount(snapshot: Partial<SessionListRowStateSnapshot>, session: SessionStatusSource): number {
    const pendingMessages = snapshot.pending?.messages;
    if (Array.isArray(pendingMessages)) return pendingMessages.length;
    const renderableCount = (session as SessionListRenderableSession).pendingCount;
    return normalizeFiniteCount(renderableCount) ?? 0;
}

function readPendingBlockedCount(snapshot: Partial<SessionListRowStateSnapshot>, session: SessionStatusSource): number {
    const renderableCount = (session as SessionListRenderableSession).pendingBlockedCount ?? (session as Session).pendingBlockedCount;
    const normalizedRenderableCount = normalizeFiniteCount(renderableCount);
    if (normalizedRenderableCount !== null) return normalizedRenderableCount;
    const pendingMessages = snapshot.pending?.messages;
    if (Array.isArray(pendingMessages)) {
        return pendingMessages.reduce((count, message) => message.pendingDeliveryStatus === 'blocked' ? count + 1 : count, 0);
    }
    return 0;
}

function listCommittedMessages(snapshot: Partial<SessionListRowStateSnapshot>): readonly Message[] {
    const messages = snapshot.messages;
    if (!messages) return [];
    const ids = messages.messageIdsOldestFirst;
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const out: Message[] = [];
    for (const messageId of ids) {
        const message = messages.messagesById[messageId];
        if (message) out.push(message);
    }
    return out;
}

function resolveLatestCommittedMessageCreatedAt(snapshot: Partial<SessionListRowStateSnapshot>): number | null {
    const messages = snapshot.messages;
    const ids = messages?.messageIdsOldestFirst;
    if (!ids || ids.length === 0) return null;
    const latestMessageId = ids[ids.length - 1] ?? null;
    if (!latestMessageId) return null;
    return normalizeFiniteTimestamp(messages?.messagesById[latestMessageId]?.createdAt);
}

function resolveLatestPendingMessageCreatedAt(snapshot: Partial<SessionListRowStateSnapshot>): number | null {
    let latest: number | null = null;
    for (const pendingMessage of snapshot.pending?.messages ?? []) {
        const createdAt = normalizeFiniteTimestamp(pendingMessage.createdAt);
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

function resolveSessionListRowSession(
    storeSession: SessionListRenderableSession | undefined,
    rowSession: Session | SessionListRenderableSession,
): Session | SessionListRenderableSession {
    if (!storeSession) return rowSession;
    const rowRenderable = rowSession as Partial<SessionListRenderableSession>;
    const hasPendingPermissionRequests =
        rowRenderable.hasPendingPermissionRequests === true || storeSession.hasPendingPermissionRequests === true;
    const hasPendingUserActionRequests =
        rowRenderable.hasPendingUserActionRequests === true || storeSession.hasPendingUserActionRequests === true;
    const keepVisibleWhenInactive =
        rowRenderable.keepVisibleWhenInactive === true || storeSession.keepVisibleWhenInactive === true;
    const rowPendingBlockedCount = normalizeFiniteCount(rowRenderable.pendingBlockedCount);
    const storePendingBlockedCount = normalizeFiniteCount(storeSession.pendingBlockedCount);
    const pendingBlockedCount = storePendingBlockedCount ?? rowPendingBlockedCount;
    const meaningfulActivityAt =
        typeof rowRenderable.meaningfulActivityAt === 'number'
        && Number.isFinite(rowRenderable.meaningfulActivityAt)
        && (
            typeof storeSession.meaningfulActivityAt !== 'number'
            || rowRenderable.meaningfulActivityAt > storeSession.meaningfulActivityAt
        )
            ? rowRenderable.meaningfulActivityAt
            : storeSession.meaningfulActivityAt ?? null;

    if (
        hasPendingPermissionRequests === storeSession.hasPendingPermissionRequests
        && hasPendingUserActionRequests === storeSession.hasPendingUserActionRequests
        && keepVisibleWhenInactive === storeSession.keepVisibleWhenInactive
        && pendingBlockedCount === normalizeFiniteCount(storeSession.pendingBlockedCount)
        && meaningfulActivityAt === (storeSession.meaningfulActivityAt ?? null)
    ) {
        return storeSession;
    }

    return {
        ...storeSession,
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        keepVisibleWhenInactive,
        ...(pendingBlockedCount === null ? {} : { pendingBlockedCount }),
        meaningfulActivityAt,
    };
}

function resolveMeaningfulActivityAt(
    snapshot: Partial<SessionListRowStateSnapshot>,
    session: SessionStatusSource,
): number | null {
    return deriveSessionListMeaningfulActivityAt({
        sessionCreatedAt: session.createdAt,
        sessionMeaningfulActivityAt: session.meaningfulActivityAt ?? null,
        latestCommittedMessageCreatedAt: resolveLatestCommittedMessageCreatedAt(snapshot),
        latestThinkingActivityAt: snapshot.messages?.latestThinkingMessageActivityAtMs ?? null,
        latestPendingMessageCreatedAt: resolveLatestPendingMessageCreatedAt(snapshot),
    });
}

function resolveHasUnreadMessages(
    snapshot: Partial<SessionListRowStateSnapshot>,
    session: SessionStatusSource,
): boolean {
    const readableSeq = resolveSessionReadableSeq({
        messages: listCommittedMessages(snapshot),
        sessionSeq: session.seq,
        latestReadyEventSeq:
            snapshot.messages?.latestReadyEventSeq
            ?? (session as Session).latestReadyEventSeq
            ?? (session as SessionListRenderableSession).latestReadyEventSeq
            ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        includeTerminalSessionSeq: true,
    });
    const lastViewedSessionSeq = resolveLastViewedSessionSeq(session) ?? null;
    if (readableSeq !== null) {
        return readableSeq > (lastViewedSessionSeq ?? 0);
    }
    return (session as SessionListRenderableSession).hasUnreadMessages === true;
}

/**
 * What agent work is live, from whichever shape of session this row was handed.
 *
 * A renderable-backed row carries the tally already projected (see `SessionListRenderableMetadata`),
 * which is the path every virtualized list row takes. A row backed by a full store session — the
 * fallback when no renderable exists — computes it from real metadata through the same owner, so the
 * two paths cannot produce different numbers.
 */
function readSessionAgentActivityCounts(session: SessionStatusSource): AgentActivityCounts {
    const projected = (session as SessionListRenderableSession).metadata?.agentActivityCounts;
    if (projected) return projected;
    return countSessionAgentActivityFromMetadata((session as Session).metadata);
}

function resolveNextRuntimeFreshnessAtMs(session: SessionStatusSource, nowMs: number): number | null {
    if (session.active !== true || session.presence !== 'online') return null;
    return resolveNextSessionRuntimePresentationFreshnessAtMs({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState,
        runtimeActivityActiveCount: session.runtimeActivityActiveCount,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt,
        runtimeActivityRevision: session.runtimeActivityRevision,
        hasPendingPermissionRequests: (session as SessionListRenderableSession).hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: (session as SessionListRenderableSession).hasPendingUserActionRequests === true,
        pendingRequestObservedAt: (session as SessionListRenderableSession).pendingRequestObservedAt ?? null,
    }, nowMs);
}

function buildStatusSignature(status: ReturnType<typeof getSessionStatus>, nextRuntimeFreshnessAtMs: number | null): string {
    return [
        status.state,
        status.isConnected ? '1' : '0',
        status.shouldShowStatus ? '1' : '0',
        status.statusText,
        status.isPulsing === true ? '1' : '0',
        nextRuntimeFreshnessAtMs ?? '',
    ].join('|');
}

function resolveRowIdentityLoading(input: Readonly<{
    session: SessionStatusSource;
    title: string;
}>): boolean {
    const metadataUnavailable = (input.session as SessionListRenderableSession).metadataUnavailable === true;
    return !metadataUnavailable
        && input.session.metadata == null
        && input.title === t('status.unknown');
}

function resolveRowSubtitle(input: Readonly<{
    rowKey: string;
    settings: SessionListRowPresentationSettings;
    session: SessionStatusSource;
}>): Readonly<{ subtitle: string; subtitleEllipsizeMode: 'head' | 'tail' }> {
    const reachableDisplay = input.settings.reachableSessionDisplayByKey[input.rowKey];
    if (reachableDisplay) {
        const workspaceSubtitle = normalizeNonEmptyString(reachableDisplay.workspaceSubtitle) ?? '';
        const machineLabel = normalizeNonEmptyString(reachableDisplay.machineLabel) ?? '';
        return {
            subtitle: input.settings.hasMultipleMachines
                ? (machineLabel && workspaceSubtitle
                    ? `${machineLabel} · ${workspaceSubtitle}`
                    : machineLabel || workspaceSubtitle)
                : workspaceSubtitle,
            subtitleEllipsizeMode: reachableDisplay.workspaceSubtitleEllipsizeMode ?? 'head',
        };
    }

    return {
        subtitle: getSessionSubtitle(input.session),
        subtitleEllipsizeMode: 'head',
    };
}

export function buildSessionListRowModel(input: BuildSessionListRowModelInput): SessionListRowModel {
    const { item, settings } = input;
    const sessionId = String(item.session.id);
    const serverId = normalizeNonEmptyString(item.serverId);
    const rowKey = serverId ? sessionTagKey(serverId, sessionId) : sessionId;
    const resolvedSession = resolveSessionListRowSession(input.state?.renderable, item.session);
    const activityMode: SessionListRowModel['activity']['mode'] = item.groupKind === 'date'
        ? 'updatedAt'
        : 'meaningful';
    const activityTimestamp = activityMode === 'updatedAt'
        ? normalizeFiniteTimestamp(resolveSessionListUpdatedAt({
            sessionCreatedAt: resolvedSession.createdAt,
            sessionUpdatedAt: resolvedSession.updatedAt,
        }))
        : resolveMeaningfulActivityAt(input.state ?? {}, resolvedSession);
    const activityLabel = typeof activityTimestamp === 'number' && activityTimestamp > 0
        ? formatShortRelativeTimeAt(activityTimestamp, settings.relativeNowMs)
        : '';
    const status = getSessionStatus(resolvedSession, settings.runtimeNowMs, {
        workingTextMode: settings.workingTextMode,
        statusColors: settings.statusColors,
    });
    const pendingCount = readPendingCount(input.state ?? {}, resolvedSession);
    const pendingBlockedCount = readPendingBlockedCount(input.state ?? {}, resolvedSession);
    const hasUnreadMessages = resolveHasUnreadMessages(input.state ?? {}, resolvedSession);
    const attentionState = deriveSessionListAttentionState({
        hasUnreadMessages,
        pendingCount,
        pendingBlockedCount,
        sessionState: status.state,
        latestTurnStatus: resolvedSession.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: normalizeFiniteTimestamp(resolvedSession.latestTurnStatusObservedAt),
        lastRuntimeIssue: resolvedSession.lastRuntimeIssue ?? null,
        seq: normalizeFiniteTimestamp(resolvedSession.seq),
        meaningfulActivityAt: resolveMeaningfulActivityAt(input.state ?? {}, resolvedSession),
        latestReadyEventSeq:
            input.state?.messages?.latestReadyEventSeq
            ?? (resolvedSession as Session).latestReadyEventSeq
            ?? (resolvedSession as SessionListRenderableSession).latestReadyEventSeq
            ?? null,
        latestReadyEventAt:
            input.state?.messages?.latestReadyEventAt
            ?? (resolvedSession as Session).latestReadyEventAt
            ?? (resolvedSession as SessionListRenderableSession).latestReadyEventAt
            ?? null,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(resolvedSession) ?? null,
    });
    const derivedRowAttentionState = resolveSessionRowAttentionState(attentionState);
    // Retained working placement holds the session in the working group while
    // its live signals are stale. Present it as a PAUSED working row (working
    // indicator without animation) unless a more alerting state applies —
    // otherwise the user sees a session in the working group with no
    // indicator at all.
    const presentsRetainedWorking = item.workingPlacementReason === 'working-retained'
        && (
            derivedRowAttentionState === 'quiet'
            || derivedRowAttentionState === 'unread'
            || derivedRowAttentionState === 'pending'
        );
    const rowAttentionState = presentsRetainedWorking
        ? 'working'
        : derivedRowAttentionState;
    // Attention standing is the person's own instruction to keep a read, idle
    // session in the band. It comes off the placement reason and stays OUT of the
    // attention state on purpose: the session has nothing new in it, so the row
    // must not take an unread title or badge — it only says why it is still here.
    const presentsAttentionStanding = item.attentionPromotionReason === 'standing';
    const secondaryLineGroupKind = item.groupKind === 'folder' ? 'project' : item.groupKind;
    const secondaryLineMode = resolveSessionListSecondaryLineMode({ groupKind: secondaryLineGroupKind });
    const { subtitle, subtitleEllipsizeMode } = resolveRowSubtitle({
        rowKey,
        settings,
        session: resolvedSession,
    });
    const presentation = resolveSessionRowPresentation({
        attentionState: rowAttentionState,
        density: settings.density,
        requestedSecondaryLineMode: secondaryLineMode,
        hasPathSubtitle: subtitle.trim().length > 0,
        workingRetained: presentsRetainedWorking,
        standing: presentsAttentionStanding,
        backgroundActive: status.state === 'background_active',
    });
    // Absent unless the person asked for it (R-8): the row model always carries the field so a host
    // cannot invent a second way to get the sentence, and the setting decides whether it is drawn.
    // Composed through the composer chip's own owner, so a row and the session it opens onto cannot
    // describe the same workflow differently.
    const agentActivityLabel = settings.agentActivityCountEnabled
        ? formatSessionAgentActivityLabel(
            readSessionAgentActivityCounts(resolvedSession),
            resolveSessionActivityComposerTranslate(),
        )
        : null;
    const nextRuntimeFreshnessAtMs = resolveNextRuntimeFreshnessAtMs(resolvedSession, settings.runtimeNowMs);
    const isArchived = resolvedSession.archivedAt != null;
    const isPinned = item.pinned === true || settings.pinnedSessionKeys.includes(rowKey);
    // The STORED instruction, resolved through the policy owner, never the placement reason: a
    // standing session that is currently placed for being unread must still offer to be removed.
    const isAttentionStanding = resolveSessionAttentionStanding(settings.attentionStandingPolicy, rowKey);
    const title = getSessionName(resolvedSession);

    return {
        rowKey,
        sessionId,
        serverId,
        serverName: item.serverName,
        treeRowId: serverId ? treeRowId.session(serverId, sessionId) : `session:${sessionId}`,
        testID: `session-list-item-${sessionId}`,
        dataIndex: input.dataIndex,
        session: resolvedSession,
        status,
        statusSignature: buildStatusSignature(status, nextRuntimeFreshnessAtMs),
        nextRuntimeFreshnessAtMs,
        secondaryLineMode,
        attention: {
            listState: attentionState,
            rowState: rowAttentionState,
        },
        presentation,
        workingIndicatorPaused: presentsRetainedWorking,
        activity: {
            mode: activityMode,
            timestamp: activityTimestamp,
            label: activityLabel,
            bucket: activityLabel,
        },
        isIdentityLoading: resolveRowIdentityLoading({
            session: resolvedSession,
            title,
        }),
        title,
        subtitle,
        subtitleEllipsizeMode,
        groupKey: String(item.groupKey ?? '').trim(),
        groupKind: item.groupKind ?? null,
        section: item.section ?? null,
        variant: item.variant ?? null,
        folder: {
            id: item.folderId ?? null,
            depth: settings.folderViewEnabled ? Math.max(0, Math.trunc(item.folderDepth ?? 0)) : 0,
        },
        adjacency: {
            isFirst: input.isFirst,
            isLast: input.isLast,
            isSingle: input.isSingle,
        },
        isSelected: (item as SessionListRowSessionItem & { selected?: boolean }).selected === true,
        isPinned,
        isAttentionStanding,
        attentionStandingEnabled: settings.attentionStandingEnabled,
        isArchived,
        isActive: resolvedSession.active === true,
        hasUnreadMessages,
        pendingCount,
        pendingBlockedCount,
        agentActivityLabel,
        tags: settings.sessionTagsByKey[rowKey] ?? [],
        allKnownTags: settings.allKnownTags,
        tagsEnabled: settings.tagsEnabled,
        currentUserId: settings.currentUserId,
        showServerBadge: isPinned ? settings.showPinnedServerBadge : settings.showServerBadge,
        compact: settings.compact,
        compactMinimal: settings.compactMinimal,
        identityDisplay: settings.identityDisplay,
        activeColorMode: settings.activeColorMode,
        workingIndicatorMode: settings.workingIndicatorMode,
        hideInactiveSessions: settings.hideInactiveSessions,
    };
}
