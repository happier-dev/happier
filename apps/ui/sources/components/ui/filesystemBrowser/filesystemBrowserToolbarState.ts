import type { ReactNode } from 'react';

import type { ItemAction } from '@/components/ui/lists/itemActions';

import { resolveVisibleFileBrowserToolbarActionIds, type FileBrowserToolbarActionLike } from './FileBrowserToolbar';

export type FilesystemBrowserToolbarAction = Readonly<{
    id: string;
    priority: number;
    order: number;
    icon: ReactNode;
    menuIcon: NonNullable<ItemAction['icon']>;
    accessibilityLabel: string;
    disabled?: boolean;
    selected?: boolean;
    onPress: () => void;
}>;

export type FilesystemBrowserToolbarState = Readonly<{
    visibleActions: readonly FilesystemBrowserToolbarAction[];
    hiddenActions: readonly FilesystemBrowserToolbarAction[];
}>;

export function resolveFilesystemBrowserToolbarState(params: Readonly<{
    toolbarWidth: number | null;
    actions: readonly FilesystemBrowserToolbarAction[];
}>): FilesystemBrowserToolbarState {
    const visibleIds = resolveVisibleFileBrowserToolbarActionIds({
        toolbarWidth: params.toolbarWidth,
        actions: params.actions as readonly FileBrowserToolbarActionLike[],
    });

    const visibleActions = params.actions
        .filter((action) => visibleIds.has(action.id))
        .sort((left, right) => left.order - right.order);

    const hiddenActions = params.actions
        .filter((action) => !visibleIds.has(action.id))
        .sort((left, right) => left.order - right.order);

    return { visibleActions, hiddenActions };
}
