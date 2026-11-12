import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { isHostCancellation } from '../../hostCancellation.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1, TRIAGE_TASK_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import {
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
    preflightTriageRouteLensV1,
  type TriageRouteLensV1,
} from './location.js';

/** The settled answer for a linked-row navigation attempt. */
export type OpenTriageLinkedEntryOutcomeV1 =
    | Readonly<{ kind: 'opened' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'refused'; reason: 'routeTooLong' }>
    | Readonly<{ kind: 'refused'; reason: 'unavailable'; error: unknown }>;


/**
 * Open one linked entry through the qualified Triage destination.
 *
 * This is deliberately a route-only adapter for Session-linked rows: it does
 * not create a second details route or store, and it has no Composer launch
 * context to manufacture. The destination's existing Triage page owns the
 * selection reducer; this helper only supplies that page's canonical subpath.
 */
export async function openTriageLinkedEntry(
    hostApi: Pick<PluginUiHostApi, 'openSurface'>,
    entryRef: TriageEntryRefV1,
    signal?: AbortSignal,
    lens: TriageRouteLensV1 = TRIAGE_ROUTE_DEFAULT_LENS_V1,
): Promise<OpenTriageLinkedEntryOutcomeV1> {
    if (signal?.aborted === true) return { kind: 'cancelled' };

    const location = preflightTriageRouteLensV1({
        ...lens,
        selection: entryRef,
    });
    if (location.kind === 'refused') return { kind: 'refused', reason: 'routeTooLong' };

    try {
        await hostApi.openSurface(
            lens.filters.tasks === undefined ? TRIAGE_ENTRY_DETAIL_DESTINATION_V1 : TRIAGE_TASK_DETAIL_DESTINATION_V1,
            undefined,
            signal === undefined
                ? { subPath: location.subPath }
                : { subPath: location.subPath, signal },
        );
    } catch (error) {
        if (isHostCancellation(error, signal)) return { kind: 'cancelled' };
        return { kind: 'refused', reason: 'unavailable', error };
    }
    return { kind: 'opened' };
}
