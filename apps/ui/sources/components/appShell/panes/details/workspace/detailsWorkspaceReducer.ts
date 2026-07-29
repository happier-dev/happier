import type {
    DetailsTab,
    DetailsTabOpenMode,
    DetailsTabState,
    DetailsWorkspaceAxis,
    DetailsWorkspaceGroupState,
    DetailsWorkspaceNode,
    DetailsWorkspacePlacement,
    PaneDetailsState,
} from './detailsWorkspaceTypes';
import {
    applyDetailsWorkspaceSplitCanvasAction,
    createDetailsWorkspaceLeafNode,
    listDetailsWorkspaceGroupIds,
    mapDetailsWorkspaceAxisToSplitCanvasAxis,
} from './detailsWorkspaceSplitCanvas';
import { arePaneStateJsonValuesEqual } from '../../model/paneStateStructuralEquality';

const ROOT_GROUP_ID = 'group:1';

export function createEmptyPaneDetailsState(): PaneDetailsState {
    return {
        isOpen: false,
        tabState: {},
        tabsByKey: {},
        groupsById: {},
        root: null,
        focusedGroupId: null,
        maximizedGroupId: null,
        nextGroupOrdinal: 1,
    };
}

function getNextGroupId(details: PaneDetailsState): string {
    return `group:${Math.max(1, details.nextGroupOrdinal)}`;
}

function extractGroupOrdinal(groupId: string): number {
    const match = /^group:(\d+)$/.exec(groupId);
    if (!match) return 0;
    return Number.parseInt(match[1] ?? '0', 10) || 0;
}

function getFirstGroupId(details: Readonly<Pick<PaneDetailsState, 'root'>>): string | null {
    return listDetailsWorkspaceGroupIds(details.root)[0] ?? null;
}

function findLastDifferent(values: ReadonlyArray<string>, excludedValue: string): string | null {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (value && value !== excludedValue) return value;
    }
    return null;
}

function findGroupIdByTabKey(details: PaneDetailsState, tabKey: string): string | null {
    for (const [groupId, group] of Object.entries(details.groupsById)) {
        if (group.tabKeys.includes(tabKey)) return groupId;
    }
    return null;
}

function sanitizeTabKeys(
    group: DetailsWorkspaceGroupState,
    tabsByKey: Readonly<Record<string, DetailsTabState>>,
): DetailsWorkspaceGroupState {
    const tabKeys = group.tabKeys.filter((tabKey) => tabsByKey[tabKey] != null);
    const activeTabKey = group.activeTabKey && tabKeys.includes(group.activeTabKey)
        ? group.activeTabKey
        : tabKeys.at(-1) ?? null;
    if (tabKeys === group.tabKeys && activeTabKey === group.activeTabKey) return group;
    return {
        ...group,
        tabKeys,
        activeTabKey,
    };
}

function ensureRootGroup(details: PaneDetailsState): PaneDetailsState {
    if (details.root) return details;
    return {
        ...details,
        groupsById: {
            [ROOT_GROUP_ID]: {
                id: ROOT_GROUP_ID,
                tabKeys: [],
                activeTabKey: null,
            },
        },
        root: createDetailsWorkspaceLeafNode(ROOT_GROUP_ID),
        focusedGroupId: ROOT_GROUP_ID,
        nextGroupOrdinal: Math.max(details.nextGroupOrdinal, 2),
    };
}

function withFocusedGroup(details: PaneDetailsState, targetGroupId?: string | null): string {
    return targetGroupId && details.groupsById[targetGroupId]
        ? targetGroupId
        : details.focusedGroupId && details.groupsById[details.focusedGroupId]
            ? details.focusedGroupId
            : getFirstGroupId(details)
                ?? ROOT_GROUP_ID;
}

