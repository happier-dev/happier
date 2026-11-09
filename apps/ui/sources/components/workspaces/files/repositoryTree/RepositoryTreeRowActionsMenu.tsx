import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useDeviceType } from '@/utils/platform/responsive';
import type { FilesystemBrowserRowActionsControl } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { resolveFileMenuItems, type FileMenuContext } from '@/components/workspaces/files/file/fileMenus';
import { useWorkspaceFileShareActions, type WorkspaceFileShareActionsInput } from '@/components/workspaces/files/file/useWorkspaceFileShareActions';
import type { WorkspaceFileTarget } from '@happier-dev/protocol/actions/workspaceActionFamily';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { openSaveFileAsArtifactDialog } from '@/components/workspaces/files/file/SaveFileAsArtifactDialog';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

/** What a tree row's Share items act on: the canonical share owner runs them for the row's own path. */
export type RepositoryTreeRowShareTarget = Readonly<{
    workspaceScope: WorkspaceShareScope;
    actionScope: WorkspaceFileShareActionsInput['actionScope'];
    /** Where a Happier link to the file opens (its Session or Project); no target, no Copy Happier link. */
    linkTarget?: WorkspaceFileTarget | null;
    /** The composer Attach to message adds the file to (the Session's own); none, no Attach. */
    composer?: WorkspaceFileShareActionsInput['composer'];
}>;
type WorkspaceShareScope = WorkspaceFileShareActionsInput['workspaceScope'];

export type RepositoryTreeRowActionMenuItemId =
    | 'repository-tree-menuitem-rename'
    | 'repository-tree-menuitem-delete'
    | 'repository-tree-menuitem-download'
    | 'repository-tree-menuitem-zip'
    | 'repository-tree-menuitem-copy-path'
    | 'repository-tree-menuitem-new-folder'
    | 'repository-tree-menuitem-upload';

type RepositoryTreeRowActionItem = Omit<ItemAction, 'onPress'>;

/** One glyph per item of the shared file menu (lab FB1k); an item without one keeps the file mark. */
const FILE_MENU_ITEM_ICONS: Readonly<Record<string, ItemAction['icon']>> = {
    open: 'eye',
    openBeside: 'square-split-horizontal',
    openWithBlame: 'clock-counter-clockwise',
    copyPath: 'copy',
    copyLink: 'link',
    mentionInComposer: 'at',
    saveAsArtifact: 'file-arrow-up',
    download: 'download',
    shareFile: 'share-network',
    rename: 'pencil-simple',
    openInDefaultApp: 'arrow-square-out',
    restoreBeforeTurn: 'clock-counter-clockwise',
    discard: 'arrow-arc-left',
};

// Touch rows open the menu from a long press; the anchor stays, the … is not drawn.
const renderNoTrigger = () => null;

