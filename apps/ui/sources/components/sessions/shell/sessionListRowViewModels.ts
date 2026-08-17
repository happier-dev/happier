import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import {
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName, getSessionStatus, type SessionStatus, type SessionWorkingTextMode } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { LruMap } from '@/utils/cache/lruMap';
import { t } from '@/text';

import { getTagsForSession, sessionTagKey } from './sessionTagUtils';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalSessionRuntimePresentation,
    type ExternalSessionRuntimePresentation,
} from '../presentation/externalSessionRuntimePresentation';
import {
    resolveExternalSessionIdentityPresentation,
    type ExternalSessionIdentityPresentation,
} from '../presentation/externalSessionIdentityPresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

export type SessionReachableDisplay = Readonly<{
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
    externalSessionRuntime: ExternalSessionRuntimePresentation | null;
    externalSessionIdentity: ExternalSessionIdentityPresentation | null;
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
    /**
     * Retained working placement: the session is held in the working group
     * while its live signals are stale. Rows render the working indicator
     * WITHOUT animation for it, with a dedicated status text.
     */
    workingPlacementRetained: boolean;
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

export type BuildSessionListRowViewModelInput = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    index: number;
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
}>;

export function buildSessionListRowViewModel(input: BuildSessionListRowViewModelInput): SessionListRowViewModel {
    const item = input.item;
    const groupKey = String(item.groupKey ?? '').trim();
    const prev = input.index > 0 ? input.listItems[input.index - 1] : null;
    const next = input.index < input.listItems.length - 1 ? input.listItems[input.index + 1] : null;
    const prevGroupKey = prev && prev.type === 'session' ? String(prev.groupKey ?? '').trim() : '';
    const nextGroupKey = next && next.type === 'session' ? String(next.groupKey ?? '').trim() : '';
    const isFirst = !groupKey || prevGroupKey !== groupKey;
    const isLast = !groupKey || nextGroupKey !== groupKey;
    const sessionId = String(item.sessionId ?? '').trim();
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionKey = serverId && sessionId ? sessionTagKey(serverId, sessionId) : null;
    const rowKey = buildSessionListServerScopedRowKey(serverId, sessionId);
    const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
    const reachableDisplay = (sessionKey ? input.reachableSessionDisplayByKey?.get(sessionKey) : undefined)
        ?? input.reachableSessionDisplayById.get(sessionId);
    const workspaceSubtitle = reachableDisplay?.workspaceSubtitle ?? '';
    const subtitleEllipsizeMode = reachableDisplay?.workspaceSubtitleEllipsizeMode ?? 'head';
    const machineLabel = reachableDisplay?.machineLabel ?? '';
    const subtitle = input.hasMultipleMachines
        ? (machineLabel && workspaceSubtitle ? `${machineLabel} · ${workspaceSubtitle}` : machineLabel || workspaceSubtitle)
        : workspaceSubtitle;
    const session = rowKey ? input.rowRenderableByKey?.get(rowKey) ?? null : null;
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
    const sessionMetadata = session?.metadata;
    const externalSessionLink = readExternalSessionLink(sessionMetadata);
    const externalSessionIdentity = externalSessionLink
        ? resolveExternalSessionIdentityPresentation(sessionMetadata, reachableDisplay?.machineId)
        : null;
    const externalSessionRuntime = externalSessionLink && sessionStatus
        ? resolveExternalSessionRuntimePresentation({
            controlConnectivity: sessionStatus.isConnected ? 'connected' : 'offline',
            detachedActivity: sessionStatus.state === 'background_active'
                ? 'active'
                : sessionStatus.isConnected
                    ? 'idle'
                    : 'unknown',
            externalAgent: readExternalAgentObservationPresentationInput(sessionMetadata),
            nowMs: runtimeNowMs,
        })
        : null;
    const sessionName = session ? getSessionName(session) : '';

    const rowViewModel: SessionListRowViewModel = {
        groupKey,
        sessionKey,
        session,
        sessionStatus,
        externalSessionRuntime,
        externalSessionIdentity,
        isIdentityLoading: session ? resolveRowIdentityLoading({
            session,
            title: sessionName,
        }) : false,
        nextRuntimeFreshnessAtMs: resolveEarliestFreshnessAtMs(
            session ? resolveNextRuntimeFreshnessAtMs(session, runtimeNowMs) : null,
            externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? null,
        ),
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
        workingPlacementRetained: item.workingPlacementReason === 'working-retained',
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
}

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

        return buildSessionListRowViewModel({
            ...input,
            item,
            index,
            listItems: input.listItems,
        });
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
        viewModel.externalSessionRuntime?.controlConnectivity ?? '',
        viewModel.externalSessionRuntime?.detachedActivity ?? '',
        viewModel.externalSessionRuntime?.externalAgent.state ?? '',
        viewModel.externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? '',
        viewModel.externalSessionIdentity?.agentId ?? '',
        viewModel.externalSessionIdentity?.identityLabel ?? '',
        viewModel.externalSessionIdentity?.rowMetadataLabel ?? '',
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
        viewModel.workingPlacementRetained ? '1' : '0',
    ].join('\u0002');
}

function normalizeClockNow(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function resolveEarliestFreshnessAtMs(
    first: number | null,
    second: number | null,
): number | null {
    if (first === null) return second;
    if (second === null) return first;
    return Math.min(first, second);
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
    if (session.presence !== 'online') return null;

    const expirations = readSessionRuntimePresentationFreshnessExpirations({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        hasPendingUserMessages: typeof session.pendingCount === 'number' && session.pendingCount > 0,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests === true,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
    }, nowMs);

    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}
