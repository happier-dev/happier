import * as React from 'react';
import { usePathname } from 'expo-router';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSetting, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSessionFolderAssignmentsBySessionKey, useSessionListRowStateByServerId } from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { normalizeSessionListAttentionPlacementMode } from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import { normalizeSessionListKeyParts } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { resolveSelectedSessionIdForList } from '@/sync/domains/session/listing/resolveSelectedSessionIdForList';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    applySessionFolderTreeToSessionListIndex,
    DEFAULT_SESSION_FOLDERS_V1,
    normalizeSessionFolders,
    type SessionFolderFocusScope,
    type FolderAwareSessionListIndexResult,
    type SessionFoldersV1,
    type SessionListFocusedFolderV1,
} from '@/sync/domains/session/folders';
import { useFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';

type SessionListGroupOrderV1 = Record<string, string[] | undefined>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: SessionFolderFocusScope | null;
}>;

function buildFolderAwareSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    storageFilter: SessionListStorageFilter;
    folderFocusInput: SessionListFocusedFolderV1;
    sessionFoldersV1: SessionFoldersV1;
    sessionFolderViewModeV1: unknown;
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
}>): FolderAwareSessionListIndexResult {
    const folderTreeEnabled = params.storageFilter !== 'direct'
        && params.sessionFoldersFeatureEnabled
        && params.sessionFolderViewModeV1 === 'tree';
    if (!folderTreeEnabled) {
        return { items: params.source, folderFocus: null };
    }
    return applySessionFolderTreeToSessionListIndex({
        source: params.source,
        folders: params.sessionFoldersV1,
        assignmentsBySessionKey: params.sessionFolderAssignmentsBySessionKey,
        collapsedGroupKeys: params.collapsedGroupKeysV1,
        focusedFolder: params.folderFocusInput,
    });
}

function countSessionItems(index: ReadonlyArray<SessionListIndexItem> | null): number {
    if (!index) return 0;
    let count = 0;
    for (const item of index) {
        if (item.type === 'session') {
            count += 1;
        }
    }
    return count;
}

function resolveSessionRowFromState(
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>,
    serverId: string | null | undefined,
    sessionId: string,
) {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedServerId || !normalizedSessionId) {
        return null;
    }
    const scoped = sessionRowStateByServerId?.[normalizedServerId];
    if (!scoped || typeof scoped !== 'object') {
        return null;
    }
    return scoped[normalizedSessionId] ?? null;
}

function resolveRetainedAttentionSessionKeys(params: Readonly<{
    previousVisibleIndex: ReadonlyArray<SessionListIndexItem> | null | undefined;
    activeSessionId: string | null;
}>): ReadonlyArray<string> {
    const activeSessionId = String(params.activeSessionId ?? '').trim();
    if (!activeSessionId) return [];
    if (!params.previousVisibleIndex) return [];
    for (const item of params.previousVisibleIndex) {
        if (item.type !== 'session' || item.sessionId !== activeSessionId) continue;
        if (item.groupKind !== 'attention' && !item.attentionPlacementReason) continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId).sessionKey;
        return key ? [key] : [];
    }
    return [];
}

function buildVisibleSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
    sessionListAttentionPromotionModeV1: 'off' | 'global' | 'withinGroups';
    activeSessionId: string | null;
    normalizedGroupOrder: SessionListGroupOrderV1;
    sessionListGroupOrderV1: SessionListGroupOrderV1;
    collapsedGroupKeysV1: Readonly<Record<string, boolean>>;
    sessionFoldersFeatureEnabled: boolean;
    selection: ReturnType<typeof useVisibleSessionListSourceState>['selection'];
    storageFilter: SessionListStorageFilter;
    folderFocusInput: SessionListFocusedFolderV1;
    sessionFoldersV1: SessionFoldersV1;
    sessionFolderViewModeV1: unknown;
    sessionFolderAssignmentsBySessionKey: Readonly<Record<string, string | null>>;
    retainAttentionSessionKeys: ReadonlyArray<string>;
}>): ReadonlyArray<SessionListIndexItem> | null {
    const folderAwareSource = buildFolderAwareSessionListIndex(params).items;
    const visible = computeVisibleSessionListIndex({
        source: folderAwareSource,
        resolveSessionRow: (serverId, sessionId) => resolveSessionRowFromState(params.sessionRowStateByServerId, serverId, sessionId),
        hideInactiveSessions: params.hideInactiveSessions,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionListOrderingModeV1: params.sessionListOrderingModeV1,
        attentionPlacement: {
            mode: params.sessionListAttentionPromotionModeV1,
            retainSessionKeys: params.retainAttentionSessionKeys,
        },
        presentation: {
            enabled: params.selection.enabled,
            presentation: params.selection.presentation,
            selectedServerIds: params.selection.allowedServerIds,
        },
        storageFilterApplied: params.storageFilter !== 'all',
    });
    if (!visible || params.storageFilter === 'all') return visible;
    return filterSessionListIndexByStorageKind(visible, params.storageFilter);
}

