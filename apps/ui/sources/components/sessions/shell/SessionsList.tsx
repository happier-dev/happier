import React from 'react';
import {
    View,
    FlatList,
    Platform,
    RefreshControl,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    type LayoutChangeEvent,
    type ViewToken,
} from 'react-native';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { usePathname, useRouter } from 'expo-router';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { SessionListViewItem, storage, useSetting } from '@/sync/domains/state/storage';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { layout } from '@/components/ui/layout/layout';
import {
    createSessionFolder,
    deleteSessionFolder,
    normalizeSessionFolders,
    renameSessionFolder,
    resolveDurableWorkspaceRefForSessionListHeader,
} from '@/sync/domains/session/folders';
import {
    resolveEffectiveSessionListOrderingModeForGroup,
    type SessionListOrderingSectionMode,
} from '@/sync/domains/session/listing/sessionListOrderingRules';
import { isSessionListWorkingPlacementReason } from '@/sync/domains/session/listing/placement/sessionListPlacementProjection';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import {
    setSessionFolderAssignment,
    setSessionPin,
    setSessionTagLabels,
} from '@/sync/ops/sessionOrganization';
import { sessionTagKey } from './sessionTagUtils';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import { FolderGroupHeader } from './sessionFolderHeader';
import {
    asSessionFolderHeaderItem,
    readSessionFolderDepth,
    type SessionFolderMoveTarget,
} from './sessionFolderShellTypes';
import { SessionFolderScopeBreadcrumb } from './sessionFolderScopeBreadcrumb';
import { DraggableSessionFolderHeaderFrame } from './DraggableSessionFolderHeaderFrame';
import { ProjectGroupHeader } from './ProjectGroupHeader';
import { SessionListHeaderFrame } from './SessionListHeaderFrame';
import { resolveSessionListRowModelAdjacency } from './row/buildSessionListRowModels';
import { SessionListRowModelBoundary } from './row/SessionListRowModelBoundary';
import type {
    SessionListRowPresentationSettings,
    SessionListSessionItem,
} from './row/sessionListRowModelTypes';
import { useSessionListRowMoveActionHandlers } from './row/useSessionListRowMoveActionHandlers';
import {
    buildSessionListEmbeddedPriorityRowKeys,
    buildSessionListRowStoreSubscriptionTelemetryFields,
    resolveSessionListRowStoreScopeKey,
    resolveSessionListRowStoreSubscriptionMode,
    resolveSessionListRowStoreSubscriptionScopes,
    reuseSessionListRowStoreKeySet,
    reuseSessionListRowStoreSubscriptionScopes,
    type SessionListRowStorePriorityReason,
    type SessionListRowStorePriorityReasonCounts,
    type SessionListRowStoreSubscriptionScope,
} from './row/sessionListVisibleRowStoreScopes';
import { treeRowId } from './drop-resolution/treeRowId';
import { SessionListViewMenuButton } from './sessionListViewMenu';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import { storeTempData } from '@/utils/sessions/tempDataStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    buildVisibleSessionNavigationEntries,
    moveSessionMruEntryToFront,
    resolveSessionMruNavigation,
    resolveVisibleSessionEdgeNavigation,
    resolveVisibleSessionNavigation,
    type VisibleSessionNavigationEntry,
} from '@/keyboard/sessions';
import { useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { CollapsibleSectionHeader } from './CollapsibleSectionHeader';
import { useSessionListViewState } from './view-state/useSessionListViewState';
import { useSessionListRowInteractions } from './view-state/useSessionListRowInteractions';
import { readSessionIdFromPathname } from './readSessionIdFromPathname';
import { useSessionListMoveSheet } from './move-sheet/useSessionListMoveSheet';
import type { SessionListMoveSheetTarget } from './move-sheet/buildSessionListMoveSheetTargets';
import { useSessionListA11yAnnouncements } from './accessibility/useSessionListA11yAnnouncements';
import { useFrozenSessionListItemsDuringDrag } from './drag/useFrozenSessionListItemsDuringDrag';
import { SessionListDropOverlay } from './drag/SessionListDropOverlay';
import { SessionListHeaderControls } from './SessionListHeaderControls';
import { useSessionListSearchTextByKey } from './useSessionListSearchTextByKey';
import { useSessionListMemorySearchAugmentation } from './search/useSessionListMemorySearchAugmentation';
import { useSessionListHeaderFilterRetention } from './search/useSessionListHeaderFilterRetention';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import {
    getSessionListHeaderControlsAnchorKey,
    hasActiveSessionListHeaderFilters,
} from './sessionListFilters';
import { useSessionListScrollRetention } from './scroll/useSessionListScrollRetention';
import { buildSessionListRetentionKey } from './scroll/sessionListRetentionKey';
import {
    normalizeSessionListSurfaceOwnership,
    type SessionListSurfaceOwnership,
} from './surface/sessionListSurfaceOwnership';
import { useSessionListSnapshotWhenInactive } from './surface/useSessionListSnapshotWhenInactive';
import {
    createSessionListRuntimePriorityRowScopeSelector,
} from '@/sync/store/sessionListRowStateSnapshot';
import { preloadEnrichedMarkdownRuntime } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';
import { SyncPerformanceReactProfiler } from '@/components/ui/performance/SyncPerformanceReactProfiler';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import type {
    SessionBulkActionExecutionContext,
    SessionBulkActionTarget,
} from '@/components/sessions/actions/sessionBulkActionExecution';
import {
    sessionArchiveWithServerScope,
    sessionSetManualReadStateWithServerScope,
    sessionStopWithServerScope,
    sessionUnarchiveWithServerScope,
} from '@/sync/ops';
import {
    clearSessionVisibleWhenInactive,
    stopSessionAndMaybeArchive,
} from '@/components/sessions/sessionStopArchiveFlow';
import {
    SessionListSelectionStoreProvider,
    useSessionListSelectionController,
} from './selection/SessionListSelectionContext';
import {
    buildSessionListSelectionScopeKey,
    readSessionListSelectionKeysFromVisibleEntries,
} from './selection/sessionListSelectionKeys';
import { SessionListSelectionActionBarHost } from './selection/SessionListSelectionActionBar';
import { Icon } from '@/components/ui/icons/Icon';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';

export { ProjectGroupHeader } from './ProjectGroupHeader';
export { CollapsibleSectionHeader } from './CollapsibleSectionHeader';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.background.canvas,
    },
    contentContainer: {
        position: 'relative',
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    footerContainer: {
        marginTop: -4,
    },
}));

const SESSION_FOLDER_MOVE_MENU_BASE_LEFT_PADDING = 16;
const SESSION_FOLDER_MOVE_MENU_INDENT_STEP = 12;
const SEARCH_FOCUS_TRANSFER_SETTLE_MS = 50;
const SESSION_LIST_END_REACHED_THRESHOLD_RATIO = 0.4;

function isSessionListScrollNearEnd(event: NativeSyntheticEvent<NativeScrollEvent>): boolean {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offsetY = typeof contentOffset?.y === 'number' ? contentOffset.y : 0;
    const contentHeight = typeof contentSize?.height === 'number' ? contentSize.height : 0;
    const viewportHeight = typeof layoutMeasurement?.height === 'number' ? layoutMeasurement.height : 0;
    if (contentHeight <= 0 || viewportHeight <= 0) return false;

    const thresholdPx = Math.max(1, viewportHeight * SESSION_LIST_END_REACHED_THRESHOLD_RATIO);
    return offsetY + viewportHeight >= contentHeight - thresholdPx;
}

/**
 * Web `FlatList` (React Native Web `VirtualizedList`) virtualization bounds.
 *
 * Phase 5 of the session-list drag geometry & performance unification
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.6, 13.6). Plan section 1.2 measured the live web list mounting all
 * 148 rows for an ~11.5-viewport list: the cause is `VirtualizedList`'s default
 * `windowSize` of 21 viewport heights, which exceeds the content length, so the
 * whole list mounts. Drag correctness no longer requires every row to be
 * mounted — row/header geometry is content-coordinate and measured on mount,
 * including while autoscrolling to a previously offscreen target, and the drag
 * snapshot freezes tree topology only (never pixel geometry). So the web list
 * can be windowed safely.
 *
 * Chosen bounds — deliberately conservative (~3 viewports mounted, ~1 viewport
 * of overscan each side around the visible viewport):
 * - `windowSize` 3: the mounted region is the visible viewport plus one
 *   viewport of overscan above and below. With the measured ~84px session rows
 *   and a typical viewport that mounts roughly 3x the visible rows, far below
 *   the previous full-list mount, while keeping enough overscan that a drag
 *   autoscroll always has measured geometry slightly ahead of the pointer.
 * - `initialNumToRender` 12: ~one viewport-and-a-half of rows on first paint so
 *   the first screen and its header are populated without a visible fill-in.
 * - `maxToRenderPerBatch` 8 with `updateCellsBatchingPeriod` 50ms: incremental
 *   fill of newly revealed rows in small batches so scroll/drag-autoscroll keep
 *   a steady frame budget instead of one large synchronous mount.
 *
 * `getItemLayout` is intentionally NOT set: the list interleaves fixed-height
 * session rows with variable-height headers (folder/project/collapsible
 * headers and the search/primary header, which wrap by content), plus a
 * variable-height list header/footer — a single-stride `getItemLayout` would
 * report wrong offsets for every header and corrupt scrolling/anchoring. The
 * conservative `windowSize` keeps measurement-driven virtualization correct for
 * the mixed-height list without needing precomputed offsets.
 *
 * `removeClippedSubviews` is NOT enabled: on React Native Web it detaches
 * clipped cells and is a known source of disappearing rows / measurement gaps
 * during fast scroll, which would undermine the content-coordinate geometry the
 * drag relies on. The native FlashList path is untouched.
 */
const WEB_LIST_WINDOW_SIZE = 3;
const WEB_LIST_INITIAL_NUM_TO_RENDER = 12;
const WEB_LIST_MAX_TO_RENDER_PER_BATCH = 8;
const WEB_LIST_UPDATE_CELLS_BATCHING_PERIOD_MS = 50;
const WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS = 120;
const WEB_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
const NATIVE_LIST_ALL_RENDERED_ROW_STORE_MAX_ITEMS = 200;
const NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS = 16;
const NATIVE_LIST_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({ disabled: true });
const EMPTY_SESSION_KEYS: ReadonlyArray<string> = Object.freeze([]);
const EMPTY_COLLAPSED_GROUP_KEYS: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_SESSION_LIST_VIEW_ITEMS: ReadonlyArray<SessionListViewItem> = Object.freeze([]);
const EMPTY_SESSION_LIST_ROW_STORE_SCOPES: ReadonlyArray<{ sessionId: string; serverId?: string | null }> = Object.freeze([]);
const EMPTY_SESSION_ROW_STORE_KEY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());
const EMPTY_MEMORY_MATCHED_SESSION_KEYS: ReadonlySet<string> = Object.freeze(new Set<string>());
const EMPTY_REACHABLE_SESSION_DISPLAY_BY_KEY: Readonly<Record<string, never>> = Object.freeze({});
const EMPTY_SESSION_TAGS_BY_KEY: Readonly<Record<string, readonly string[]>> = Object.freeze({});
const SESSION_LIST_IDLE_MOVE_RESULT = Object.freeze({
    instruction: Object.freeze({ kind: 'idle' as const }),
    visual: Object.freeze({ kind: 'none' as const }),
});

function isPrioritySessionListHeader(item: Extract<SessionListViewItem, { type: 'header' }>): boolean {
    return item.headerKind === 'attention'
        || item.headerKind === 'working'
        || item.headerKind === 'pinned'
        || item.headerKind === 'active';
}

function isInactiveSessionListBoundary(item: SessionListViewItem): boolean {
    return item.type === 'header' && item.headerKind === 'inactive';
}

function resolveWebListInitialNumToRender(items: ReadonlyArray<SessionListViewItem>): number {
    if (items.length <= WEB_LIST_INITIAL_NUM_TO_RENDER) return WEB_LIST_INITIAL_NUM_TO_RENDER;

    let hasPrioritySection = false;
    let firstInactiveIndex = -1;
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item) continue;
        if (item.type === 'header' && isPrioritySessionListHeader(item)) {
            hasPrioritySection = true;
        }
        if (isInactiveSessionListBoundary(item)) {
            firstInactiveIndex = index;
            break;
        }
    }

    if (!hasPrioritySection) return WEB_LIST_INITIAL_NUM_TO_RENDER;
    const priorityPrefixLength = firstInactiveIndex >= 0 ? firstInactiveIndex : items.length;
    return Math.max(WEB_LIST_INITIAL_NUM_TO_RENDER, priorityPrefixLength);
}

