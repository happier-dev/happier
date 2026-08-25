import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/plugin-ui';
import type {
    TriageEvidenceDisclosureOutcomeV1,
    TriageEvidenceDisclosureResolverV1,
    TriageEvidenceDisclosureV1,
} from '@happier-dev/triage-sources/ui';

import { isHostCancellation } from '../hostCancellation.js';
import { applyTriageRevisionCheckedMutation } from './applyEntryMutation.js';
import { planTriageTierBEvidenceInsertion } from './mutationPlan.js';
import { useTriageBoundComposer } from './useBoundComposer.js';

export type { TriageEvidenceCandidateV1 } from './mutationPlan.js';

const UNAVAILABLE: TriageEvidenceDisclosureOutcomeV1 = Object.freeze({
    kind: 'refused',
    reason: 'The composer is no longer open.',
});
const CANCELLED: TriageEvidenceDisclosureOutcomeV1 = Object.freeze({ kind: 'cancelled' });
const INERT: TriageEvidenceDisclosureOutcomeV1 = Object.freeze({ kind: 'inert' });
const CONFLICT: TriageEvidenceDisclosureOutcomeV1 = Object.freeze({
    kind: 'refused',
    reason: 'The draft changed while this was applied. Try again.',
});

/**
 * The single Triage consumer for source-owned Tier-B evidence candidates.
 *
 * The exact `originComposer` from the closed Triage launch input is bound by
 * `useTriageBoundComposer`; no active/focused lookup and no remembered handle
 * exists. One request supersedes its predecessor. Cleanup aborts the public
 * Composer calls and invalidates the synchronous currentness predicate, so a
 * candidate or read that settles after replacement/unmount cannot reach apply.
 *
 * The value this returns IS the shared source bridge's disclosure contract
 * (`@happier-dev/triage-sources/ui`), handed straight to the provider the detail
 * region mounts. There is no Triage-local adapter shape in between: one
 * declaration of what a disclosure is, one owner of what it does.
 */
export function useTriageTierBEvidenceInsertion(
    originComposer: ComposerRefV1 | null,
): TriageEvidenceDisclosureV1 {
    const handle = useTriageBoundComposer(originComposer);
    const generation = React.useRef(0);
    const active = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        generation.current += 1;
        return () => {
            generation.current += 1;
            active.current?.abort();
            active.current = null;
        };
    }, [handle]);

    const disclose = React.useCallback(async (
        resolver: TriageEvidenceDisclosureResolverV1,
    ): Promise<TriageEvidenceDisclosureOutcomeV1> => {
        if (handle === null) return UNAVAILABLE;

        active.current?.abort();
        const controller = new AbortController();
        active.current = controller;
        const requestGeneration = ++generation.current;
        const isCurrent = () => (
            !controller.signal.aborted
            && active.current === controller
            && generation.current === requestGeneration
        );

        try {
            const disclosed = await resolver(controller.signal);
            if (!isCurrent()) return INERT;
            if (disclosed === null) return CANCELLED;

            const outcome = await applyTriageRevisionCheckedMutation({
                handle,
                options: { signal: controller.signal },
                isCurrent,
                plan: (snapshot) => planTriageTierBEvidenceInsertion(snapshot, disclosed),
            });
            return outcome.kind === 'conflict' ? CONFLICT : outcome;
        } catch (error) {
            if (!isCurrent() || isHostCancellation(error, controller.signal)) return INERT;
            return {
                kind: 'refused',
                reason: 'The evidence reference could not be prepared. Try again.',
            };
        } finally {
            if (active.current === controller) active.current = null;
        }
    }, [handle]);

    return React.useMemo(() => Object.freeze({
        available: handle !== null,
        disclose,
    }), [disclose, handle]);
}
