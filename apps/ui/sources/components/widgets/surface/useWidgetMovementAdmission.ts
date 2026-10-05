import * as React from 'react';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { admitWidgetEntityMovement, widgetEntitySourceRef, type WidgetEntityMovementAdmission, type WidgetEntityMovementPort } from '@/sync/ops/actions/widgetEntityMovement';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';

/** One read-only projection per mounted destination surface; pointer frames never trigger reads. */
export function useWidgetMovementAdmission(surface: WidgetSurfaceRefV1 | null, basis: unknown, port?: WidgetEntityMovementPort) {
    const runtime = useEntityDragDropRuntime();
    const item = React.useSyncExternalStore(runtime.subscribe, () => runtime.getSnapshot().phase === 'carrying' ? runtime.getSnapshot().item : null, () => null);
    const ref = item ? widgetEntitySourceRef(item) : null;
    const key = ref && surface ? JSON.stringify({ ref, surface }) : null;
    const [current, setCurrent] = React.useState<Readonly<{ key: string; basis: unknown; admission: WidgetEntityMovementAdmission }> | null>(null);
    React.useEffect(() => {
        if (!key || !ref || !surface) return;
        const abort = new AbortController();
        setCurrent(null);
        const read = port ? port.readAdmission(ref, surface, abort.signal)
            : import('@/sync/ops/actions/defaultActionExecutor').then(module => module.readDefaultWidgetMovementAdmission(ref, surface, abort.signal));
        void read
            .then(admission => { if (!abort.signal.aborted) setCurrent({ key, basis, admission }); })
            .catch(() => { if (!abort.signal.aborted) setCurrent({ key, basis, admission: { status: 'refused', code: 'widget_admission_unavailable' } }); });
        return () => abort.abort();
    }, [key, basis, port]);
    React.useEffect(() => { runtime.refresh(); }, [runtime, current]);
    const admission = current?.key === key && current.basis === basis ? current.admission : null;
    const admit = React.useCallback((effect: EntityDropEffectV1) => admitWidgetEntityMovement(effect, admission), [admission]);
    return { admit, sourceRef: admission?.ref ?? null };
}
