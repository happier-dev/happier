import * as React from 'react';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import { useWorkspaceRepositoryTreeBrowser } from '@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { classifyGalleryFile, groupGalleryMedia, type GalleryMediaItem } from './galleryModel';

export function useFolderGalleryModel(input: Readonly<{
    scope: WorkspaceScopeBase;
    folderPath: string;
    enabled: boolean;
    online?: boolean;
}>) {
    const online = input.online !== false;
    const tree = useWorkspaceRepositoryTreeBrowser({
        scope: input.scope, enabled: input.enabled && online,
        rootDirectoryPath: input.folderPath, visibilityMode: 'all', gallery: true,
    });
    const { nodes } = tree;
    const { scope } = input;
    const gallery = React.useMemo(() => {
        const folders: LazyDirectoryTreeNode[] = [];
        const otherFiles: LazyDirectoryTreeNode[] = [];
        const items: GalleryMediaItem[] = [];
        let incomplete = false;
        for (const node of nodes) {
            if (node.depth !== 0) continue;
            if (node.type === 'directory') folders.push(node);
            else if (node.type === 'file') {
                const item = classifyGalleryFile(node, scope, 'folder');
                if (item) items.push(item);
                else otherFiles.push(node);
            } else if (node.infoKind === 'truncated') incomplete = true;
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));
        return { ...groupGalleryMedia(items), folders, otherFiles, incomplete };
    }, [nodes, scope]);
    return {
        ...gallery,
        loading: input.enabled && online && (tree.rootLoading || (!tree.rootLoaded && !tree.rootError)),
        stale: !online && tree.rootLoaded,
        failure: tree.rootError ? { error: tree.rootError, errorCode: tree.rootErrorCode } : null,
        loadMore: input.enabled && online && gallery.incomplete && !tree.expandedRootListing ? tree.loadMoreRoot : null,
        refresh: tree.retryRoot,
    };
}
