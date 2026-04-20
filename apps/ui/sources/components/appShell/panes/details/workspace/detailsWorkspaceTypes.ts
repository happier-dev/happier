import type {
    SplitCanvasLeafNode,
    SplitCanvasNode,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

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

export type PaneDetailsState = Readonly<{
    isOpen: boolean;
    tabState: Readonly<Record<string, unknown>>;
    tabsByKey: Readonly<Record<string, DetailsTabState>>;
    groupsById: Readonly<Record<string, DetailsWorkspaceGroupState>>;
    root: DetailsWorkspaceNode | null;
    focusedGroupId: string | null;
    maximizedGroupId: string | null;
    nextGroupOrdinal: number;
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
}>;