function removePreviewTabsFromGroup(
    details: PaneDetailsState,
    groupId: string,
    exceptTabKey?: string,
): PaneDetailsState {
    const group = details.groupsById[groupId];
    if (!group) return details;

    const removedKeys = group.tabKeys.filter((tabKey) => {
        if (tabKey === exceptTabKey) return false;
        return details.tabsByKey[tabKey]?.isPreview === true;
    });
    if (removedKeys.length === 0) return details;

    const removedKeySet = new Set(removedKeys);
    const nextTabState = { ...details.tabState } as Record<string, unknown>;
    const nextTabsByKey = { ...details.tabsByKey } as Record<string, DetailsTabState>;
    for (const key of removedKeys) {
        delete nextTabsByKey[key];
        delete nextTabState[key];
    }
    return {
        ...details,
        tabState: nextTabState,
        tabsByKey: nextTabsByKey,
        groupsById: {
            ...details.groupsById,
            [groupId]: {
                ...group,
                tabKeys: group.tabKeys.filter((tabKey) => !removedKeySet.has(tabKey)),
                activeTabKey:
                    group.activeTabKey && removedKeySet.has(group.activeTabKey)
                        ? findLastDifferent(
                            group.tabKeys.filter((tabKey) => !removedKeySet.has(tabKey)),
                            '',
                        )
                        : group.activeTabKey,
            },
        },
    };
}

function cleanupDetailsState(details: PaneDetailsState): PaneDetailsState {
    const groupIdsInTree = new Set(listDetailsWorkspaceGroupIds(details.root));
    const nextGroupsById = Object.fromEntries(
        Object.entries(details.groupsById)
            .filter(([groupId]) => groupIdsInTree.has(groupId))
            .map(([groupId, group]) => [groupId, sanitizeTabKeys(group, details.tabsByKey)]),
    ) as Record<string, DetailsWorkspaceGroupState>;

    const referencedTabKeys = new Set(
        Object.values(nextGroupsById).flatMap((group) => group.tabKeys),
    );

    const nextTabsByKey = Object.fromEntries(
        Object.entries(details.tabsByKey).filter(([tabKey]) => referencedTabKeys.has(tabKey)),
    ) as Record<string, DetailsTabState>;

    const nextTabState = Object.fromEntries(
        Object.entries(details.tabState).filter(([tabKey]) => referencedTabKeys.has(tabKey)),
    ) as Record<string, unknown>;

    const firstGroupId = getFirstGroupId(details);
    const focusedGroupId =
        details.focusedGroupId && nextGroupsById[details.focusedGroupId]
            ? details.focusedGroupId
            : firstGroupId;

    const maximizedGroupId =
        details.maximizedGroupId && nextGroupsById[details.maximizedGroupId]
            ? details.maximizedGroupId
            : null;

    const maxObservedOrdinal = Math.max(
        0,
        ...Object.keys(nextGroupsById).map(extractGroupOrdinal),
    );

    if (Object.keys(nextGroupsById).length === 0 || details.root == null) {
        return {
            ...createEmptyPaneDetailsState(),
            nextGroupOrdinal: Math.max(details.nextGroupOrdinal, maxObservedOrdinal + 1, 1),
        };
    }

    return {
        ...details,
        tabState: nextTabState,
        tabsByKey: nextTabsByKey,
        groupsById: nextGroupsById,
        focusedGroupId,
        maximizedGroupId,
        nextGroupOrdinal: Math.max(details.nextGroupOrdinal, maxObservedOrdinal + 1, 1),
    };
}

