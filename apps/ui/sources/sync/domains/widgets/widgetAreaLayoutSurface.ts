import { buildWidgetSurfaceArtifactIdV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export function widgetAreaLayoutBaseSurface(surface: WidgetSurfaceRefV1): WidgetSurfaceRefV1 {
    const owner = surface.owner;
    if (owner.kind !== 'project' && owner.kind !== 'corePage' && owner.kind !== 'pluginArea') return surface;
    const { layoutId: _layoutId, ...base } = owner;
    return { serverId: resolveServerProfileScopeIdForIdentifier(surface.serverId), accountId: surface.accountId,
        ...(surface.artifactId ? { artifactId: surface.artifactId } : {}), owner: base };
}

export function widgetAreaLayoutSurfaceKey(surface: WidgetSurfaceRefV1): string {
    const base = widgetAreaLayoutBaseSurface(surface);
    return JSON.stringify([buildWidgetSurfaceArtifactIdV1(base), base.artifactId ?? null]);
}
