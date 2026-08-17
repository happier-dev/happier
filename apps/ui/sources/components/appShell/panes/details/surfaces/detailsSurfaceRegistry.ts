import type {
    DetailsSurfaceDescriptorV1,
    DetailsSurfaceRegionV1,
    DetailsSurfaceRenderInputV1,
    DetailsSurfaceRendererV1,
    DetailsSurfaceScopeV1,
} from './types';
import type { DetailsTabState } from '../workspace/detailsWorkspaceTypes';

function readResourceKind(resource: unknown): string {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        return 'unknown';
    }
    const kind = (resource as { kind?: unknown }).kind;
    return typeof kind === 'string' && kind.trim().length > 0 ? kind : 'unknown';
}

function scopeIdentity(scope: DetailsSurfaceScopeV1): string {
    switch (scope.kind) {
        case 'session':
            return [
                'session',
                scope.sessionId,
                scope.workspaceRefId ?? '',
                scope.serverId ?? '',
                scope.machineId ?? '',
                scope.rootPath ?? '',
            ].join(':');
        case 'workspace':
            return ['workspace', scope.workspaceRefId, scope.serverId, scope.machineId, scope.rootPath].join(':');
        case 'project':
            return ['project', scope.workspaceRefId, scope.serverId, scope.machineId, scope.rootPath, scope.activeRootPath ?? ''].join(':');
        case 'global':
            return 'global';
    }
}

export function createDetailsSurfaceDescriptor(input: Readonly<{
    tab: DetailsTabState;
    scope: DetailsSurfaceScopeV1;
    region: DetailsSurfaceRegionV1;
    status?: DetailsSurfaceDescriptorV1['status'];
}>): DetailsSurfaceDescriptorV1 {
    const resourceKind = readResourceKind(input.tab.resource);
    const resourceKey = `${resourceKind}:${input.tab.key}`;
    return {
        surfaceId: `${scopeIdentity(input.scope)}:${input.region}:${resourceKey}`,
        resourceKey,
        scope: input.scope,
        region: input.region,
        status: input.status ?? 'available',
        order: 0,
        pinned: input.tab.isPinned,
        preview: input.tab.isPreview,
    };
}

export function compareDetailsSurfaceRenderers(
    left: DetailsSurfaceRendererV1,
    right: DetailsSurfaceRendererV1,
): number {
    const orderDiff = (left.order ?? 0) - (right.order ?? 0);
    if (orderDiff !== 0) return orderDiff;
    return left.id.localeCompare(right.id);
}

export function resolveDetailsSurfaceRenderer(input: Readonly<{
    renderers: readonly DetailsSurfaceRendererV1[];
    renderInput: DetailsSurfaceRenderInputV1;
}>): DetailsSurfaceRendererV1 | null {
    const ordered = [...input.renderers].sort(compareDetailsSurfaceRenderers);
    for (const renderer of ordered) {
        try {
            if (renderer.canRender(input.renderInput)) {
                return renderer;
            }
        } catch {
            continue;
        }
    }
    return null;
}

export function createDetailsSurfacePaneCallbacks(input: Readonly<{
    openTab?: DetailsSurfaceRenderInputV1['callbacks']['openTab'];
    openOverlay?: DetailsSurfaceRenderInputV1['callbacks']['openOverlay'];
    closeTab?: DetailsSurfaceRenderInputV1['callbacks']['closeTab'];
    pinTab?: DetailsSurfaceRenderInputV1['callbacks']['pinTab'];
    unpinTab?: DetailsSurfaceRenderInputV1['callbacks']['unpinTab'];
    replaceTab?: DetailsSurfaceRenderInputV1['callbacks']['replaceTab'];
}>): DetailsSurfaceRenderInputV1['callbacks'] {
    return {
        openTab: input.openTab,
        openOverlay: input.openOverlay,
        closeTab: input.closeTab,
        pinTab: input.pinTab,
        unpinTab: input.unpinTab,
        replaceTab: input.replaceTab,
    };
}
