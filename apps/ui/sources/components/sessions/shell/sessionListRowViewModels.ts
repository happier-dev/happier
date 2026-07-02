import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import {
    isFreshTimestamp,
    readSessionRuntimePresentationFreshnessTimestamps,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName, getSessionStatus, type SessionStatus, type SessionWorkingTextMode } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { LruMap } from '@/utils/cache/lruMap';
import { t } from '@/text';

import { getTagsForSession, sessionTagKey } from './sessionTagUtils';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

export type SessionListRowViewModel = Readonly<{
    groupKey: string;
    sessionKey: string | null;
    session: SessionListRenderableSession | null;
    sessionStatus: SessionStatus | null;
    isIdentityLoading: boolean;
    nextRuntimeFreshnessAtMs: number | null;
    hasUnreadMessages: boolean;
    activityTimeLabel: string;
    workingIndicatorMode: 'spinner' | 'pulse';
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions: boolean;
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
    subtitleOverride: string | null;
    subtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    pinned: boolean;
    showServerBadge: boolean;
    selected: boolean;
    tags: string[];
    secondaryLineMode: ReturnType<typeof resolveSessionListSecondaryLineMode>;
}>;

const EMPTY_SESSION_LIST_ROW_VIEW_MODELS: ReadonlyArray<SessionListRowViewModel | null> = [];

type RowViewModelCacheEntry = Readonly<{
    sessionRef: SessionListRenderableSession | null;
    signature: string;
    value: SessionListRowViewModel;
}>;

const SESSION_LIST_ROW_VIEW_MODEL_CACHE = new LruMap<string, RowViewModelCacheEntry>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function buildSessionListRowViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey?: ReadonlyMap<string, SessionReachableDisplay>;
    rowRenderableByKey?: ReadonlyMap<string, SessionListRenderableSession>;
    relativeNowMs?: number;
    runtimeNowMs?: number;
    workingIndicatorMode?: 'spinner' | 'pulse';
    workingTextMode?: SessionWorkingTextMode;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none';
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions?: boolean;
    hasMultipleMachines: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
}>): ReadonlyArray<SessionListRowViewModel | null> {
    if (input.listItems.length === 0) {
        return EMPTY_SESSION_LIST_ROW_VIEW_MODELS;
    }

    const next = input.listItems.map((item, index) => {
        if (item.type !== 'session') {
            return null;
        }

        const groupKey = String(item.groupKey ?? '').trim();
        const prev = index > 0 ? input.listItems[index - 1] : null;
        const next = index < input.listItems.length - 1 ? input.listItems[index + 1] : null;
        const prevGroupKey = prev && prev.type === 'session' ? String(prev.groupKey ?? '').trim() : '';
        const nextGroupKey = next && next.type === 'session' ? String(next.groupKey ?? '').trim() : '';
        const isFirst = !groupKey || prevGroupKey !== groupKey;
        const isLast = !groupKey || nextGroupKey !== groupKey;
        const sessionId = String(item.sessionId ?? '').trim();
        const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
        const sessionKey = serverId && sessionId ? sessionTagKey(serverId, sessionId) : null;
        const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
        const reachableDisplay = (sessionKey ? input.reachableSessionDisplayByKey?.get(sessionKey) : undefined)
            ?? input.reachableSessionDisplayById.get(sessionId);
        const workspaceSubtitle = reachableDisplay?.workspaceSubtitle ?? '';
        const subtitleEllipsizeMode = reachableDisplay?.workspaceSubtitleEllipsizeMode ?? 'head';
        const machineLabel = reachableDisplay?.machineLabel ?? '';
        const subtitle = input.hasMultipleMachines
            ? (machineLabel && workspaceSubtitle ? `${machineLabel} · ${workspaceSubtitle}` : machineLabel || workspaceSubtitle)
            : workspaceSubtitle;
        const session = sessionKey ? input.rowRenderableByKey?.get(sessionKey) ?? null : null;
        const relativeNowMs = normalizeClockNow(input.relativeNowMs);
        const runtimeNowMs = normalizeClockNow(input.runtimeNowMs);
        const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : null;
        const activityTimeLabel = typeof activityAt === 'number' && activityAt > 0
            ? formatShortRelativeTimeAt(activityAt, relativeNowMs)
            : '';
        const sessionStatus = session
            ? getSessionStatus(session, runtimeNowMs, {
                vibingIndex: resolveStableVibingIndex(sessionKey ?? sessionId),
                workingTextMode: input.workingTextMode ?? 'animated',
            })
            : null;
        const sessionName = session ? getSessionName(session) : '';

        const rowViewModel: SessionListRowViewModel = {
            groupKey,
            sessionKey,
            session,
            sessionStatus,
            isIdentityLoading: session ? resolveRowIdentityLoading({
                session,
                title: sessionName,
            }) : false,
            nextRuntimeFreshnessAtMs: session ? resolveNextRuntimeFreshnessAtMs(session, runtimeNowMs) : null,
            hasUnreadMessages: session?.hasUnreadMessages === true,
            activityTimeLabel,
            workingIndicatorMode: input.workingIndicatorMode === 'pulse' ? 'pulse' : 'spinner',
            identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
            activeColorMode: normalizeActiveColorMode(input.activeColorMode),
            hideInactiveSessions: input.hideInactiveSessions === true,
            isFirst,
            isLast,
            isSingle: isFirst && isLast,
            subtitleOverride: item.groupKind === 'project' && item.variant === 'no-path' ? null : (subtitle || null),
            subtitleEllipsizeMode,
            pinned,
            showServerBadge: pinned ? input.showPinnedServerBadge : input.showServerBadge,
            selected: input.selectedSessionId != null && input.selectedSessionId === sessionId,
            tags: getTagsForSession(input.sessionTags, sessionKey ?? ''),
            secondaryLineMode: resolveSessionListSecondaryLineMode({ groupKind: item.groupKind }),
        };
        const signature = buildRowViewModelSignature(rowViewModel);
        const cacheKey = sessionKey ?? `session:${sessionId}`;
        const cached = SESSION_LIST_ROW_VIEW_MODEL_CACHE.get(cacheKey);
        if (
            cached?.signature === signature
            && (
                cached.sessionRef === session
                || (cached.sessionRef != null && session != null && areSessionListRenderablesEqual(cached.sessionRef, session))
            )
        ) {
            return cached.value;
        }
        SESSION_LIST_ROW_VIEW_MODEL_CACHE.set(cacheKey, {
            sessionRef: session,
            signature,
            value: rowViewModel,
        });
        return rowViewModel;
    });
    return next;
}

