import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';

import { normalizeTrimmedString } from './normalizeTrimmedString';
import { buildSessionListDateGroups } from './sessionListDateGroups';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import {
    buildSessionListSessionOrderingKey,
    compareSessionListSessionOrderingKeys,
    readSessionListMeaningfulActivityAt,
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListSessionOrderingKey,
} from './sessionListOrderingRules';
import type { SessionListRenderableSession } from './sessionListRenderable';

import { SESSION_LIST_LAYOUT_CHOICES, type SessionListLayoutChoice, type SessionListGroupingMode, type SessionListSectionMode, type SessionListLayoutSettings, normalizeSessionListSectionModeV1, normalizeSessionListGroupingModeV1, resolveSessionListLayoutChoice, resolveSessionListLayoutSettingsDelta } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';
export { SESSION_LIST_LAYOUT_CHOICES, normalizeSessionListSectionModeV1, normalizeSessionListGroupingModeV1, resolveSessionListLayoutChoice, resolveSessionListLayoutSettingsDelta };
export type { SessionListLayoutChoice, SessionListGroupingMode, SessionListSectionMode, SessionListLayoutSettings };

export type SessionListSessionRowDragPolicy = Readonly<{
    canReorderSiblings: boolean;
    canMoveBetweenFolders: boolean;
    /** The row can be dropped on another Session to report to it (`manager`, R-03). */
    canPutUnder: boolean;
    canDrag: boolean;
}>;

export function resolveSessionListLayoutApplicability(params: Readonly<{
    choice: SessionListLayoutChoice;
    activeGroupingV1?: unknown;
    inactiveGroupingV1?: unknown;
    folderViewModeV1?: unknown;
    foldersFeatureEnabled?: boolean;
}>): Readonly<{
    usesProjectGrouping: boolean;
    usesFolderTreePresentation: boolean;
    showsAdvancedSectionGrouping: boolean;
}> {
    return {
        usesProjectGrouping: params.choice === 'projects',
        usesFolderTreePresentation: params.foldersFeatureEnabled === true,
        showsAdvancedSectionGrouping: false,
    };
}

/**
 * The presentation the arranged layout actually renders, which is not always the one
 * the person saved for server groups.
 *
 * Recent activity rebuilds the corpus as one cross-Home chronological timeline and
 * drops every server header (`projectSessionListIndexForLayout` below), so the saved
 * `grouped` preference — the normalized default — cannot carry Home identity there and
 * the row badge has to. Both the index projection and the row badge read this one
 * answer; deriving it twice is what let two Homes render as indistinguishable rows.
 */
export function resolveSessionListLayoutPresentation(
    choice: SessionListLayoutChoice,
    savedPresentation: ServerSelectionPresentation,
): ServerSelectionPresentation {
    return choice === 'recent_activity' ? 'flat-with-badge' : savedPresentation;
}

export function resolveSessionListSessionRowDragPolicy(params: Readonly<{
    manualSessionOrderingEnabled: boolean;
    folderContainmentEnabled: boolean;
    putUnderEnabled?: boolean;
    item: Pick<Extract<SessionListIndexItem, { type: 'session' }>, 'section' | 'groupKind' | 'supplementalAttention'>;
    layoutV1: SessionListLayoutChoice;
}>): SessionListSessionRowDragPolicy {
    const canReorderSiblings = params.manualSessionOrderingEnabled
        && params.item.supplementalAttention !== true
        && resolveEffectiveSessionListOrderingModeForGroup({
            groupKind: params.item.groupKind,
            userOrderingMode: params.layoutV1 === 'recent_activity' ? 'updated' : 'custom',
        }) === 'custom';
    const canMoveBetweenFolders = params.folderContainmentEnabled;
    const canPutUnder = params.putUnderEnabled === true;
    return {
        canReorderSiblings,
        canMoveBetweenFolders,
        canPutUnder,
        canDrag: canReorderSiblings || canMoveBetweenFolders || canPutUnder,
    };
}

export function isSessionListSessionSiblingReorder(params: Readonly<{
    sourceFolderId?: string | null;
    destinationFolderId?: string | null;
}>): boolean {
    return (params.sourceFolderId ?? null) === (params.destinationFolderId ?? null);
}

export const SESSION_LIST_RECENT_LOADING_GROUP_KEY = 'recent:loading';

