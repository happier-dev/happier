import { useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';

import {
    readTriageLaunchProfilesV1,
    type TriageActionResolutionHostV1,
    type TriageLaunchProfileOptionV1,
} from '../../sessions/actionResolution.js';

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
}>;

export function useTriageLaunchProfiles(): TriageLaunchProfilesStateV1 {
    const host = usePluginHostApi() as unknown as TriageActionResolutionHostV1;
    const [state, setState] = useState<TriageLaunchProfilesStateV1>({
        profiles: [],
        coverage: null,
        pending: true,
    });
    const retired = useRef(false);

    useEffect(() => {
        retired.current = false;
        void (async () => {
            const read = await readTriageLaunchProfilesV1(host);
            if (retired.current) return;
            if (read.status !== 'read') {
                setState({ profiles: [], coverage: null, pending: false });
                return;
            }
            setState({
                profiles: read.profiles,
                coverage: read.coverage,
                pending: false,
            });
        })();
        return () => { retired.current = true; };
    }, [host]);

    return useMemo(() => state, [state]);
}
