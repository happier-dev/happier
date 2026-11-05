import React from 'react';
import { View, Platform, Image as ReactNativeImage, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { useIsTablet } from '@/utils/platform/responsive';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';
import { useSessionListOrganizeMode } from './organize/SessionListOrganizeMode';

import {
    useSessionListLayoutChoice,
    useYieldSessionListLayoutIntent,
} from '@/hooks/session/sessionListLayoutIntent';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { cancelSessionListLayoutFlight, captureSessionListLayoutFlight } from './sessionListLayoutFlight';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';

import { SESSION_LIST_COLUMN_METRICS, sessionListStyles } from './sessionListStyles';
import { resolveProjectGroupHeaderMenuItems } from './resolveProjectGroupHeaderMenuItems';
import { resolveNewSessionGroupTarget } from './resolveSessionListHeaderActionHandlers';
import {
    resolveSessionListDensityItems,
    resolveSessionListIdentityItems,
    resolveSessionListViewOptionsPresentation,
    type SessionListViewOptionDescriptor,
} from './sessionListViewOptionsPresentation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { RegisterSessionFolderDropTarget } from './useSessionListViewState';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { resolveWorkspaceRootTreeRowId, treeRowId } from './drop-resolution/treeRowId';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { useSessionListViewOptionWriter } from './useSessionListViewOptionWriter';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import type { CollectionGroupRollup } from '@happier-dev/plugin-ui/components';
import { WorkStatusRollup } from '@/components/work/status/WorkStatusRollup';
import { SESSION_SECTION_ICON_CHOICES, resolveSessionSectionIcon } from '@/components/sessions/organization/sessionSectionIcons';
import { useSessionSectionDraftController } from '@/components/sessions/organization/useSessionSectionDraft';
import { resolveSessionSectionDisplayTitle } from '@/sync/domains/session/organization/sections';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';


/**
 * A group header's actions are small glyph buttons (`groupHeaderActionButton`) a gap apart, each its own
 * target (siblings, never nested in the label). Their hit areas reach the 24 floor (a finger's target
 * under a touch pointer). The menu is the row's first action: it takes the free space before it and
 * leaves the gap to the "+" with it; the "+" ends at the column edge, where the pane's resize handle
 * takes over, so it reaches no further right.
 */
const GROUP_ACTION_HIT_TARGET = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
function groupActionHitReach(gapPx: number): Readonly<{ menu: { left: number; right: number }; create: { left: number; right: number } }> {
    return { menu: { left: GROUP_ACTION_HIT_TARGET, right: 0 }, create: { left: gapPx, right: 0 } };
}

export function stopPressEventPropagation(event: unknown): void {
    if (!event || typeof event !== 'object' || !('stopPropagation' in event)) {
        return;
    }
    const stopPropagation = (event as { stopPropagation?: () => void }).stopPropagation;
    if (typeof stopPropagation === 'function') {
        (event as { stopPropagation: () => void }).stopPropagation();
    }
}


type MeasuredSessionFolderDropTarget = Readonly<
    | {
        type: 'folder';
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
    | {
        type: 'workspace-root';
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
>;

function useMeasuredDropTargetRegistration(params: Readonly<{
    id: string | null;
    target: MeasuredSessionFolderDropTarget | null;
    onRegister?: RegisterSessionFolderDropTarget;
}>) {
    const ref = React.useRef<View>(null);
    const cleanupRef = React.useRef<(() => void) | null>(null);
    const clearRegistration = React.useCallback(() => {
        cleanupRef.current?.();
        cleanupRef.current = null;
    }, []);
    React.useEffect(() => clearRegistration, [clearRegistration]);
    const onLayout = React.useCallback((event?: { nativeEvent?: { layout?: { x: number; y: number; width: number; height: number } } }) => {
        clearRegistration();
        if (!params.id || !params.target || !params.onRegister) return;
        const node = ref.current as unknown as {
            measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } | null;
        const targetId = params.id;
        const target = params.target;
        const register = (x: number, y: number, width: number, height: number) => {
            if (!targetId || !target) return;
            cleanupRef.current = params.onRegister?.(target.type === 'folder' ? {
                type: 'folder',
                folderId: target.folderId,
                workspace: target.workspace,
                serverId: target.serverId,
                id: targetId,
                bounds: { x, y, width, height },
            } : {
                type: 'workspace-root',
                workspace: target.workspace,
                serverId: target.serverId,
                id: targetId,
                bounds: { x, y, width, height },
            }) ?? null;
        };
        if (typeof node?.measureInWindow === 'function') {
            node.measureInWindow(register);
            return;
        }
        const fallback = event?.nativeEvent?.layout;
        if (fallback) {
            register(fallback.x, fallback.y, fallback.width, fallback.height);
        }
    }, [clearRegistration, params.id, params.onRegister, params.target]);
    return { ref, onLayout };
}

const SESSION_LIST_ORGANIZE_MENU_ITEM_ID = 'organize';
const SESSION_LIST_NEW_SECTION_MENU_ITEM_ID = 'newSection';
const SESSION_LIST_FILTER_MENU_ITEM_ID = 'filter';
const SESSION_LIST_SETTINGS_MENU_ITEM_ID = 'settings';
/** The View menu holds whole placement sentences (lab `clfilter:view`) at the menu's own type size. */
const VIEW_MENU_OVERLAY_STYLE = { minWidth: 300 } as const;

export const SessionListViewOptionsButton = React.memo(function SessionListViewOptionsButton(props: Readonly<{
    placement?: 'top' | 'bottom' | 'left' | 'right';
    onMenuOpenChange?: (open: boolean) => void;
    serverId?: string | null;
    /** Filter… closes the View menu (lab `clfilter:view`): View is layout only, Find narrows. */
    onOpenFilter?: () => void;
}>) {
    const styles = sessionListStyles;
    const router = useRouter();
    const [sessionListIdentityDisplay] = useSettingMutable('sessionListIdentityDisplay');
    const [sessionListDensity] = useSettingMutable('sessionListDensity');
    const [sessionListRowContextV1] = useSettingMutable('sessionListRowContextV1');
    const [sessionListStatusWords] = useSettingMutable('sessionListStatusWords');
    const { theme } = useUnistyles();
    const [sessionListAttentionPlacementV1] = useSettingMutable('sessionListAttentionPlacementV1');
    const applyViewOption = useSessionListViewOptionWriter();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const organize = useSessionListOrganizeMode();
    const sectionDraft = useSessionSectionDraftController();
    const openNewSection = sectionDraft?.openNew;
    const actionIconColor = theme.colors.text.secondary;
    // The rendered arrangement is the one this menu describes, so the checkmark
    // and the dependent controls read the effective-layout owner, not the raw
    // settings a visit intent may currently be overriding.
    const effectiveLayout = useSessionListLayoutChoice();
    const yieldLayoutIntent = useYieldSessionListLayoutIntent();
    const presentation = resolveSessionListViewOptionsPresentation({ sessionListAttentionPlacementV1 }, effectiveLayout);
    const withSelection = React.useCallback((
        items: ReadonlyArray<SessionListViewOptionDescriptor>,
        selectedId: string,
        category: string,
    ): ReadonlyArray<DropdownMenuItem> => items.map((item) => ({
        ...item,
        category,
        checked: item.id === selectedId,
        rightElement: item.id === selectedId
            ? <Icon name="check" size={16} color={actionIconColor} />
            : undefined,
    })), [actionIconColor]);
    // Lab `clfilter:view`: what the list shows (Projects or Recent), where Needs you and Working sit, what
    // each row shows; then Filter… and the settings page. Every item is the Settings → Sessions setting.
    const identityItems = React.useMemo(() => resolveSessionListIdentityItems(), []);
    const densityItems = React.useMemo(() => resolveSessionListDensityItems(), []);
    const rowsCategory = t('settingsSession.sessionList.rowsTitle');
    const menuItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => {
        const selectedIdentity = identityItems.find((item) => item.id === `identity:${sessionListIdentityDisplay}`) ?? identityItems[0]!;
        const selectedDensity = densityItems.find((item) => item.id === `density:${sessionListDensity}`) ?? densityItems[densityItems.length - 1]!;
        return [
            ...withSelection(presentation.layoutItems, `layout:${presentation.selectedLayout}`,
                t('settingsSession.sessionList.viewTitle')),
            ...withSelection(presentation.attentionItems, `attention:${presentation.selectedAttentionPlacement}`,
                t('settingsSession.sessionList.attentionPlacementTitle')),
            {
                id: 'menu:identity',
                testID: 'session-list-view-identity',
                title: t('settingsSession.sessionList.leadingMarkTitle'),
                category: rowsCategory,
                rightElement: <View style={styles.viewMenuValue}><Text style={styles.viewMenuValueText}>{selectedIdentity.title}</Text><Icon name="caret-right" size={14} color={actionIconColor} /></View>,
                submenu: { items: withSelection(identityItems, selectedIdentity.id, ''), placement: 'right' },
            },
            {
                id: `rowContext:${sessionListRowContextV1 === false ? 'true' : 'false'}`,
                testID: 'session-list-view-row-context',
                title: t('settingsSession.sessionList.rowContextTitle'),
                category: rowsCategory,
                checked: sessionListRowContextV1 !== false,
                rightElement: sessionListRowContextV1 !== false ? <Icon name="check" size={16} color={actionIconColor} /> : undefined,
            },
            {
                id: `statusWords:${sessionListStatusWords === true ? 'false' : 'true'}`,
                testID: 'session-list-view-status-words',
                title: t('settingsSession.sessionList.statusWordsTitle'),
                category: rowsCategory,
                checked: sessionListStatusWords === true,
                rightElement: sessionListStatusWords === true ? <Icon name="check" size={16} color={actionIconColor} /> : undefined,
            },
            {
                id: 'menu:density',
                testID: 'session-list-view-density',
                title: t('settingsSession.sessionList.densityMenuTitle'),
                category: rowsCategory,
                rightElement: <View style={styles.viewMenuValue}><Text style={styles.viewMenuValueText}>{selectedDensity.title}</Text><Icon name="caret-right" size={14} color={actionIconColor} /></View>,
                submenu: { items: withSelection(densityItems, selectedDensity.id, ''), placement: 'right' },
            },
            // A new section is named in place, where it lands (lab `clsections:custom`).
            ...(openNewSection ? [{
                id: SESSION_LIST_NEW_SECTION_MENU_ITEM_ID,
                testID: 'session-list-view-new-section',
                title: t('sessionsList.newSection'),
                category: t('entityDragDrop.organize.title'),
                icon: <Icon name="plus" size={16} color={actionIconColor} />,
            } satisfies DropdownMenuItem] : []),
            // Phones drag only in an intentional Organize mode (lab K1); desktop rows carry themselves.
            ...(organize.available ? [{
                id: SESSION_LIST_ORGANIZE_MENU_ITEM_ID,
                title: t('entityDragDrop.organize.enter'),
                category: t('entityDragDrop.organize.title'),
                icon: <Icon name="dots-six-vertical" size={16} color={actionIconColor} />,
            } satisfies DropdownMenuItem] : []),
            ...(props.onOpenFilter ? [{
                id: SESSION_LIST_FILTER_MENU_ITEM_ID,
                testID: 'session-list-view-filter',
                title: t('sessionsList.spacesFilter'),
                icon: <Icon name="funnel-simple" size={16} color={actionIconColor} />,
            } satisfies DropdownMenuItem] : []),
            {
                id: SESSION_LIST_SETTINGS_MENU_ITEM_ID,
                testID: 'session-list-view-settings',
                title: t('sessionsList.spacesSessionListSettings'),
                icon: <Icon name="gear" size={16} color={actionIconColor} />,
            },
        ];
    }, [actionIconColor, densityItems, identityItems, openNewSection, organize.available, presentation, props.onOpenFilter, rowsCategory,
        sessionListDensity, sessionListIdentityDisplay, sessionListRowContextV1, sessionListStatusWords, styles.viewMenuValue, styles.viewMenuValueText, withSelection]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === SESSION_LIST_ORGANIZE_MENU_ITEM_ID) {
            setMenuOpen(false);
            organize.enter();
            return;
        }
        if (itemId === SESSION_LIST_NEW_SECTION_MENU_ITEM_ID) {
            setMenuOpen(false);
            openNewSection?.();
            return;
        }
        if (itemId === SESSION_LIST_FILTER_MENU_ITEM_ID) {
            setMenuOpen(false);
            props.onOpenFilter?.();
            return;
        }
        if (itemId === SESSION_LIST_SETTINGS_MENU_ITEM_ID) {
            setMenuOpen(false);
            router.push(SETTINGS_ROUTES.session as never);
            return;
        }
        if (itemId.startsWith('menu:')) return;
        if (!await applyViewOption(itemId)) return;
        // An explicit layout choice retires the host's opening intent, so the
        // choice applies here and now instead of only after leaving the route.
        if (itemId.startsWith('layout:')) yieldLayoutIntent();
        setMenuOpen(false);
    }, [applyViewOption, openNewSection, organize, props, router, yieldLayoutIntent]);

    return (
        <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
                setMenuOpen(open);
                props.onMenuOpenChange?.(open);
            }}
            items={menuItems}
            onSelect={handleMenuSelect}
            variant="slim"
            search={false}
            showCategoryTitles={true}
            separateCategories
            matchTriggerWidth={false}
            maxWidthCap={320}
            overlayStyle={VIEW_MENU_OVERLAY_STYLE}
            popoverPortalWebTarget="body"
            placement={props.placement ?? 'bottom'}
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
                <IconButton
                    testID="session-list-view-options-trigger"
                    accessibilityLabel={t('sessionsList.viewOptions')}
                    tooltip={t('sessionsList.viewOptions')}
                    tooltipHidden={menuOpen}
                    variant="plain"
                    size={SESSION_LIST_COLUMN_METRICS.iconButtonSizePx}
                    iconSize={ICON_SIZE.sm}
                    interactiveTargetGapPx={SESSION_LIST_COLUMN_METRICS.iconButtonGapPx}
                    expanded={menuOpen}
                    hasPopup="menu"
                    // The View menu rides the header's ⋯ (lab `clfilter:view`); Find and the title menu own filtering.
                    iconName="dots-three"
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        toggle();
                    }}
                />
            )}
        />
    );
});

