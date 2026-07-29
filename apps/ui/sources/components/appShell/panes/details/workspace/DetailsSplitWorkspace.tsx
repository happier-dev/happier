import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SplitCanvasHost } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type {
    SplitCanvasAction,
    SplitCanvasLeafNode,
    SplitCanvasState,
} from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { buildDetailsWorkspaceStateView } from './detailsWorkspaceSelectors';
import {
    createDetailsWorkspaceLeafNode,
    createDetailsWorkspaceSplitCanvasState,
    mapSplitCanvasDirectionToDetailsWorkspacePlacement,
    readDetailsWorkspaceGroupId,
    mapSplitCanvasDirectionToDetailsWorkspaceAxis,
} from './detailsWorkspaceSplitCanvas';
import type {
    DetailsTabState,
    DetailsWorkspaceGroupView,
    PaneDetailsStateView,
} from './detailsWorkspaceTypes';
import { DetailsTabGroupPanel, type DetailsTabGroupPanelProps } from './DetailsTabGroupPanel';
import type { DetailsTabPresentation } from './DetailsTabStrip';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface.base,
    },
    groupFrame: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
}));

export type DetailsSplitWorkspaceProps = Readonly<{
    pane: AppPaneScopeApi;
    paddingTop?: number;
    headerPaddingTop?: number;
    forceEmptyState?: boolean;
    testIds?: DetailsTabGroupPanelProps['testIds'];
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    resolveTabPresentation?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null;
    renderTabContent: (tab: DetailsTabState) => React.ReactNode;
    renderHeaderLeadingActions?: (() => React.ReactNode) | null;
    renderHeaderActions?: (() => React.ReactNode) | null;
    renderEmptyState?: (() => React.ReactNode) | null;
}>;

type DetailsLeafPayload = { groupId: string };

const TypedSplitCanvasHost = SplitCanvasHost as unknown as React.ComponentType<Readonly<{
    state: SplitCanvasState<DetailsLeafPayload>;
    dispatch: (action: SplitCanvasAction<DetailsLeafPayload>) => void;
    renderLeaf: (input: Readonly<{
        leaf: SplitCanvasLeafNode<DetailsLeafPayload>;
        isFocused: boolean;
        isMaximized: boolean;
    }>) => React.ReactNode;
    renderLeafLabel?: (leaf: SplitCanvasLeafNode<DetailsLeafPayload>) => string;
    onRequestSplitLeaf?: (input: Readonly<{
        leafId: string;
        direction: 'left' | 'right' | 'up' | 'down';
    }>) => void;
    keyboardEnabled?: boolean;
}>>;

function isDetailsStateView(value: unknown): value is PaneDetailsStateView {
    return !!value && typeof value === 'object' && Array.isArray((value as PaneDetailsStateView).groups);
}

type LegacyDetailsStateView = Readonly<{
    isOpen?: boolean;
    tabState?: Readonly<Record<string, unknown>>;
    tabs?: ReadonlyArray<DetailsTabState>;
    activeTabKey?: string | null;
}>;

function isLegacyDetailsStateView(value: unknown): value is LegacyDetailsStateView {
    return !!value && typeof value === 'object' && Array.isArray((value as LegacyDetailsStateView).tabs);
}

function createEmptyDetailsView(): PaneDetailsStateView {
    return {
        isOpen: false,
        tabState: {},
        tabs: [],
        activeTabKey: null,
        groups: [],
        root: null,
        focusedGroupId: null,
        maximizedGroupId: null,
    };
}

function coerceLegacyDetailsStateView(value: LegacyDetailsStateView): PaneDetailsStateView {
    const tabs = value.tabs ?? [];
    const activeTabKey =
        typeof value.activeTabKey === 'string' && tabs.some((tab) => tab.key === value.activeTabKey)
            ? value.activeTabKey
            : tabs.at(-1)?.key ?? null;

    if (tabs.length === 0) {
        return createEmptyDetailsView();
    }

    const legacyGroup: DetailsWorkspaceGroupView = {
        id: 'group:legacy',
        tabKeys: tabs.map((tab) => tab.key),
        activeTabKey,
        tabs,
        isFocused: true,
    };

    return {
        isOpen: value.isOpen === true,
        tabState: value.tabState ?? {},
        tabs,
        activeTabKey,
        groups: [legacyGroup],
        root: createDetailsWorkspaceLeafNode(legacyGroup.id),
        focusedGroupId: legacyGroup.id,
        maximizedGroupId: null,
    };
}

function getDetailsView(pane: AppPaneScopeApi): PaneDetailsStateView {
    const value: unknown = pane.scopeState?.details ?? null;
    if (isDetailsStateView(value)) return value;
    if (isLegacyDetailsStateView(value)) return coerceLegacyDetailsStateView(value);
    return createEmptyDetailsView();
}

