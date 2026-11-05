import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetSurfaceArtifactIdV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { storage } from '@/sync/domains/state/storage';
import { registerWidgetAreaLayoutSelectionOwner, type WidgetAreaLayoutSelectionOwner } from '@/sync/domains/widgets/widgetAreaLayoutSelection';

/** Retained pages and parked panels keep their state, but only presented destinations answer selection. */
export function useWidgetAreaLayoutSelectionOwner(owner: WidgetAreaLayoutSelectionOwner | null): void {
    const focused = useDestinationFocus();
    const presented = useLayoutPresentationActive();
    React.useEffect(() => focused && presented && owner ? registerWidgetAreaLayoutSelectionOwner(owner) : undefined,
        [focused, owner, presented]);
}

/** One selection read may supply the area's first observation, even after it settles.
 * An in-flight read follows the selecting caller until the area takes it, then follows
 * the area's signal. A later Artifact publication makes the offered answer unusable. */
export function createWidgetAreaSelectionReadHandoff<Result extends ActionExecuteResult>() {
    type Offered = {
        surface: WidgetSurfaceRefV1;
        binding: object;
        result?: Promise<Result>;
        controller: AbortController;
        releaseSignal: () => void;
        publication: unknown;
    };
    let offered: Offered | null = null;
    const publicationFor = (surface: WidgetSurfaceRefV1) => storage.getState().artifacts[
        surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(surface)];
    const cancel = () => {
        if (!offered) return;
        const retired = offered;
        offered = null;
        retired.releaseSignal();
        retired.controller.abort();
    };
    return {
        offer(surface: WidgetSurfaceRefV1, binding: object, signal: AbortSignal | undefined,
            start: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
            cancel();
            const controller = new AbortController();
            const entry: Offered = { surface, binding, controller, releaseSignal: () => {}, publication: undefined };
            const onAbort = () => { if (offered === entry) cancel(); };
            signal?.addEventListener('abort', onAbort, { once: true });
            entry.releaseSignal = () => signal?.removeEventListener('abort', onAbort);
            offered = entry;
            if (signal?.aborted) onAbort();
            entry.result = Promise.resolve().then(() => start(controller.signal)).then(result => {
                entry.publication = publicationFor(surface);
                return result;
            }).finally(() => entry.releaseSignal());
            return entry.result;
        },
        take(surface: WidgetSurfaceRefV1, binding: object, signal?: AbortSignal): Promise<Result | null> | null {
            return this.takeWhere(binding, offeredSurface => sameStrictJsonValue(offeredSurface, surface), signal);
        },
        takeWhere(binding: object, matches: (surface: WidgetSurfaceRefV1) => boolean, signal?: AbortSignal): Promise<Result | null> | null {
            const entry = offered;
            if (!entry || entry.binding !== binding || !matches(entry.surface)) return null;
            offered = null;
            entry.releaseSignal();
            const onAbort = () => entry.controller.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            entry.releaseSignal = () => signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) onAbort();
            return entry.result!.then(result => publicationFor(entry.surface) === entry.publication ? result : null)
                .finally(() => entry.releaseSignal());
        },
        cancel,
    };
}
