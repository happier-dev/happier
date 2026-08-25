import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageEntryDetailLaunchInputV1 } from '../../composer/entryDetailLaunchInput.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';

/**
 * The Composer this page was opened FROM, held for the entry that open named
 * (`core/COMPOSER.md` §2.1).
 *
 * A delivered launch is not a place to read an address from later. The host
 * retires it as soon as the page's own location moves — which happens the
 * instant the launch is adopted, long before the reader has finished with the
 * entry it opened — so a detail that read `launch.originComposer` on demand
 * would find nothing there every time it mattered. The address is captured once,
 * beside the entry it belongs to, and survives the retirement.
 *
 * It is answered only while that exact entry is the one selected. The
 * originating draft is a fact about THIS open, not about wherever the reader
 * navigates next, and handing it to another entry's detail would offer to write
 * a reference to something the reader never opened from that draft.
 *
 * Nothing is cleared when the selection moves, because nothing needs to be: the
 * pair is inert for every other entry, and a Composer scope the host has since
 * retired fails at the canonical owner's own `read`/`apply` rather than being
 * guessed at here. Returning to the same entry re-answers with the same address,
 * which is the same draft the reader left open.
 */
export function useTriageRetainedComposerOriginV1(input: Readonly<{
    launch: TriageEntryDetailLaunchInputV1 | undefined;
    selectedEntryRef: TriageEntryRefV1 | null;
}>): ComposerRefV1 | null {
    const { launch, selectedEntryRef } = input;
    const [retained, setRetained] = React.useState<Readonly<{
        entryRef: TriageEntryRefV1;
        composer: ComposerRefV1;
    }> | null>(null);

    const launchedComposer = launch?.originComposer;
    const launchedEntryRef = launch?.entryRef;
    React.useEffect(() => {
        if (launchedComposer === undefined || launchedEntryRef === undefined) return;
        setRetained({ entryRef: launchedEntryRef, composer: launchedComposer });
    }, [launchedComposer, launchedEntryRef]);

    return React.useMemo(() => {
        if (retained === null || selectedEntryRef === null) return null;
        return sameTriageEntryRefV1(retained.entryRef, selectedEntryRef)
            ? retained.composer
            : null;
    }, [retained, selectedEntryRef]);
}