function projectRecentActivitySessionItem(params: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    groupKey: string;
    groupKind: 'date' | 'loading';
    section: 'active' | 'inactive';
}>): Extract<SessionListIndexItem, { type: 'session' }> {
    const { item } = params;
    return {
        type: 'session',
        sessionId: item.sessionId,
        ...(item.projectKey ? { projectKey: item.projectKey } : {}),
        ...(item.occurrenceRole ? { occurrenceRole: item.occurrenceRole } : {}),
        ...(item.supplementalAttention ? { supplementalAttention: true } : {}),
        ...(item.keyParts ? { keyParts: item.keyParts } : {}),
        ...(item.serverId ? { serverId: item.serverId } : {}),
        ...(item.serverName ? { serverName: item.serverName } : {}),
        ...(item.storageKind ? { storageKind: item.storageKind } : {}),
        ...(item.workspace ? { workspace: item.workspace } : {}),
        ...(item.folderId !== undefined ? { folderId: item.folderId } : {}),
        ...(item.archivedAt != null ? { archivedAt: item.archivedAt } : {}),
        ...(item.keepVisibleWhenInactive ? { keepVisibleWhenInactive: true } : {}),
        ...(item.contextualSearchReasons ? { contextualSearchReasons: item.contextualSearchReasons } : {}),
        ...(item.contextualSearchSourceMachineId
            ? { contextualSearchSourceMachineId: item.contextualSearchSourceMachineId }
            : {}),
        section: params.section,
        groupKey: params.groupKey,
        groupKind: params.groupKind,
        variant: 'default',
    };
}

/**
 * Keeps custom Section bands ahead of one cross-Home unfiled timeline.
 *
 * Membership is decided by the caller's index, never by row hydration: a qualified
 * address whose renderable has not landed yet keeps its membership in one localized
 * loading tail group and moves atomically into its date group once the same key
 * resolves. Its section stays `active` so the incumbent hidden-inactive rule cannot
 * delete a member whose activity is not knowable yet.
 */
export function projectSessionListIndexForLayout(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    choice: SessionListLayoutChoice;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs?: number;
}>): ReadonlyArray<SessionListIndexItem> {
    if (params.choice !== 'recent_activity') {
        return params.source;
    }

    const result: SessionListIndexItem[] = [];
    const entries: Array<{
        item: Extract<SessionListIndexItem, { type: 'session' }>;
        row: SessionListRenderableSession;
        orderingKey: SessionListSessionOrderingKey;
    }> = [];
    const unresolved: Array<Extract<SessionListIndexItem, { type: 'session' }>> = [];
    const seen = new Set<string>();
    for (const item of params.source) {
        if (item.type === 'header' && item.headerKind === 'folder') {
            result.push(item);
            continue;
        }
        if (item.type !== 'session') continue;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey
            || normalizeTrimmedString(item.sessionId);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const row = params.resolveSessionRow(item.serverId, item.sessionId);
        if (!row) {
            unresolved.push(item);
            continue;
        }
        if (item.groupKind === 'folder' && item.folderId != null) {
            result.push(item);
            continue;
        }
        // Derived once per qualified member, like the incumbent index sort's key
        // cache. Building it inside the comparator instead would rebuild the same
        // key O(n log n) times over a corpus this projection is expected to hold.
        entries.push({ item, row, orderingKey: buildSessionListSessionOrderingKey({ item, row }) });
    }
    entries.sort((a, b) => compareSessionListSessionOrderingKeys(a.orderingKey, b.orderingKey, 'updated'));

    for (const group of buildSessionListDateGroups({
        items: entries,
        readMeaningfulActivityAt: (entry) => readSessionListMeaningfulActivityAt(entry.row),
        nowMs: params.nowMs,
    })) {
        const groupKey = `recent:day:${group.dateKey}`;
        result.push({
            type: 'header',
            title: group.title,
            headerKind: 'date',
            groupKey,
        });
        for (const { item, row } of group.items) {
            result.push(projectRecentActivitySessionItem({
                item,
                groupKey,
                groupKind: 'date',
                section: row.active ? 'active' : 'inactive',
            }));
        }
    }

    if (unresolved.length > 0) {
        result.push({
            type: 'header',
            title: t('sessionsList.loadingSectionTitle'),
            headerKind: 'loading',
            groupKey: SESSION_LIST_RECENT_LOADING_GROUP_KEY,
        });
        for (const item of unresolved) {
            result.push(projectRecentActivitySessionItem({
                item,
                groupKey: SESSION_LIST_RECENT_LOADING_GROUP_KEY,
                groupKind: 'loading',
                section: 'active',
            }));
        }
    }

    return result;
}
