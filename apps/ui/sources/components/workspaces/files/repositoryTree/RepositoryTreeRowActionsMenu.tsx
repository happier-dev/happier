import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { FilesystemBrowserRowActionsControl } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';

export type RepositoryTreeRowActionMenuItemId =
    | 'repository-tree-menuitem-rename'
    | 'repository-tree-menuitem-delete'
    | 'repository-tree-menuitem-download'
    | 'repository-tree-menuitem-zip'
    | 'repository-tree-menuitem-copy-path'
    | 'repository-tree-menuitem-new-folder'
    | 'repository-tree-menuitem-upload';

type RepositoryTreeRowActionItem = Omit<ItemAction, 'onPress'>;

// Touch rows open the menu from a long press; the anchor stays, the … is not drawn.
const renderNoTrigger = () => null;

export function RepositoryTreeRowActionsMenu(props: Readonly<{
    path: string;
    href?: string | null;
    kind: 'file' | 'directory';
    disableWriteActions: boolean;
    downloadActionsEnabled: boolean;
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
    const workspaceOpen = useWorkspaceOpenActions(props.kind === 'file' ? props.href ?? null : null);

    const items = React.useMemo<RepositoryTreeRowActionItem[]>(() => {
        const renameItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-rename',
            title: t('common.rename'),
            icon: 'pencil',
            color: theme.colors.text.secondary,
            disabled: props.disableWriteActions,
        };
        // Delete is last and reads as destructive (lab p-code ACTIONS); it still asks first.
        const deleteItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-delete',
            title: t('common.delete'),
            icon: 'trash',
            destructive: true,
            disabled: props.disableWriteActions,
        };

        const copyPathItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-copy-path',
            title: t('files.repositoryTree.actions.copyPath'),
            icon: 'copy',
            color: theme.colors.text.secondary,
        };

        if (props.kind === 'file') {
            return [
                copyPathItem,
                ...(props.downloadActionsEnabled
                    ? ([
                        {
                            id: 'repository-tree-menuitem-download',
                            title: t('files.repositoryTree.actions.download'),
                            icon: 'download',
                            color: theme.colors.text.secondary,
                        },
                        {
                            id: 'repository-tree-menuitem-zip',
                            title: t('files.repositoryTree.actions.downloadAsZip'),
                            icon: 'archive',
                            color: theme.colors.text.secondary,
                        },
                    ] satisfies RepositoryTreeRowActionItem[])
                    : []),
                renameItem,
                deleteItem,
            ];
        }

        return [
            copyPathItem,
            ...(props.downloadActionsEnabled
                ? ([
                    {
                        id: 'repository-tree-menuitem-zip',
                        title: t('files.repositoryTree.actions.downloadAsZip'),
                        icon: 'archive',
                        color: theme.colors.text.secondary,
                    },
                ] satisfies RepositoryTreeRowActionItem[])
                : []),
            renameItem,
            ...(props.folderCreation?.newFolder ? [{
                id: 'repository-tree-menuitem-new-folder',
                title: t('files.pane.newFolder'),
                icon: 'folder-plus',
                color: theme.colors.text.secondary,
                disabled: props.disableWriteActions,
            } satisfies RepositoryTreeRowActionItem] : []),
            ...(props.folderCreation?.upload ? [{
                id: 'repository-tree-menuitem-upload',
                title: t('files.toolbar.uploadFiles'),
                icon: 'upload',
                color: theme.colors.text.secondary,
            } satisfies RepositoryTreeRowActionItem] : []),
            deleteItem,
        ];
    }, [props.disableWriteActions, props.downloadActionsEnabled, props.folderCreation?.newFolder, props.folderCreation?.upload, props.kind, theme.colors.text.secondary]);

    const safePath = React.useMemo(() => toTestIdSafeValue(props.path), [props.path]);
    const triggerId = `repository-tree-row-menu-${safePath}`;

    return (
        <ItemRowActions
            title={props.path.split('/').filter(Boolean).at(-1) ?? props.path}
            actions={[...workspaceOpen.items.map(item => ({
                id: item.id, title: item.title, icon: item.icon,
                onPress: () => { workspaceOpen.select(item.id); },
            })), ...items.map((item) => ({
                ...item,
                onPress: () => props.onSelect(item.id as RepositoryTreeRowActionMenuItemId),
            }))]}
            overflowTriggerTestID={triggerId}
            compactThreshold={Number.POSITIVE_INFINITY}
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