/**
 * Projects or Recent (lab `clviews`): the one icon segmented control beside Find and View, bound to the one
 * stored layout (`session.list.layout`) through the same writer the View menu and Settings use. Choosing here
 * retires a route's opening intent, so the choice applies now.
 */
export const SessionListLayoutSegment = React.memo(function SessionListLayoutSegment() {
    const { theme } = useUnistyles();
    const effectiveLayout = useSessionListLayoutChoice();
    const yieldLayoutIntent = useYieldSessionListLayoutIntent();
    const applyViewOption = useSessionListViewOptionWriter();
    const iconColor = theme.colors.text.secondary;
    const reducedMotion = useReducedMotionPreference();
    const handleSelect = React.useCallback((next: SessionListLayoutChoice) => {
        if (next === effectiveLayout) return;
        // The rows glide to where the chosen layout puts them (P5 §6); reduced motion switches in place.
        if (Platform.OS === 'web' && !reducedMotion) captureSessionListLayoutFlight(next);
        void applyViewOption(`layout:${next}`).then((applied) => {
            if (applied) yieldLayoutIntent();
            else cancelSessionListLayoutFlight();
        });
    }, [applyViewOption, effectiveLayout, reducedMotion, yieldLayoutIntent]);
    return (
        <View style={sessionListStyles.layoutSegment}>
            <SegmentedTabBar<SessionListLayoutChoice>
                testIDPrefix="session-list-layout"
                accessibilityLabel={t('settingsSession.sessionList.layoutTitle')}
                role="radiogroup"
                compact
                segmentSizing="content"
                tabs={[
                    { id: 'projects', label: t('settingsSession.sessionList.layoutProjectsTitle'), icon: <Icon name="list-bullets" size={15} color={iconColor} /> },
                    { id: 'recent_activity', label: t('settingsSession.sessionList.layoutRecentActivityTitle'), icon: <Icon name="clock" size={15} color={iconColor} /> },
                ]}
                activeTabId={effectiveLayout === 'recent_activity' ? 'recent_activity' : 'projects'}
                onSelectTab={handleSelect}
            />
        </View>
    );
});

