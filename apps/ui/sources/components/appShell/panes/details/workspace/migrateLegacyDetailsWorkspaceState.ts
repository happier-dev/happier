import { createEmptyPaneDetailsState } from './detailsWorkspaceReducer';
import {
    isPluginDetailsDestinationResourceCandidate,
    normalizePluginDetailsDestinationResource,
} from '../surfaces/pluginDetailsDestination';
import {
    createDetailsWorkspaceLeafNode,
    DETAILS_WORKSPACE_LEAF_KIND,
    listDetailsWorkspaceGroupIds,
} from './detailsWorkspaceSplitCanvas';
import {
    PluginUiDestinationReferenceV1Schema,
    PluginUiInstanceKeyV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    getOwnDetailsWorkspaceRecordEntry,
    hasOwnDetailsWorkspaceRecordEntry,
    readDetailsTabRehydrationFallbackState,
} from './detailsWorkspaceTypes';
import type {
    DetailsTabState,
    DetailsWorkspaceGroupState,
    DetailsWorkspaceNode,
    DetailsWorkspaceOverlayState,
    LegacyPaneDetailsState,
    PaneDetailsState,
} from './detailsWorkspaceTypes';

type PersistedDetailsWorkspaceStateInput = Readonly<{
    isOpen?: boolean;
    tabState?: Readonly<Record<string, unknown>>;
    tabsByKey?: Readonly<Record<string, DetailsTabState>>;
    groupsById?: Readonly<Record<string, DetailsWorkspaceGroupState>>;
    root?: unknown;
    focusedGroupId?: string | null;
    maximizedGroupId?: string | null;
    nextGroupOrdinal?: number | null;
    overlay?: unknown;
}>;

export type SerializedDetailsWorkspaceState = {
    isOpen: boolean;
    tabState: Record<string, unknown>;
    tabsByKey: Record<string, DetailsTabState>;
    groupsById: Record<string, { id: string; tabKeys: string[]; activeTabKey: string | null }>;
    root: DetailsWorkspaceNode | null;
    focusedGroupId: string | null;
    maximizedGroupId: string | null;
    nextGroupOrdinal: number;
    overlay: DetailsWorkspaceOverlayState | null;
};

type LegacyDetailsWorkspaceNode = Readonly<{
    kind: 'group';
    groupId: string;
}> | Readonly<{
    kind: 'split';
    axis: 'horizontal' | 'vertical';
    ratio: number;
    first: LegacyDetailsWorkspaceNode;
    second: LegacyDetailsWorkspaceNode;
}>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyDetailsState(value: unknown): value is LegacyPaneDetailsState {
    return isObjectRecord(value) && Array.isArray(value.tabs);
}

function isCanonicalDetailsWorkspaceState(value: unknown): value is PersistedDetailsWorkspaceStateInput {
    return isObjectRecord(value) && isObjectRecord(value.tabsByKey) && isObjectRecord(value.groupsById);
}

function normalizeNextGroupOrdinal(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : 1;
}

/**
 * The persisted overlay is selection only. Strictly parse it here so hostile
 * launch input/currentness fields are dropped with the overlay rather than
 * invalidating otherwise sound Details groups.
 */
