import { useEffect, useMemo, useRef, useState } from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';

import {
    readTriagePromptInvocationsV1,
    type TriageActionResolutionHostV1,
    type TriagePromptInvocationOptionV1,
} from '../../sessions/actionResolution.js';

/**
 * The Prompt Library invocations this mount may offer, read once.
 *
 * The editor stores a STABLE invocation id, and nobody can type one. Offering
 * the list is therefore not a convenience: without it the reference is
 * unwritable and the member stays configured-looking and inert — the exact
 * shape of defect this vertical exists to remove.
 *
 * A read that does not answer leaves the list empty and the editor falls back
 * to showing the id it already holds, so an existing configuration is never
 * silently cleared because a catalog was briefly unreachable.
 */
export type TriagePromptInvocationsStateV1 = Readonly<{
    invocations: readonly TriagePromptInvocationOptionV1[];
    coverage: 'complete' | 'truncated' | null;
}>;

export function useTriagePromptInvocations(): TriagePromptInvocationsStateV1 {
    const host = usePluginHostApi() as unknown as TriageActionResolutionHostV1;
    const [state, setState] = useState<TriagePromptInvocationsStateV1>({
        invocations: [],
        coverage: null,
    });
    const retired = useRef(false);

    useEffect(() => {
        retired.current = false;
        void (async () => {
            const read = await readTriagePromptInvocationsV1(host);
            if (retired.current || read.status !== 'read') return;
            setState({ invocations: read.invocations, coverage: read.coverage });
        })();
        return () => { retired.current = true; };
    }, [host]);

    return useMemo(() => state, [state]);
}