export const SessionsListHeader = React.memo(function SessionsListHeader() {
    const styles = sessionListStyles;
    // Wide layouts show the home hub beside this list, and its "Get set up" section owns the
    // recovery-key step; a second card here would repeat it. A phone's Home is a pushed page, so a
    // person who stays on Sessions would never see it: it stays here, one line above the list.
    const wideLayout = useIsTablet();
    if (wideLayout) return null;

    return (
        <View style={styles.listHeaderSection}>
            <RecoveryKeyReminderBanner />
        </View>
    );
});


export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    machineSubtitle?: string;
    hasMultipleMachines: boolean;
    displayTitle: string;
    hasCustomLabel: boolean;
    canOpenProject: boolean;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    newSessionEnabled?: boolean;
    onOpenProject: () => void;
    onCreateSession: () => void;
    onAddFolder: () => void;
    onRename: () => void;
    onReset: () => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onRegisterDropTarget?: RegisterSessionFolderDropTarget;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    /** The column's first group sits closer to the header. */
    first?: boolean;
    /**
     * The header VM's accepted baseline (P5): `null` means no baseline, so no favicon is asked for.
     * Only a header drawn without a VM falls back to the item's own scope.
     */
    faviconSource?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
    /** The held baseline Machine's canonical reachability; false keeps the folder mark. */
    faviconSourceReachable?: boolean;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const machineSubtitle = props.machineSubtitle ?? props.item.subtitle;
    const { item, hasMultipleMachines, displayTitle, hasCustomLabel, canOpenProject, workspaceFaviconsEnabled = false, workspaceMachineSubtitlesEnabled = true, newSessionEnabled = true, onOpenProject, onCreateSession, onAddFolder, onRename, onReset, collapsed, onToggleCollapse } = props;
    const [menuOpen, setMenuOpen] = React.useState(false);
    const newSessionTarget = resolveNewSessionGroupTarget(item);
    const projectServerId = newSessionTarget?.serverId ?? item.serverId ?? null;
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders', projectServerId
        ? { scopeKind: 'spawn', serverId: projectServerId }
        : { scopeKind: 'main_selection' });
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = newSessionEnabled && newSessionTarget !== null;
    const actionReach = groupActionHitReach(theme.space.s4);
    const faviconSource = props.faviconSource !== undefined ? props.faviconSource : item.workspaceScopeHint ?? null;
    const favicon = useWorkspaceFavicon({
        enabled: workspaceFaviconsEnabled,
        serverId: faviconSource?.serverId ?? item.serverId ?? null,
        machineId: faviconSource?.machineId ?? null,
        workspacePath: faviconSource?.rootPath ?? null,
        reachable: props.faviconSourceReachable,
    });
    const workspace = React.useMemo(() => resolveDurableWorkspaceRefForSessionListHeader(item), [item]);
    const dropTarget = React.useMemo(() => {
        if (!workspace) return null;
        return {
            type: 'workspace-root' as const,
            workspace,
            serverId: item.serverId ?? workspace.serverId ?? null,
        };
    }, [item.serverId, workspace]);
    const workspaceRootRowId = resolveWorkspaceRootTreeRowId(item, displayTitle);
    const headerTestId = `session-list-project-header:${item.groupKey ?? item.title}`;
    const dropRegistration = useMeasuredDropTargetRegistration({
        id: dropTarget ? workspaceRootRowId : null,
        target: dropTarget,
        onRegister: props.onRegisterDropTarget,
    });

    const menuItems = resolveProjectGroupHeaderMenuItems({
        canOpenProject,
        canAddFolder: sessionFoldersFeatureEnabled && workspace !== null,
        canRename: Boolean(item.projectKey) && item.workspace?.t !== 'managedSessions',
        hasCustomLabel,
        canMoveUp: typeof props.onMoveUp === 'function',
        canMoveDown: typeof props.onMoveDown === 'function',
        actionIconColor,
    });
    const menuEnabled = menuItems.length > 0;

    const mark = favicon ? (
        <View testID="session-list-workspace-favicon" style={styles.groupHeaderFaviconFrame}>
            <ReactNativeImage
                source={{ uri: favicon.uri }}
                style={styles.groupHeaderFavicon}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
            />
        </View>
    ) : <Icon name="folder" size={13} color={theme.colors.text.tertiary} />;
    // The group's own operations ride with the pointer (lab `.ls-h .act`): ⋯ then New session here.
    const actions = (
        <>
            {menuEnabled ? (
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={menuItems}
                    onSelect={(itemId) => {
                        if (itemId === 'moveUp') {
                            props.onMoveUp?.();
                        } else if (itemId === 'moveDown') {
                            props.onMoveDown?.();
                        } else if (itemId === 'openProject') {
                            onOpenProject();
                        } else if (itemId === 'addFolder') {
                            onAddFolder();
                        } else if (itemId === 'rename') {
                            onRename();
                        } else if (itemId === 'reset') {
                            onReset();
                        }
                    }}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    variant="slim"
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    showCategoryTitles={false}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <HappierPressable
                            style={styles.groupHeaderActionButton}
                            hitTarget={GROUP_ACTION_HIT_TARGET}
                            hitReach={actionReach.menu}
                            onPress={(event) => {
                                stopPressEventPropagation(event);
                                toggle();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('common.moreActions')}
                        >
                            <Icon name="dots-three" size={14} color={actionIconColor} />
                        </HappierPressable>
                    )}
                />
            ) : null}
            {canCreateSession ? (
                <HappierPressable
                    style={styles.groupHeaderActionButton}
                    hitTarget={GROUP_ACTION_HIT_TARGET}
                    hitReach={actionReach.create}
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        onCreateSession();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={newSessionTarget && 'kind' in newSessionTarget && newSessionTarget.kind === 'managed'
                        ? t('newSession.title')
                        : t('machine.launchNewSessionInDirectory')}
                >
                    <Icon name="plus" size={14} color={actionIconColor} />
                </HappierPressable>
            ) : null}
        </>
    );
    return (
        <View ref={dropRegistration.ref} onLayout={dropRegistration.onLayout} collapsable={false}>
            <CollectionListGroupLabel
                testID={headerTestId}
                title={displayTitle}
                detail={workspaceMachineSubtitlesEnabled && hasMultipleMachines && machineSubtitle ? machineSubtitle : undefined}
                first={props.first}
                rollup={<WorkStatusRollup rollup={props.item.rollup} testID={`${headerTestId}:rollup`} />}
                mark={mark}
                disclosure={{ expanded: !collapsed, onToggle: onToggleCollapse }}
                actions={actions}
                actionsHeld={menuOpen}
            />
        </View>
    );
});

