import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetSurfaceArtifactIdV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { widgetAreaLayoutBaseSurface } from '@/sync/domains/widgets/widgetAreaLayoutSurface';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export { widgetAreaLayoutBaseSurface } from '@/sync/domains/widgets/widgetAreaLayoutSurface';

/** Selection lives in the mounted page's route/state; this is only its answering-client address. */
export type WidgetAreaLayoutSelectionOwner = Readonly<{
    surface: WidgetSurfaceRefV1;
    /** A Project destination can display a separately owned, admitted shared document. */
    displayedSurface?: WidgetSurfaceRefV1;
    /** The same captured page values used by the mounted area's Action port. */
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    isCurrent(): boolean;
    read(surface: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<ActionExecuteResult>;
    select(surface: WidgetSurfaceRefV1): void;
}>;
const mountedOwners = new Set<WidgetAreaLayoutSelectionOwner>();

export function registerWidgetAreaLayoutSelectionOwner(owner: WidgetAreaLayoutSelectionOwner): () => void {
    mountedOwners.add(owner);
    return () => { mountedOwners.delete(owner); };
}

/** Settle personal dashboard selection before any publisher removes its row. */
export function settleMountedWidgetAreaLayoutDeletion(artifactId: string): void {
    for (const owner of mountedOwners) {
        const displayed = owner.displayedSurface ?? owner.surface;
        if (!displayed.artifactId && 'layoutId' in displayed.owner && displayed.owner.layoutId
            && owner.isCurrent() && buildWidgetSurfaceArtifactIdV1(displayed) === artifactId) {
            owner.select(widgetAreaLayoutBaseSurface(owner.surface));
        }
    }
}

export function resolveMountedWidgetAreaLayoutSelectionOwner(surface: WidgetSurfaceRefV1): WidgetAreaLayoutSelectionOwner | ActionExecuteFailure {
    const base = widgetAreaLayoutBaseSurface(surface);
    const matches = [...mountedOwners].filter(owner => owner.isCurrent()
        && [owner.surface, owner.displayedSurface].some(address => address && sameStrictJsonValue(widgetAreaLayoutBaseSurface(address), base)));
    if (matches.length === 1) return matches[0]!;
    const errorCode = matches.length ? 'widget_area_layout_owner_ambiguous' : 'widget_area_layout_owner_unavailable';
    return { ok: false, errorCode, error: errorCode };
}

export async function selectMountedWidgetAreaLayout(surface: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<ActionExecuteResult> {
    const failed = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
    if (signal?.aborted) return failed('cancelled');
    const owner = resolveMountedWidgetAreaLayoutSelectionOwner(surface);
    if ('ok' in owner) return owner;
    // Navigation is the user's intent, not the result of acquiring its contents.
    // Reads may finish in either order; none of their continuations selects a view.
    owner.select(surface);
    // Preserve the single-read handoff to the mounted area. Acquisition and its
    // failure presentation belong to that area; neither undoes this selection.
    try { await owner.read(surface, signal); }
    catch { /* The mounted area consumes the handoff's read failure. */ }
    return { ok: true, result: { surface } };
}
