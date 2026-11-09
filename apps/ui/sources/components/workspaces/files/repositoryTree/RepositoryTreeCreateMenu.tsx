import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { createRepositoryTreeUploadMenuConfig } from './createRepositoryTreeUploadMenuConfig';

export type RepositoryTreeCreateMenuItemId =
    | 'repository-tree-create-file'
    | 'repository-tree-create-folder'
    | 'repository-tree-upload-destination-select'
    | 'repository-tree-upload-files'
    | 'repository-tree-upload-folder';

/**
 * The Files tree's + (lab F1): New file, New folder and the uploads, in one menu. In a session it is
 * the pane header's trailing action; a pane without a header keeps it at the end of the toolbar.
 * Only what the tree's owner can do is offered, and it says so by disabling what cannot run now.
 */
export const RepositoryTreeCreateMenu = React.memo(function RepositoryTreeCreateMenu(props: Readonly<{
    createEnabled: boolean;
    /** A New file / New folder write is in flight: the + shows it until the Machine answers. */
    createPending?: boolean;
    uploadEnabled: boolean;
    isWeb: boolean;
    /** Where uploads land ("Project root" until a folder is chosen). */
    uploadDestinationLabel: string;
    /** Why its rows can't run now (the machine isn't answering): said once, above them (lab FB1o). */
    unavailableReason?: string | null;
    onSelect: (itemId: RepositoryTreeCreateMenuItemId) => void;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const iconColor = theme.colors.text.secondary;
    const { onSelect } = props;

    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        const upload = createRepositoryTreeUploadMenuConfig({ uploadActionsAvailable: props.uploadEnabled, isWeb: props.isWeb });
        return [
            {
                id: 'repository-tree-create-file',
                testID: 'repository-tree-create-file',
                title: t('files.pane.newFile'),
                icon: <Icon name="file-text" size={16} color={iconColor} />,
                disabled: !props.createEnabled,
            },
            {
                id: 'repository-tree-create-folder',
                testID: 'repository-tree-create-folder',
                title: t('files.pane.newFolder'),
                icon: <Icon name="folder" size={16} color={iconColor} />,
                disabled: !props.createEnabled,
            },
            ...upload.items.map((item) => ({
                id: item.id,
                testID: item.id,
                title: t(item.titleKey),
                subtitle: props.uploadDestinationLabel,
                category: t('files.toolbar.upload'),
                icon: <Icon name={item.iconName} size={16} color={iconColor} />,
                disabled: item.disabled,
            })),
            {
                id: 'repository-tree-upload-destination-select',
                testID: 'repository-tree-upload-destination-select',
                title: t('settingsAttachments.workspaceDirectory.uploadsDirectory.title'),
                subtitle: props.uploadDestinationLabel,
                category: t('files.toolbar.upload'),
                icon: <Icon name="folder-open" size={16} color={iconColor} />,
                disabled: !props.uploadEnabled,
            },
        ];
    }, [iconColor, props.createEnabled, props.isWeb, props.uploadDestinationLabel, props.uploadEnabled]);
    const unavailableNote = React.useMemo(() => (props.unavailableReason ? <SurfaceStateCard
        testID="repository-tree-create-unavailable"
        size="line"
        lineDensity="menu"
        kind="unavailable"
        iconName="wifi-slash"
        title={props.unavailableReason}
    /> : undefined), [props.unavailableReason]);

    const select = React.useCallback((itemId: string) => {
        setOpen(false);
        onSelect(itemId as RepositoryTreeCreateMenuItemId);
    }, [onSelect]);

    return (
        <DropdownMenu
            testID="repository-tree-create-menu"
            open={open}
            onOpenChange={setOpen}
            header={unavailableNote}
            items={items}
            onSelect={select}
            matchTriggerWidth={false}
            placement="bottom"
            trigger={({ open: isOpen, toggle }) => (
                <IconButton
                    testID="repository-tree-create-button"
                    iconName="plus"
                    variant="plain"
                    busy={props.createPending}
                    selected={isOpen}
                    expanded={isOpen}
                    hasPopup="menu"
                    accessibilityLabel={t('files.pane.newMenu')}
                    tooltip={t('files.pane.newMenu')}
                    onPress={toggle}
                />
            )}
        />
    );
});