export function applyOpenDetailsTab(
    detailsState: PaneDetailsState,
    params: Readonly<{ tab: DetailsTab; openAs: DetailsTabOpenMode }>,
): PaneDetailsState {
    let details = ensureRootGroup(detailsState);
    const existingGroupId = findGroupIdByTabKey(details, params.tab.key);
    const targetGroupId = existingGroupId ?? withFocusedGroup(details);

    if (existingGroupId) {
        const existing = details.tabsByKey[params.tab.key]!;
        const isPinned = params.openAs === 'pinned' ? true : existing.isPinned;
        const isPreview = isPinned ? false : existing.isPreview;
        const nextTabState = {
            ...params.tab,
            isPinned,
            isPreview,
        };
        if (
            details.isOpen === true
            && details.focusedGroupId === existingGroupId
            && details.groupsById[existingGroupId]?.activeTabKey === params.tab.key
            && arePaneStateJsonValuesEqual(existing, nextTabState)
        ) {
            return details;
        }
        return cleanupDetailsState({
            ...details,
            isOpen: true,
            focusedGroupId: existingGroupId,
            tabsByKey: {
                ...details.tabsByKey,
                [params.tab.key]: nextTabState,
            },
            groupsById: {
                ...details.groupsById,
                [existingGroupId]: {
                    ...details.groupsById[existingGroupId]!,
                    activeTabKey: params.tab.key,
                },
            },
        });
    }

    if (params.openAs === 'preview') {
        details = removePreviewTabsFromGroup(details, targetGroupId);
    }

    const nextTab: DetailsTabState = {
        ...params.tab,
        isPinned: params.openAs === 'pinned',
        isPreview: params.openAs === 'preview',
    };

    const group = details.groupsById[targetGroupId] ?? { id: targetGroupId, tabKeys: [], activeTabKey: null };
    return cleanupDetailsState({
        ...details,
        isOpen: true,
        focusedGroupId: targetGroupId,
        tabsByKey: {
            ...details.tabsByKey,
            [nextTab.key]: nextTab,
        },
        groupsById: {
            ...details.groupsById,
            [targetGroupId]: {
                ...group,
                tabKeys: [...group.tabKeys, nextTab.key],
                activeTabKey: nextTab.key,
            },
        },
    });
}

export function applyReplaceDetailsTab(
    detailsState: PaneDetailsState,
    params: Readonly<{ tabKey: string; tab: DetailsTab; openAs?: DetailsTabOpenMode }>,
): PaneDetailsState {
    const sourceGroupId = findGroupIdByTabKey(detailsState, params.tabKey);
    const existing = detailsState.tabsByKey[params.tabKey];
    if (!sourceGroupId || !existing) return detailsState;

    const isPinned =
        params.openAs === 'pinned'
            ? true
            : params.openAs === 'preview'
                ? false
                : existing.isPinned;
    const isPreview =
        isPinned
            ? false
            : params.openAs === 'preview'
                ? true
                : existing.isPreview;

    let details = isPreview
        ? removePreviewTabsFromGroup(detailsState, sourceGroupId, params.tabKey)
        : detailsState;
    const sourceGroup = details.groupsById[sourceGroupId];
    if (!sourceGroup) return detailsState;

    const nextTab: DetailsTabState = {
        ...params.tab,
        isPinned,
        isPreview,
    };
    const nextTabsByKey = { ...details.tabsByKey } as Record<string, DetailsTabState>;
    const nextTabState = { ...details.tabState } as Record<string, unknown>;

    delete nextTabsByKey[params.tabKey];
    nextTabsByKey[nextTab.key] = nextTab;

    if (params.tabKey !== nextTab.key && Object.prototype.hasOwnProperty.call(nextTabState, params.tabKey)) {
        nextTabState[nextTab.key] = nextTabState[params.tabKey];
        delete nextTabState[params.tabKey];
    }

    const nextGroupsById = Object.fromEntries(
        Object.entries(details.groupsById).map(([groupId, group]) => {
            const seen = new Set<string>();
            const tabKeys: string[] = [];
            for (const tabKey of group.tabKeys) {
                if (groupId !== sourceGroupId && (tabKey === params.tabKey || tabKey === nextTab.key)) {
                    continue;
                }
                const nextKey = groupId === sourceGroupId && tabKey === params.tabKey
                    ? nextTab.key
                    : tabKey;
                if (seen.has(nextKey)) continue;
                seen.add(nextKey);
                tabKeys.push(nextKey);
            }
            return [groupId, {
                ...group,
                tabKeys,
                activeTabKey: group.activeTabKey === params.tabKey ? nextTab.key : group.activeTabKey,
            }];
        }),
    ) as Record<string, DetailsWorkspaceGroupState>;

    return cleanupDetailsState({
        ...details,
        tabsByKey: nextTabsByKey,
        tabState: nextTabState,
        groupsById: nextGroupsById,
    });
}

export function applySetDetailsTabState(
    details: PaneDetailsState,
    tabKey: string,
    nextState: unknown,
): PaneDetailsState {
    if (nextState == null) {
        if (!(tabKey in details.tabState)) return details;
        const nextTabState = { ...details.tabState } as Record<string, unknown>;
        delete nextTabState[tabKey];
        return { ...details, tabState: nextTabState };
    }
    if (arePaneStateJsonValuesEqual(details.tabState[tabKey], nextState)) {
        return details;
    }
    return {
        ...details,
        tabState: {
            ...details.tabState,
            [tabKey]: nextState,
        },
    };
}

