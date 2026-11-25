import { useEffect, useMemo, useState } from 'react';
import { usePluginHostApi, usePluginHostReadiness } from '@happier-dev/plugin-ui';

import {
    readTriageLaunchProfilesV1,
    type TriageActionResolutionHostV1,
    type TriageLaunchProfileOptionV1,
} from '../../sessions/actionResolution.js';
import type { TriageNewSessionFailureV1 } from '../header/newSessionSeedCommand.js';

/**
 * The Launch Profiles this mount may offer, read once, WITH what the catalog
 * said about its own answer.
 *
 * The editor stores a profile's STABLE id and nobody can type one, so the list
 * is what makes the member writable at all. It is read through the same host
 * Action the press path resolves a profile with, so the editor cannot offer a
 * profile the press would then fail to find.
 *
 * `coverage` is the part a bare array cannot carry. An empty list because the
 * catalog did not answer, a prefix cut by a caller bound, and a projection that
 * retained unreadable newer-schema rows must not look like an account with no
 * profiles. Only `complete` makes absence evidence of deletion.
 */
export type TriageLaunchProfilesStateV1 = Readonly<{
    profiles: readonly TriageLaunchProfileOptionV1[];
    /** What absence from the returned rows means. Null while no read answered. */
    coverage: 'complete' | 'truncated' | 'unreadable' | null;
    /** The read has not come back yet; nothing may be concluded from it. */
    pending: boolean;
    failure?: TriageNewSessionFailureV1;
}>;

export function useTriageLaunchProfiles(): TriageLaunchProfilesStateV1 {
    const host = usePluginHostApi() as unknown as TriageActionResolutionHostV1;
    const readiness = usePluginHostReadiness(false);
    const [state, setState] = useState<TriageLaunchProfilesStateV1>({
        profiles: [],
        coverage: null,
        pending: true,
    });
    useEffect(() => {
        if (readiness.pending || readiness.ready === false) return;
        const controller = new AbortController();
        void (async () => {
            const read = await readTriageLaunchProfilesV1(host, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (read.status !== 'read') {
                setState({ profiles: [], coverage: null, pending: false, failure: read.failure });
                return;
            }
            setState({
                profiles: read.profiles,
                coverage: read.coverage,
                pending: false,
            });
        })();
        return () => { controller.abort(); };
    }, [host, readiness.pending, readiness.ready, readiness.revision]);

    return useMemo(() => state, [state]);
}