function normalizePersistedOverlay(value: unknown): DetailsWorkspaceOverlayState | null {
    if (!isObjectRecord(value)) return null;
    const destination = PluginUiDestinationReferenceV1Schema.safeParse(value.destination);
    const instanceKey = value.instanceKey === undefined
        ? { success: true as const, data: undefined }
        : PluginUiInstanceKeyV1Schema.safeParse(value.instanceKey);
    if (
        !destination.success
        || !instanceKey.success
        || typeof value.returnIsOpen !== 'boolean'
        || (value.returnFocusedGroupId !== null && typeof value.returnFocusedGroupId !== 'string')
        || (value.returnMaximizedGroupId !== null && typeof value.returnMaximizedGroupId !== 'string')
    ) {
        return null;
    }
    const allowedKeys = new Set([
        'destination',
        'instanceKey',
        'returnFocusedGroupId',
        'returnMaximizedGroupId',
        'returnIsOpen',
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
    return {
        destination: Object.freeze({ ...destination.data }),
        ...(instanceKey.data === undefined ? {} : { instanceKey: instanceKey.data }),
        returnFocusedGroupId: value.returnFocusedGroupId,
        returnMaximizedGroupId: value.returnMaximizedGroupId,
        returnIsOpen: value.returnIsOpen,
    };
}

function extractGroupOrdinal(groupId: string): number {
    const match = /^group:(\d+)$/.exec(groupId);
    if (!match) return 0;
    return Number.parseInt(match[1] ?? '0', 10) || 0;
}

function isPersistedDetailsTabState(value: unknown, tabKey: string): value is DetailsTabState {
    return (
        isObjectRecord(value)
        && value.key === tabKey
        && typeof value.kind === 'string'
        && typeof value.title === 'string'
        && typeof value.isPinned === 'boolean'
        && typeof value.isPreview === 'boolean'
    );
}

function resolveDetailsTabRehydrationFallbackState(value: unknown): DetailsTabState | null {
    const fallback = readDetailsTabRehydrationFallbackState(value);
    return fallback && !isPluginDetailsDestinationResourceCandidate(fallback.resource) ? fallback : null;
}

function normalizePersistedDetailsTabState(tab: DetailsTabState): DetailsTabState {
    if (!isPluginDetailsDestinationResourceCandidate(tab.resource)) {
        return tab;
    }
    return {
        ...tab,
        // A malformed claimed resource remains a truthful unsupported tab, but
        // never retains arbitrary persisted fields such as launch input.
        resource: normalizePluginDetailsDestinationResource(tab.resource),
    };
}

function shouldPersistDetailsTabState(tab: DetailsTabState | undefined): boolean {
    return !isPluginDetailsDestinationResourceCandidate(tab?.resource);
}

function resolveSerializedDetailsTabs(value: PaneDetailsState): Readonly<{
    tabsByKey: Record<string, DetailsTabState>;
    persistedKeyByCurrentKey: ReadonlyMap<string, string>;
    rehydratedCurrentTabKeys: ReadonlySet<string>;
}> {
    const fallbackByCurrentKey = new Map<string, DetailsTabState>();
    const fallbackKeyCounts = new Map<string, number>();
    for (const [tabKey, tab] of Object.entries(value.tabsByKey)) {
        if (!isPluginDetailsDestinationResourceCandidate(tab.resource)) continue;
        const fallback = resolveDetailsTabRehydrationFallbackState(
            getOwnDetailsWorkspaceRecordEntry(value.tabState, tabKey),
        );
        if (!fallback || hasOwnDetailsWorkspaceRecordEntry(value.tabsByKey, fallback.key)) continue;
        fallbackByCurrentKey.set(tabKey, fallback);
        fallbackKeyCounts.set(fallback.key, (fallbackKeyCounts.get(fallback.key) ?? 0) + 1);
    }

    const persistedKeyByCurrentKey = new Map<string, string>();
    const rehydratedCurrentTabKeys = new Set<string>();
    const tabsByKey = Object.fromEntries(
        Object.entries(value.tabsByKey).map(([tabKey, tab]) => {
            const fallback = fallbackByCurrentKey.get(tabKey);
            const canRehydrate = fallback && fallbackKeyCounts.get(fallback.key) === 1;
            const persistedTab = canRehydrate
                ? fallback
                : normalizePersistedDetailsTabState(tab);
            const persistedKey = canRehydrate ? fallback.key : tabKey;
            persistedKeyByCurrentKey.set(tabKey, persistedKey);
            if (canRehydrate) rehydratedCurrentTabKeys.add(tabKey);
            return [persistedKey, persistedTab];
        }),
    ) as Record<string, DetailsTabState>;

    return {
        tabsByKey,
        persistedKeyByCurrentKey,
        rehydratedCurrentTabKeys,
    };
}

function serializeDetailsWorkspaceGroup(input: Readonly<{
    group: DetailsWorkspaceGroupState;
    tabsByKey: Readonly<Record<string, DetailsTabState>>;
    persistedKeyByCurrentKey: ReadonlyMap<string, string>;
}>): { id: string; tabKeys: string[]; activeTabKey: string | null } {
    const seenTabKeys = new Set<string>();
    const tabKeys = input.group.tabKeys.flatMap((tabKey) => {
        const persistedTabKey = input.persistedKeyByCurrentKey.get(tabKey) ?? tabKey;
        if (!getOwnDetailsWorkspaceRecordEntry(input.tabsByKey, persistedTabKey) || seenTabKeys.has(persistedTabKey)) return [];
        seenTabKeys.add(persistedTabKey);
        return [persistedTabKey];
    });
    const requestedActiveTabKey = input.group.activeTabKey
        ? input.persistedKeyByCurrentKey.get(input.group.activeTabKey) ?? input.group.activeTabKey
        : null;
    return {
        id: input.group.id,
        tabKeys,
        activeTabKey: requestedActiveTabKey && tabKeys.includes(requestedActiveTabKey)
            ? requestedActiveTabKey
            : tabKeys.at(-1) ?? null,
    };
}

function normalizePersistedTabsByKey(value: unknown): Record<string, DetailsTabState> {
    if (!isObjectRecord(value)) return {};
    const normalizedEntries: Array<[string, DetailsTabState]> = [];
    for (const [tabKey, tab] of Object.entries(value)) {
        if (!isPersistedDetailsTabState(tab, tabKey)) continue;
        normalizedEntries.push([tabKey, normalizePersistedDetailsTabState(tab)]);
    }
    return Object.fromEntries(normalizedEntries);
}

function normalizePersistedGroup(
    groupId: string,
    value: unknown,
    tabsByKey: Readonly<Record<string, DetailsTabState>>,
): DetailsWorkspaceGroupState | null {
    if (!isObjectRecord(value)) return null;
    const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : groupId;
    if (id !== groupId) return null;
    const tabKeys = Array.isArray(value.tabKeys)
        ? value.tabKeys.filter((tabKey): tabKey is string => (
            typeof tabKey === 'string'
            && getOwnDetailsWorkspaceRecordEntry(tabsByKey, tabKey) != null
        ))
        : [];
    const activeTabKey = typeof value.activeTabKey === 'string' && tabKeys.includes(value.activeTabKey)
        ? value.activeTabKey
        : tabKeys.at(-1) ?? null;
    return {
        id,
        tabKeys,
        activeTabKey,
    };
}

function isLegacyDetailsWorkspaceNode(value: unknown): value is LegacyDetailsWorkspaceNode {
    if (!isObjectRecord(value) || typeof value.kind !== 'string') return false;
    if (value.kind === 'group') {
        return typeof value.groupId === 'string';
    }
    if (value.kind === 'split') {
        return (
            (value.axis === 'horizontal' || value.axis === 'vertical')
            && typeof value.ratio === 'number'
            && isLegacyDetailsWorkspaceNode(value.first)
            && isLegacyDetailsWorkspaceNode(value.second)
        );
    }
    return false;
}

function isCanonicalDetailsWorkspaceNode(value: unknown): value is DetailsWorkspaceNode {
    if (!isObjectRecord(value) || typeof value.kind !== 'string' || typeof value.id !== 'string') return false;
    if (value.kind === 'leaf') {
        return (
            value.leafKind === DETAILS_WORKSPACE_LEAF_KIND
            && isObjectRecord(value.payload)
            && typeof value.payload.groupId === 'string'
        );
    }
    if (value.kind === 'split') {
        return (
            (value.axis === 'row' || value.axis === 'column')
            && typeof value.ratio === 'number'
            && isCanonicalDetailsWorkspaceNode(value.first)
            && isCanonicalDetailsWorkspaceNode(value.second)
        );
    }
    return false;
}

function migrateLegacyDetailsWorkspaceNode(
    node: LegacyDetailsWorkspaceNode | null | undefined,
    path = 'root',
): DetailsWorkspaceNode | null {
    if (!node) return null;
    if (node.kind === 'group') {
        return createDetailsWorkspaceLeafNode(node.groupId);
    }
    return {
        id: `migrated:${path}`,
        kind: 'split',
        axis: node.axis === 'vertical' ? 'row' : 'column',
        ratio: node.ratio,
        first: migrateLegacyDetailsWorkspaceNode(node.first, `${path}:first`) ?? createDetailsWorkspaceLeafNode('group:missing:first'),
        second: migrateLegacyDetailsWorkspaceNode(node.second, `${path}:second`) ?? createDetailsWorkspaceLeafNode('group:missing:second'),
    };
}

function normalizePersistedRoot(root: unknown): DetailsWorkspaceNode | null {
    if (isCanonicalDetailsWorkspaceNode(root)) return root;
    if (isLegacyDetailsWorkspaceNode(root)) return migrateLegacyDetailsWorkspaceNode(root);
    return null;
}

function migrateLegacyDetailsState(value: LegacyPaneDetailsState): PaneDetailsState {
    if (value.tabs.length === 0) {
        return {
            ...createEmptyPaneDetailsState(),
            isOpen: value.isOpen,
            tabState: value.tabState,
            nextGroupOrdinal: 2,
        };
    }

    const groupId = 'group:1';
    const tabsByKey = Object.fromEntries(
        value.tabs.map((tab) => [tab.key, normalizePersistedDetailsTabState({
            ...tab,
            subtitle: tab.subtitle ?? null,
        })]),
    ) as Record<string, DetailsTabState>;
    const tabKeys = value.tabs.map((tab) => tab.key);
    const activeTabKey = value.activeTabKey && tabKeys.includes(value.activeTabKey)
        ? value.activeTabKey
        : tabKeys.at(-1) ?? null;

    return {
        isOpen: value.isOpen,
        tabState: Object.fromEntries(
            Object.entries(value.tabState).filter(([tabKey]) => (
                shouldPersistDetailsTabState(getOwnDetailsWorkspaceRecordEntry(tabsByKey, tabKey))
            )),
        ),
        tabsByKey,
        groupsById: {
            [groupId]: {
                id: groupId,
                tabKeys,
                activeTabKey,
            },
        },
        root: createDetailsWorkspaceLeafNode(groupId),
        focusedGroupId: groupId,
        maximizedGroupId: null,
        nextGroupOrdinal: 2,
        overlay: null,
    };
}

function createEmptyDetailsStateWithOrdinal(nextGroupOrdinal: number): PaneDetailsState {
    return {
        ...createEmptyPaneDetailsState(),
        nextGroupOrdinal,
    };
}

function normalizeCanonicalDetailsWorkspaceState(value: PersistedDetailsWorkspaceStateInput): PaneDetailsState {
    const requestedOrdinal = normalizeNextGroupOrdinal(value.nextGroupOrdinal);
    const root = normalizePersistedRoot(value.root);
    const overlay = normalizePersistedOverlay(value.overlay);
    if (!root) {
        return {
            ...createEmptyDetailsStateWithOrdinal(requestedOrdinal),
            isOpen: overlay ? true : false,
            overlay,
        };
    }

    const tabsByKey = normalizePersistedTabsByKey(value.tabsByKey);
    const groupIdsInTree = listDetailsWorkspaceGroupIds(root);
    const groupIdsInTreeSet = new Set(groupIdsInTree);
    const normalizedGroups = Object.fromEntries(
        groupIdsInTree
            .map((groupId) => [groupId, normalizePersistedGroup(
                groupId,
                value.groupsById
                    ? getOwnDetailsWorkspaceRecordEntry(value.groupsById, groupId)
                    : undefined,
                tabsByKey,
            )] as const)
            .filter((entry): entry is readonly [string, DetailsWorkspaceGroupState] => entry[1] != null),
    ) as Record<string, DetailsWorkspaceGroupState>;

    if (Object.keys(normalizedGroups).length !== groupIdsInTree.length) {
        return {
            ...createEmptyDetailsStateWithOrdinal(requestedOrdinal),
            isOpen: overlay ? true : false,
            overlay,
        };
    }

    const referencedTabKeys = new Set(
        Object.values(normalizedGroups).flatMap((group) => group.tabKeys),
    );
    const normalizedTabsByKey = Object.fromEntries(
        Object.entries(tabsByKey).filter(([tabKey]) => referencedTabKeys.has(tabKey)),
    ) as Record<string, DetailsTabState>;
    const normalizedTabState = Object.fromEntries(
        Object.entries(isObjectRecord(value.tabState) ? value.tabState : {})
            .filter(([tabKey]) => (
                referencedTabKeys.has(tabKey)
                && shouldPersistDetailsTabState(getOwnDetailsWorkspaceRecordEntry(normalizedTabsByKey, tabKey))
            )),
    ) as Record<string, unknown>;
    const focusedGroupId = typeof value.focusedGroupId === 'string' && groupIdsInTreeSet.has(value.focusedGroupId)
        ? value.focusedGroupId
        : groupIdsInTree[0] ?? null;
    const maximizedGroupId = typeof value.maximizedGroupId === 'string' && groupIdsInTreeSet.has(value.maximizedGroupId)
        ? value.maximizedGroupId
        : null;
    const maxObservedOrdinal = Math.max(
        0,
        ...groupIdsInTree.map(extractGroupOrdinal),
    );

    return {
        isOpen: overlay ? true : value.isOpen === true,
        tabState: normalizedTabState,
        tabsByKey: normalizedTabsByKey,
        groupsById: normalizedGroups,
        root,
        focusedGroupId,
        maximizedGroupId,
        nextGroupOrdinal: Math.max(requestedOrdinal, maxObservedOrdinal + 1, 1),
        overlay,
    };
}

export function migrateLegacyDetailsWorkspaceState(value: unknown): PaneDetailsState {
    if (!value) return createEmptyPaneDetailsState();

    if (isCanonicalDetailsWorkspaceState(value)) {
        return normalizeCanonicalDetailsWorkspaceState(value);
    }

    if (isLegacyDetailsState(value)) {
        return migrateLegacyDetailsState(value);
    }

    return createEmptyPaneDetailsState();
}

export function serializeDetailsWorkspaceState(value: PaneDetailsState): SerializedDetailsWorkspaceState {
    const serializedTabs = resolveSerializedDetailsTabs(value);
    return {
        isOpen: value.isOpen,
        tabState: Object.fromEntries(
            Object.entries(value.tabState).filter(([tabKey]) => (
                !serializedTabs.rehydratedCurrentTabKeys.has(tabKey)
                && shouldPersistDetailsTabState(getOwnDetailsWorkspaceRecordEntry(value.tabsByKey, tabKey))
            )),
        ),
        tabsByKey: Object.fromEntries(
            Object.entries(serializedTabs.tabsByKey).map(([tabKey, tab]) => [
                tabKey,
                {
                    ...tab,
                    subtitle: tab.subtitle ?? null,
                },
            ]),
        ),
        groupsById: Object.fromEntries(
            Object.entries(value.groupsById).map(([groupId, group]) => [
                groupId,
                serializeDetailsWorkspaceGroup({
                    group,
                    tabsByKey: serializedTabs.tabsByKey,
                    persistedKeyByCurrentKey: serializedTabs.persistedKeyByCurrentKey,
                }),
            ]),
        ),
        root: value.root,
        focusedGroupId: value.focusedGroupId,
        maximizedGroupId: value.maximizedGroupId,
        nextGroupOrdinal: value.nextGroupOrdinal,
        overlay: normalizePersistedOverlay(value.overlay),
    };
}