export function applyPinDetailsTab(details: PaneDetailsState, tabKey: string): PaneDetailsState {
    const tab = details.tabsByKey[tabKey];
    if (!tab) return details;
    return {
        ...details,
        tabsByKey: {
            ...details.tabsByKey,
            [tabKey]: {
                ...tab,
                isPinned: true,
                isPreview: false,
            },
        },
    };
}

export function applyUnpinDetailsTab(detailsState: PaneDetailsState, tabKey: string): PaneDetailsState {
    const groupId = findGroupIdByTabKey(detailsState, tabKey);
    const tab = detailsState.tabsByKey[tabKey];
    if (!groupId || !tab) return detailsState;

    let details = removePreviewTabsFromGroup(detailsState, groupId, tabKey);
    details = {
        ...details,
        focusedGroupId: groupId,
        tabsByKey: {
            ...details.tabsByKey,
            [tabKey]: {
                ...tab,
                isPinned: false,
                isPreview: true,
            },
        },
        groupsById: {
            ...details.groupsById,
            [groupId]: {
                ...details.groupsById[groupId]!,
                activeTabKey: tabKey,
            },
        },
    };
    return cleanupDetailsState(details);
}

export function applyCloseDetails(details: PaneDetailsState): PaneDetailsState {
    if (!details.isOpen) return details;
    return { ...details, isOpen: false };
}

export function applyCloseDetailsTab(detailsState: PaneDetailsState, tabKey: string): PaneDetailsState {
    const groupId = findGroupIdByTabKey(detailsState, tabKey);
    if (!groupId) return detailsState;
    const group = detailsState.groupsById[groupId]!;

    const nextTabsByKey = { ...detailsState.tabsByKey } as Record<string, DetailsTabState>;
    const nextTabState = { ...detailsState.tabState } as Record<string, unknown>;
    delete nextTabsByKey[tabKey];
    delete nextTabState[tabKey];

    const nextTabKeys = group.tabKeys.filter((key) => key !== tabKey);
    const nextGroupsById = { ...detailsState.groupsById } as Record<string, DetailsWorkspaceGroupState>;
    let nextDetails: PaneDetailsState = {
        ...detailsState,
        tabsByKey: nextTabsByKey,
        tabState: nextTabState,
        groupsById: nextGroupsById,
    };

    if (nextTabKeys.length === 0) {
        delete nextGroupsById[groupId];
        nextDetails = applyDetailsWorkspaceSplitCanvasAction(nextDetails, {
            type: 'closeLeaf',
            leafId: groupId,
        });
    } else {
        nextGroupsById[groupId] = {
            ...group,
            tabKeys: nextTabKeys,
            activeTabKey:
                group.activeTabKey === tabKey
                    ? (nextTabKeys[group.tabKeys.indexOf(tabKey) - 1] ?? nextTabKeys[group.tabKeys.indexOf(tabKey)] ?? nextTabKeys.at(-1) ?? null)
                    : group.activeTabKey,
        };
    }

    return cleanupDetailsState({
        ...nextDetails,
        isOpen: Object.keys(nextGroupsById).length > 0 ? detailsState.isOpen : false,
    });
}

export function applySetActiveDetailsTab(detailsState: PaneDetailsState, tabKey: string): PaneDetailsState {
    const groupId = findGroupIdByTabKey(detailsState, tabKey);
    if (!groupId) return detailsState;
    return applyDetailsWorkspaceSplitCanvasAction({
        ...detailsState,
        groupsById: {
            ...detailsState.groupsById,
            [groupId]: {
                ...detailsState.groupsById[groupId]!,
                activeTabKey: tabKey,
            },
        },
    }, {
        type: 'focusLeaf',
        leafId: groupId,
    });
}

