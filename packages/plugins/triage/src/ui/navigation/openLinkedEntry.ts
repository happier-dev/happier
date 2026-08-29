import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { isHostCancellation } from '../../hostCancellation.js';
import { TRIAGE_ENTRY_DETAIL_DESTINATION_V1 } from '../../composer/openEntryDetails.js';
import {
    TRIAGE_ROUTE_DEFAULT_LENS_V1,
    preflightTriageRouteLensV1,
} from './location.js';

/** The settled answer for a linked-row navigation attempt. */
export type OpenTriageLinkedEntryOutcomeV1 =
    | Readonly<{ kind: 'opened' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'refused'; reason: 'routeTooLong' | 'unavailable'; code?: string }>;

function hostErrorCode(error: unknown): string | undefined {
    const code = (error as Readonly<{ code?: unknown }> | null)?.code;
    return typeof code === 'string' && code !== '' ? code : undefined;
}

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
): Promise<OpenTriageLinkedEntryOutcomeV1> {
    if (signal?.aborted === true) return { kind: 'cancelled' };

    const location = preflightTriageRouteLensV1({
        ...TRIAGE_ROUTE_DEFAULT_LENS_V1,
        selection: entryRef,
    });
    if (location.kind === 'refused') return { kind: 'refused', reason: 'routeTooLong' };

    try {
        await hostApi.openSurface(
            TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
            undefined,
            signal === undefined
                ? { subPath: location.subPath }
                : { subPath: location.subPath, signal },
        );
    } catch (error) {
        if (isHostCancellation(error, signal)) return { kind: 'cancelled' };
        const code = hostErrorCode(error);
        return code === undefined
            ? { kind: 'refused', reason: 'unavailable' }
            : { kind: 'refused', reason: 'unavailable', code };
    }
    return { kind: 'opened' };
}
