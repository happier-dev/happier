import { createEmptyPaneDetailsState } from './detailsWorkspaceReducer';
import {
    createDetailsWorkspaceLeafNode,
    DETAILS_WORKSPACE_LEAF_KIND,
    listDetailsWorkspaceGroupIds,
} from './detailsWorkspaceSplitCanvas';
import type {
    DetailsTabState,
    DetailsWorkspaceGroupState,
    DetailsWorkspaceNode,
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

function normalizePersistedTabsByKey(value: unknown): Record<string, DetailsTabState> {
    if (!isObjectRecord(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([tabKey, tab]) => isPersistedDetailsTabState(tab, tabKey)),
    ) as Record<string, DetailsTabState>;
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
        ? value.tabKeys.filter((tabKey): tabKey is string => typeof tabKey === 'string' && tabsByKey[tabKey] != null)
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
        value.tabs.map((tab) => [tab.key, {
            ...tab,
            subtitle: tab.subtitle ?? null,
        }]),
    ) as Record<string, DetailsTabState>;
    const tabKeys = value.tabs.map((tab) => tab.key);
    const activeTabKey = value.activeTabKey && tabKeys.includes(value.activeTabKey)
        ? value.activeTabKey
        : tabKeys.at(-1) ?? null;

    return {
        isOpen: value.isOpen,
        tabState: value.tabState,
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
    if (!root) {
        return createEmptyDetailsStateWithOrdinal(requestedOrdinal);
    }

    const tabsByKey = normalizePersistedTabsByKey(value.tabsByKey);
    const groupIdsInTree = listDetailsWorkspaceGroupIds(root);
    const groupIdsInTreeSet = new Set(groupIdsInTree);
    const normalizedGroups = Object.fromEntries(
        groupIdsInTree
            .map((groupId) => [groupId, normalizePersistedGroup(groupId, value.groupsById?.[groupId], tabsByKey)] as const)
            .filter((entry): entry is readonly [string, DetailsWorkspaceGroupState] => entry[1] != null),
    ) as Record<string, DetailsWorkspaceGroupState>;

    if (Object.keys(normalizedGroups).length !== groupIdsInTree.length) {
        return createEmptyDetailsStateWithOrdinal(requestedOrdinal);
    }

    const referencedTabKeys = new Set(
        Object.values(normalizedGroups).flatMap((group) => group.tabKeys),
    );
    const normalizedTabsByKey = Object.fromEntries(
        Object.entries(tabsByKey).filter(([tabKey]) => referencedTabKeys.has(tabKey)),
    ) as Record<string, DetailsTabState>;
    const normalizedTabState = Object.fromEntries(
        Object.entries(isObjectRecord(value.tabState) ? value.tabState : {})
            .filter(([tabKey]) => referencedTabKeys.has(tabKey)),
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
        isOpen: value.isOpen === true,
        tabState: normalizedTabState,
        tabsByKey: normalizedTabsByKey,
        groupsById: normalizedGroups,
        root,
        focusedGroupId,
        maximizedGroupId,
        nextGroupOrdinal: Math.max(requestedOrdinal, maxObservedOrdinal + 1, 1),
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
    return {
        isOpen: value.isOpen,
        tabState: { ...value.tabState },
        tabsByKey: Object.fromEntries(
            Object.entries(value.tabsByKey).map(([tabKey, tab]) => [
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
                {
                    id: group.id,
                    tabKeys: [...group.tabKeys],
                    activeTabKey: group.activeTabKey,
                },
            ]),
        ),
        root: value.root,
        focusedGroupId: value.focusedGroupId,
        maximizedGroupId: value.maximizedGroupId,
        nextGroupOrdinal: value.nextGroupOrdinal,
    };
}