export function applySplitDetailsGroup(
    detailsState: PaneDetailsState,
    params: Readonly<{ axis: DetailsWorkspaceAxis; groupId?: string; placement?: DetailsWorkspacePlacement }>,
): PaneDetailsState {
    const details = ensureRootGroup(detailsState);
    const sourceGroupId = params.groupId ?? withFocusedGroup(details);
    if (!details.groupsById[sourceGroupId] || !details.root) return detailsState;

    const newGroupId = getNextGroupId(details);
    const nextDetails = applyDetailsWorkspaceSplitCanvasAction({
        ...details,
        maximizedGroupId: null,
        groupsById: {
            ...details.groupsById,
            [newGroupId]: {
                id: newGroupId,
                tabKeys: [],
                activeTabKey: null,
            },
        },
        nextGroupOrdinal: details.nextGroupOrdinal + 1,
    }, {
        type: 'splitLeaf',
        targetLeafId: sourceGroupId,
        axis: mapDetailsWorkspaceAxisToSplitCanvasAxis(params.axis),
        placement: params.placement ?? 'after',
        newLeaf: createDetailsWorkspaceLeafNode(newGroupId),
    });

    return cleanupDetailsState({
        ...nextDetails,
        isOpen: true,
    });
}

export function applyMoveDetailsTabToGroup(
    detailsState: PaneDetailsState,
    params: Readonly<{ tabKey: string; targetGroupId: string }>,
): PaneDetailsState {
    const sourceGroupId = findGroupIdByTabKey(detailsState, params.tabKey);
    if (!sourceGroupId) return detailsState;
    if (!detailsState.groupsById[params.targetGroupId]) return detailsState;
    if (sourceGroupId === params.targetGroupId) {
        return applySetActiveDetailsTab(detailsState, params.tabKey);
    }

    const movingTab = detailsState.tabsByKey[params.tabKey];
    if (!movingTab) return detailsState;

    let details = detailsState;
    if (movingTab.isPreview) {
        details = removePreviewTabsFromGroup(details, params.targetGroupId, params.tabKey);
    }

    const sourceGroup = details.groupsById[sourceGroupId]!;
    const targetGroup = details.groupsById[params.targetGroupId]!;

    const nextGroupsById = { ...details.groupsById } as Record<string, DetailsWorkspaceGroupState>;
    nextGroupsById[sourceGroupId] = {
        ...sourceGroup,
        tabKeys: sourceGroup.tabKeys.filter((tabKey) => tabKey !== params.tabKey),
        activeTabKey:
            sourceGroup.activeTabKey === params.tabKey
                ? findLastDifferent(sourceGroup.tabKeys, params.tabKey)
                : sourceGroup.activeTabKey,
    };
    nextGroupsById[params.targetGroupId] = {
        ...targetGroup,
        tabKeys: [...targetGroup.tabKeys.filter((tabKey) => tabKey !== params.tabKey), params.tabKey],
        activeTabKey: params.tabKey,
    };

    let nextDetails: PaneDetailsState = {
        ...details,
        groupsById: nextGroupsById,
        focusedGroupId: params.targetGroupId,
    };

    if (nextGroupsById[sourceGroupId]?.tabKeys.length === 0) {
        delete nextGroupsById[sourceGroupId];
        nextDetails = applyDetailsWorkspaceSplitCanvasAction(nextDetails, {
            type: 'closeLeaf',
            leafId: sourceGroupId,
        });
    }

    return cleanupDetailsState(nextDetails);
}

export function applyFocusDetailsGroup(detailsState: PaneDetailsState, groupId: string): PaneDetailsState {
    if (!detailsState.groupsById[groupId]) return detailsState;
    if (detailsState.focusedGroupId === groupId) return detailsState;
    return applyDetailsWorkspaceSplitCanvasAction(detailsState, {
        type: 'focusLeaf',
        leafId: groupId,
    });
}

export function applySetMaximizedDetailsGroup(detailsState: PaneDetailsState, groupId: string | null): PaneDetailsState {
    if (groupId && !detailsState.groupsById[groupId]) return detailsState;
    if (groupId == null) {
        if (detailsState.maximizedGroupId == null) return detailsState;
        return applyDetailsWorkspaceSplitCanvasAction(detailsState, {
            type: 'restoreMaximize',
        });
    }
    if (detailsState.maximizedGroupId === groupId) return detailsState;
    return applyDetailsWorkspaceSplitCanvasAction(detailsState, {
        type: 'toggleMaximizeLeaf',
        leafId: groupId,
    });
}

