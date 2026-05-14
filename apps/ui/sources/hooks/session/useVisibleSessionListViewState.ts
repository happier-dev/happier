import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useLocalSetting, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useSessionFolderAssignmentsBySessionKey, useSessionListRowStateByServerId } from '@/sync/domains/state/storage';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { areSessionListGroupOrderMapsEqual, normalizeSessionListGroupOrderV1ForIndexSource } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { filterSessionListIndexByStorageKind } from '@/sync/domains/session/listing/filterSessionListIndexByStorageKind';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    applySessionFolderTreeToSessionListIndex,
    DEFAULT_SESSION_FOLDERS_V1,
    normalizeSessionFolders,
    type SessionFolderFocusScope,
    type SessionFoldersV1,
    type SessionListFocusedFolderV1,
} from '@/sync/domains/session/folders';
import { useVisibleSessionListSourceState } from './useVisibleSessionListSourceState';

type SessionListGroupOrderV1 = Record<string, string[] | undefined>;
type PinnedSessionKeysV1 = ReadonlyArray<string>;

export type VisibleSessionListViewState = Readonly<{
    visibleSessionListIndex: ReadonlyArray<SessionListIndexItem> | null;
    hasHiddenInactiveSessions: boolean;
    folderFocus: SessionFolderFocusScope | null;
}>;

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

function buildVisibleSessionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sessionRowStateByServerId: ReturnType<typeof useSessionListRowStateByServerId>;
    hideInactiveSessions: boolean;
    pinnedSessionKeysV1: PinnedSessionKeysV1;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
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
}>): ReadonlyArray<SessionListIndexItem> | null {
    const folderTreeEnabled = params.storageFilter !== 'direct'
        && params.sessionFoldersFeatureEnabled
        && params.sessionFolderViewModeV1 === 'tree';
    const folderAwareSource = folderTreeEnabled
        ? applySessionFolderTreeToSessionListIndex({
            source: params.source,
            folders: params.sessionFoldersV1,
            assignmentsBySessionKey: params.sessionFolderAssignmentsBySessionKey,
            collapsedGroupKeys: params.collapsedGroupKeysV1,
            focusedFolder: params.folderFocusInput,
        }).items
        : params.source;
    const visible = computeVisibleSessionListIndex({
        source: folderAwareSource,
        resolveSessionRow: (serverId, sessionId) => resolveSessionRowFromState(params.sessionRowStateByServerId, serverId, sessionId),
        hideInactiveSessions: params.hideInactiveSessions,
        pinnedSessionKeysV1: params.pinnedSessionKeysV1,
        sessionListGroupOrderV1: params.sessionListOrderingModeV1 === 'custom'
            ? params.normalizedGroupOrder
            : params.sessionListGroupOrderV1,
        sessionListOrderingModeV1: params.sessionListOrderingModeV1,
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
    const { selection, source } = useVisibleSessionListSourceState();
    const sessionRowStateByServerId = useSessionListRowStateByServerId();
    const hideInactiveSessions = useSetting('hideInactiveSessions') as boolean | null;
    const pinnedSessionKeysV1 = (useSetting('pinnedSessionKeysV1') ?? []) as PinnedSessionKeysV1;
    const sessionListOrderingModeV1 = useSetting('sessionListOrderingModeV1') as
        | 'custom'
        | 'created'
        | 'updated';
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

    const normalizedGroupOrder = React.useMemo(() => {
        if (!source) return sessionListGroupOrderV1;
        if (sessionListOrderingModeV1 !== 'custom') return sessionListGroupOrderV1;
        return normalizeSessionListGroupOrderV1ForIndexSource({
            source,
            pinnedSessionKeysV1,
            sessionListGroupOrderV1,
        });
    }, [pinnedSessionKeysV1, sessionListGroupOrderV1, sessionListOrderingModeV1, source]);

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
        return buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: hideInactiveSessions === true,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
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
        });
    }, [
        folderFocusInput,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        selection.allowedServerIds,
        selection.enabled,
        pinnedSessionKeysV1,
        normalizedGroupOrder,
        selection.presentation,
        sessionListGroupOrderV1,
        sessionRowStateByServerId,
        sessionFolderAssignmentsBySessionKey,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        sessionFoldersV1,
        source,
        storageFilter,
        sessionListOrderingModeV1,
    ]);

    const hasHiddenInactiveSessions = React.useMemo(() => {
        if (!source || !hideInactiveSessions) {
            return false;
        }

        if (countSessionItems(visibleSessionListIndex) > 0) {
            return false;
        }

        const visibleWithoutInactiveFilter = buildVisibleSessionListIndex({
            source,
            sessionRowStateByServerId,
            hideInactiveSessions: false,
            pinnedSessionKeysV1,
            sessionListOrderingModeV1,
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
        });

        return countSessionItems(visibleWithoutInactiveFilter) > 0;
    }, [
        folderFocusInput,
        collapsedGroupKeysV1,
        hideInactiveSessions,
        normalizedGroupOrder,
        pinnedSessionKeysV1,
        selection.allowedServerIds,
        selection.enabled,
        selection.presentation,
        sessionListGroupOrderV1,
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
