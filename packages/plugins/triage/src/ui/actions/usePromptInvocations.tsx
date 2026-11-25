import { useEffect, useMemo, useState } from 'react';
import { usePluginHostApi, usePluginHostReadiness } from '@happier-dev/plugin-ui';

import {
    readTriagePromptInvocationsV1,
    type TriageActionResolutionHostV1,
    type TriagePromptInvocationOptionV1,
} from '../../sessions/actionResolution.js';
import type { TriageNewSessionFailureV1 } from '../header/newSessionSeedCommand.js';

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
    failure?: TriageNewSessionFailureV1;
}>;

export function useTriagePromptInvocations(): TriagePromptInvocationsStateV1 {
    const host = usePluginHostApi() as unknown as TriageActionResolutionHostV1;
    const readiness = usePluginHostReadiness(false);
    const [state, setState] = useState<TriagePromptInvocationsStateV1>({
        invocations: [],
        coverage: null,
    });
    useEffect(() => {
        if (readiness.pending || readiness.ready === false) return;
        const controller = new AbortController();
        void (async () => {
            const read = await readTriagePromptInvocationsV1(host, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (read.status === 'unavailable') {
                setState(previous => ({ ...previous, failure: read.failure }));
                return;
            }
            setState({ invocations: read.invocations, coverage: read.coverage });
        })();
        return () => { controller.abort(); };
    }, [host, readiness.pending, readiness.ready, readiness.revision]);

    return useMemo(() => state, [state]);
}
