export type RepositoryTreeUploadMenuItemConfig = Readonly<{
    id: 'repository-tree-upload-files' | 'repository-tree-upload-folder';
    titleKey: 'files.toolbar.uploadFiles' | 'files.toolbar.uploadFolder';
    iconName: 'cloud-upload-outline' | 'folder-outline';
    disabled: boolean;
}>;

export function createRepositoryTreeUploadMenuConfig(params: Readonly<{
    uploadActionsAvailable: boolean;
    isWeb: boolean;
}>): Readonly<{
    matchTriggerWidth: false;
    items: readonly [RepositoryTreeUploadMenuItemConfig, RepositoryTreeUploadMenuItemConfig];
}> {
    return {
        matchTriggerWidth: false,
        items: [
            {
                id: 'repository-tree-upload-files',
                titleKey: 'files.toolbar.uploadFiles',
                iconName: 'cloud-upload-outline',
                disabled: !params.uploadActionsAvailable,
            },
            {
                id: 'repository-tree-upload-folder',
                titleKey: 'files.toolbar.uploadFolder',
                iconName: 'folder-outline',
                disabled: !params.uploadActionsAvailable || !params.isWeb,
            },
        ],
    };
}