export function useVisibleSessionListViewState(storageFilter: SessionListStorageFilter = 'all'): VisibleSessionListViewState {
    const pathname = usePathname();
    const focusedSessionId = useFocusedSessionId();
    const previousVisibleSessionListIndexRef = React.useRef<ReadonlyArray<SessionListIndexItem> | null>(null);
    const { selection, source } = useVisibleSessionListSourceState();
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') as boolean | null;
    const pinnedSessionKeysV1 = (useSetting('pinnedSessionKeysV1') ?? []) as PinnedSessionKeysV1;
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
    const sessionListAttentionPromotionModeV1 = normalizeSessionListAttentionPlacementMode(
        useSetting('sessionListAttentionPromotionModeV1'),
    );
    const [sessionListGroupOrderV1, setSessionListGroupOrderV1] = useSettingMutable('sessionListGroupOrderV1') as [
        SessionListGroupOrderV1,
        (value: SessionListGroupOrderV1) => void,
    ];
    const sessionFoldersRaw = useSetting('sessionFoldersV1') as SessionFoldersV1 | null | undefined;
    const sessionFolderViewModeV1 = useSetting('sessionFolderViewModeV1');
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const collapsedGroupKeysV1 = (useSetting('collapsedGroupKeysV1') ?? {}) as Readonly<Record<string, boolean>>;
    const folderFocusInput = useLocalSetting('sessionListFocusedFolderV1') as SessionListFocusedFolderV1;
    const sessionFolderAssignmentsBySessionKey = useSessionFolderAssignmentsBySessionKey();
    const sessionFoldersV1 = React.useMemo(
        () => normalizeSessionFolders(sessionFoldersRaw ?? DEFAULT_SESSION_FOLDERS_V1),
        [sessionFoldersRaw],
    );
    const activeSessionId = React.useMemo(() => resolveSelectedSessionIdForList({
        selectable: true,
        pathname,
        focusedSessionId,
    }), [focusedSessionId, pathname]);

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionListGroupOrderV1;
        const folderAwareSource = buildFolderAwareSessionListIndex({
            source,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
        }).items;
        return normalizeSessionListGroupOrderV1ForIndexSource({
            source: folderAwareSource,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [
        collapsedGroupKeysV1,
        folderFocusInput,
        pinnedSessionKeysV1,
        sessionFolderAssignmentsBySessionKey,
        sessionFolderViewModeV1,
        sessionFoldersFeatureEnabled,
        sessionFoldersV1,
        sessionListGroupOrderV1,
        sessionListOrderingModeV1,
        source,
        storageFilter,
    ]);

    React.useEffect(() => {
        if (!source) return;
        if (sessionListOrderingModeV1 !== 'custom') return;
        if (areSessionListGroupOrderMapsEqual(sessionListGroupOrderV1, normalizedGroupOrder)) {
            return;
        }
        setSessionListGroupOrderV1(normalizedGroupOrder);
    }, [normalizedGroupOrder, sessionListGroupOrderV1, sessionListOrderingModeV1, setSessionListGroupOrderV1, source]);

    const visibleSessionListIndex = React.useMemo(() => {
        if (!source) return source;
        const retainAttentionSessionKeys = resolveRetainedAttentionSessionKeys({
            previousVisibleIndex: previousVisibleSessionListIndexRef.current,
            activeSessionId,
        });
        return buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: hideInactiveSessions === true,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            sessionListAttentionPromotionModeV1,
            activeSessionId,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            selection,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
            retainAttentionSessionKeys,
        });
    }, [
        folderFocusInput,
        activeSessionId,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        selection.allowedServerIds,
        selection.enabled,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionListAttentionPromotionModeV1,
        sessionRowStateByServerId,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
        sessionListOrderingModeV1,
    ]);

    React.useEffect(() => {
        previousVisibleSessionListIndexRef.current = visibleSessionListIndex;
    }, [visibleSessionListIndex]);

    const hasHiddenInactiveSessions = React.useMemo(() => {
        if (!source || !hideInactiveSessions) {
            return false;
        }

        if (countSessionItems(visibleSessionListIndex) > 0) {
            return false;
        }

        const retainAttentionSessionKeys = resolveRetainedAttentionSessionKeys({
            previousVisibleIndex: previousVisibleSessionListIndexRef.current,
            activeSessionId,
        });
        const visibleWithoutInactiveFilter = buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: false,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
            sessionListAttentionPromotionModeV1,
            activeSessionId,
            normalizedGroupOrder,
            sessionListGroupOrderV1,
            collapsedGroupKeysV1,
            sessionFoldersFeatureEnabled,
            selection,
            storageFilter,
            folderFocusInput,
            sessionFoldersV1,
            sessionFolderViewModeV1,
            sessionFolderAssignmentsBySessionKey,
            retainAttentionSessionKeys,
        });

        return countSessionItems(visibleWithoutInactiveFilter) > 0;
    }, [
        folderFocusInput,
        activeSessionId,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        normalizedGroupOrder,
        pinnedSessionKeysV1,
        selection.allowedServerIds,
        selection.enabled,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionListAttentionPromotionModeV1,
        sessionListOrderingModeV1,
        sessionRowStateByServerId,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
        visibleSessionListIndex,
    ]);

    const folderFocus = React.useMemo(() => {
        if (storageFilter === 'direct' || !sessionFoldersFeatureEnabled || sessionFolderViewModeV1 !== 'tree' || !source) return null;
        return applySessionFolderTreeToSessionListIndex({
            source,
            folders: sessionFoldersV1,
            assignmentsBySessionKey: sessionFolderAssignmentsBySessionKey,
            collapsedGroupKeys: {},
            focusedFolder: folderFocusInput,
        }).folderFocus;
    }, [
        folderFocusInput,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
    ]);

    return React.useMemo(() => ({
        visibleSessionListIndex,
        hasHiddenInactiveSessions,
        folderFocus,
    }), [folderFocus, hasHiddenInactiveSessions, visibleSessionListIndex]);
}