export function applySetDetailsSplitRatio(
    detailsState: PaneDetailsState,
    splitId: string,
    ratio: number,
): PaneDetailsState {
    return applyDetailsWorkspaceSplitCanvasAction(detailsState, {
        type: 'setSplitRatio',
        splitId,
        ratio,
    });
}

export function applyCloseDetailsGroup(detailsState: PaneDetailsState, groupId: string): PaneDetailsState {
    const group = detailsState.groupsById[groupId];
    if (!group) return detailsState;
    let next = detailsState;
    for (const tabKey of group.tabKeys) {
        next = applyCloseDetailsTab(next, tabKey);
    }
    if (next.groupsById[groupId]) {
        const nextGroupsById = { ...next.groupsById } as Record<string, DetailsWorkspaceGroupState>;
        delete nextGroupsById[groupId];
        next = cleanupDetailsState(applyDetailsWorkspaceSplitCanvasAction({
            ...next,
            groupsById: nextGroupsById,
        }, {
            type: 'closeLeaf',
            leafId: groupId,
        }));
    }
    return next;
}

function areTabStateRecordsEqual(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!arePaneStateJsonValuesEqual(left[key], right[key])) return false;
    }
    return true;
}

function areDetailsTabStatesEqual(
    left: DetailsTabState | undefined,
    right: DetailsTabState | undefined,
): boolean {
    if (!left || !right) return false;
    return (
        left.key === right.key
        && left.kind === right.kind
        && left.title === right.title
        && left.subtitle === right.subtitle
        && Object.is(left.resource, right.resource)
        && left.isPreview === right.isPreview
        && left.isPinned === right.isPinned
    );
}

function areGroupStatesEqual(
    left: DetailsWorkspaceGroupState | undefined,
    right: DetailsWorkspaceGroupState | undefined,
): boolean {
    if (!left || !right) return false;
    if (left.id !== right.id || left.activeTabKey !== right.activeTabKey) return false;
    if (left.tabKeys.length !== right.tabKeys.length) return false;
    for (let index = 0; index < left.tabKeys.length; index += 1) {
        if (left.tabKeys[index] !== right.tabKeys[index]) return false;
    }
    return true;
}

function areNodesEqual(left: DetailsWorkspaceNode | null, right: DetailsWorkspaceNode | null): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    if (left.kind !== right.kind || left.id !== right.id) return false;
    if (left.kind === 'leaf' && right.kind === 'leaf') {
        return left.leafKind === right.leafKind && left.payload.groupId === right.payload.groupId;
    }
    if (left.kind === 'split' && right.kind === 'split') {
        return (
            left.axis === right.axis
            && left.ratio === right.ratio
            && areNodesEqual(left.first, right.first)
            && areNodesEqual(left.second, right.second)
        );
    }
    return false;
}

export function arePaneDetailsStatesEqual(left: PaneDetailsState, right: PaneDetailsState): boolean {
    if (
        left.isOpen !== right.isOpen
        || left.focusedGroupId !== right.focusedGroupId
        || left.maximizedGroupId !== right.maximizedGroupId
        || left.nextGroupOrdinal !== right.nextGroupOrdinal
        || !areNodesEqual(left.root, right.root)
        || !areTabStateRecordsEqual(left.tabState, right.tabState)
    ) {
        return false;
    }

    const leftTabKeys = Object.keys(left.tabsByKey);
    const rightTabKeys = Object.keys(right.tabsByKey);
    if (leftTabKeys.length !== rightTabKeys.length) return false;
    for (const tabKey of leftTabKeys) {
        if (!areDetailsTabStatesEqual(left.tabsByKey[tabKey], right.tabsByKey[tabKey])) return false;
    }

    const leftGroupIds = Object.keys(left.groupsById);
    const rightGroupIds = Object.keys(right.groupsById);
    if (leftGroupIds.length !== rightGroupIds.length) return false;
    for (const groupId of leftGroupIds) {
        if (!areGroupStatesEqual(left.groupsById[groupId], right.groupsById[groupId])) return false;
    }
    return true;
}
