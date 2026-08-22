import type { ProtocolComposerRefV1 } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { isHostCancellation } from '../hostCancellation.js';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import type { TriageEntryRefV1, TriageSourceInstanceRefV1 } from '@happier-dev/triage-protocol/v1';

import {
    buildTriageEntryDetailLaunchInput,
    parseTriageEntryDetailLaunchInput,
} from './entryDetailLaunchInput.js';

/**
 * View details (`core/COMPOSER.md` §2.1).
 *
 * It opens exactly one thing — the qualified Triage app page — through the
 * generic qualified-destination navigation owner, carrying the strict Triage
 * launch input unchanged.
 *
 * It is the picker row's OTHER action, and it is independent by construction:
 * it takes no composer handle, no attachment id and no draft capability, so
 * "View details cannot mutate the attachment" is a property of the signature
 * rather than a rule someone has to keep remembering. A denied or cancelled
 * open therefore leaves the draft byte-identical without doing anything to
 * preserve it.
 *
 * `originComposer` does not weaken that: it is the mounted scope's ADDRESS, not
 * a handle. It travels inside the strict launch input — the one carrier PEP
 * `03d1` §17.8 allows — so the opened page can later reach back to the draft the
 * reader was writing in through the canonical Composer owner, which stays the
 * sole authority on whether that scope is still live.
 *
 * Triage owns no router here. `subPath: ''` is the destination's host-owned
 * page root; the opened page's own selection reducer and location writer
 * replace it with the canonical entry encoding.
 */

/**
 * The local id of the one Triage `appPage` destination.
 *
 * `core/COMPOSER.md` §7 assigns the declaration to the Surface lane's
 * `manifest.ts`. This is the single constant both sides consume: the manifest
 * declares `app.pages` with exactly this local id and imports it from here, so
 * the navigation call and the declaration cannot drift into two spellings.
 */
export const TRIAGE_APP_PAGE_LOCAL_ID_V1 = 'triage';

/** The one qualified destination View details opens. */
export const TRIAGE_ENTRY_DETAIL_DESTINATION_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_APP_PAGE_LOCAL_ID_V1,
});

export type TriageEntryDetailOpenOutcomeV1 =
    | Readonly<{ kind: 'opened' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'refused'; reason: 'invalidSelection' | 'unavailable'; code?: string }>;

export type TriageEntryDetailOpenRequestV1 = Readonly<{
    /** The generic navigation seam. Deliberately narrowed to the one method used. */
    hostApi: Pick<PluginUiHostApi, 'openSurface'>;
    entryRef: TriageEntryRefV1;
    sourceInstance: TriageSourceInstanceRefV1;
    /**
     * The exact scope this mount was stamped with, on a Composer-origin open.
     * Absent for an app-origin open; never inferred from `current()`/`active()`.
     */
    originComposer?: ProtocolComposerRefV1;
    signal?: AbortSignal;
}>;

function hostErrorCode(error: unknown): string | undefined {
    const code = (error as Readonly<{ code?: unknown }> | null)?.code;
    return typeof code === 'string' && code !== '' ? code : undefined;
}

export async function openTriageEntryDetails(
    request: TriageEntryDetailOpenRequestV1,
): Promise<TriageEntryDetailOpenOutcomeV1> {
    if (request.signal?.aborted === true) return { kind: 'cancelled' };

    // Admitted by the SAME parser the destination applies. Navigating first and
    // letting the page refuse would strand the reader on a detail page that
    // cannot say what it is showing.
    const parsed = parseTriageEntryDetailLaunchInput(buildTriageEntryDetailLaunchInput({
        entryRef: request.entryRef,
        sourceInstance: request.sourceInstance,
        originComposer: request.originComposer,
    }));
    if (parsed.status !== 'valid') return { kind: 'refused', reason: 'invalidSelection' };

    try {
        await request.hostApi.openSurface(
            TRIAGE_ENTRY_DETAIL_DESTINATION_V1,
            parsed.input,
            { subPath: '' },
        );
    } catch (error) {
        // A fail-closed destination resolver is correct behaviour, not something
        // to route around: there is no second opener to try, and the invoked
        // control has to be able to say why nothing happened.
        if (isHostCancellation(error, request.signal)) return { kind: 'cancelled' };
        const code = hostErrorCode(error);
        return code === undefined
            ? { kind: 'refused', reason: 'unavailable' }
            : { kind: 'refused', reason: 'unavailable', code };
    }
    return { kind: 'opened' };
}