function buildSessionBulkActionTargetFromSessionItem(
    item: SessionListSessionItem,
    settings: SessionListRowPresentationSettings,
): SessionBulkActionTarget {
    const sessionId = String(item.session.id);
    const serverId = typeof item.serverId === 'string' && item.serverId.trim()
        ? item.serverId.trim()
        : null;
    const rowKey = serverId ? sessionTagKey(serverId, sessionId) : sessionId;
    const actionTarget = createSessionActionTarget({
        session: item.session,
        serverId,
        currentUserId: settings.currentUserId,
        isConnected: item.session.active === true,
        isPinned: item.pinned === true || settings.pinnedSessionKeys.includes(rowKey),
    });
    const readState = actionTarget.readStateAction.visible
        ? actionTarget.readStateAction.targetState === 'read'
            ? 'unread'
            : 'read'
        : undefined;

    return {
        key: rowKey,
        sessionId,
        serverId,
        active: actionTarget.isActive,
        archived: actionTarget.isArchived,
        hasAdminAccess: actionTarget.hasAdminAccess,
        canStop: actionTarget.canStop,
        canArchive: actionTarget.canArchive,
        pinned: actionTarget.isPinned,
        tags: settings.sessionTagsByKey[rowKey] ?? [],
        readState,
    };
}

function buildStringListSignature(values: ReadonlyArray<string> | null | undefined): string {
    if (!values || values.length === 0) return '';
    return values.join('\u0001');
}

function buildStringSetSignature(values: ReadonlySet<string> | null | undefined): string {
    if (!values) return '*';
    if (values.size === 0) return '';
    return Array.from(values).sort((left, right) => left.localeCompare(right)).join('\u0001');
}

function buildSessionRowStoreKeySetFromScopes(
    scopes: ReadonlyArray<SessionListRowStoreSubscriptionScope>,
): ReadonlySet<string> {
    if (scopes.length === 0) return EMPTY_SESSION_ROW_STORE_KEY_SET;
    const keys = new Set<string>();
    for (const scope of scopes) {
        const key = resolveSessionListRowStoreScopeKey(scope);
        if (key) keys.add(key);
    }
    return keys.size > 0 ? keys : EMPTY_SESSION_ROW_STORE_KEY_SET;
}

function mergeSessionRowStoreKeySets(
    primary: ReadonlySet<string>,
    secondary: ReadonlySet<string>,
): ReadonlySet<string> {
    if (secondary.size === 0) return primary;
    if (primary.size === 0) return secondary;
    const merged = new Set(primary);
    for (const key of secondary) {
        merged.add(key);
    }
    return merged;
}

function incrementPriorityReasonCount(
    counts: Partial<Record<SessionListRowStorePriorityReason, number>>,
    reason: SessionListRowStorePriorityReason,
): void {
    counts[reason] = (counts[reason] ?? 0) + 1;
}

function buildPrioritySessionRowReasonCounts(
    items: ReadonlyArray<SessionListViewItem>,
): SessionListRowStorePriorityReasonCounts {
    const counts: Partial<Record<SessionListRowStorePriorityReason, number>> = {};
    for (const item of items) {
        if (item.type !== 'session') continue;
        const sessionItem = item as SessionListSessionItem;
        if (isSessionListWorkingPlacementReason(sessionItem.workingPlacementReason)) incrementPriorityReasonCount(counts, 'workingPlacement');
        if (sessionItem.attentionPromotionReason != null) incrementPriorityReasonCount(counts, 'attention');
        if (sessionItem.selected === true) incrementPriorityReasonCount(counts, 'selected');
    }
    return counts;
}

function buildSessionCandidateKeySet(items: ReadonlyArray<SessionListViewItem>): ReadonlySet<string> {
    if (items.length === 0) return EMPTY_MEMORY_MATCHED_SESSION_KEYS;
    const keys = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.session?.id ?? '').trim();
        if (serverId && sessionId) {
            keys.add(sessionTagKey(serverId, sessionId));
        }
    }
    return keys.size > 0 ? keys : EMPTY_MEMORY_MATCHED_SESSION_KEYS;
}

function buildStringRecordSignature(value: Readonly<Record<string, string>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => `${key}\u0001${entryValue}`)
        .join('\u0002');
}

function buildStringArrayRecordSignature(value: Readonly<Record<string, readonly string[]>> | null | undefined): string {
    if (!value) return '';
    const entries = Object.entries(value);
    if (entries.length === 0) return '';
    return entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => `${key}\u0001${buildStringListSignature(entryValue)}`)
        .join('\u0002');
}

function buildFolderMoveTargetSignature(targets: ReadonlyArray<SessionFolderMoveTarget>): string {
    if (targets.length === 0) return '';
    return targets
        .map((target) => `${target.folderId ?? ''}\u0001${target.title}\u0001${target.depth}`)
        .join('\u0002');
}

function buildRowLabelSignature(labels: ReadonlyMap<string, string>): string {
    if (labels.size === 0) return '';
    return Array.from(labels.entries())
        .map(([key, label]) => `${key}\u0001${label}`)
        .join('\u0002');
}

function buildReachableDisplaySignature(displayByKey: ReadonlyMap<string, Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: 'head' | 'tail';
}>>): string {
    if (displayByKey.size === 0) return '';
    return Array.from(displayByKey.entries())
        .map(([rowKey, display]) => [
            rowKey,
            display.machineId ?? '',
            display.machineLabel,
            display.workspaceSubtitle,
            display.workspaceSubtitleEllipsizeMode,
        ].join('\u0001'))
        .join('\u0002');
}

function buildReachableDisplayRecord(displayByKey: ReadonlyMap<string, Readonly<{
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: 'head' | 'tail';
}>>): SessionListRowPresentationSettings['reachableSessionDisplayByKey'] {
    if (displayByKey.size === 0) return EMPTY_REACHABLE_SESSION_DISPLAY_BY_KEY;
    const record: Record<string, {
        machineLabel: string;
        workspaceSubtitle: string;
        workspaceSubtitleEllipsizeMode: 'head' | 'tail';
    }> = {};
    for (const [rowKey, display] of displayByKey.entries()) {
        record[rowKey] = {
            machineLabel: display.machineLabel,
            workspaceSubtitle: display.workspaceSubtitle,
            workspaceSubtitleEllipsizeMode: display.workspaceSubtitleEllipsizeMode,
        };
    }
    return record;
}

function normalizeRowDensity(compact: boolean, compactMinimal: boolean): SessionListRowPresentationSettings['density'] {
    if (compact && compactMinimal) return 'minimal';
    return compact ? 'compact' : 'default';
}

function normalizeIdentityDisplay(value: unknown): SessionListRowPresentationSettings['identityDisplay'] {
    return value === 'agentLogo' || value === 'none' ? value : 'avatar';
}

function normalizeActiveColorMode(value: unknown): SessionListRowPresentationSettings['activeColorMode'] {
    switch (value) {
        case 'attentionOnly':
        case 'allActive':
            return value;
        case 'activityAndAttention':
        default:
            return 'activityAndAttention';
    }
}

function normalizeWorkingIndicatorMode(value: unknown): SessionListRowPresentationSettings['workingIndicatorMode'] {
    return value === 'pulse' ? 'pulse' : 'spinner';
}

/**
 * FlashList recycling pools are keyed on this type. Session cell heights are
 * NOT uniform: last/single-in-group rows carry the inter-group bottom margin
 * (see SessionItem container styles) and density changes the base height, so
 * pooling all sessions under one type lets a recycled cell reuse a stale
 * height from a different group position — visible as a bottom gap/overlap
 * when sessions change groups. Keying the pool on the HEIGHT CLASS keeps
 * every pool height-homogeneous while avoiding remounts (a type change
 * remounts the cell, tearing down drag/context-menu state) for position
 * flips that do not change the cell height: 'tail' rows (last/single) carry
 * the inter-group gap, 'body' rows (first/middle) do not. Adjacency comes
 * from the same canonical resolver the row models use.
 */
function resolveSessionListVirtualizedItemType(params: Readonly<{
    item: SessionListViewItem;
    index: number;
    items: ReadonlyArray<SessionListViewItem>;
    density: SessionListRowPresentationSettings['density'];
}>): string {
    if (params.item.type !== 'session') {
        const headerKind = typeof params.item.headerKind === 'string' && params.item.headerKind.length > 0
            ? params.item.headerKind
            : 'generic';
        return `header:${headerKind}`;
    }
    const adjacency = resolveSessionListRowModelAdjacency(params.items, params.index);
    const heightClass = adjacency.isLast || adjacency.isSingle ? 'tail' : 'body';
    return `session:${params.density}:${heightClass}`;
}

function resolveSessionFolderMoveMenuRowPaddingLeft(depth: number): number | undefined {
    const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.trunc(depth)) : 0;
    if (normalizedDepth <= 0) return undefined;
    return SESSION_FOLDER_MOVE_MENU_BASE_LEFT_PADDING + normalizedDepth * SESSION_FOLDER_MOVE_MENU_INDENT_STEP;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function stringSetsEqual(left: ReadonlySet<string> | null, right: ReadonlySet<string>): boolean {
    if (left === right) return true;
    if (left === null || left.size !== right.size) return false;
    for (const value of right) {
        if (!left.has(value)) return false;
    }
    return true;
}

function useStableSessionListRowStoreKeySet<T extends ReadonlySet<string>>(value: T): T {
    const previousRef = React.useRef<T | null>(null);
    const stableValue = reuseSessionListRowStoreKeySet(previousRef.current, value);
    previousRef.current = stableValue;
    return stableValue;
}

function useStableSessionListRowStoreSubscriptionScopes<T extends ReadonlyArray<SessionListRowStoreSubscriptionScope>>(
    scopes: T,
): T {
    const previousRef = React.useRef<T | null>(null);
    const stableScopes = reuseSessionListRowStoreSubscriptionScopes(previousRef.current, scopes);
    previousRef.current = stableScopes;
    return stableScopes;
}

