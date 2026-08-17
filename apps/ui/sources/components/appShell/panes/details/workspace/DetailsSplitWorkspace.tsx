import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SplitCanvasHost } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import {
    ModalPaneBoundaryView,
    useModalPaneBoundary,
} from '@/components/ui/panels/ModalPaneBoundary';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Text } from '@/components/ui/text/Text';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { t } from '@/text';
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
import {
    getOwnDetailsWorkspaceRecordEntry,
} from './detailsWorkspaceTypes';
import type {
    DetailsTabState,
    DetailsWorkspaceGroupView,
    DetailsWorkspaceOverlayState,
    PaneDetailsStateView,
} from './detailsWorkspaceTypes';
import { DetailsTabGroupPanel, type DetailsTabGroupPanelProps } from './DetailsTabGroupPanel';
import type { DetailsTabPresentation } from './DetailsTabStrip';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        position: 'relative',
        backgroundColor: theme.colors.surface.base,
    },
    groupFrame: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    workspaceUnderlay: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    overlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 10,
        backgroundColor: theme.colors.surface.base,
    },
    overlayChrome: {
        minHeight: 46,
        paddingHorizontal: 10,
        paddingVertical: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    overlayChromeSpacer: {
        flex: 1,
        minWidth: 0,
    },
    overlayAction: {
        borderRadius: 8,
        paddingHorizontal: 10,
        justifyContent: 'center',
    },
    overlayActionText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontWeight: '600',
    },
    overlayContent: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    overlayUnavailable: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    overlayUnavailableText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
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
    /**
     * The current scope adapter renders an exact qualified `detailsPane`
     * destination here. The workspace continues to own the overlay's chrome,
     * return state, focus/a11y suspension, and close/reveal behavior.
     */
    renderOverlay?: ((overlay: DetailsWorkspaceOverlayState) => React.ReactNode) | null;
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
    const overlay = details.overlay ?? null;
    const localOpeningFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    const openingFocusReturnRef = props.pane.detailsOverlayFocusReturnRef ?? localOpeningFocusReturnRef;
    const interactiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const overlayActionTargetStyle = React.useMemo(() => ({
        minWidth: interactiveTargetSize,
        minHeight: interactiveTargetSize,
    }), [interactiveTargetSize]);
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
        const group = getOwnDetailsWorkspaceRecordEntry(groupsById, groupId) ?? null;
        if (!group) return renderEmptyWorkspace();
        return renderGroup(group, group.id === details.focusedGroupId);
    }, [details.focusedGroupId, groupsById, renderEmptyWorkspace, renderGroup]);

    const renderDetailsLeafLabel = React.useCallback((leaf: SplitCanvasLeafNode<DetailsLeafPayload>) => {
        const groupId = readDetailsWorkspaceGroupId(leaf);
        return getOwnDetailsWorkspaceRecordEntry(groupsById, groupId)?.tabs.at(-1)?.title ?? groupId;
    }, [groupsById]);

    const handleReturnToWorkspace = React.useCallback(() => {
        props.pane.closeDetailsOverlay?.();
    }, [props.pane]);
    const handleRevealRightPane = React.useCallback(() => {
        // The right pane may be parked below the outer Details pane on narrow
        // layouts. Close that host pane, rather than merely toggling a second
        // overlay flag, so its incumbent layout owner reveals the retained
        // right state with no remount or local visibility store.
        props.pane.closeDetails();
        props.pane.openRight();
    }, [props.pane]);
    const handleFocusWorkspace = React.useCallback(() => {
        if (overlay?.returnFocusedGroupId) {
            props.pane.focusDetailsGroup?.(overlay.returnFocusedGroupId);
        }
        props.pane.closeDetailsOverlay?.();
    }, [overlay?.returnFocusedGroupId, props.pane]);
    const detailsModalBoundary = useModalPaneBoundary({
        active: overlay !== null,
        label: t('ui.modalPane.details'),
        onRequestClose: handleReturnToWorkspace,
        focusReturnRef: openingFocusReturnRef,
        allowEditableEscape: overlay !== null,
        escapeEnabled: overlay !== null,
    });
    const renderWorkspace = details.root ? (
        <TypedSplitCanvasHost
            keyboardEnabled
            state={splitCanvasState}
            dispatch={dispatch}
            onRequestSplitLeaf={props.pane.splitDetailsGroup ? handleRequestSplitLeaf : undefined}
            renderLeaf={renderDetailsLeaf}
            renderLeafLabel={renderDetailsLeafLabel}
        />
    ) : renderEmptyWorkspace();
    const overlayContent = overlay && props.renderOverlay
        ? props.renderOverlay(overlay)
        : overlay
            ? (
                <View testID="details-workspace-overlay-unavailable" style={styles.overlayUnavailable}>
                    <Text style={styles.overlayUnavailableText}>
                        {t('session.detailsPanel.unsupportedTab')}
                    </Text>
                </View>
            )
            : null;

    return (
        <View testID={props.testIds?.root} style={styles.root}>
            <ModalPaneBoundaryView
                ref={detailsModalBoundary.setUnderlayFocusRef}
                testID={overlay ? 'details-workspace-underlay' : undefined}
                style={styles.workspaceUnderlay}
                {...detailsModalBoundary.underlayProps}
            >
                <PluginSurfaceFocusEligibilityProvider active={!overlay}>
                    {renderWorkspace}
                </PluginSurfaceFocusEligibilityProvider>
            </ModalPaneBoundaryView>
            {overlay ? (
                <ModalPaneBoundaryView
                    ref={detailsModalBoundary.setOverlayFocusRef}
                    testID="details-workspace-overlay"
                    style={styles.overlay}
                    {...detailsModalBoundary.overlayProps}
                >
                    <View style={styles.overlayChrome}>
                        <Pressable
                            testID="details-workspace-overlay-back"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.back')}
                            onPress={handleReturnToWorkspace}
                            style={[styles.overlayAction, overlayActionTargetStyle]}
                        >
                            <Text style={styles.overlayActionText}>{t('common.back')}</Text>
                        </Pressable>
                        <Pressable
                            testID="details-workspace-overlay-focus-workspace"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.restore')}
                            onPress={handleFocusWorkspace}
                            style={[styles.overlayAction, overlayActionTargetStyle]}
                        >
                            <Text style={styles.overlayActionText}>{t('common.restore')}</Text>
                        </Pressable>
                        <View style={styles.overlayChromeSpacer} />
                        <Pressable
                            testID="details-workspace-overlay-reveal-right"
                            accessibilityRole="button"
                            accessibilityLabel={t('session.detailsPanel.openRightSidebarA11y')}
                            onPress={handleRevealRightPane}
                            style={[styles.overlayAction, overlayActionTargetStyle]}
                        >
                            <Text style={styles.overlayActionText}>{t('session.detailsPanel.openRightSidebarA11y')}</Text>
                        </Pressable>
                        <Pressable
                            testID="details-workspace-overlay-close"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.close')}
                            onPress={props.pane.closeDetails}
                            style={[styles.overlayAction, overlayActionTargetStyle]}
                        >
                            <Text style={styles.overlayActionText}>{t('common.close')}</Text>
                        </Pressable>
                    </View>
                    <View style={styles.overlayContent}>
                        <PluginSurfaceFocusEligibilityProvider active>
                            {overlayContent}
                        </PluginSurfaceFocusEligibilityProvider>
                    </View>
                </ModalPaneBoundaryView>
            ) : null}
        </View>
    );
});
