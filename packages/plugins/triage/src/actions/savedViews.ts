
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { parseCorpusSmartPolicy } from '../corpus/query/smartPolicy.js';
import { mintTriageOpaqueIdV1 } from '../opaqueId.js';
import {
    mutateTriageSavedViews,
    readTriageSavedViews,
    type CorpusSavedViewCommandV1,
    type CorpusSavedViewV1,
    type CorpusSavedViewsDepsV1,
} from '../settings/savedViews.js';
import type {
    TriageAdministerSavedViewInputV1,
    TriageAdministerSavedViewResultV1,
    TriageReadSavedViewsInputV1,
    TriageReadSavedViewsResultV1,
} from './savedViewsProtocol.js';

/**
 * The two saved-view Actions: the surface's only path to the one
 * `triage.savedViews` CAS owner.
 *
 * Neither is a second authority. `savedViews.ts` still mints the view id,
 * validates every bound before the write, decides the conflict verdict, clears a
 * deleted view's selection atomically, and declines to overwrite a stored value
 * it cannot read. This module transports the caller's intent to it and projects
 * its answer back.
 */

export type TriageSavedViewsDepsV1 = Readonly<{
    settings: CorpusSavedViewsDepsV1['settings'];
    mintViewId: () => string;
    signal?: AbortSignal;
}>;

function projectViews(views: readonly CorpusSavedViewV1[]): TriageReadSavedViewsResultV1['views'] {
    return views.map((view) => ({
        viewId: view.viewId,
        label: view.label,
        filters: view.filters,
        order: view.order,
        smartPolicy: view.smartPolicy,
    }));
}

export async function readTriageSavedViewsForSurface(
    _input: TriageReadSavedViewsInputV1,
    deps: TriageSavedViewsDepsV1,
): Promise<TriageReadSavedViewsResultV1> {
    const read = await readTriageSavedViews({
        settings: deps.settings,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        v: 1,
        // `unreadable` is reported as `unavailable` rather than collapsed into
        // `absent`: the surface must be able to say the set belongs to a newer
        // writer instead of offering to replace it.
        availability: read.kind === 'unreadable' ? 'unavailable' : read.kind,
        views: projectViews(read.value.views),
        selectedViewId: read.value.selectedViewId,
        revision: read.revision,
    };
}

function commandFrom(input: TriageAdministerSavedViewInputV1): CorpusSavedViewCommandV1 | null {
    const expectedRevision = input.expectedRevision;
    if (input.kind === 'delete') return { kind: 'delete', viewId: input.viewId, expectedRevision };
    if (input.kind === 'select') return { kind: 'select', viewId: input.viewId, expectedRevision };
    // The wire bounds the policy's shape; the one canonical owner closes its
    // vocabulary, so a repeated predicate is refused here rather than ranked.
    const smartPolicy = parseCorpusSmartPolicy(input.smartPolicy);
    if (smartPolicy === null) return null;
    const draft = {
        label: input.label,
        filters: input.filters,
        order: input.order,
        smartPolicy,
    };
    return input.kind === 'create'
        ? {
            kind: 'create',
            expectedRevision,
            ...draft,
            ...(input.select === undefined ? {} : { select: input.select }),
        }
        : { kind: 'update', viewId: input.viewId, expectedRevision, ...draft };
}

export async function administerTriageSavedView(
    input: TriageAdministerSavedViewInputV1,
    deps: TriageSavedViewsDepsV1,
): Promise<TriageAdministerSavedViewResultV1> {
    const command = commandFrom(input);
    if (command === null) return { v: 1, status: 'rejected', reason: 'smartPolicy' };

    const result = await mutateTriageSavedViews({
        settings: deps.settings,
        mintViewId: deps.mintViewId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    }, command);

    if (result.status !== 'applied') {
        return result.status === 'rejected'
            ? { v: 1, status: 'rejected', reason: result.reason }
            : { v: 1, status: result.status };
    }
    return {
        v: 1,
        status: 'applied',
        views: projectViews(result.value.views),
        selectedViewId: result.value.selectedViewId,
        revision: result.revision,
    };
}

export function createTriageReadSavedViewsActionHandler(): ActionHandler<
    TriageReadSavedViewsInputV1,
    TriageReadSavedViewsResultV1
> {
    return async (input, context: PluginInvocationContext) => await readTriageSavedViewsForSurface(input, {
        settings: context.services.settings.forScope({ kind: 'account' }),
        mintViewId: () => mintTriageOpaqueIdV1(),
        signal: context.signal,
    });
}

export function createTriageAdministerSavedViewActionHandler(): ActionHandler<
    TriageAdministerSavedViewInputV1,
    TriageAdministerSavedViewResultV1
> {
    return async (input, context: PluginInvocationContext) => await administerTriageSavedView(input, {
        settings: context.services.settings.forScope({ kind: 'account' }),
        // Minted at the writer, never by a caller: a client-chosen id would let
        // two devices claim one view.
        mintViewId: () => mintTriageOpaqueIdV1(),
        signal: context.signal,
    });
}