export function RepositoryTreeRowActionsMenu(props: Readonly<{
    path: string;
    href?: string | null;
    kind: 'file' | 'directory';
    disableWriteActions: boolean;
    downloadActionsEnabled: boolean;
    fileMenuContext?: Partial<FileMenuContext>;
    share?: RepositoryTreeRowShareTarget | null;
    onSelect: (itemId: RepositoryTreeRowActionMenuItemId) => void;
    /**
     * A folder's own creation actions (lab p-code ACTIONS): a new folder or uploaded files land inside it.
     * Offered only by hosts that own those effects.
     */
    folderCreation?: Readonly<{ newFolder: boolean; upload: boolean }> | null;
    /** The tree row's reveal: open from a long press, and no … drawn under a finger. */
    control?: FilesystemBrowserRowActionsControl;
}>) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const workspaceOpen = useWorkspaceOpenActions(props.kind === 'file' ? props.href ?? null : null);
    const machineReachable = props.fileMenuContext?.machineReachable ?? !props.disableWriteActions;
    const unavailableReason = props.fileMenuContext?.unavailableReason ?? t('errors.daemonUnavailableBody');
    const file = props.kind === 'file';
    const router = useRouter();
    // A folder publishes as one HTML Artifact (V-OP-01): the same Save as Artifact… and Action as a file,
    // naming the page it opens with. The File page owns the single-file entry.
    const actionScope = props.share?.actionScope ?? null;
    const workspaceScope = props.share?.workspaceScope ?? null;
    const linkTarget = props.share?.linkTarget ?? null;
    const saveFolderAsArtifact = React.useMemo(() => props.kind === 'directory' && actionScope && workspaceScope ? () => {
        if (!areServerAccountScopesEqual(actionScope, getActiveServerAccountScope())) return;
        const sourceSessionId = linkTarget?.kind === 'session' ? linkTarget.sessionId : null;
        openSaveFileAsArtifactDialog({
            source: { scope: actionScope, sourceSessionId, filePath: props.path, entrypoint: 'index.html',
                sourceWorkspace: sourceSessionId ? null : { machineId: workspaceScope.machineId, rootPath: workspaceScope.rootPath } },
            sourceFacts: props.path,
            onOpenArtifact: (artifactId: string) => {
                if (areServerAccountScopesEqual(actionScope, getActiveServerAccountScope())) router.push(artifactViewRoute(artifactId) as never);
            },
        });
    } : undefined, [actionScope, linkTarget, props.kind, props.path, router, workspaceScope]);
    // The File page's share owner, for this row's path: Copy path / Happier link, Attach and Open in go through it.
    const share = useWorkspaceFileShareActions({
        workspaceScope: props.share?.workspaceScope ?? null,
        path: props.path,
        entryKind: props.kind,
        actionScope: props.share?.actionScope ?? null,
        linkInput: file && props.share?.linkTarget ? { target: props.share.linkTarget, path: props.path } : undefined,
        machineReachable,
        unavailableReason,
        composer: props.share?.composer ?? null,
    });
    const sharedContext = React.useMemo<FileMenuContext>(() => ({
        ...props.fileMenuContext,
        machineReachable,
        unavailableReason,
        hasCachedContent: props.fileMenuContext?.hasCachedContent ?? false,
        platform: props.fileMenuContext?.platform ?? (Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web'),
        isDirectory: props.kind === 'directory',
        copyPath: props.fileMenuContext?.copyPath ?? (share.copyPath ? () => share.copyPath?.()
            : () => props.onSelect('repository-tree-menuitem-copy-path')),
        copyLink: props.fileMenuContext?.copyLink ?? share.copyLink,
        mentionInComposer: props.fileMenuContext?.mentionInComposer ?? share.mentionInComposer,
        openInDefaultApp: props.fileMenuContext?.openInDefaultApp ?? (file ? share.openInDefaultApp : undefined),
        saveAsArtifact: props.fileMenuContext?.saveAsArtifact ?? saveFolderAsArtifact,
        shareFile: props.fileMenuContext?.shareFile ?? (file ? share.shareFile : undefined),
        rename: props.fileMenuContext?.rename ?? (() => props.onSelect('repository-tree-menuitem-rename')),
        download: props.fileMenuContext?.download ?? (props.kind === 'file' && props.downloadActionsEnabled ? () => props.onSelect('repository-tree-menuitem-download') : undefined),
        openBeside: props.fileMenuContext?.openBeside ?? (workspaceOpen.items.some(item => item.id === 'workspace.open.right')
            ? () => { workspaceOpen.open('splitRight'); } : undefined),
    }), [file, machineReachable, saveFolderAsArtifact, props.downloadActionsEnabled, props.fileMenuContext, props.kind, props.onSelect, share.mentionInComposer,
        share.copyLink, share.copyPath, share.openInDefaultApp, share.shareFile, unavailableReason, workspaceOpen]);
    const sharedItems = React.useMemo(() => resolveFileMenuItems(sharedContext, 'treeRow'), [sharedContext]);
    const sharedActions = React.useMemo(() => sharedItems.map(item => ({
        id: `repository-tree-menuitem-${item.id === 'copyPath' ? 'copy-path' : item.id}`,
        title: item.title ?? t(item.titleKey),
        icon: FILE_MENU_ITEM_ICONS[item.id] ?? 'file',
        disabled: item.state !== 'enabled',
        subtitle: item.state === 'enabled' ? undefined : item.state.disabledReason,
        destructive: item.destructive,
        onPress: () => item.run(),
    } satisfies ItemAction)), [sharedItems]);

    const items = React.useMemo<RepositoryTreeRowActionItem[]>(() => {
        // Delete is last and reads as destructive (lab p-code ACTIONS); it still asks first.
        const deleteItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-delete',
            title: t('files.repositoryTree.actions.deleteEllipsis'),
            icon: 'trash',
            destructive: true,
            disabled: props.disableWriteActions,
        };

        if (props.kind === 'file') {
            return [
                ...(props.downloadActionsEnabled
                    ? ([
                        {
                            id: 'repository-tree-menuitem-zip',
                            title: t('files.repositoryTree.actions.downloadAsZip'),
                            icon: 'download',
                            color: theme.colors.text.secondary,
                        },
                    ] satisfies RepositoryTreeRowActionItem[])
                    : []),
                deleteItem,
            ];
        }

        return [
            ...(props.downloadActionsEnabled
                ? ([
                    {
                        id: 'repository-tree-menuitem-zip',
                        title: t('files.repositoryTree.actions.downloadAsZip'),
                        icon: 'download',
                        color: theme.colors.text.secondary,
                    },
                ] satisfies RepositoryTreeRowActionItem[])
                : []),
            ...(props.folderCreation?.newFolder ? [{
                id: 'repository-tree-menuitem-new-folder',
                title: t('files.repositoryTree.actions.newFolderEllipsis'),
                icon: 'folder-plus',
                color: theme.colors.text.secondary,
                disabled: props.disableWriteActions,
            } satisfies RepositoryTreeRowActionItem] : []),
            ...(props.folderCreation?.upload ? [{
                id: 'repository-tree-menuitem-upload',
                title: t('files.repositoryTree.actions.uploadFilesEllipsis'),
                icon: 'upload',
                color: theme.colors.text.secondary,
            } satisfies RepositoryTreeRowActionItem] : []),
            deleteItem,
        ];
    }, [props.disableWriteActions, props.downloadActionsEnabled, props.folderCreation?.newFolder, props.folderCreation?.upload, props.kind, theme.colors.text.secondary]);

    const menuTitle = props.path.split('/').filter(Boolean).at(-1) ?? props.path;
    // Lab FB1k: open first (under the file's name), then share, the row's own file operations, and Discard
    // last and red, each run of rows set apart by a quiet rule.
    const rowActions = React.useMemo<ItemAction[]>(() => {
        const inGroup = (id: string, title = '') => (action: ItemAction): ItemAction => ({ ...action, group: { id, title } });
        // The phone sheet's own title names the file, so its first run carries no second label.
        const openTitle = phone ? '' : menuTitle;
        return [
            ...sharedActions.filter((_, index) => sharedItems[index].group === 'open').map(inGroup('open', openTitle)),
            ...workspaceOpen.items.filter(item => item.id !== 'workspace.open.right' || !sharedItems.some(shared => shared.id === 'openBeside'))
                .map(item => inGroup('open', openTitle)({ id: item.id, title: item.title, icon: item.icon, onPress: () => { workspaceOpen.select(item.id); } })),
            ...sharedActions.filter((_, index) => sharedItems[index].group !== 'open' && sharedItems[index].group !== 'change').map(inGroup('share')),
            ...items.filter(item => !item.destructive).map(item => inGroup('file')({ ...item, onPress: () => props.onSelect(item.id as RepositoryTreeRowActionMenuItemId) })),
            ...sharedActions.filter((_, index) => sharedItems[index].group === 'change').map(inGroup('change')),
            // Delete closes the menu, set apart with the other changes that drop work; a phone sheet says what it removes.
            ...items.filter(item => item.destructive).map(item => inGroup('change')({
                ...item,
                ...(phone ? { subtitle: t(file ? 'files.repositoryTree.actions.deleteFileConsequence' : 'files.repositoryTree.actions.deleteFolderConsequence') } : {}),
                onPress: () => props.onSelect(item.id as RepositoryTreeRowActionMenuItemId),
            })),
        ];
    }, [file, items, menuTitle, phone, props.onSelect, sharedActions, sharedItems, workspaceOpen]);

    // Room for the whole menu (its title row, every item, each group's padding), so no item is cut at the
    // menu's foot on a desktop window (lab FB1k); the popover still shrinks to a shorter window and scrolls.
    const menuGroupCount = new Set(rowActions.map(action => action.group?.id)).size;
    const menuContentHeightPx = (rowActions.length + 1) * MENU_ROW_METRICS.minHeightPx
        + menuGroupCount * 2 * MENU_ROW_METRICS.sectionPaddingVerticalPx;
    const folder = props.path.split('/').filter(Boolean).slice(0, -1).join('/');
    const phoneSheet = React.useMemo(() => (folder ? { subtitle: folder } : {}), [folder]);
    const safePath = React.useMemo(() => toTestIdSafeValue(props.path), [props.path]);
    const triggerId = `repository-tree-row-menu-${safePath}`;

    return (
        <ItemRowActions
            title={menuTitle}
            // Lab FB1k: open first, then share, the row's own file operations, and Discard last and red.
            actions={rowActions}
            overflowTriggerTestID={triggerId}
            compactThreshold={Number.POSITIVE_INFINITY}
            overflowMaxHeightCap={menuContentHeightPx}
            // Phone (lab FB1kp): the same items in the bottom sheet over a scrim, named by the row's file and folder.
            overflowPhoneSheet={phoneSheet}
            compactActionIds={[]}
            iconSize={14}
            // Tree rows are 28 px (session tabs lab F1): the ⋯ is drawn at 24 and its press frame grows
            // vertically to the platform floor, so it never makes the row taller.
            actionControlSizePx={24}
            gap={0}
            overflowOpen={props.control?.open}
            onOverflowOpenChange={props.control?.onOpenChange}
            renderOverflowTrigger={props.control?.triggerHidden ? renderNoTrigger : undefined}
        />
    );
}