/** The glyph a column's own groups lead with (lab `clgroups`): amber only where the person is needed. */
const SECTION_HEADER_MARKS: Partial<Record<NonNullable<SessionListHeaderItemKind>, Readonly<{ icon: IconName; attention?: boolean }>>> = {
    attention: { icon: 'tray', attention: true },
    working: { icon: 'pulse' },
    pinned: { icon: 'push-pin' },
};

type SessionListHeaderItemKind = Extract<SessionListIndexItem, { type: 'header' }>['headerKind'];

/**
 * A column group's label that folds its rows (Needs you, Working, Pinned, a date or Home): the shared list
 * label on the plane — glyph, sentence-case title, quiet count and the chevron after them — 24 apart from
 * the group above it and tight to its own first row.
 */
export const CollapsibleSectionHeader = React.memo(function CollapsibleSectionHeader(props: Readonly<{
    /** Admitted facts from the membership owner before local disclosure hides rows. */
    rollup?: CollectionGroupRollup;
    title: string;
    collapsed: boolean;
    onPress: () => void;
    /** Opens what the group stands for (Needs you → Inbox); the chevron then folds it on its own. */
    onOpen?: () => void;
    headerKind?: SessionListHeaderItemKind;
    /** How many the group holds now; omitted while unknown. */
    count?: number;
    /** The column's first group sits closer to the header. */
    first?: boolean;
    testID?: string;
    rootMeasurement?: Readonly<{
        active: boolean;
        ref: React.Ref<View>;
        onLayout: NonNullable<ViewProps['onLayout']>;
        style?: StyleProp<ViewStyle>;
    }>;
}>) {
    const { theme } = useUnistyles();
    const markSpec = props.headerKind ? SECTION_HEADER_MARKS[props.headerKind] : undefined;
    const mark = markSpec ? (
        <Icon name={markSpec.icon} size={13}
            color={markSpec.attention ? theme.colors.state.warning.foreground : theme.colors.text.tertiary} />
    ) : undefined;
    const label = (
        <CollectionListGroupLabel
            title={props.title}
            count={props.count}
            first={props.first}
            mark={mark}
            testID={props.testID}
            rollup={props.testID ? <WorkStatusRollup rollup={props.rollup} testID={`${props.testID}:rollup`} /> : undefined}
            disclosure={{
                expanded: !props.collapsed,
                onToggle: props.onPress,
                ...(props.onOpen ? {
                    onOpen: props.onOpen,
                    openAccessibilityLabel: t('sessionsList.openNeedsYouInInbox'),
                    toggleAccessibilityLabel: props.collapsed ? t('common.expand') : t('common.collapse'),
                } : {}),
            }}
        />
    );
    if (!props.rootMeasurement) return label;
    return (
        <View
            ref={props.rootMeasurement.ref}
            collapsable={props.rootMeasurement.active ? false : undefined}
            style={props.rootMeasurement.style}
            onLayout={props.rootMeasurement.onLayout}
        >
            {label}
        </View>
    );
});