export const DetailsSplitWorkspace = React.memo((props: DetailsSplitWorkspaceProps) => {
    const styles = stylesheet;
    const details = getDetailsView(props.pane);
    const groupsById = React.useMemo(
        () => Object.fromEntries(details.groups.map((group) => [group.id, group])),
        [details.groups],
    );
    const groupPanelTestIds = React.useMemo(
        () => (props.testIds ? { ...props.testIds, root: undefined } : undefined),
        [props.testIds],
    );
    const emptyGroup = React.useMemo((): DetailsWorkspaceGroupView => ({
        id: 'group:empty',
        tabKeys: [],
        activeTabKey: null,
        tabs: [],
        isFocused: true,
    }), []);

    const renderGroup = React.useCallback((group: DetailsWorkspaceGroupView, isFocused: boolean) => {
        return (
            <View key={group.id} style={styles.groupFrame}>
                <DetailsTabGroupPanel
                    pane={props.pane}
                    group={group}
                    paddingTop={props.paddingTop}
                    headerPaddingTop={props.headerPaddingTop}
                    forceEmptyState={props.forceEmptyState}
                    testIds={groupPanelTestIds}
                    resolveTabIconName={props.resolveTabIconName}
                    resolveTabPresentation={props.resolveTabPresentation}
                    renderTabContent={props.renderTabContent}
                    renderHeaderLeadingActions={isFocused ? props.renderHeaderLeadingActions : null}
                    renderHeaderActions={isFocused ? props.renderHeaderActions : null}
                    renderEmptyState={props.renderEmptyState}
                />
            </View>
        );
    }, [
        props.forceEmptyState,
        groupPanelTestIds,
        props.headerPaddingTop,
        props.paddingTop,
        props.pane,
        props.renderEmptyState,
        props.renderHeaderActions,
        props.renderHeaderLeadingActions,
        props.renderTabContent,
        props.resolveTabIconName,
        props.resolveTabPresentation,
        styles.groupFrame,
    ]);

    const renderEmptyWorkspace = React.useCallback(() => (
        <DetailsTabGroupPanel
            pane={props.pane}
            group={emptyGroup}
            paddingTop={props.paddingTop}
            headerPaddingTop={props.headerPaddingTop}
            forceEmptyState={props.forceEmptyState}
            testIds={groupPanelTestIds}
            resolveTabIconName={props.resolveTabIconName}
            resolveTabPresentation={props.resolveTabPresentation}
            renderTabContent={props.renderTabContent}
            renderHeaderLeadingActions={props.renderHeaderLeadingActions}
            renderHeaderActions={props.renderHeaderActions}
            renderEmptyState={props.renderEmptyState}
        />
    ), [
        emptyGroup,
        props.forceEmptyState,
        groupPanelTestIds,
        props.headerPaddingTop,
        props.paddingTop,
        props.pane,
        props.renderEmptyState,
        props.renderHeaderActions,
        props.renderHeaderLeadingActions,
        props.renderTabContent,
        props.resolveTabIconName,
        props.resolveTabPresentation,
    ]);

    const handleRequestSplitLeaf = React.useCallback((input: Readonly<{
        leafId: string;
        direction: 'left' | 'right' | 'up' | 'down';
    }>) => {
        const axis = mapSplitCanvasDirectionToDetailsWorkspaceAxis(input.direction);
        const placement = mapSplitCanvasDirectionToDetailsWorkspacePlacement(input.direction);
        props.pane.splitDetailsGroup?.({
            axis,
            groupId: input.leafId,
            placement,
        });
    }, [props.pane]);

    const dispatch = React.useCallback((action: SplitCanvasAction<DetailsLeafPayload>) => {
        switch (action.type) {
            case 'focusLeaf':
                if (action.leafId) {
                    props.pane.focusDetailsGroup?.(action.leafId);
                }
                return;
            case 'closeLeaf':
                props.pane.closeDetailsGroup?.(action.leafId);
                return;
            case 'toggleMaximizeLeaf':
                props.pane.setMaximizedDetailsGroup?.(
                    details.maximizedGroupId === action.leafId ? null : action.leafId,
                );
                return;
            case 'restoreMaximize':
                props.pane.setMaximizedDetailsGroup?.(null);
                return;
            case 'setSplitRatio':
                props.pane.setDetailsSplitRatio?.(action.splitId, action.ratio);
                return;
            default:
                return;
        }
    }, [details.maximizedGroupId, props.pane]);

    const splitCanvasState = React.useMemo(
        () => createDetailsWorkspaceSplitCanvasState({
            root: details.root,
            focusedGroupId: details.focusedGroupId,
            maximizedGroupId: details.maximizedGroupId,
        }),
        [details.focusedGroupId, details.maximizedGroupId, details.root],
    );

    const renderDetailsLeaf = React.useCallback(({ leaf }: Readonly<{
        leaf: SplitCanvasLeafNode<DetailsLeafPayload>;
    }>) => {
        const groupId = readDetailsWorkspaceGroupId(leaf);
        const group = groupsById[groupId] ?? null;
        if (!group) return renderEmptyWorkspace();
        return renderGroup(group, group.id === details.focusedGroupId);
    }, [details.focusedGroupId, groupsById, renderEmptyWorkspace, renderGroup]);

    const renderDetailsLeafLabel = React.useCallback((leaf: SplitCanvasLeafNode<DetailsLeafPayload>) => {
        const groupId = readDetailsWorkspaceGroupId(leaf);
        return groupsById[groupId]?.tabs.at(-1)?.title ?? groupId;
    }, [groupsById]);

    return (
        <View testID={props.testIds?.root} style={styles.root}>
            {details.root ? (
                <TypedSplitCanvasHost
                    keyboardEnabled
                    state={splitCanvasState}
                    dispatch={dispatch}
                    onRequestSplitLeaf={props.pane.splitDetailsGroup ? handleRequestSplitLeaf : undefined}
                    renderLeaf={renderDetailsLeaf}
                    renderLeafLabel={renderDetailsLeafLabel}
                />
            ) : renderEmptyWorkspace()}
        </View>
    );
});
