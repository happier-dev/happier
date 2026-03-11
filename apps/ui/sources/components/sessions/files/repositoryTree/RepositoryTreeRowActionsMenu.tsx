import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

export type RepositoryTreeRowActionMenuItemId =
    | 'repository-tree-menuitem-rename'
    | 'repository-tree-menuitem-delete'
    | 'repository-tree-menuitem-download'
    | 'repository-tree-menuitem-zip'
    | 'repository-tree-menuitem-copy-path';

type RepositoryTreeRowActionItem = Omit<ItemAction, 'onPress'>;

export function RepositoryTreeRowActionsMenu(props: Readonly<{
    path: string;
    kind: 'file' | 'directory';
    disableWriteActions: boolean;
    onSelect: (itemId: RepositoryTreeRowActionMenuItemId) => void;
}>) {
    const { theme } = useUnistyles();

    const items = React.useMemo<RepositoryTreeRowActionItem[]>(() => {
        const renameItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-rename',
            title: t('common.rename'),
            icon: 'pencil-outline',
            color: theme.colors.textSecondary,
            disabled: props.disableWriteActions,
        };
        const deleteItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-delete',
            title: t('common.delete'),
            icon: 'trash-outline',
            color: theme.colors.textSecondary,
            disabled: props.disableWriteActions,
        };

        const copyPathItem: RepositoryTreeRowActionItem = {
            id: 'repository-tree-menuitem-copy-path',
            title: t('files.repositoryTree.actions.copyPath'),
            icon: 'copy-outline',
            color: theme.colors.textSecondary,
        };

        if (props.kind === 'file') {
            return [
                renameItem,
                deleteItem,
                {
                    id: 'repository-tree-menuitem-download',
                    title: t('files.repositoryTree.actions.download'),
                    icon: 'download-outline',
                    color: theme.colors.textSecondary,
                },
                {
                    id: 'repository-tree-menuitem-zip',
                    title: t('files.repositoryTree.actions.downloadAsZip'),
                    icon: 'archive-outline',
                    color: theme.colors.textSecondary,
                },
                copyPathItem,
            ];
        }

        return [
            renameItem,
            deleteItem,
            {
                id: 'repository-tree-menuitem-zip',
                title: t('files.repositoryTree.actions.downloadAsZip'),
                icon: 'archive-outline',
                color: theme.colors.textSecondary,
            },
            copyPathItem,
        ];
    }, [props.disableWriteActions, props.kind, theme.colors.textSecondary]);

    const safePath = React.useMemo(() => toTestIdSafeValue(props.path), [props.path]);
    const triggerId = `repository-tree-row-menu-${safePath}`;

    return (
        <ItemRowActions
            title={props.path.split('/').filter(Boolean).at(-1) ?? props.path}
            actions={items.map((item) => ({
                ...item,
                onPress: () => props.onSelect(item.id as RepositoryTreeRowActionMenuItemId),
            }))}
            overflowTriggerTestID={triggerId}
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
            iconSize={14}
            gap={0}
        />
    );
}
