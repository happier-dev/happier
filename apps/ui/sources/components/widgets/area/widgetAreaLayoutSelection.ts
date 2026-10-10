import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WidgetSurfaceReadV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

/** Selection lives in the mounted page's route/state; this is only its answering-client address. */
export type WidgetAreaLayoutSelectionOwner = Readonly<{
    surface: WidgetSurfaceRefV1;
    isCurrent(): boolean;
    read(surface: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<ActionExecuteResult>;
    select(surface: WidgetSurfaceRefV1): void;
}>;
const mountedOwners = new Set<WidgetAreaLayoutSelectionOwner>();

export function widgetAreaLayoutBaseSurface(surface: WidgetSurfaceRefV1): WidgetSurfaceRefV1 {
    const owner = surface.owner;
    if (owner.kind !== 'project' && owner.kind !== 'corePage' && owner.kind !== 'pluginArea') return surface;
    const { layoutId: _layoutId, ...base } = owner;
    return { serverId: surface.serverId, accountId: surface.accountId, owner: base };
}

export function registerWidgetAreaLayoutSelectionOwner(owner: WidgetAreaLayoutSelectionOwner): () => void {
    mountedOwners.add(owner);
    return () => { mountedOwners.delete(owner); };
}

export async function selectMountedWidgetAreaLayout(surface: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<ActionExecuteResult> {
    const failed = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
    if (signal?.aborted) return failed('cancelled');
    const base = widgetAreaLayoutBaseSurface(surface);
    const matches = [...mountedOwners].filter(owner => owner.isCurrent() && sameStrictJsonValue(widgetAreaLayoutBaseSurface(owner.surface), base));
    if (matches.length !== 1) return failed(matches.length ? 'widget_area_layout_owner_ambiguous' : 'widget_area_layout_owner_unavailable');
    const owner = matches[0]!;
    const result = await owner.read(surface, signal);
    if (!result.ok) return result;
    const read = WidgetSurfaceReadV1Schema.safeParse(result.result);
    if (!read.success || !sameStrictJsonValue(widgetAreaLayoutBaseSurface(read.data.surface), base)) return failed('invalid_widget_area_result');
    if (('layoutId' in surface.owner && surface.owner.layoutId || surface.artifactId)
        && !sameStrictJsonValue(read.data.surface, surface)) return failed('invalid_widget_area_result');
    if (!owner.isCurrent() || signal?.aborted) return failed('widget_area_scope_retired');
    owner.select(read.data.surface);
    return { ok: true, result: read.data };
}