/**
 * A section's label (lab `clsections:custom`): its own icon, sentence-case name and complete membership
 * count, folding from the label; New session here and ⋯ ride with the pointer. Sections are flat Account
 * filing, so the label sits on the column's text edge whatever a legacy definition's parents were.
 */
export const SessionSectionHeader = React.memo(function SessionSectionHeader(props: Readonly<{
    title: string;
    /** The section's chosen icon; unknown names keep the default lines. */
    icon: string | null;
    /** Complete assignment membership; omitted while it is not proven (unknown is not zero). */
    memberCount?: number;
    /** Whether this view draws any of its members; a counted section with none says where they are. */
    hasRowsInView?: boolean;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onNewSession?: () => void;
    onRename: () => void | Promise<void>;
    onChangeIcon: (icon: IconName) => void | Promise<void>;
    onRemove: () => void | Promise<void>;
    /** Archives the section's exact membership; omitted where the list cannot archive. */
    onArchiveAll?: () => void | Promise<void>;
    onMove?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    onRegisterDropTarget?: RegisterSessionFolderDropTarget;
    disabled?: boolean;
    /** The column's first group sits closer to the header. */
    first?: boolean;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const displayLocked = props.item.displayState?.status === 'locked';
    const displayTitle = props.item.displayState?.status === 'locked'
        ? resolveSessionSectionDisplayTitle(props.item.displayState) : props.title;
    const actionsDisabled = props.disabled || displayLocked;
    const actionReach = groupActionHitReach(theme.space.s4);
    const iconColor = actionsDisabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    // Archive all works by the section's id, so a locked name does not stop it; a proven-empty section has nothing to archive.
    const archiveDisabled = props.disabled === true || props.memberCount === 0;
    const archiveIconColor = archiveDisabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    const sectionIcon = resolveSessionSectionIcon(props.icon);
    const dropTarget = React.useMemo(() => {
        if (!props.item.workspace || !props.item.folderId) return null;
        return {
            type: 'folder' as const,
            folderId: props.item.folderId,
            workspace: props.item.workspace,
            serverId: props.item.serverId ?? props.item.workspace.serverId ?? null,
        };
    }, [props.item.folderId, props.item.serverId, props.item.workspace]);
    const dropRegistration = useMeasuredDropTargetRegistration({
        id: dropTarget && dropTarget.serverId
            ? treeRowId.folder(dropTarget.serverId, dropTarget.folderId)
            : null,
        target: dropTarget,
        onRegister: props.onRegisterDropTarget,
    });
    const menuItems = React.useMemo((): DropdownMenuItem[] => [
        {
            id: 'rename',
            title: t('common.rename'),
            icon: <Icon name="pencil-simple" size={16} color={iconColor} />,
            disabled: actionsDisabled,
            category: 'edit',
        },
        {
            id: 'icon',
            title: t('sessionsList.sectionChangeIcon'),
            icon: <Icon name={sectionIcon} size={16} color={iconColor} />,
            disabled: actionsDisabled,
            category: 'edit',
            submenu: {
                title: t('sessionsList.sectionChangeIcon'),
                maxWidthCap: 200,
                items: SESSION_SECTION_ICON_CHOICES.map((choice) => ({
                    id: `icon:${choice}`,
                    title: t(`sessionsList.sectionIcons.${choice}` as never),
                    icon: <Icon name={choice} size={16} color={theme.colors.text.secondary} />,
                    checked: choice === sectionIcon,
                })),
            },
        },
        ...(props.onNewSession ? [{
            id: 'new-session',
            title: t('sessionsList.sectionNewSessionHere'),
            icon: <Icon name="plus" size={16} color={iconColor} />,
            disabled: actionsDisabled,
            category: 'edit',
        }] : []),
        ...(props.onArchiveAll ? [{
            id: 'archive-all',
            title: t('sessionsList.sectionArchiveAll'),
            icon: <Icon name="archive" size={16} color={archiveIconColor} />,
            disabled: archiveDisabled,
            category: 'remove',
        }] : []),
        {
            id: 'remove',
            title: t('sessionsList.removeSection'),
            subtitle: t('sessionsList.removeSectionDetail'),
            icon: <Icon name="minus-circle" size={16} color={theme.colors.text.secondary} />,
            category: 'remove',
        },
    ], [actionsDisabled, archiveDisabled, archiveIconColor, iconColor, props.onArchiveAll, props.onNewSession, sectionIcon, theme.colors.text.secondary]);
    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'remove') {
            await props.onRemove();
            return;
        }
        if (itemId === 'archive-all') {
            if (!archiveDisabled) await props.onArchiveAll?.();
            return;
        }
        if (actionsDisabled) return;
        if (itemId === 'new-session') {
            props.onNewSession?.();
        } else if (itemId === 'rename') {
            await props.onRename();
        } else if (itemId.startsWith('icon:')) {
            const choice = SESSION_SECTION_ICON_CHOICES.find((candidate) => `icon:${candidate}` === itemId);
            if (choice) await props.onChangeIcon(choice);
        }
    }, [actionsDisabled, props]);
    const sectionAccessibilityActions = React.useMemo(() => {
        const actions: Array<{ name: string; label: string }> = [];
        if (typeof props.onMoveUp === 'function') {
            actions.push({ name: 'moveUp', label: t('common.moveUp') });
        }
        if (typeof props.onMoveDown === 'function') {
            actions.push({ name: 'moveDown', label: t('common.moveDown') });
        }
        return actions;
    }, [props.onMoveDown, props.onMoveUp]);
    const handleSectionAccessibilityAction = React.useCallback((event: { nativeEvent?: { actionName?: string } }) => {
        if (actionsDisabled) return;
        switch (event.nativeEvent?.actionName) {
            case 'moveUp':
                props.onMoveUp?.();
                break;
            case 'moveDown':
                props.onMoveDown?.();
                break;
            default:
                break;
        }
    }, [actionsDisabled, props]);
    const sectionKey = props.item.folderId ?? props.title;
    const headerTestId = `session-folder-header-${sectionKey}`;
    const touchPrimary = useHappierTouchPrimaryPointer(Platform.OS);
    return (
        <View ref={dropRegistration.ref} onLayout={dropRegistration.onLayout} collapsable={false}>
            <CollectionListGroupLabel
                testID={headerTestId}
                title={displayTitle}
                count={props.memberCount}
                first={props.first}
                rollup={<WorkStatusRollup rollup={props.item.rollup} testID={`${headerTestId}:rollup`} />}
                mark={<Icon name={sectionIcon} size={13} color={theme.colors.text.tertiary} />}
                disclosure={{
                    expanded: !props.collapsed,
                    onToggle: props.onToggleCollapse,
                    toggleAccessibilityLabel: props.collapsed ? t('common.expand') : t('common.collapse'),
                    accessibilityActions: sectionAccessibilityActions,
                    onAccessibilityAction: sectionAccessibilityActions.length > 0 ? handleSectionAccessibilityAction : undefined,
                    disabled: actionsDisabled,
                }}
                actionsHeld={menuOpen}
                actions={(
                    <>
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={handleMenuSelect}
                            placement="bottom"
                            popoverAnchorAlign="end"
                            variant="slim"
                            matchTriggerWidth={false}
                            maxWidthCap={240}
                            showCategoryTitles={false}
                            separateCategories
                            popoverPortalWebTarget="body"
                            trigger={({ toggle }) => (
                                <HappierPressable
                                    testID={`session-folder-menu-trigger-${sectionKey}`}
                                    style={styles.groupHeaderActionButton}
                                    hitTarget={GROUP_ACTION_HIT_TARGET}
                                    hitReach={actionReach.menu}
                                    onPress={(event) => {
                                        stopPressEventPropagation(event);
                                        toggle();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.moreActions')}
                                >
                                    <Icon name="dots-three" size={14} color={theme.colors.text.secondary} />
                                </HappierPressable>
                            )}
                        />
                        {props.onNewSession && !actionsDisabled ? (
                            <HappierPressable
                                testID={`session-folder-new-session-${sectionKey}`}
                                style={styles.groupHeaderActionButton}
                                hitTarget={GROUP_ACTION_HIT_TARGET}
                                hitReach={actionReach.create}
                                onPress={(event) => {
                                    stopPressEventPropagation(event);
                                    props.onNewSession?.();
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={t('sessionsList.sectionNewSessionHere')}
                            >
                                <Icon name="plus" size={14} color={theme.colors.text.secondary} />
                            </HappierPressable>
                        ) : null}
                    </>
                )}
            />
            {props.memberCount === 0 && !props.collapsed && !displayLocked ? (
                // Under a finger the place is a destination you move to (Organize, the move sheet); the hint
                // is a note, not a control, so it keeps the list row's own height.
                <View style={styles.sectionQuietHint}
                    testID={`${headerTestId}:drop-hint`}>
                    <Text variant="meta" style={styles.sectionDropHintText} numberOfLines={1}>
                        {touchPrimary ? t('sessionsList.sectionDropHintTouch') : t('sessionsList.sectionDropHint')}
                    </Text>
                </View>
            ) : null}
            {(props.memberCount ?? 0) > 0 && props.hasRowsInView === false && !props.collapsed && !displayLocked ? (
                <View style={styles.sectionQuietHint} testID={`${headerTestId}:outside-view`}>
                    <Text variant="meta" style={styles.sectionDropHintText} numberOfLines={1}>
                        {t('sessionsList.sectionMembersOutsideView', { count: props.memberCount ?? 0 })}
                    </Text>
                </View>
            ) : null}
        </View>
    );
});