function findVisibleSessionNavigationEntryByScope(
    entries: readonly VisibleSessionNavigationEntry[],
    sessionId: string,
    serverId: string | null | undefined,
): VisibleSessionNavigationEntry | null {
    const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0
        ? serverId.trim()
        : null;
    if (normalizedServerId) {
        const scoped = entries.find((entry) =>
            entry.sessionId === sessionId && entry.serverId === normalizedServerId
        );
        if (scoped) return scoped;
    }
    return entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

function resolveSessionTreeRowId(sessionKey: string | null): string | null {
    if (!sessionKey) return null;
    const separatorIndex = sessionKey.indexOf(':');
    if (separatorIndex <= 0) return null;
    const serverId = sessionKey.slice(0, separatorIndex);
    const sessionId = sessionKey.slice(separatorIndex + 1);
    return serverId && sessionId ? treeRowId.session(serverId, sessionId) : null;
}

function resolveAdjacentSessionSelectionKey(params: Readonly<{
    visibleKeys: readonly string[];
    currentKey: string | null;
    direction: 'previous' | 'next';
}>): string | null {
    if (params.visibleKeys.length === 0) return null;
    const currentIndex = params.currentKey ? params.visibleKeys.indexOf(params.currentKey) : -1;
    if (currentIndex < 0) {
        return params.direction === 'previous'
            ? params.visibleKeys[params.visibleKeys.length - 1] ?? null
            : params.visibleKeys[0] ?? null;
    }
    const targetIndex = params.direction === 'previous'
        ? Math.max(0, currentIndex - 1)
        : Math.min(params.visibleKeys.length - 1, currentIndex + 1);
    return params.visibleKeys[targetIndex] ?? null;
}

const SessionsListHeader = React.memo(function SessionsListHeader(props: Readonly<{
    children?: React.ReactNode;
}>) {
    return (
        <View>
            <RecoveryKeyReminderBanner />
            <UpdateBanner />
            {props.children}
        </View>
    );
});

export function SessionsList(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    const pathname = usePathname();
    const activeSessionId = React.useMemo(() => readSessionIdFromPathname(pathname), [pathname]);
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    React.useEffect(() => {
        fireAndForget(preloadEnrichedMarkdownRuntime(), { tag: 'SessionsList.preloadEnrichedMarkdownRuntime' });
    }, []);
    const data = useVisibleSessionListViewData(props.storageKind ?? 'all', {
        activeSessionId,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
    });
    return (
        <SessionsListContent
            storageKind={props.storageKind}
            data={data}
            pathname={pathname}
            surfaceOwnership={surfaceOwnership}
        />
    );
}

export const SessionsListContent = React.memo(function SessionsListContent(props: Readonly<{
    storageKind?: SessionListStorageFilter;
    data: SessionListViewItem[] | null;
    pathname?: string;
    surfaceOwnership?: Partial<SessionListSurfaceOwnership>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const liveData = props.data;
    const surfaceOwnership = normalizeSessionListSurfaceOwnership(props.surfaceOwnership);
    const data = useSessionListSnapshotWhenInactive(liveData, surfaceOwnership.dataActive);
    const surfaceDataActiveRef = React.useRef(surfaceOwnership.dataActive);
    surfaceDataActiveRef.current = surfaceOwnership.dataActive;
    const currentPathname = usePathname();
    const pathname = props.pathname ?? currentPathname;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const focusReturnFallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
    const { openMoveSheet } = useSessionListMoveSheet();
    const sessionListA11y = useSessionListA11yAnnouncements();
    const retentionKey = React.useMemo(
        () => buildSessionListRetentionKey(props.storageKind),
        [props.storageKind],
    );
    const {
        searchQuery,
        setSearchQuery,
        selectedHeaderTags,
        setSelectedHeaderTags,
    } = useSessionListHeaderFilterRetention(retentionKey);
    const [activeSearchHeaderControlsAnchorKey, setActiveSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const [focusedSearchHeaderControlsAnchorKey, setFocusedSearchHeaderControlsAnchorKey] = React.useState<string | null>(null);
    const [refreshingSessions, setRefreshingSessions] = React.useState(false);
    const refreshingSessionsRef = React.useRef(false);
    const searchFocusTransferTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sessionListMemoryCandidateKeys = React.useMemo(
        () => buildSessionCandidateKeySet(data ?? EMPTY_SESSION_LIST_VIEW_ITEMS),
        [data],
    );
    const memorySearch = useSessionListMemorySearchAugmentation({
        searchQuery,
        candidateSessionKeys: sessionListMemoryCandidateKeys,
        enabled: surfaceOwnership.dataActive,
    });
    const activeMemoryMatchedSessionKeys = React.useMemo(() => {
        const query = searchQuery.trim();
        if (!query || memorySearch.lastSuccessfulQuery !== query) {
            return EMPTY_MEMORY_MATCHED_SESSION_KEYS;
        }
        return memorySearch.memoryMatchedSessionKeys;
    }, [memorySearch.lastSuccessfulQuery, memorySearch.memoryMatchedSessionKeys, searchQuery]);
    const searchableTextBySessionKey = useSessionListSearchTextByKey(
        data ?? EMPTY_SESSION_LIST_VIEW_ITEMS,
        searchQuery.trim().length > 0,
    );
    const headerFilters = React.useMemo(() => ({
        searchQuery,
        selectedTags: selectedHeaderTags,
        searchableTextBySessionKey,
        memoryMatchedSessionKeys: activeMemoryMatchedSessionKeys,
        controlsAnchorKey: activeSearchHeaderControlsAnchorKey,
    }), [activeMemoryMatchedSessionKeys, activeSearchHeaderControlsAnchorKey, searchQuery, searchableTextBySessionKey, selectedHeaderTags]);

    React.useEffect(() => {
        if (
            focusedSearchHeaderControlsAnchorKey !== null
            || searchQuery.trim().length > 0
            || selectedHeaderTags.length > 0
        ) {
            return;
        }
        setActiveSearchHeaderControlsAnchorKey(null);
    }, [focusedSearchHeaderControlsAnchorKey, searchQuery, selectedHeaderTags.length]);

    const clearSearchFocusTransferTimeout = React.useCallback(() => {
        if (searchFocusTransferTimeoutRef.current === null) return;
        clearTimeout(searchFocusTransferTimeoutRef.current);
        searchFocusTransferTimeoutRef.current = null;
    }, []);

    React.useEffect(() => () => {
        clearSearchFocusTransferTimeout();
    }, [clearSearchFocusTransferTimeout]);

    const handleHeaderSearchFocusChange = React.useCallback((anchorKey: string, focused: boolean) => {
        clearSearchFocusTransferTimeout();
        if (focused) {
            setActiveSearchHeaderControlsAnchorKey(anchorKey);
            setFocusedSearchHeaderControlsAnchorKey(anchorKey);
            return;
        }

        searchFocusTransferTimeoutRef.current = setTimeout(() => {
            searchFocusTransferTimeoutRef.current = null;
            setFocusedSearchHeaderControlsAnchorKey((current) => current === anchorKey ? null : current);
        }, SEARCH_FOCUS_TRANSFER_SETTLE_MS);
    }, [clearSearchFocusTransferTimeout]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside nested scroll views.
        // Stopping propagation here keeps the event within the sessions list subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, []);

    const {
        focusedFolderId,
        folderBreadcrumbs,
        focusFolder: handleFocusSessionFolder,
        clearFolderFocus: handleClearSessionFolderFocus,
        focusBreadcrumbFolder: handleSelectSessionFolderBreadcrumb,
        folderBreadcrumbRootTitle,
        folderMoveTargets,
        listItems,
        selectionScopeListItems,
        sessionListIndexRef,
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
        sessionMruOrderV1,
        setSessionMruOrderV1,
        currentGroupOrderMap,
        setSessionListGroupOrderV1,
        currentWorkspaceOrderMap,
        setSessionWorkspaceOrderV1,
        sessionFolderViewMode,
        setSessionFolderViewModeV1,
        sessionListOrderingMode,
        setSessionListOrderingModeV1,
        sessionListSavedFolderSortMode,
        sessionListFolderSortMode,
        setSessionListFolderSortModeV1,
        sessionFoldersV1,
        setSessionFoldersV1,
        sessionTagsV1,
        setSessionTagsV1,
        sessionTagsEnabled,
        hideInactiveSessions,
        setHideInactiveSessions,
        rememberLastProjectSessionSelections,
        workspaceLabelsV1,
        setWorkspaceLabelsV1,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
        collapsedGroupKeysV1,
        setCollapsedGroupKeysV1,
        compactSessionView,
        compactSessionViewMinimal,
        currentUserId,
        selection,
        showServerBadge,
        showPinnedServerBadge,
        folderActionsEnabled,
        folderViewEnabled,
        allKnownTags,
        hasMultipleMachines,
        reachableSessionDisplayByKey,
    } = useSessionListViewState({
        data,
        headerFilters,
        pathname,
        sessionListSurfaceDataActive: surfaceOwnership.dataActive,
        storageKind: props.storageKind,
    });
    const sessionListWorkingIndicatorStyle = useSetting('sessionListNarrowWorkingIndicatorStyle');
    const sessionListAgentActivityCountEnabled = useSetting('sessionListAgentActivityCountEnabled');
    const sessionListIdentityDisplay = useSetting('sessionListIdentityDisplay');
    const sessionListActiveColorMode = useSetting('sessionListActiveColorModeV1');
    const sessionListSectionModeRaw = useSetting('sessionListSectionModeV1');
    const sessionListSectionMode: SessionListOrderingSectionMode = sessionListSectionModeRaw === 'single'
        ? 'single'
        : 'activity';
    const hasAnySessionFolderInAccount = React.useMemo(
        () => normalizeSessionFolders(sessionFoldersV1).folders.length > 0,
        [sessionFoldersV1],
    );
    const showStructuralDragHandles = sessionFolderViewMode === 'tree' && hasAnySessionFolderInAccount;
    React.useEffect(() => {
        if (selectedHeaderTags.length === 0) return;
        const known = new Set(allKnownTags);
        const next = selectedHeaderTags.filter((tag) => known.has(tag));
        if (next.length === selectedHeaderTags.length) return;
        setSelectedHeaderTags(next);
    }, [allKnownTags, selectedHeaderTags]);

    const virtualizedListRef = React.useRef<{
        scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    } | null>(null);
    const listViewportRef = React.useRef<View>(null);
    const nativeListScrollInteractionActiveRef = React.useRef(false);
    const scrollToTreeOffset = React.useCallback((offsetY: number) => {
        virtualizedListRef.current?.scrollToOffset?.({ offset: offsetY, animated: false });
    }, []);
    const scrollToRetainedOffset = React.useCallback((params: { offset: number; animated?: boolean }) => {
        virtualizedListRef.current?.scrollToOffset?.(params);
    }, []);
    const scrollRetention = useSessionListScrollRetention({
        retentionKey,
        scrollToOffset: scrollToRetainedOffset,
    });

    // Latest visible render items, kept in a ref so the drag snapshot can be
    // built once at drag start without re-subscribing the drag hook.
    const listItemsRef = React.useRef<ReadonlyArray<SessionListViewItem>>(EMPTY_SESSION_LIST_VIEW_ITEMS);
    listItemsRef.current = listItems as ReadonlyArray<SessionListViewItem>;

    const {
        activeDragSnapshot,
        applyKeyboardMove,
        applyMoveSheetTarget,
        draggingSessionKey,
        dropOverlayShared,
        handleDragCancel,
        handleDragStart,
        handleFolderHeaderTreeDropResult,
        handleTreeContentSizeChange,
        handleTreeDropResult,
        handleTreeListLayout,
        handleTreeScroll,
        handleTreeViewportMeasure,
        nativeContextMenuSessionKey,
        registerTreeRowBounds,
        resolveMoveSheetTargets,
        resolveDropResult,
        scheduleSessionFolderAssignment,
        setNativeContextMenuSessionKey,
        unregisterTreeRowBounds,
    } = useSessionListRowInteractions({
        folderActionsEnabled,
        folderSortMode: sessionListFolderSortMode,
        sessionListOrderingModeV1: sessionListOrderingMode,
        sessionListSectionModeV1: sessionListSectionMode,
        sessionFoldersV1,
        sessionListGroupOrderV1: currentGroupOrderMap,
        sessionWorkspaceOrderV1: currentWorkspaceOrderMap,
        sessionListIndexRef,
        listItemsRef,
        setSessionFoldersV1,
        setSessionListGroupOrderV1,
        setSessionWorkspaceOrderV1,
        scrollToOffset: scrollToTreeOffset,
    });

    const rowPinnedActionStateRef = React.useRef({
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
    });
    rowPinnedActionStateRef.current = {
        pinnedKeyList,
        pinnedKeySet,
        setPinnedSessionKeysV1,
    };
    const rowTogglePinnedHandlerByKeyRef = React.useRef(new Map<string, () => void>());
    const getRowTogglePinnedHandler = React.useCallback((sessionKey: string): (() => void) => {
        const cached = rowTogglePinnedHandlerByKeyRef.current.get(sessionKey);
        if (cached) return cached;

        const handler = () => {
            const {
                pinnedKeyList: currentPinnedKeyList,
                pinnedKeySet: currentPinnedKeySet,
                setPinnedSessionKeysV1: setCurrentPinnedSessionKeysV1,
            } = rowPinnedActionStateRef.current;
            if (currentPinnedKeySet.has(sessionKey)) {
                setCurrentPinnedSessionKeysV1(currentPinnedKeyList.filter((k) => k !== sessionKey));
            } else {
                setCurrentPinnedSessionKeysV1([...currentPinnedKeyList, sessionKey]);
            }
        };
        rowTogglePinnedHandlerByKeyRef.current.set(sessionKey, handler);
        return handler;
    }, []);

    const rowTagsActionStateRef = React.useRef({
        sessionTagsV1,
        setSessionTagsV1,
    });
    rowTagsActionStateRef.current = {
        sessionTagsV1,
        setSessionTagsV1,
    };
    const rowSetTagsHandlerByKeyRef = React.useRef(new Map<string, (newTags: string[]) => void>());
    const getRowSetTagsHandler = React.useCallback((sessionKey: string): ((newTags: string[]) => void) => {
        const cached = rowSetTagsHandlerByKeyRef.current.get(sessionKey);
        if (cached) return cached;

        const handler = (newTags: string[]) => {
            const {
                sessionTagsV1: currentSessionTagsV1,
                setSessionTagsV1: setCurrentSessionTagsV1,
            } = rowTagsActionStateRef.current;
            const nextTags = { ...currentSessionTagsV1 };
            if (newTags.length === 0) {
                delete nextTags[sessionKey];
            } else {
                nextTags[sessionKey] = newTags;
            }
            setCurrentSessionTagsV1(nextTags);
        };
        rowSetTagsHandlerByKeyRef.current.set(sessionKey, handler);
        return handler;
    }, []);

    const rowNativeContextMenuStateRef = React.useRef({
        setNativeContextMenuSessionKey,
    });
    rowNativeContextMenuStateRef.current = {
        setNativeContextMenuSessionKey,
    };
    const rowNativeContextMenuOpenChangeHandlerByKeyRef = React.useRef(new Map<string, (next: boolean) => void>());
    const getRowNativeContextMenuOpenChangeHandler = React.useCallback((sessionKey: string): ((next: boolean) => void) => {
        const cached = rowNativeContextMenuOpenChangeHandlerByKeyRef.current.get(sessionKey);
        if (cached) return cached;

        const handler = (next: boolean) => {
            if (next && nativeListScrollInteractionActiveRef.current) return;
            rowNativeContextMenuStateRef.current.setNativeContextMenuSessionKey((prev) => {
                if (next) return sessionKey;
                return prev === sessionKey ? null : prev;
            });
        };
        rowNativeContextMenuOpenChangeHandlerByKeyRef.current.set(sessionKey, handler);
        return handler;
    }, []);

    // Freeze the visible surface for the duration of a pointer drag: the
    // snapshot's frozen order is rendered, so a background reorder does not move
    // the rows under the pointer. After drop/cancel the latest live list renders.
    const frozenListProjection = useFrozenSessionListItemsDuringDrag({
        activeSnapshot: activeDragSnapshot,
        liveViewItems: listItems as ReadonlyArray<SessionListViewItem>,
    });
    const renderedListItems = frozenListProjection.viewItems;
    const rowStoreScopesRaw = React.useMemo(() => renderedListItems
        .filter((item): item is SessionListSessionItem => item.type === 'session')
        .map((item) => ({
            sessionId: item.session.id,
            serverId: item.serverId ?? null,
        })), [renderedListItems]);
    const rowStoreScopes = useStableSessionListRowStoreSubscriptionScopes(rowStoreScopesRaw);
    const rowStoreSubscriptionMode = React.useMemo(() => resolveSessionListRowStoreSubscriptionMode({
        nativeAllRenderedMaxRows: NATIVE_LIST_ALL_RENDERED_ROW_STORE_MAX_ITEMS,
        platformOS: Platform.OS,
        renderedSessionRows: rowStoreScopes.length,
        webNonVirtualizedMaxRows: WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS,
    }), [rowStoreScopes.length]);
    const visibleDataPrioritySessionRowKeys = React.useMemo(
        () => buildSessionListEmbeddedPriorityRowKeys(renderedListItems),
        [renderedListItems],
    );
    const runtimePriorityRowStoreScopeSelector = React.useMemo(
        () => createSessionListRuntimePriorityRowScopeSelector(
            rowStoreSubscriptionMode === 'viewable'
                ? rowStoreScopes
                : EMPTY_SESSION_LIST_ROW_STORE_SCOPES,
            selection.activeServerId,
        ),
        [rowStoreScopes, rowStoreSubscriptionMode, selection.activeServerId],
    );
    const runtimePriorityRowStoreScopes = storage(runtimePriorityRowStoreScopeSelector);
    const runtimePrioritySessionRowKeys = React.useMemo(
        () => buildSessionRowStoreKeySetFromScopes(runtimePriorityRowStoreScopes),
        [runtimePriorityRowStoreScopes],
    );
    const prioritySessionRowKeysRaw = React.useMemo(
        () => mergeSessionRowStoreKeySets(
            visibleDataPrioritySessionRowKeys,
            runtimePrioritySessionRowKeys,
        ),
        [runtimePrioritySessionRowKeys, visibleDataPrioritySessionRowKeys],
    );
    const prioritySessionRowKeys = useStableSessionListRowStoreKeySet(prioritySessionRowKeysRaw);
    const prioritySessionRowReasonCounts = React.useMemo(
        () => buildPrioritySessionRowReasonCounts(renderedListItems),
        [renderedListItems],
    );
    const [viewableSessionRowKeys, setViewableSessionRowKeys] = React.useState<ReadonlySet<string> | null>(null);
    const viewabilityConfigRef = React.useRef({ itemVisiblePercentThreshold: 1 });
    const handleViewableItemsChangedRef = React.useRef((info: { viewableItems: ViewToken[] }) => {
        const nextKeys = new Set<string>();
        for (const token of info.viewableItems) {
            if (token.isViewable === false) continue;
            const item = token.item as SessionListViewItem | undefined;
            if (!item || item.type !== 'session') continue;
            nextKeys.add(resolveSessionListRowStoreScopeKey({
                sessionId: item.session.id,
                serverId: item.serverId ?? null,
            }));
        }
        setViewableSessionRowKeys((current) => {
            if (stringSetsEqual(current, nextKeys)) return current;
            if (syncPerformanceTelemetry.isEnabled()) {
                syncPerformanceTelemetry.count('ui.sessionsList.viewableRows.changed', {
                    changed: 1,
                    nextVisibleRows: nextKeys.size,
                    previousKnown: current === null ? 0 : 1,
                    previousVisibleRows: current?.size ?? 0,
                });
            }
            return nextKeys;
        });
    });
    const viewableRowStoreScopes = React.useMemo(
        () => resolveSessionListRowStoreSubscriptionScopes(
            rowStoreScopes,
            viewableSessionRowKeys,
            rowStoreSubscriptionMode,
            prioritySessionRowKeys,
        ),
        [prioritySessionRowKeys, rowStoreScopes, rowStoreSubscriptionMode, viewableSessionRowKeys],
    );
    const rowStoreSubscriptionScopes = surfaceOwnership.dataActive
        ? viewableRowStoreScopes
        : EMPTY_SESSION_LIST_ROW_STORE_SCOPES;
    const rowStoreSubscriptionKeys = React.useMemo(
        () => buildSessionRowStoreKeySetFromScopes(rowStoreSubscriptionScopes),
        [rowStoreSubscriptionScopes],
    );
    React.useEffect(() => {
        if (!syncPerformanceTelemetry.isEnabled()) return;
        syncPerformanceTelemetry.count('ui.sessionsList.rowStoreSubscriptions', buildSessionListRowStoreSubscriptionTelemetryFields({
            dataActive: surfaceOwnership.dataActive,
            mode: rowStoreSubscriptionMode,
            priorityReasonCounts: prioritySessionRowReasonCounts,
            priorityRowKeys: prioritySessionRowKeys,
            subscribedScopes: rowStoreSubscriptionScopes,
            totalScopes: rowStoreScopes,
            visibleRowKeys: viewableSessionRowKeys,
        }));
    }, [
        prioritySessionRowKeys,
        prioritySessionRowReasonCounts,
        rowStoreScopes,
        rowStoreSubscriptionMode,
        rowStoreSubscriptionScopes,
        surfaceOwnership.dataActive,
        viewableSessionRowKeys,
    ]);
    const reachableSessionDisplayByKeyRecord = React.useMemo(
        () => buildReachableDisplayRecord(reachableSessionDisplayByKey),
        [reachableSessionDisplayByKey],
    );
    const rowPresentationSettings = React.useMemo<SessionListRowPresentationSettings>(() => {
        const compact = Boolean(compactSessionView);
        const compactMinimal = Boolean(compactSessionView && compactSessionViewMinimal);
        return {
            currentUserId,
            density: normalizeRowDensity(compact, compactMinimal),
            compact,
            compactMinimal,
            identityDisplay: normalizeIdentityDisplay(sessionListIdentityDisplay),
            activeColorMode: normalizeActiveColorMode(sessionListActiveColorMode),
            workingIndicatorMode: normalizeWorkingIndicatorMode(sessionListWorkingIndicatorStyle),
            workingTextMode: 'static',
            statusColors: theme.colors.status,
            hideInactiveSessions,
            showServerBadge,
            showPinnedServerBadge,
            agentActivityCountEnabled: sessionListAgentActivityCountEnabled === true,
            tagsEnabled: sessionTagsEnabled === true,
            sessionTagsByKey: sessionTagsV1 ?? EMPTY_SESSION_TAGS_BY_KEY,
            allKnownTags,
            pinnedSessionKeys: pinnedKeyList,
            hasMultipleMachines,
            reachableSessionDisplayByKey: reachableSessionDisplayByKeyRecord,
            folderViewEnabled,
            // Placeholders: SessionListRowModelBoundary overlays the live
            // shared-clock values per row. Keeping them out of this memo's
            // identity avoids re-creating the settings object on every tick.
            relativeNowMs: 0,
            runtimeNowMs: 0,
        };
    }, [
        allKnownTags,
        compactSessionView,
        compactSessionViewMinimal,
        currentUserId,
        folderViewEnabled,
        hasMultipleMachines,
        hideInactiveSessions,
        pinnedKeyList,
        reachableSessionDisplayByKeyRecord,
        sessionListAgentActivityCountEnabled,
        sessionListActiveColorMode,
        sessionListIdentityDisplay,
        sessionListWorkingIndicatorStyle,
        sessionTagsEnabled,
        sessionTagsV1,
        showPinnedServerBadge,
        showServerBadge,
        theme.colors.status,
    ]);
    const sessionListSelectionTargetsByKey = React.useMemo(() => {
        const targets = new Map<string, SessionBulkActionTarget>();
        for (const item of selectionScopeListItems ?? EMPTY_SESSION_LIST_VIEW_ITEMS) {
            if (item.type !== 'session') continue;
            const target = buildSessionBulkActionTargetFromSessionItem(
                item as SessionListSessionItem,
                rowPresentationSettings,
            );
            targets.set(target.key, target);
        }
        return targets;
    }, [rowPresentationSettings, selectionScopeListItems]);

    const handleVirtualizedListLayout = React.useCallback((event: LayoutChangeEvent) => {
        handleTreeListLayout(event);
        scrollRetention.handleLayout(event);
        handleTreeViewportMeasure(listViewportRef.current);
    }, [handleTreeListLayout, handleTreeViewportMeasure, scrollRetention]);
    const handleLoadMoreSessions = React.useCallback(() => {
        if (!surfaceDataActiveRef.current) return;
        fireAndForget(sync.fetchMoreSessions(), { tag: 'SessionsList.fetchMoreSessions' });
    }, []);
    const handleRefreshSessions = React.useCallback(async () => {
        if (!surfaceDataActiveRef.current) return;
        if (refreshingSessionsRef.current) return;
        refreshingSessionsRef.current = true;
        setRefreshingSessions(true);
        try {
            await runRefreshDiagnosticAction(
                { action: 'pull_to_refresh', screen: 'session_list' },
                () => sync.refreshSessions(),
            );
        } finally {
            refreshingSessionsRef.current = false;
            setRefreshingSessions(false);
        }
    }, []);
    const handleVirtualizedListScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (surfaceDataActiveRef.current) {
            sync.markSessionListScrollActivity();
        }
        scrollRetention.handleScroll(event);
        handleTreeScroll(event);
        if (Platform.OS !== 'web' && isSessionListScrollNearEnd(event)) {
            handleLoadMoreSessions();
        }
    }, [handleLoadMoreSessions, handleTreeScroll, scrollRetention]);
    const handleNativeListScrollInteractionStart = React.useCallback(() => {
        if (Platform.OS !== 'ios') return;
        nativeListScrollInteractionActiveRef.current = true;
        setNativeContextMenuSessionKey(null);
    }, [setNativeContextMenuSessionKey]);
    const handleNativeListScrollInteractionEnd = React.useCallback(() => {
        if (Platform.OS !== 'ios') return;
        nativeListScrollInteractionActiveRef.current = false;
    }, []);

    const handleRenameWorkspace = React.useCallback(async (workspaceKey: string, currentLabel: string) => {
        const newName = await Modal.prompt(
            t('sessionsList.renameWorkspacePromptTitle'),
            undefined,
            {
                defaultValue: currentLabel,
                placeholder: t('sessionsList.renameWorkspacePromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (newName !== null && newName.trim()) {
            setWorkspaceLabelsV1({ ...workspaceLabelsV1, [workspaceKey]: newName.trim() });
        }
    }, [workspaceLabelsV1, setWorkspaceLabelsV1]);

    const handleResetWorkspaceName = React.useCallback((workspaceKey: string) => {
        const next = { ...workspaceLabelsV1 };
        delete next[workspaceKey];
        setWorkspaceLabelsV1(next);
    }, [workspaceLabelsV1, setWorkspaceLabelsV1]);

    const handleCreateSessionFromProject = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>) => {
        const workspaceScopeHint = item.workspaceScopeHint ?? null;
        if (!workspaceScopeHint) {
            return;
        }
        const seedSessionId = typeof item.seedSessionId === 'string' ? item.seedSessionId.trim() : '';
        const seedSession = seedSessionId
            ? ((storage.getState() as any)?.sessions?.[seedSessionId] as Session | undefined)
            : undefined;
        const seedMachineTarget = seedSessionId
            ? readMachineControlTargetForSession(seedSessionId)
            : null;
        const directory = seedMachineTarget?.machineId === workspaceScopeHint.machineId
            ? seedMachineTarget.basePath
            : workspaceScopeHint.rootPath;
        if (rememberLastProjectSessionSelections && seedSession) {
            const dataId = storeTempData(buildNewSessionTempDataFromSessionConfiguration({
                session: seedSession,
                machineId: workspaceScopeHint.machineId,
                directoryOverride: directory,
            }));
            router.push({
                pathname: '/new',
                params: {
                    dataId,
                    machineId: workspaceScopeHint.machineId,
                    directory,
                    ...(workspaceScopeHint.serverId ? { spawnServerId: workspaceScopeHint.serverId } : {}),
                },
            } as any);
            return;
        }
        router.push({
            pathname: '/new',
            params: {
                machineId: workspaceScopeHint.machineId,
                directory,
                ...(workspaceScopeHint.serverId ? { spawnServerId: workspaceScopeHint.serverId } : {}),
            },
        } as any);
    }, [rememberLastProjectSessionSelections, router]);

    const handleCreateSessionFromFolder = React.useCallback((folder: { workspace?: unknown }) => {
        const workspace = folder.workspace;
        if (!workspace || typeof workspace !== 'object' || (workspace as { t?: unknown }).t !== 'workspaceScope') {
            return;
        }
        const scope = workspace as { serverId?: string | null; machineId: string; rootPath: string };
        router.push({
            pathname: '/new',
            params: {
                machineId: scope.machineId,
                directory: scope.rootPath,
                ...(scope.serverId ? { spawnServerId: scope.serverId } : {}),
            },
        } as any);
    }, [router]);

    const handleAddFolderToProject = React.useCallback(async (item: Extract<SessionListViewItem, { type: 'header' }>) => {
        if (!folderActionsEnabled) return;
        const workspace = resolveDurableWorkspaceRefForSessionListHeader(item);
        if (!workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addFolderPromptTitle'),
            undefined,
            {
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.add'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const created = createSessionFolder({
            current: sessionFoldersV1,
            workspace,
            renderWorkspaceKey: typeof item.workspaceKey === 'string' ? item.workspaceKey : undefined,
            parentId: null,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleAddSessionSubfolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder?.workspace) return;
        const name = await Modal.prompt(
            t('sessionsList.addSubfolderPromptTitle'),
            undefined,
            {
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.add'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const created = createSessionFolder({
            current: sessionFoldersV1,
            workspace: folder.workspace,
            renderWorkspaceKey: folder.renderWorkspaceKey,
            parentId: folder.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(created.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleRenameSessionFolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder) return;
        const name = await Modal.prompt(
            t('sessionsList.renameFolderPromptTitle'),
            undefined,
            {
                defaultValue: folder.title,
                placeholder: t('sessionsList.folderNamePlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (name === null) return;
        const renamed = renameSessionFolder({
            current: sessionFoldersV1,
            folderId: folder.folderId,
            name,
            now: Date.now(),
        });
        setSessionFoldersV1(renamed.next);
    }, [folderActionsEnabled, sessionFoldersV1, setSessionFoldersV1]);

    const handleDeleteSessionFolder = React.useCallback(async (folder: ReturnType<typeof asSessionFolderHeaderItem>) => {
        if (!folderActionsEnabled || !folder) return;
        const confirmed = await Modal.confirm(
            t('sessionsList.deleteFolderPromptTitle'),
            t('sessionsList.deleteFolderPromptDescription'),
            {
                confirmText: t('common.delete'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        const deleted = deleteSessionFolder({
            current: sessionFoldersV1,
            folderId: folder.folderId,
        });
        if (deleted.deletedFolderIds.length === 0) return;
        const serverId = typeof folder.serverId === 'string' ? folder.serverId.trim() : '';
        const serverProfile = serverId ? getServerProfileById(serverId) : null;
        if (!serverProfile) return;
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
        if (!credentials) return;
        setSessionFoldersV1(deleted.next);
        if (focusedFolderId && deleted.deletedFolderIds.includes(focusedFolderId)) {
            handleClearSessionFolderFocus();
        }
    }, [focusedFolderId, folderActionsEnabled, handleClearSessionFolderFocus, sessionFoldersV1, setSessionFoldersV1]);

    const handleToggleCollapse = React.useCallback((collapseKey: string) => {
        const current = collapsedGroupKeysV1 ?? {};
        if (current[collapseKey]) {
            setCollapsedGroupKeysV1({ ...current, [collapseKey]: false });
        } else {
            setCollapsedGroupKeysV1({ ...current, [collapseKey]: true });
        }
    }, [collapsedGroupKeysV1, setCollapsedGroupKeysV1]);

    const folderMoveTargetsSignature = React.useMemo(
        () => buildFolderMoveTargetSignature(folderMoveTargets),
        [folderMoveTargets],
    );
    const folderMoveMenuItems = React.useMemo((): DropdownMenuItem[] => {
        return folderMoveTargets.map((target) => {
            const paddingLeft = target.folderId == null
                ? undefined
                : resolveSessionFolderMoveMenuRowPaddingLeft(target.depth);
            return {
                id: `move-to-folder:${target.folderId ?? 'null'}`,
                title: target.folderId == null ? t('sessionsList.moveToWorkspaceRoot') : target.title,
                icon: <Icon name={target.folderId == null ? 'arrow-elbow-up-left' : 'folder'} size={16} color={theme.colors.text.secondary} />,
                rowContainerStyle: paddingLeft == null ? undefined : { paddingLeft },
                disabled: !folderActionsEnabled,
            };
        });
    }, [folderActionsEnabled, folderMoveTargetsSignature, theme.colors.text.secondary]);

    const rowLabelByTreeRowId = React.useMemo(() => {
        const labels = new Map<string, string>();
        for (const item of listItems) {
            if (item.type === 'session') {
                const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                if (!serverId) continue;
                labels.set(treeRowId.session(serverId, item.session.id), item.session.id);
                continue;
            }
            if (item.headerKind === 'folder' && item.folderId) {
                labels.set(treeRowId.folder(item.folderId), item.title);
            } else if (item.headerKind === 'project' && item.groupKey) {
                labels.set(treeRowId.workspaceRoot(item.groupKey), item.title);
            }
        }
        return labels;
    }, [listItems]);
    const rowLabelByTreeRowIdRef = React.useRef(rowLabelByTreeRowId);
    rowLabelByTreeRowIdRef.current = rowLabelByTreeRowId;

    const resolveDropDestinationLabel = React.useCallback((target: SessionListMoveSheetTarget) => {
        if (target.kind === 'root') return t('sessionsList.moveToWorkspaceRoot');
        return target.label;
    }, []);

    const applyMoveTargetWithAnnouncement = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        target: SessionListMoveSheetTarget,
    ) => {
        applyMoveSheetTarget(sourceRowId, target);
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropDestinationLabel(target),
            result: target.result,
        });
    }, [applyMoveSheetTarget, resolveDropDestinationLabel, sessionListA11y]);

    const openMoveSheetForTreeRow = React.useCallback(async (sourceRowId: string, sourceLabel: string) => {
        const targets = resolveMoveSheetTargets(sourceRowId);
        if (targets.length === 0) return;
        const selectedTarget = await openMoveSheet({
            sourceLabel,
            targets,
        });
        if (!selectedTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, selectedTarget);
    }, [applyMoveTargetWithAnnouncement, openMoveSheet, resolveMoveSheetTargets]);

    const sessionListBulkActionContext = React.useMemo<SessionBulkActionExecutionContext>(() => {
        const resolveMutationContext = async (target: SessionBulkActionTarget, actionName: string) => {
            const serverId = typeof target.serverId === 'string' ? target.serverId.trim() : '';
            if (!serverId) {
                throw new Error(`${actionName} requires a server id`);
            }
            const serverProfile = getServerProfileById(serverId);
            if (!serverProfile) {
                throw new Error(`${actionName} requires an available server profile`);
            }
            const credentials = await TokenStorage.getCredentialsForServerUrl(serverProfile.serverUrl, { serverId: serverProfile.id });
            if (!credentials) {
                throw new Error(`${actionName} requires server credentials`);
            }
            return { credentials, serverId: serverProfile.id, serverUrl: serverProfile.serverUrl };
        };

        return {
            hideInactiveSessions,
            foldersFeatureDecision: { state: folderActionsEnabled ? 'enabled' : 'disabled' },
            stopErrorMessage: t('sessionInfo.failedToStopSession'),
            archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
            stopSession: async (target) => await sessionStopWithServerScope(target.sessionId, { serverId: target.serverId ?? null }),
            archiveSession: async (target) => {
                const result = await sessionArchiveWithServerScope(target.sessionId, { serverId: target.serverId ?? null });
                if (result.success) {
                    clearSessionVisibleWhenInactive(target.sessionId);
                }
                return result;
            },
            unarchiveSession: async (target) => await sessionUnarchiveWithServerScope(target.sessionId, { serverId: target.serverId ?? null }),
            setManualReadState: async (target, readState) => await sessionSetManualReadStateWithServerScope(
                target.sessionId,
                readState,
                { serverId: target.serverId ?? null },
            ),
            stopSessionAndMaybeArchive: async (params) => {
                await stopSessionAndMaybeArchive({
                    sessionId: params.sessionId,
                    hideInactiveSessions: params.hideInactiveSessions,
                    isPinned: params.isPinned,
                    archiveAfterStop: params.archiveAfterStop,
                    stopSession: params.stopSession,
                    archiveSession: params.archiveSession,
                    stopErrorMessage: params.stopErrorMessage,
                    archiveErrorMessage: params.archiveErrorMessage,
                });
            },
            setSessionPin: async ({ target, pinned }) => {
                const mutation = await resolveMutationContext(target, 'Session pin mutation');
                await setSessionPin({
                    ...mutation,
                    sessionId: target.sessionId,
                    pinned,
                });
            },
            setSessionTagAssignments: async ({ target, tags }) => {
                const mutation = await resolveMutationContext(target, 'Session tag assignment');
                await setSessionTagLabels({
                    ...mutation,
                    sessionId: target.sessionId,
                    tags: [...tags],
                });
            },
            setSessionFolderAssignment: async ({ target, folderId }) => {
                const mutation = await resolveMutationContext(target, 'Session folder assignment');
                await setSessionFolderAssignment({
                    ...mutation,
                    sessionId: target.sessionId,
                    folderId,
                });
            },
        };
    }, [
        folderActionsEnabled,
        hideInactiveSessions,
    ]);

    const handleRequestBulkMoveToFolder = React.useCallback(async (targets: readonly SessionBulkActionTarget[]) => {
        if (!folderActionsEnabled) return null;
        if (targets.length === 0) return null;
        const folderIdByTargetId = new Map<string, string | null>();
        const moveTargets = folderMoveTargets.map((target): SessionListMoveSheetTarget => {
            const id = `bulk-move-folder:${target.folderId ?? 'root'}`;
            folderIdByTargetId.set(id, target.folderId ?? null);
            return {
                id,
                kind: target.folderId == null ? 'root' : 'folder',
                label: target.folderId == null ? t('sessionsList.moveToWorkspaceRoot') : target.title,
                disabled: false,
                result: SESSION_LIST_IDLE_MOVE_RESULT,
            };
        });
        if (moveTargets.length === 0) return null;
        const selectedTarget = await openMoveSheet({
            sourceLabel: t('sessionsList.selectionMoveSheetSourceLabel', { count: targets.length }),
            targets: moveTargets,
        });
        if (!selectedTarget || selectedTarget.disabled) return null;
        if (!folderIdByTargetId.has(selectedTarget.id)) return null;
        return {
            folderId: folderIdByTargetId.get(selectedTarget.id) ?? null,
        };
    }, [folderActionsEnabled, folderMoveTargetsSignature, folderMoveTargets, openMoveSheet]);

    const moveTreeRowToWorkspaceRoot = React.useCallback((sourceRowId: string, sourceLabel: string) => {
        const rootTarget = resolveMoveSheetTargets(sourceRowId).find((target) =>
            target.kind === 'root' && !target.disabled
        );
        if (!rootTarget) return;
        applyMoveTargetWithAnnouncement(sourceRowId, sourceLabel, rootTarget);
    }, [applyMoveTargetWithAnnouncement, resolveMoveSheetTargets]);

    const resolveDragLabel = React.useCallback((dragKey: string) => {
        const rowId = dragKey.startsWith('folder:')
            ? dragKey
            : resolveSessionTreeRowId(dragKey);
        return rowId ? rowLabelByTreeRowIdRef.current.get(rowId) ?? dragKey : dragKey;
    }, []);

    const resolveDropResultDestinationLabel = React.useCallback((
        result: Parameters<typeof sessionListA11y.announceDropResult>[0]['result'],
    ) => {
        const instruction = result.instruction;
        if (instruction.kind === 'move-to-root') return t('sessionsList.moveToWorkspaceRoot');
        if (instruction.kind === 'nest-into') return rowLabelByTreeRowIdRef.current.get(instruction.targetId) ?? null;
        if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
            return rowLabelByTreeRowIdRef.current.get(instruction.targetId) ?? null;
        }
        return null;
    }, []);

    const moveTreeRowByKeyboard = React.useCallback((
        sourceRowId: string,
        sourceLabel: string,
        direction: 'up' | 'down',
    ) => {
        const result = applyKeyboardMove(sourceRowId, direction);
        if (!result) return;
        sessionListA11y.announceDropResult({
            label: sourceLabel,
            destinationLabel: resolveDropResultDestinationLabel(result),
            result,
        });
    }, [applyKeyboardMove, resolveDropResultDestinationLabel, sessionListA11y]);

    const handleDragStartRef = React.useRef(handleDragStart);
    handleDragStartRef.current = handleDragStart;
    const handleDragCancelRef = React.useRef(handleDragCancel);
    handleDragCancelRef.current = handleDragCancel;
    const resolveDropResultRef = React.useRef(resolveDropResult);
    resolveDropResultRef.current = resolveDropResult;
    const handleTreeDropResultRef = React.useRef(handleTreeDropResult);
    handleTreeDropResultRef.current = handleTreeDropResult;
    const handleFolderHeaderTreeDropResultRef = React.useRef(handleFolderHeaderTreeDropResult);
    handleFolderHeaderTreeDropResultRef.current = handleFolderHeaderTreeDropResult;
    const sessionListA11yRef = React.useRef(sessionListA11y);
    sessionListA11yRef.current = sessionListA11y;

    const handleA11yDragStart = React.useCallback((dragKey: string) => {
        handleDragStartRef.current(dragKey);
        sessionListA11yRef.current.announcePickedUp({ label: resolveDragLabel(dragKey) });
    }, [resolveDragLabel]);

    const handleA11yTreeDropResult = React.useCallback((event: Parameters<typeof handleTreeDropResult>[0]) => {
        handleTreeDropResultRef.current(event);
        sessionListA11yRef.current.announceDropResult({
            label: resolveDragLabel(event.sessionKey),
            destinationLabel: resolveDropResultDestinationLabel(event.result),
            result: event.result,
        });
    }, [resolveDragLabel, resolveDropResultDestinationLabel]);

    const handleA11yFolderHeaderTreeDropResult = React.useCallback((event: Parameters<typeof handleFolderHeaderTreeDropResult>[0]) => {
        handleFolderHeaderTreeDropResultRef.current(event);
        sessionListA11yRef.current.announceDropResult({
            label: resolveDragLabel(event.sessionKey),
            destinationLabel: resolveDropResultDestinationLabel(event.result),
            result: event.result,
        });
    }, [resolveDragLabel, resolveDropResultDestinationLabel]);

    const handleStableDragCancel = React.useCallback((event: Parameters<typeof handleDragCancel>[0]) => {
        handleDragCancelRef.current(event);
    }, []);

    const resolveStableDropResult = React.useCallback((event: Parameters<typeof resolveDropResult>[0]): ReturnType<typeof resolveDropResult> => {
        return resolveDropResultRef.current(event);
    }, []);

    const handleSessionFolderMoveMenuItem = React.useCallback((
        item: Extract<SessionListViewItem, { type: 'session' }>,
        itemId: string,
    ) => {
        const prefix = 'move-to-folder:';
        if (!itemId.startsWith(prefix)) return;
        const folderId = itemId.slice(prefix.length);
        scheduleSessionFolderAssignment(item, folderId === 'null' ? null : folderId);
    }, [scheduleSessionFolderAssignment]);
    const getRowMoveActionHandlers = useSessionListRowMoveActionHandlers({
        openMoveSheetForTreeRow,
        moveTreeRowToWorkspaceRoot,
        moveTreeRowByKeyboard,
        handleSessionFolderMoveMenuItem,
    });
    const visibleSessionNavigationEntries = React.useMemo(
        () => buildVisibleSessionNavigationEntries(listItems),
        [listItems],
    );
    const selectionScopeSessionNavigationEntries = React.useMemo(
        () => buildVisibleSessionNavigationEntries(selectionScopeListItems ?? EMPTY_SESSION_LIST_VIEW_ITEMS),
        [selectionScopeListItems],
    );
    const knownSessionKeys = React.useMemo(
        () => visibleSessionNavigationEntries.map((entry) => entry.sessionKey),
        [visibleSessionNavigationEntries],
    );
    const cursorSessionKeyRef = React.useRef<string | null>(null);
    const mruCursorSessionKeyRef = React.useRef<string | null>(null);
    const sessionListKeyboardFocusedRef = React.useRef(false);
    const [sessionListKeyboardFocused, setSessionListKeyboardFocused] = React.useState(false);
    const activeSessionKey = React.useMemo(() => {
        const selectedEntries = listItems.filter((item): item is SessionListSessionItem =>
            item.type === 'session' && (item as SessionListSessionItem).selected === true
        );
        const selectedEntry = selectedEntries.find((item) => item.serverId === selection.activeServerId)
            ?? selectedEntries[0];
        if (selectedEntry?.type === 'session') {
            return findVisibleSessionNavigationEntryByScope(
                visibleSessionNavigationEntries,
                selectedEntry.session.id,
                selectedEntry.serverId,
            )?.sessionKey ?? null;
        }

        const activeSessionId = readSessionIdFromPathname(pathname);
        if (!activeSessionId) return null;
        return findVisibleSessionNavigationEntryByScope(
            visibleSessionNavigationEntries,
            activeSessionId,
            selection.activeServerId,
        )?.sessionKey ?? null;
    }, [listItems, pathname, selection.activeServerId, visibleSessionNavigationEntries]);
    const visibleSessionSelectionKeys = React.useMemo(
        () => readSessionListSelectionKeysFromVisibleEntries(visibleSessionNavigationEntries),
        [visibleSessionNavigationEntries],
    );
    const selectionScopeSelectionKeys = React.useMemo(
        () => readSessionListSelectionKeysFromVisibleEntries(selectionScopeSessionNavigationEntries),
        [selectionScopeSessionNavigationEntries],
    );
    const sessionListSelectionScopeKey = React.useMemo(
        () => buildSessionListSelectionScopeKey({
            storageKind: props.storageKind ?? 'all',
            activeServerId: selection.activeServerId ?? null,
            focusedFolderId,
            searchQuery,
            selectedTags: selectedHeaderTags,
            hideInactiveSessions,
        }),
        [
            focusedFolderId,
            hideInactiveSessions,
            props.storageKind,
            searchQuery,
            selectedHeaderTags,
            selection.activeServerId,
        ],
    );
    const sessionListSelectionStore = useSessionListSelectionController({
        scopeKey: sessionListSelectionScopeKey,
        visibleOrderedKeys: visibleSessionSelectionKeys,
        eligibleKeys: selectionScopeSelectionKeys,
        enabled: surfaceOwnership.interactive,
    });
    const sessionListSelectionSnapshot = React.useSyncExternalStore(
        sessionListSelectionStore.subscribe,
        sessionListSelectionStore.getSnapshot,
        sessionListSelectionStore.getSnapshot,
    );
    const previousSelectionCountRef = React.useRef(sessionListSelectionSnapshot.count);
    React.useEffect(() => {
        if (!sessionListSelectionSnapshot.isSelectionMode) {
            previousSelectionCountRef.current = sessionListSelectionSnapshot.count;
            return;
        }
        if (previousSelectionCountRef.current === sessionListSelectionSnapshot.count) return;
        previousSelectionCountRef.current = sessionListSelectionSnapshot.count;
        sessionListA11y.announceSelectionCount({ count: sessionListSelectionSnapshot.count });
    }, [
        sessionListA11y,
        sessionListSelectionSnapshot.count,
        sessionListSelectionSnapshot.isSelectionMode,
    ]);
    useEscapeLayer({
        enabled: sessionListSelectionSnapshot.isSelectionMode,
        priority: ESCAPE_LAYER_PRIORITIES.sessionListSelection,
        focusReturnRef: focusReturnFallbackRef,
        onEscape: () => {
            sessionListSelectionStore.exit();
            return true;
        },
    });
    React.useEffect(() => {
        if (!surfaceOwnership.dataActive) return;
        if (!activeSessionKey) return;
        mruCursorSessionKeyRef.current = null;
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : EMPTY_SESSION_KEYS;
        const nextOrder = moveSessionMruEntryToFront({
            order: currentOrder,
            activeSessionKey,
            knownSessionKeys,
        });
        if (stringArraysEqual(currentOrder, nextOrder)) return;
        setSessionMruOrderV1(nextOrder);
    }, [activeSessionKey, knownSessionKeys, sessionMruOrderV1, setSessionMruOrderV1, surfaceOwnership.dataActive]);
    const navigateToSessionTarget = React.useCallback((target: VisibleSessionNavigationEntry | null) => {
        if (!target) return;
        void navigateToSession(target.sessionId, target.serverId ? { serverId: target.serverId } : undefined);
    }, [navigateToSession]);
    const handleVisibleSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const target = resolveVisibleSessionNavigation({
            visibleEntries: visibleSessionNavigationEntries,
            activeSessionKey,
            cursorSessionKey: cursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        cursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, navigateToSessionTarget, visibleSessionNavigationEntries]);
    const handleMruSessionShortcut = React.useCallback((direction: 'previous' | 'next') => {
        const currentOrder = Array.isArray(sessionMruOrderV1) ? sessionMruOrderV1 : EMPTY_SESSION_KEYS;
        const order = moveSessionMruEntryToFront({
            order: currentOrder,
            activeSessionKey,
            knownSessionKeys,
        });
        const target = resolveSessionMruNavigation({
            order,
            activeSessionKey,
            cursorSessionKey: mruCursorSessionKeyRef.current,
            direction,
        });
        if (!target) return;
        mruCursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [activeSessionKey, knownSessionKeys, navigateToSessionTarget, sessionMruOrderV1]);
    const resolveSelectionKeyboardCurrentKey = React.useCallback(() => {
        const snapshot = sessionListSelectionStore.getSnapshot();
        return snapshot.focusedKey
            ?? snapshot.anchorKey
            ?? activeSessionKey
            ?? visibleSessionSelectionKeys[0]
            ?? null;
    }, [activeSessionKey, sessionListSelectionStore, visibleSessionSelectionKeys]);
    const handleSessionSelectionToggleFocused = React.useCallback(() => {
        const currentKey = resolveSelectionKeyboardCurrentKey();
        if (!currentKey) return;
        sessionListSelectionStore.toggle(currentKey);
    }, [resolveSelectionKeyboardCurrentKey, sessionListSelectionStore]);
    const handleSessionSelectionExtend = React.useCallback((direction: 'previous' | 'next') => {
        const snapshot = sessionListSelectionStore.getSnapshot();
        const currentKey = resolveSelectionKeyboardCurrentKey();
        if (!currentKey) return;
        const targetKey = resolveAdjacentSessionSelectionKey({
            visibleKeys: visibleSessionSelectionKeys,
            currentKey,
            direction,
        });
        if (!targetKey) return;
        if (snapshot.selectedKeys.size === 0 || snapshot.anchorKey == null) {
            sessionListSelectionStore.replaceWith(currentKey);
        }
        sessionListSelectionStore.selectRange(targetKey);
    }, [resolveSelectionKeyboardCurrentKey, sessionListSelectionStore, visibleSessionSelectionKeys]);
    useKeyboardShortcutHandlers(React.useMemo(() => {
        if (!surfaceOwnership.interactive) return {};
        return {
            'session.visible.previous': () => handleVisibleSessionShortcut('previous'),
            'session.visible.next': () => handleVisibleSessionShortcut('next'),
            'session.mru.previous': () => handleMruSessionShortcut('next'),
            'session.mru.next': () => handleMruSessionShortcut('previous'),
            ...(sessionListKeyboardFocused
                ? {
                    'sessions.selection.toggleFocused': handleSessionSelectionToggleFocused,
                    'sessions.selection.extendUp': () => handleSessionSelectionExtend('previous'),
                    'sessions.selection.extendDown': () => handleSessionSelectionExtend('next'),
                    'sessions.selection.selectAll': () => sessionListSelectionStore.selectAllVisible(),
                    'sessions.selection.clear': () => sessionListSelectionStore.exit(),
                }
                : {}),
            'sessions.row.moveToFolder': () => {
                const rowId = resolveSessionTreeRowId(activeSessionKey);
                if (!rowId) return;
                void openMoveSheetForTreeRow(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
            },
            'sessions.row.moveToWorkspaceRoot': () => {
                const rowId = resolveSessionTreeRowId(activeSessionKey);
                if (!rowId) return;
                moveTreeRowToWorkspaceRoot(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'));
            },
            'sessions.row.moveUp': () => {
                const rowId = resolveSessionTreeRowId(activeSessionKey);
                if (!rowId) return;
                moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'up');
            },
            'sessions.row.moveDown': () => {
                const rowId = resolveSessionTreeRowId(activeSessionKey);
                if (!rowId) return;
                moveTreeRowByKeyboard(rowId, rowLabelByTreeRowId.get(rowId) ?? t('sessionsList.sessionFallbackLabel'), 'down');
            },
        };
    }, [
        activeSessionKey,
        handleMruSessionShortcut,
        handleSessionSelectionExtend,
        handleSessionSelectionToggleFocused,
        handleVisibleSessionShortcut,
        moveTreeRowByKeyboard,
        moveTreeRowToWorkspaceRoot,
        openMoveSheetForTreeRow,
        rowLabelByTreeRowId,
        sessionListKeyboardFocused,
        sessionListSelectionStore,
        surfaceOwnership.interactive,
    ]));
    const handleSessionListKeyDown = React.useCallback((event: any) => {
        if (!surfaceOwnership.interactive) return;
        if (Platform.OS !== 'web') return;
        if (!sessionListKeyboardFocusedRef.current) return;
        if (event?.altKey !== true) return;

        const key = String(event?.key ?? '');
        const target = key === 'ArrowDown'
            ? resolveVisibleSessionNavigation({
                visibleEntries: visibleSessionNavigationEntries,
                activeSessionKey,
                cursorSessionKey: cursorSessionKeyRef.current,
                direction: 'next',
            })
            : key === 'ArrowUp'
                ? resolveVisibleSessionNavigation({
                    visibleEntries: visibleSessionNavigationEntries,
                    activeSessionKey,
                    cursorSessionKey: cursorSessionKeyRef.current,
                    direction: 'previous',
                })
                : key === 'Home'
                    ? resolveVisibleSessionEdgeNavigation({
                        visibleEntries: visibleSessionNavigationEntries,
                        edge: 'first',
                    })
                    : key === 'End'
                        ? resolveVisibleSessionEdgeNavigation({
                            visibleEntries: visibleSessionNavigationEntries,
                            edge: 'last',
                        })
                        : null;
        if (!target) return;

        event?.preventDefault?.();
        event?.stopPropagation?.();
        cursorSessionKeyRef.current = target.sessionKey;
        navigateToSessionTarget(target);
    }, [
        activeSessionKey,
        navigateToSessionTarget,
        surfaceOwnership.interactive,
        visibleSessionNavigationEntries,
    ]);

    const listItemKeyExtractor = React.useCallback((item: SessionListViewItem, index: number) => {
        if (item.type === 'header') {
            const gk = String(item.groupKey ?? '').trim();
            const kind = String(item.headerKind ?? '').trim();
            const sid = String(item.serverId ?? '').trim();
            if (gk) return `header:${gk}`;
            if (kind === 'server' && (sid || item.title)) return `server:${sid || item.title}`;
            return `header:${kind}:${sid}:${item.title}:${index}`;
        }
        const sid = String(item.serverId ?? '').trim();
        const id = String(item.session?.id ?? '').trim();
        if (sid && id) return `session:${sid}:${id}`;
        return `session:${index}`;
    }, []);

    const fallbackHeaderControlsAnchorKey = React.useMemo(() => {
        const anchor = listItems.find((item): item is Extract<SessionListViewItem, { type: 'header' }> =>
            item.type === 'header' && isSessionListPrimaryHeaderKind(item.headerKind)
        );
        return anchor ? getSessionListHeaderControlsAnchorKey(anchor) : null;
    }, [listItems]);
    const headerControlsAnchorKey = activeSearchHeaderControlsAnchorKey
        ?? (hasActiveSessionListHeaderFilters(headerFilters) ? fallbackHeaderControlsAnchorKey : null);

    const collapsedKeys = collapsedGroupKeysV1 ?? EMPTY_COLLAPSED_GROUP_KEYS;
    const searchTrailingAccessory = React.useMemo(() => (
        memorySearch.isSearchingMemory ? (
            <ActivitySpinner
                testID="session-list-memory-search-loading-indicator"
                size={14}
                color={theme.colors.text.secondary}
                accessibilityElementsHidden={true}
                importantForAccessibility="no-hide-descendants"
            />
        ) : null
    ), [memorySearch.isSearchingMemory, theme.colors.text.secondary]);
    const renderHeaderControls = React.useCallback((anchorKey: string) => {
        const menu = (
            <SessionListViewMenuButton
                folderViewMode={sessionFolderViewMode}
                onFolderViewModeChange={setSessionFolderViewModeV1}
                orderingMode={sessionListOrderingMode}
                onOrderingModeChange={setSessionListOrderingModeV1}
                folderSortMode={sessionListSavedFolderSortMode}
                onFolderSortModeChange={setSessionListFolderSortModeV1}
                hideInactiveSessions={hideInactiveSessions}
                onHideInactiveSessionsChange={setHideInactiveSessions}
                disabled={!folderActionsEnabled}
            />
        );
        return (
            <SessionListHeaderControls
                allKnownTags={sessionTagsEnabled === true ? allKnownTags : EMPTY_SESSION_KEYS}
                selectedTags={selectedHeaderTags}
                searchQuery={searchQuery}
                searchOpen={focusedSearchHeaderControlsAnchorKey === anchorKey}
                onSelectedTagsChange={setSelectedHeaderTags}
                onSearchQueryChange={setSearchQuery}
                onSearchFocusChange={(focused) => handleHeaderSearchFocusChange(anchorKey, focused)}
                searchTrailingAccessory={searchTrailingAccessory}
                viewMenu={menu}
            />
        );
    }, [
        allKnownTags,
        focusedSearchHeaderControlsAnchorKey,
        handleHeaderSearchFocusChange,
        selectedHeaderTags,
        searchQuery,
        searchTrailingAccessory,
        sessionTagsEnabled,
        folderActionsEnabled,
        hideInactiveSessions,
        sessionListOrderingMode,
        sessionListSavedFolderSortMode,
        sessionFolderViewMode,
        setSessionListOrderingModeV1,
        setSessionListFolderSortModeV1,
        setHideInactiveSessions,
        setSessionFolderViewModeV1,
        setActiveSearchHeaderControlsAnchorKey,
        setFocusedSearchHeaderControlsAnchorKey,
    ]);
    const renderHeaderItem = React.useCallback((item: Extract<SessionListViewItem, { type: 'header' }>, index: number) => {
        const headerTestId = item.headerKind === 'project'
            ? `session-list-project-header:${item.groupKey ?? item.title}`
            : `session-list-header:${item.groupKey ?? item.title}`;
        const folderHeader = folderViewEnabled ? asSessionFolderHeaderItem(item) : null;
        if (folderHeader) {
            const collapseKey = folderHeader.groupKey ?? `folder:${folderHeader.folderId}`;
            const treeRow = treeRowId.folder(folderHeader.folderId);
            const folderLabel = rowLabelByTreeRowId.get(treeRow) ?? folderHeader.title;
            return (
                <DraggableSessionFolderHeaderFrame
                    folderId={folderHeader.folderId}
                    groupKey={folderHeader.groupKey ?? collapseKey}
                    treeRowId={treeRow}
                    dataIndex={index}
                    overlayShared={dropOverlayShared}
                    onDragStart={handleA11yDragStart}
                    onDropResult={handleA11yFolderHeaderTreeDropResult}
                    onDragCancel={handleDragCancel}
                    resolveDropResult={resolveDropResult}
                    onRegisterTreeRowBounds={registerTreeRowBounds}
                    onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                >
                    <FolderGroupHeader
                        item={folderHeader}
                        collapsed={Boolean(collapsedKeys[collapseKey])}
                        onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                        onFocus={() => handleFocusSessionFolder(folderHeader)}
                        onNewSession={() => handleCreateSessionFromFolder(folderHeader)}
                        onAddSubfolder={() => handleAddSessionSubfolder(folderHeader)}
                        onRename={() => handleRenameSessionFolder(folderHeader)}
                        onDelete={() => handleDeleteSessionFolder(folderHeader)}
                        onMove={() => {
                            void openMoveSheetForTreeRow(treeRow, folderLabel);
                        }}
                        onMoveToWorkspaceRoot={() => moveTreeRowToWorkspaceRoot(treeRow, folderLabel)}
                        onMoveUp={() => moveTreeRowByKeyboard(treeRow, folderLabel, 'up')}
                        onMoveDown={() => moveTreeRowByKeyboard(treeRow, folderLabel, 'down')}
                        disabled={!folderActionsEnabled}
                    />
                </DraggableSessionFolderHeaderFrame>
            );
        }
        if (item.title && item.headerKind === 'project') {
            const collapseKey = item.groupKey ?? '';
            const treeRow = treeRowId.workspaceRoot(item.groupKey ?? item.title);
            return (
                <DraggableSessionFolderHeaderFrame
                    dragKey={treeRow}
                    groupKey={item.groupKey ?? collapseKey}
                    treeRowId={treeRow}
                    dataIndex={index}
                    overlayShared={dropOverlayShared}
                    onDragStart={handleA11yDragStart}
                    onDropResult={handleA11yFolderHeaderTreeDropResult}
                    onDragCancel={handleDragCancel}
                    resolveDropResult={resolveDropResult}
                    onRegisterTreeRowBounds={registerTreeRowBounds}
                    onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                >
                    <ProjectGroupHeader
                        item={item}
                        hasMultipleMachines={hasMultipleMachines}
                        workspaceLabelsV1={workspaceLabelsV1}
                        workspaceFaviconsEnabled={workspaceFaviconsEnabled}
                        workspaceMachineSubtitlesEnabled={workspaceMachineSubtitlesEnabled}
                        onRenameWorkspace={handleRenameWorkspace}
                        onResetWorkspaceName={handleResetWorkspaceName}
                        onCreateSession={() => handleCreateSessionFromProject(item)}
                        onAddFolder={() => handleAddFolderToProject(item)}
                        collapsed={Boolean(collapsedKeys[collapseKey])}
                        onToggleCollapse={() => handleToggleCollapse(collapseKey)}
                        headerTestId={headerTestId}
                    />
                </DraggableSessionFolderHeaderFrame>
            );
        }

        if (!item.title) return null;

        const collapseKey = item.groupKey || `${item.headerKind ?? ''}:${item.serverId ?? 'local'}`;
        const isCollapsed = Boolean(collapsedKeys[collapseKey]);
        const title =
            item.headerKind === 'server'
                ? t('sessionsList.serverHeader', { server: item.title })
                : item.title;
        const controlsAnchorKey = getSessionListHeaderControlsAnchorKey(item);
        const shouldRenderHeaderControls = isSessionListPrimaryHeaderKind(item.headerKind)
            && (headerControlsAnchorKey === null || controlsAnchorKey === headerControlsAnchorKey);

        return (
            <SessionListHeaderFrame
                treeRowId={`header:${collapseKey}`}
                onRegisterTreeRowBounds={registerTreeRowBounds}
                onUnregisterTreeRowBounds={unregisterTreeRowBounds}
            >
                <CollapsibleSectionHeader
                    title={title}
                    headerKind={item.headerKind}
                    collapsed={isCollapsed}
                    onPress={() => handleToggleCollapse(collapseKey)}
                    headerTestId={headerTestId}
                    rightElement={shouldRenderHeaderControls ? renderHeaderControls(controlsAnchorKey) : null}
                />
            </SessionListHeaderFrame>
        );
    }, [
        collapsedKeys,
        folderActionsEnabled,
        folderViewEnabled,
        dropOverlayShared,
        handleAddFolderToProject,
        handleAddSessionSubfolder,
        handleCreateSessionFromProject,
        handleCreateSessionFromFolder,
        handleDeleteSessionFolder,
        handleA11yDragStart,
        handleA11yFolderHeaderTreeDropResult,
        handleFocusSessionFolder,
        handleRenameWorkspace,
        handleRenameSessionFolder,
        handleResetWorkspaceName,
        handleToggleCollapse,
        headerControlsAnchorKey,
        hasMultipleMachines,
        registerTreeRowBounds,
        renderHeaderControls,
        resolveDropResult,
        unregisterTreeRowBounds,
        workspaceLabelsV1,
        workspaceFaviconsEnabled,
        workspaceMachineSubtitlesEnabled,
    ]);

    const pinnedKeysSignature = React.useMemo(
        () => buildStringListSignature(pinnedKeyList),
        [pinnedKeyList],
    );
    const allKnownTagsSignature = React.useMemo(
        () => buildStringListSignature(allKnownTags),
        [allKnownTags],
    );
    const sessionTagsSignature = React.useMemo(
        () => buildStringArrayRecordSignature(sessionTagsV1),
        [sessionTagsV1],
    );
    const workspaceLabelsSignature = React.useMemo(
        () => buildStringRecordSignature(workspaceLabelsV1),
        [workspaceLabelsV1],
    );
    const rowLabelsSignature = React.useMemo(
        () => buildRowLabelSignature(rowLabelByTreeRowId),
        [rowLabelByTreeRowId],
    );
    const reachableDisplaySignature = React.useMemo(
        () => buildReachableDisplaySignature(reachableSessionDisplayByKey),
        [reachableSessionDisplayByKey],
    );
    const virtualizedRowExtraData = React.useMemo(() => ({
        allKnownTagsSignature,
        compactSessionView: Boolean(compactSessionView),
        compactSessionViewMinimal: Boolean(compactSessionView && compactSessionViewMinimal),
        currentUserId,
        draggingSessionKey,
        folderActionsEnabled,
        folderMoveTargetsSignature,
        folderViewEnabled,
        hasMultipleMachines,
        nativeContextMenuSessionKey,
        pinnedKeysSignature,
        reachableDisplaySignature,
        rowLabelsSignature,
        sessionListOrderingMode,
        sessionListSectionMode,
        sessionTagsEnabled: sessionTagsEnabled === true,
        sessionTagsSignature,
        showStructuralDragHandles,
        showPinnedServerBadge,
        showServerBadge,
        workspaceFaviconsEnabled,
        workspaceLabelsSignature,
        workspaceMachineSubtitlesEnabled,
    }), [
        allKnownTagsSignature,
        compactSessionView,
        compactSessionViewMinimal,
        currentUserId,
        draggingSessionKey,
        folderActionsEnabled,
        folderMoveTargetsSignature,
        folderViewEnabled,
        hasMultipleMachines,
        nativeContextMenuSessionKey,
        pinnedKeysSignature,
        reachableDisplaySignature,
        rowLabelsSignature,
        sessionListOrderingMode,
        sessionListSectionMode,
        sessionTagsEnabled,
        sessionTagsSignature,
        showStructuralDragHandles,
        showPinnedServerBadge,
        showServerBadge,
        workspaceFaviconsEnabled,
        workspaceLabelsSignature,
        workspaceMachineSubtitlesEnabled,
    ]);
    const renderSessionItem = React.useCallback((item: SessionListSessionItem, index: number) => {
        const groupKey = String(item.groupKey ?? '').trim();
        const effectiveOrderingMode = resolveEffectiveSessionListOrderingModeForGroup({
            section: sessionListSectionMode === 'single' ? 'sessions' : item.section,
            sectionMode: sessionListSectionMode,
            groupKind: item.groupKind,
            userOrderingMode: sessionListOrderingMode,
        });
        const dragEnabled = effectiveOrderingMode === 'custom' || showStructuralDragHandles;
        const rowStoreScopeKey = resolveSessionListRowStoreScopeKey({
            sessionId: item.session.id,
            serverId: item.serverId ?? null,
        });

        return (
            <SessionListRowModelBoundary
                activeServerId={selection.activeServerId}
                dataActive={surfaceOwnership.dataActive}
                dataIndex={index}
                dragEnabled={dragEnabled}
                draggingSessionKey={draggingSessionKey}
                folderMoveMenuItems={folderMoveMenuItems}
                folderViewEnabled={folderViewEnabled}
                getRowMoveActionHandlers={getRowMoveActionHandlers}
                getRowNativeContextMenuOpenChangeHandler={getRowNativeContextMenuOpenChangeHandler}
                getRowSetTagsHandler={getRowSetTagsHandler}
                getRowTogglePinnedHandler={getRowTogglePinnedHandler}
                groupKey={groupKey}
                item={item}
                items={renderedListItems}
                nativeContextMenuSessionKey={nativeContextMenuSessionKey}
                onDragStart={handleA11yDragStart}
                onDropResult={handleA11yTreeDropResult}
                onDragCancel={handleStableDragCancel}
                resolveDropResult={resolveStableDropResult}
                onRegisterTreeRowBounds={registerTreeRowBounds}
                onUnregisterTreeRowBounds={unregisterTreeRowBounds}
                overlayShared={dropOverlayShared}
                prioritySessionRowKeys={prioritySessionRowKeys}
                rowStoreSubscriptionEnabled={rowStoreScopeKey != null && rowStoreSubscriptionKeys.has(rowStoreScopeKey)}
                rowStoreSubscriptionMode={rowStoreSubscriptionMode}
                settings={rowPresentationSettings}
                viewableSessionRowKeys={viewableSessionRowKeys}
            />
        );
    }, [
        draggingSessionKey,
        selection.activeServerId,
        surfaceOwnership.dataActive,
        nativeContextMenuSessionKey,
        prioritySessionRowKeys,
        renderedListItems,
        rowPresentationSettings,
        rowStoreSubscriptionKeys,
        rowStoreSubscriptionMode,
        viewableSessionRowKeys,
        dropOverlayShared,
        folderMoveMenuItems,
        folderViewEnabled,
        getRowMoveActionHandlers,
        handleA11yDragStart,
        handleA11yTreeDropResult,
        handleStableDragCancel,
        getRowNativeContextMenuOpenChangeHandler,
        getRowSetTagsHandler,
        getRowTogglePinnedHandler,
        resolveStableDropResult,
        registerTreeRowBounds,
        sessionListOrderingMode,
        sessionListSectionMode,
        showStructuralDragHandles,
        unregisterTreeRowBounds,
    ]);

    const renderHeaderItemRef = React.useRef(renderHeaderItem);
    renderHeaderItemRef.current = renderHeaderItem;
    const renderSessionItemRef = React.useRef(renderSessionItem);
    renderSessionItemRef.current = renderSessionItem;

    const renderVirtualizedItem = React.useCallback(({ item, index }: { item: SessionListViewItem; index: number }) => {
        if (item.type === 'header') return renderHeaderItemRef.current(item, index);
        return renderSessionItemRef.current(item, index);
    }, []);

    const virtualizedItemTypeContextRef = React.useRef<Readonly<{
        items: ReadonlyArray<SessionListViewItem>;
        density: SessionListRowPresentationSettings['density'];
    }>>({ items: EMPTY_SESSION_LIST_VIEW_ITEMS, density: 'default' });
    virtualizedItemTypeContextRef.current = {
        items: renderedListItems,
        density: rowPresentationSettings.density,
    };
    const getVirtualizedItemType = React.useCallback((item: SessionListViewItem, index: number) => {
        const context = virtualizedItemTypeContextRef.current;
        return resolveSessionListVirtualizedItemType({
            item,
            index,
            items: context.items,
            density: context.density,
        });
    }, []);

    const renderVirtualizedHeader = React.useCallback(() => (
        <SessionsListHeader>
            <SessionFolderScopeBreadcrumb
                breadcrumbs={folderBreadcrumbs}
                onClear={handleClearSessionFolderFocus}
                onSelectFolder={handleSelectSessionFolderBreadcrumb}
                rootTitle={folderBreadcrumbRootTitle}
            />
        </SessionsListHeader>
    ), [folderBreadcrumbRootTitle, folderBreadcrumbs, handleClearSessionFolderFocus, handleSelectSessionFolderBreadcrumb]);

    const renderVirtualizedFooter = React.useCallback(() => {
        return (
            <ItemGroup style={styles.footerContainer}>
                <Item
                    title={hideInactiveSessions
                        ? t('sessionInfo.inactiveAndArchivedSessions')
                        : t('sessionInfo.archivedSessions')}
                    icon={<Icon name="archive" size={20} color={theme.colors.text.secondary} />}
                    onPress={() => router.push('/session/archived')}
                />
            </ItemGroup>
        );
    }, [hideInactiveSessions, router, styles.footerContainer, theme.colors.text.secondary]);

    const onEndReached = surfaceOwnership.dataActive ? handleLoadMoreSessions : undefined;
    const nativeRefreshControl = React.useMemo(() => {
        if (Platform.OS === 'web' || !surfaceOwnership.dataActive) return undefined;
        return (
            <RefreshControl
                refreshing={refreshingSessions}
                onRefresh={handleRefreshSessions}
            />
        );
    }, [handleRefreshSessions, refreshingSessions, surfaceOwnership.dataActive]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: safeArea.bottom + 128,
        maxWidth: layout.maxWidth,
    }), [safeArea.bottom]);

    const webListDisableVirtualization = Platform.OS === 'web'
        && renderedListItems.length <= WEB_LIST_NON_VIRTUALIZED_MAX_ITEMS;
    const useWebFlatList = Platform.OS === 'web' && webListDisableVirtualization;
    const webListInitialNumToRender = Platform.OS === 'web'
        ? resolveWebListInitialNumToRender(renderedListItems)
        : WEB_LIST_INITIAL_NUM_TO_RENDER;

    const virtualizedListContent = useWebFlatList ? (
        <FlatList
            ref={virtualizedListRef as never}
            {...({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)}
            data={renderedListItems as any}
            renderItem={renderVirtualizedItem as any}
            extraData={virtualizedRowExtraData}
            keyExtractor={listItemKeyExtractor as any}
            contentContainerStyle={contentContainerStyle}
            onLayout={handleVirtualizedListLayout}
            onScroll={handleVirtualizedListScroll}
            onScrollBeginDrag={handleNativeListScrollInteractionStart}
            onScrollEndDrag={handleNativeListScrollInteractionEnd}
            onMomentumScrollBegin={handleNativeListScrollInteractionStart}
            onMomentumScrollEnd={handleNativeListScrollInteractionEnd}
            onContentSizeChange={handleTreeContentSizeChange}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.4}
            onViewableItemsChanged={handleViewableItemsChangedRef.current}
            viewabilityConfig={viewabilityConfigRef.current}
            scrollEventThrottle={WEB_LIST_SCROLL_EVENT_THROTTLE_MS}
            // Keep first-page-sized web lists non-virtualized to avoid React
            // Native Web VirtualizedList's incremental cell update churn during
            // live row data changes. Larger web lists use FlashListCompat below;
            // live browser QA showed RNW FlatList still mounted every session
            // row in production despite bounded virtualization props.
            disableVirtualization={webListDisableVirtualization}
            windowSize={WEB_LIST_WINDOW_SIZE}
            initialNumToRender={webListInitialNumToRender}
            maxToRenderPerBatch={WEB_LIST_MAX_TO_RENDER_PER_BATCH}
            updateCellsBatchingPeriod={WEB_LIST_UPDATE_CELLS_BATCHING_PERIOD_MS}
            ListHeaderComponent={renderVirtualizedHeader as any}
            ListFooterComponent={renderVirtualizedFooter as any}
        />
    ) : (
        <FlashList
            ref={virtualizedListRef as never}
            data={renderedListItems as any}
            renderItem={renderVirtualizedItem as any}
            extraData={virtualizedRowExtraData}
            keyExtractor={listItemKeyExtractor as any}
            getItemType={getVirtualizedItemType}
            contentContainerStyle={contentContainerStyle}
            onLayout={handleVirtualizedListLayout}
            onScroll={handleVirtualizedListScroll}
            onScrollBeginDrag={handleNativeListScrollInteractionStart}
            onScrollEndDrag={handleNativeListScrollInteractionEnd}
            onMomentumScrollBegin={handleNativeListScrollInteractionStart}
            onMomentumScrollEnd={handleNativeListScrollInteractionEnd}
            onContentSizeChange={handleTreeContentSizeChange}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.4}
            onViewableItemsChanged={handleViewableItemsChangedRef.current}
            viewabilityConfig={viewabilityConfigRef.current}
            scrollEventThrottle={Platform.OS === 'web'
                ? WEB_LIST_SCROLL_EVENT_THROTTLE_MS
                : NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS}
            maintainVisibleContentPosition={NATIVE_LIST_MAINTAIN_VISIBLE_CONTENT_POSITION}
            refreshControl={nativeRefreshControl}
            overrideProps={Platform.OS === 'web'
                ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                : undefined}
            ListHeaderComponent={renderVirtualizedHeader as any}
            ListFooterComponent={renderVirtualizedFooter as any}
        />
    );

    const keyboardZoneProps = Platform.OS === 'web'
        ? {
            testID: 'sessions-list-keyboard-zone',
            tabIndex: 0,
            onFocus: () => {
                sessionListKeyboardFocusedRef.current = true;
                setSessionListKeyboardFocused(true);
            },
            onBlur: () => {
                sessionListKeyboardFocusedRef.current = false;
                setSessionListKeyboardFocused(false);
                cursorSessionKeyRef.current = null;
                sessionListSelectionStore.setFocusedKey(null);
            },
            onKeyDown: handleSessionListKeyDown,
        } as const
        : {};

    // Preserve the original empty loading surface without skipping hooks above.
    if (!data) {
        return (
            <View style={styles.container} />
        );
    }

    return (
        <SessionListSelectionStoreProvider store={sessionListSelectionStore}>
            <View ref={focusReturnFallbackRef} style={styles.container} {...keyboardZoneProps}>
                <View
                    ref={listViewportRef}
                    style={styles.contentContainer}
                    onLayout={() => handleTreeViewportMeasure(listViewportRef.current)}
                >
                    <SyncPerformanceReactProfiler id="sessions.list.virtualized">
                        {virtualizedListContent}
                    </SyncPerformanceReactProfiler>
                    {/*
                     * The single list-level drop indicator. It is a viewport-level,
                     * non-interactive sibling of the scroll container: its geometry
                     * flows through numeric shared values, so a pointer move never
                     * reconciles the list rows.
                     */}
                    <SessionListDropOverlay
                        shared={dropOverlayShared}
                        testID="session-list-drop-overlay"
                    />
                    <SessionListSelectionActionBarHost
                        targetsByKey={sessionListSelectionTargetsByKey}
                        bulkActionContext={sessionListBulkActionContext}
                        tagsEnabled={sessionTagsEnabled === true}
                        onRequestMoveToFolder={folderActionsEnabled ? handleRequestBulkMoveToFolder : undefined}
                    />
                </View>
            </View>
        </SessionListSelectionStoreProvider>
    );
});