function buildRowViewModelSignature(viewModel: SessionListRowViewModel): string {
    return [
        viewModel.groupKey,
        viewModel.sessionKey ?? '',
        viewModel.sessionStatus?.state ?? '',
        viewModel.sessionStatus?.statusText ?? '',
        viewModel.sessionStatus?.shouldShowStatus === true ? '1' : '0',
        viewModel.isIdentityLoading ? '1' : '0',
        viewModel.nextRuntimeFreshnessAtMs ?? '',
        viewModel.hasUnreadMessages ? '1' : '0',
        viewModel.activityTimeLabel,
        viewModel.workingIndicatorMode,
        viewModel.identityDisplay,
        viewModel.activeColorMode,
        viewModel.hideInactiveSessions ? '1' : '0',
        viewModel.isFirst ? '1' : '0',
        viewModel.isLast ? '1' : '0',
        viewModel.isSingle ? '1' : '0',
        viewModel.subtitleOverride ?? '',
        viewModel.subtitleEllipsizeMode,
        viewModel.pinned ? '1' : '0',
        viewModel.showServerBadge ? '1' : '0',
        viewModel.selected ? '1' : '0',
        viewModel.tags.join('\u0001'),
        viewModel.secondaryLineMode,
    ].join('\u0002');
}

function normalizeClockNow(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function normalizeActiveColorMode(
    value: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null | undefined,
): 'activityAndAttention' | 'attentionOnly' | 'allActive' {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

function resolveStableVibingIndex(key: string): number {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
        hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
    }
    return hash;
}

function resolveRowIdentityLoading(input: Readonly<{
    session: SessionListRenderableSession;
    title: string;
}>): boolean {
    const metadataUnavailable = input.session.metadataUnavailable === true;
    return !metadataUnavailable
        && input.session.metadata == null
        && input.title === t('status.unknown');
}

function resolveNextRuntimeFreshnessAtMs(session: SessionListRenderableSession, nowMs: number): number | null {
    if (session.active !== true || session.presence !== 'online') return null;

    const expirations: number[] = [];
    const addExpiration = (timestamp: number | null | undefined) => {
        if (!isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) return;
        expirations.push(Math.trunc(timestamp as number) + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS);
    };

    for (const timestamp of readSessionRuntimePresentationFreshnessTimestamps({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests === true,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
    }, nowMs)) {
        addExpiration(timestamp);
    }

    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}
