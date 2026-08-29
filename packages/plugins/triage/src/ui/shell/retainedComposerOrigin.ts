import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageEntryDetailLaunchInputV1 } from '../../composer/entryDetailLaunchInput.js';
import { sameTriageEntryRefV1 } from '../state/surface.js';

/**
 * The Composer this page was opened FROM, held for the entry that open named
 * (`core/COMPOSER.md` §2.1).
 *
 * The live launch is the open's current origin fact and is derived immediately
 * in the commit that delivers it: a Composer-origin launch names its Composer
 * at once, and a same-entry app launch — whose absent address is an explicit
 * fact — clears any earlier Composer origin without that origin ever rendering
 * for a commit. Composer-B therefore never renders Composer-A, and an app
 * relaunch of the same entry never resurrects a draft the reader did not open
 * from.
 *
 * A delivered launch is not a place to read an address from later. The host
 * retires it as soon as the page's own location moves — which happens the
 * instant the launch is adopted, long before the reader has finished with the
 * entry it opened — so every delivered launch is adopted once beside the entry
 * it belongs to, and that retained pair answers only after the launch retired.
 *
 * It is answered only while that exact entry is the one selected. The
 * originating draft is a fact about THIS open, not about wherever the reader
 * navigates next, and handing it to another entry's detail would offer to write
 * a reference to something the reader never opened from that draft.
 *
 * A Composer scope the host has since retired fails at the canonical owner's
 * own `read`/`apply` rather than being guessed at here.
 */
export function useTriageRetainedComposerOriginV1(input: Readonly<{
    launch: TriageEntryDetailLaunchInputV1 | undefined;
    selectedEntryRef: TriageEntryRefV1 | null;
}>): ComposerRefV1 | null {
    const { launch, selectedEntryRef } = input;
    const [retained, setRetained] = React.useState<Readonly<{
        entryRef: TriageEntryRefV1;
        composer: ComposerRefV1 | null;
    }> | null>(null);

    const launchedEntryRef = launch?.entryRef;
    const launchedComposer = launch?.originComposer;
    React.useEffect(() => {
        if (launchedEntryRef === undefined) return;
        // Every delivered launch replaces the retained open fact for its entry.
        // An app-origin launch omits the address key, which clears the pair:
        // retention never outlives the launch it came from.
        setRetained({ entryRef: launchedEntryRef, composer: launchedComposer ?? null });
    }, [launchedComposer, launchedEntryRef]);

    return React.useMemo(() => {
        if (selectedEntryRef === null) return null;
        // The live launch wins for its own entry in its own commit — including
        // its explicit clear — so the answer never lags one commit behind the
        // open the reader just performed.
        if (launchedEntryRef !== undefined && sameTriageEntryRefV1(launchedEntryRef, selectedEntryRef)) {
            return launchedComposer ?? null;
        }
        // After the launch retired (or named another entry), the adopted pair
        // answers for the entry it was delivered with.
        if (retained !== null && sameTriageEntryRefV1(retained.entryRef, selectedEntryRef)) {
            return retained.composer;
        }
        return null;
    }, [launchedComposer, launchedEntryRef, retained, selectedEntryRef]);
}
