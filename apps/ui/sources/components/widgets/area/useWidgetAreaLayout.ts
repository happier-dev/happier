import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol';
import type { PluginUiWidgetAreaOperationV1, PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WidgetSurfaceReadV1Schema, type WidgetAreaLayoutV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useArtifact } from '@/sync/domains/state/storage';
import type { WidgetEntityMovementPort } from '@/sync/ops/actions/widgetEntityMovement';

/**
 * One personal widget area's operations (a plugin page's declared area, a Project aside). The host
 * binds it to the area, its captured Home/Account and the current page context; presentation only
 * names the semantic operation. It is the same port the public plugin-ui `WidgetSurface`, the
 * declarative `widgetArea` node and the hosted bridge reach — no catalog, layout store or input
 * resolver lives behind it here.
 */
export type WidgetAreaPort = Readonly<{
    execute(operation: PluginUiWidgetAreaOperationV1, signal?: AbortSignal): Promise<PluginUiWidgetAreaResultV1>;
    /** Only the host that already binds the layout owner may bind its existing movement owner. */
    movement?: WidgetEntityMovementPort;
}>;

/** A write that was refused or failed: the area keeps its last good layout and says so once. */
export type WidgetAreaWriteOutcome =
    | Readonly<{ kind: 'applied' }>
    | Readonly<{ kind: 'approvalPending' }>
    | Readonly<{ kind: 'refused'; errorCode: string }>;

export type WidgetAreaLayoutState<C> =
    | Readonly<{ status: 'loading' }>
    /** The host refused the area itself (scope retired, context invalid, Project source unavailable). */
    | Readonly<{ status: 'unavailable'; reasonCode: string }>
    | Readonly<{
        status: 'ready'; surface: WidgetSurfaceRefV1; placements: WidgetAreaLayoutV1['instances']; canEdit: boolean;
        /** The page context this read was admitted with; widgets follow only an admitted context. */
        context: C;
    }>;

export type WidgetAreaLayout<C> = Readonly<{
    state: WidgetAreaLayoutState<C>;
    /** One semantic write through the port, then a fresh read of the acknowledged layout. */
    write: (operation: PluginUiWidgetAreaOperationV1) => Promise<WidgetAreaWriteOutcome>;
}>;

function failureCode(result: PluginUiWidgetAreaResultV1): string | null {
    return result.ok ? null : (result.errorCode ?? 'widget_area_unavailable');
}

/** Keeps unchanged placements (and an unchanged read) referentially stable, so their cards do not re-render. */
function reconcile<C>(previous: WidgetAreaLayoutState<C>, next: WidgetAreaLayoutState<C>): WidgetAreaLayoutState<C> {
    if (previous.status !== 'ready' || next.status !== 'ready') {
        return previous.status === 'unavailable' && next.status === 'unavailable' && previous.reasonCode === next.reasonCode ? previous : next;
    }
    const byId = new Map(previous.placements.map(placement => [placement.instance.id, placement]));
    const placements = next.placements.map(placement => {
        const kept = byId.get(placement.instance.id);
        return kept && sameStrictJsonValue(kept, placement) ? kept : placement;
    });
    const samePlacements = placements.length === previous.placements.length && placements.every((placement, index) => placement === previous.placements[index]);
    if (samePlacements && previous.canEdit === next.canEdit && previous.context === next.context && sameStrictJsonValue(previous.surface, next.surface)) return previous;
    return { ...next, placements: samePlacements ? previous.placements : placements };
}

/**
 * The area's acknowledged layout, read through its port. It reads when mounted and again whenever
 * the host's binding changes (a new page context is admitted by that read before any widget follows
 * it), and after each of its own writes. While a read is in flight the last good layout and its
 * admitted context stay on screen; a refused write never discards them.
 */
export function useWidgetAreaLayout<C>(port: WidgetAreaPort, context: C): WidgetAreaLayout<C> {
    const [state, setState] = React.useState<WidgetAreaLayoutState<C>>({ status: 'loading' });
    const artifactId = state.status === 'ready' ? buildWidgetSurfaceArtifactIdV1(state.surface) : '';
    const artifact = useArtifact(artifactId);
    const generation = React.useRef(0);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const read = React.useCallback(async (signal?: AbortSignal) => {
        const current = ++generation.current;
        let next: WidgetAreaLayoutState<C>;
        try {
            const result = await port.execute({ actionId: 'widgets.instance.list' }, signal);
            const refused = failureCode(result);
            const parsed = result.ok ? WidgetSurfaceReadV1Schema.safeParse(result.result) : null;
            // The shared DTO also carries Board widths; this host consumes the existing area's native contract.
            const area = parsed?.success ? WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface: parsed.data.surface, instances: parsed.data.instances }) : null;
            next = refused !== null ? { status: 'unavailable', reasonCode: refused }
                : parsed?.success && area?.success ? { status: 'ready', surface: area.data.surface, placements: area.data.instances, canEdit: parsed.data.canEdit, context }
                : { status: 'unavailable', reasonCode: 'invalid_widget_area_result' };
        } catch {
            next = { status: 'unavailable', reasonCode: 'widget_area_unavailable' };
        }
        if (!mounted.current || signal?.aborted || current !== generation.current) return;
        setState(previous => reconcile(previous, next));
    }, [context, port]);

    React.useEffect(() => {
        const controller = new AbortController();
        void read(controller.signal);
        return () => controller.abort();
    }, [read]);

    React.useEffect(() => {
        if (!artifactId) return;
        const controller = new AbortController();
        // Canonical Artifact publication reaches both ends of an Action-driven transfer.
        void read(controller.signal);
        return () => controller.abort();
    }, [artifactId, artifact, read]);

    const write = React.useCallback(async (operation: PluginUiWidgetAreaOperationV1): Promise<WidgetAreaWriteOutcome> => {
        let outcome: WidgetAreaWriteOutcome;
        try {
            const result = await port.execute(operation);
            const refused = failureCode(result);
            outcome = refused !== null ? { kind: 'refused', errorCode: refused }
                : result.ok && 'kind' in result.result && result.result.kind === 'approval_request_created' ? { kind: 'approvalPending' }
                : { kind: 'applied' };
        } catch {
            outcome = { kind: 'refused', errorCode: 'widget_area_unavailable' };
        }
        if (mounted.current) await read();
        return outcome;
    }, [port, read]);

    return React.useMemo(() => ({ state, write }), [state, write]);
}
