import type * as React from 'react';

import type {
    PluginUiDestinationReferenceV1,
    PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui';

import type { DetailsTab, DetailsTabState } from '../workspace/detailsWorkspaceTypes';

export type DetailsSurfaceScopeV1 =
    | Readonly<{
        kind: 'session';
        sessionId: string;
        workspaceRefId?: string | null;
        serverId?: string | null;
        machineId?: string | null;
        rootPath?: string | null;
    }>
    | Readonly<{
        kind: 'workspace';
        workspaceRefId: string;
        serverId: string;
        machineId: string;
        rootPath: string;
    }>
    | Readonly<{
        kind: 'project';
        workspaceRefId: string;
        serverId: string;
        machineId: string;
        rootPath: string;
        activeRootPath?: string | null;
    }>
    | Readonly<{ kind: 'global' }>;

export type DetailsSurfaceRegionV1 = 'details' | 'main' | 'side' | 'bottom';

export type DetailsSurfaceStatusV1 =
    | 'pending'
    | 'available'
    | 'disabled'
    | 'stale'
    | 'missing'
    | 'incompatible';

export type DetailsSurfaceRendererOwnerV1 =
    | 'session'
    | 'workspace'
    | 'project'
    | 'plugin'
    | 'browser'
    | 'simulator'
    | 'terminal'
    | 'scm';

export type DetailsSurfaceDescriptorV1 = Readonly<{
    surfaceId: string;
    resourceKey: string;
    scope: DetailsSurfaceScopeV1;
    region: DetailsSurfaceRegionV1;
    status: DetailsSurfaceStatusV1;
    disabledReason?: string;
    order?: number;
    pinned?: boolean;
    preview?: boolean;
    lastResolvedAt?: string;
}>;

export type DetailsSurfaceHostCallbacksV1 = Readonly<{
    openTab?: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    /**
     * The canonical Details workspace overlay owner. A plugin destination is
     * qualified before this callback is reached; input/currentness stay in the
     * mount-local navigation handoff rather than the workspace state.
     */
    openOverlay?: (input: Readonly<{
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>) => void;
    closeTab?: (tabKey: string) => void;
    pinTab?: (tabKey: string) => void;
    unpinTab?: (tabKey: string) => void;
    replaceTab?: (tabKey: string, tab: DetailsTab, options?: Readonly<{
        intent?: 'default' | 'pinned' | 'preview';
        restoreSourceOnRehydrate?: boolean;
    }>) => void;
}>;

export type DetailsSurfaceRenderInputV1 = Readonly<{
    tab: DetailsTabState;
    descriptor: DetailsSurfaceDescriptorV1;
    scope: DetailsSurfaceScopeV1;
    region: DetailsSurfaceRegionV1;
    active: boolean;
    callbacks: DetailsSurfaceHostCallbacksV1;
}>;

export type DetailsSurfaceRendererV1 = Readonly<{
    id: string;
    owner: DetailsSurfaceRendererOwnerV1;
    order?: number;
    canRender: (input: DetailsSurfaceRenderInputV1) => boolean;
    render: (input: DetailsSurfaceRenderInputV1) => React.ReactNode;
}>;
