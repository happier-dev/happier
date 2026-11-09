import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';

import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { useItemRowHovered } from '@/components/ui/lists/ItemRowHover';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { projectWorkspaceRefV1, type QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { executeWorkspaceUiAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { resolveStoreProjectRef } from '@/components/settings/plugins/model/useStoreProjectScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readCurrentProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type ProjectsListItemMenuProps = Readonly<{
    testID?: string;
    /** The checkout the row opens; `null` on a Project row with several checkouts (Hide only). */
    workspaceRef: WorkspaceRefV1 | null;
    /** Project rows with several checkouts have a Project anchor but no selected checkout. */
    project?: QualifiedProjectKeyV1;
    pinAction?: 'pin' | 'unpin' | null;
    onTogglePinned: (workspaceRefId: string) => void;
    onRename: (workspaceRef: WorkspaceRefV1) => void | Promise<void>;
    onReset: (workspaceRef: WorkspaceRefV1) => void;
    onRemove: (workspaceRef: WorkspaceRefV1) => void;
    /** U2 renders these intents; their placement/creation authority stays in the shared model. */
    onNewSession?: (workspaceRef: WorkspaceRefV1) => unknown;
    onSaveAsSource?: (workspaceRef: WorkspaceRefV1) => unknown;
    /** Hide the Project this row belongs to (lab p-projects HIDE); its sessions and files stay. */
    onHideProject?: (() => void) | null;
    /**
     * The person's grouping (owner 11-08): "Group with…" another Project (targets read when the menu opens), and
     * "Separate from project" for a checkout that shares its Project. Both go through `projects.workspace.update`.
     */
    grouping?: Readonly<{
        targets: () => ReadonlyArray<Readonly<{ key: string; title: string; subtitle?: string }>>;
        onGroup: (projectKey: string) => void;
        onSeparate: (() => void) | null;
    }> | null;
}>;

const ROW_MENU_BUTTON_PX = 24;
/**
 * The free space around the button inside the shortest row (the button is centred in it). Stacked rows
 * touch, so the finger reach stops at the row's own edge and a neighbour's trigger never shares it.
 */
const ROW_MENU_VERTICAL_GAP_PX = HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight - ROW_MENU_BUTTON_PX;

function stopPressEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

/**
 * The menu model and its popover. Mounted only while the row's menu is open, so a closed row costs just its
 * trigger (`ProjectsListItemMenu`): no item list, no icons, no dropdown hooks.
 */
function ProjectsListItemMenuPopover(props: ProjectsListItemMenuProps & Readonly<{
    anchorRef: React.RefObject<View | null>;
    onClose: () => void;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const project = React.useMemo(() => props.project ?? (props.workspaceRef ? projectWorkspaceRefV1(props.workspaceRef) : null),
        [props.project, props.workspaceRef]);
    const pinTitle = props.pinAction === 'unpin'
        ? t('projects.actions.unpin')
        : props.pinAction === 'pin'
            ? t('projects.actions.pin')
            : null;
    const renameTitle = t('sessionsList.renameWorkspace');
    const resetTitle = t('sessionsList.resetWorkspaceName');
    const removeTitle = t('projects.actions.remove');
    const canHide = Boolean(props.onHideProject);
    const hasWorkspaceRef = props.workspaceRef != null;
    const canStartSession = Boolean(props.onNewSession);
    const canSaveAsSource = Boolean(props.onSaveAsSource);
    const { grouping } = props;
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => {
        const nextItems: DropdownMenuItem[] = [];
        // This popover mounts only while the menu is open, so the targets are read on open.
        const groupItems: DropdownMenuItem[] = grouping ? [{
            id: 'group',
            title: t('projects.identity.groupWith'),
            icon: <Icon name="stack" size={16} color={theme.colors.text.secondary} />,
            submenu: { search: true, searchPlaceholder: t('projects.identity.groupWithSearch'), items: grouping.targets().map(target => ({
                id: `group:${target.key}`, title: target.title, ...(target.subtitle ? { subtitle: target.subtitle } : {}),
            })) },
        }, ...(grouping.onSeparate ? [{
            id: 'separate',
            title: t('projects.identity.separateFromProject'),
            icon: <Icon name="arrow-square-out" size={16} color={theme.colors.text.secondary} />,
        }] : [])] : [];
        const hideItem: DropdownMenuItem | null = canHide ? {
            id: 'hide',
            title: t('projects.identity.hide'),
            subtitle: t('projects.identity.hideConsequence'),
            icon: <Icon name="eye-slash" size={16} color={theme.colors.text.secondary} />,
        } : null;
        const browseStore: DropdownMenuItem[] = project ? [{ id: 'browse-store', title: t('capabilities.store.browseStore'),
            icon: <Icon name="cube" size={16} color={theme.colors.text.secondary} /> }] : [];
        if (!hasWorkspaceRef) return [...nextItems, ...browseStore, ...groupItems, ...(hideItem ? [hideItem] : [])];
        // Lab p-projects HIDE: start work here and keep the repository first, then the row's own edits.
        if (canStartSession) {
            nextItems.push({
                id: 'new-session',
                title: t('projects.identity.newSessionHere'),
                icon: <Icon name="plus" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if (canSaveAsSource) {
            nextItems.push({
                id: 'save-source',
                title: t('projects.identity.saveAsSource'),
                icon: <Icon name="books" size={16} color={theme.colors.text.secondary} />,
            });
        }
        if ((props.pinAction === 'pin' || props.pinAction === 'unpin') && pinTitle) {
            nextItems.push({
                id: props.pinAction,
                title: pinTitle,
                icon: <Icon name="push-pin" size={16} color={theme.colors.text.secondary} />,
            });
        }
        nextItems.push(...browseStore, ...groupItems);
        nextItems.push(
            {
                id: 'rename',
                title: renameTitle,
                icon: <Icon name="pencil" size={16} color={theme.colors.text.secondary} />,
            },
            {
                id: 'reset',
                title: resetTitle,
                icon: <Icon name="arrow-clockwise" size={16} color={theme.colors.text.secondary} />,
            },
            {
                id: 'remove',
                title: removeTitle,
                icon: <Icon name="trash" size={16} color={theme.colors.state.danger.foreground} />,
            },
        );
        // Hide sits before Remove: it keeps everything, Remove forgets the checkout.
        if (hideItem) nextItems.splice(nextItems.length - 1, 0, hideItem);
        return nextItems;
    }, [canHide, canSaveAsSource, canStartSession, grouping, hasWorkspaceRef, pinTitle, project, props.pinAction, theme.colors.state.danger.foreground, theme.colors.text.secondary, removeTitle, renameTitle, resetTitle]);

    const handleSelect = useEventCallback((itemId: string) => {
        if (itemId === 'browse-store') {
            const lifetime = captureActiveServerAccountScopeLifetime();
            const ref = resolveStoreProjectRef(project, readCurrentProjectAccountRows(getStorage().getState()), lifetime?.isCurrent() ? lifetime.scope : null);
            if (ref) void executeWorkspaceUiAction({ actionId: 'workspace.tabs.open', input: {
                href: buildPluginsHomeRoute('app', { view: 'discover', project: projectWorkspaceRefV1(ref) }),
            } }, href => router.push(href));
            return;
        }
        if (itemId.startsWith('group:')) { props.grouping?.onGroup(itemId.slice('group:'.length)); return; }
        if (itemId === 'separate') { props.grouping?.onSeparate?.(); return; }
        if (itemId === 'hide') {
            props.onHideProject?.();
            return;
        }
        if (!props.workspaceRef) return;
        if (itemId === 'new-session') {
            void props.onNewSession?.(props.workspaceRef);
            return;
        }
        if (itemId === 'save-source') {
            void props.onSaveAsSource?.(props.workspaceRef);
            return;
        }
        if ((itemId === 'pin' || itemId === 'unpin') && props.pinAction) {
            props.onTogglePinned(props.workspaceRef.id);
            return;
        }
        if (itemId === 'rename') {
            void props.onRename(props.workspaceRef);
            return;
        }
        if (itemId === 'reset') {
            props.onReset(props.workspaceRef);
            return;
        }
        if (itemId === 'remove') {
            props.onRemove(props.workspaceRef);
        }
    });

    return (
        <DropdownMenu
            open
            onOpenChange={(next) => { if (!next) props.onClose(); }}
            items={items}
            onSelect={handleSelect}
            trigger={null}
            popoverAnchorRef={props.anchorRef}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={240}
            showCategoryTitles={false}
            popoverPortalWebTarget="body"
        />
    );
}

export const ProjectsListItemMenu = React.memo((props: ProjectsListItemMenuProps) => {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const rowHovered = useItemRowHovered();
    const coarsePrimaryPointer = useCoarsePrimaryPointer();
    const close = React.useCallback(() => setOpen(false), []);
    return (
        <View ref={anchorRef} collapsable={false} style={{ position: 'relative' }}>
            {/* Quiet until the row is engaged (lab TREE shows no menu at rest): the shared reveal slot keeps
                its place and stays focusable, and touch screens always show it. */}
            <RowActionRevealSlot revealed={Platform.OS !== 'web' || coarsePrimaryPointer || rowHovered || open}>
                {/* The shared icon-only button and the row menu's glyph (the Sessions rows' "⋯"). */}
                <IconButton
                    testID={props.testID}
                    iconName="dots-three"
                    variant="plain"
                    size={ROW_MENU_BUTTON_PX}
                    interactiveTargetVerticalGapPx={ROW_MENU_VERTICAL_GAP_PX}
                    accessibilityLabel={t('common.moreActions')}
                    expanded={open}
                    tooltipHidden={open}
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        setOpen((current) => !current);
                    }}
                />
            </RowActionRevealSlot>
            {open ? <ProjectsListItemMenuPopover {...props} anchorRef={anchorRef} onClose={close} /> : null}
        </View>
    );
});
