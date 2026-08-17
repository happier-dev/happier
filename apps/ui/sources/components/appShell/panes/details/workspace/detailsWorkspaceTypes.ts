import type {
    SplitCanvasLeafNode,
    SplitCanvasNode,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import type {
    PluginUiDestinationReferenceV1,
    PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui';

export type DetailsTabOpenMode = 'preview' | 'pinned';

export type DetailsTab = Readonly<{
    key: string;
    kind: string;
    title: string;
    subtitle?: string | null;
    resource: unknown;
}>;

export type DetailsTabState = Readonly<DetailsTab & {
    isPreview: boolean;
    isPinned: boolean;
}>;

/**
 * Details workspace maps accept arbitrary string identifiers from persisted
 * tabs and split groups. Read and write only exact own entries so prototype
 * names never become phantom tabs or groups.
 */
export function hasOwnDetailsWorkspaceRecordEntry<T>(
    record: Readonly<Record<string, T>>,
    key: string,
): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

export function getOwnDetailsWorkspaceRecordEntry<T>(
    record: Readonly<Record<string, T>>,
    key: string,
): T | undefined {
    return hasOwnDetailsWorkspaceRecordEntry(record, key) ? record[key] : undefined;
}

export function setOwnDetailsWorkspaceRecordEntry<T>(
    record: Readonly<Record<string, T>>,
    key: string,
    value: T,
): Record<string, T> {
    return Object.fromEntries([...Object.entries(record), [key, value]]);
}

export const DETAILS_TAB_REHYDRATION_FALLBACK_KIND = 'restore-builtin-details-tab-on-rehydrate';

export type DetailsTabRehydrationFallbackState = Readonly<{
    kind: typeof DETAILS_TAB_REHYDRATION_FALLBACK_KIND;
    tab: DetailsTabState;
}>;

function isDetailsTabState(value: unknown): value is DetailsTabState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.key === 'string'
        && typeof candidate.kind === 'string'
        && typeof candidate.title === 'string'
        && typeof candidate.isPinned === 'boolean'
        && typeof candidate.isPreview === 'boolean'
    );
}

/**
 * A generic plugin Details tab needs live launch custody. Its selected
 * workspace-file source is retained only in runtime tab state so the
 * persistence owner can restore the regular file tab instead.
 */
export function createDetailsTabRehydrationFallbackState(
    tab: DetailsTabState,
): DetailsTabRehydrationFallbackState {
    return Object.freeze({
        kind: DETAILS_TAB_REHYDRATION_FALLBACK_KIND,
        tab: Object.freeze({ ...tab }),
    });
}

export function readDetailsTabRehydrationFallbackState(value: unknown): DetailsTabState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.kind !== DETAILS_TAB_REHYDRATION_FALLBACK_KIND) return null;
    if (Object.keys(candidate).some((key) => key !== 'kind' && key !== 'tab')) return null;
    return isDetailsTabState(candidate.tab) ? candidate.tab : null;
}

export type DetailsWorkspaceAxis = 'horizontal' | 'vertical';
export type DetailsWorkspacePlacement = 'before' | 'after';
export type DetailsWorkspaceLeafPayload = Readonly<{
    groupId: string;
}>;

export type DetailsWorkspaceGroupState = Readonly<{
    id: string;
    tabKeys: ReadonlyArray<string>;
    activeTabKey: string | null;
}>;

export type DetailsWorkspaceLeafNode = SplitCanvasLeafNode<DetailsWorkspaceLeafPayload>;
export type DetailsWorkspaceNode = SplitCanvasNode<DetailsWorkspaceLeafPayload>;

/**
 * One selected full-bleed plugin details destination above the retained
 * Details workspace. Only durable selection/return facts belong here: the
 * registered scope adapter stamps the target and any launch input remains in
 * the AppPane-scoped ephemeral handoff owner.
 */
export type DetailsWorkspaceOverlayState = Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    returnFocusedGroupId: string | null;
    returnMaximizedGroupId: string | null;
    returnIsOpen: boolean;
}>;

export type PaneDetailsState = Readonly<{
    isOpen: boolean;
    tabState: Readonly<Record<string, unknown>>;
    tabsByKey: Readonly<Record<string, DetailsTabState>>;
    groupsById: Readonly<Record<string, DetailsWorkspaceGroupState>>;
    root: DetailsWorkspaceNode | null;
    focusedGroupId: string | null;
    maximizedGroupId: string | null;
    nextGroupOrdinal: number;
    overlay: DetailsWorkspaceOverlayState | null;
}>;

export type LegacyPaneDetailsState = Readonly<{
    isOpen: boolean;
    tabs: ReadonlyArray<DetailsTabState>;
    activeTabKey: string | null;
    tabState: Readonly<Record<string, unknown>>;
}>;

export type DetailsWorkspaceGroupView = Readonly<{
    id: string;
    tabKeys: ReadonlyArray<string>;
    activeTabKey: string | null;
    tabs: ReadonlyArray<DetailsTabState>;
    isFocused: boolean;
}>;

export type PaneDetailsStateView = Readonly<{
    isOpen: boolean;
    tabState: Readonly<Record<string, unknown>>;
    tabs: ReadonlyArray<DetailsTabState>;
    activeTabKey: string | null;
    groups: ReadonlyArray<DetailsWorkspaceGroupView>;
    root: DetailsWorkspaceNode | null;
    focusedGroupId: string | null;
    maximizedGroupId: string | null;
    /** Optional while legacy test/adaptor shapes finish migrating. */
    overlay?: DetailsWorkspaceOverlayState | null;
}>;
