import { describe, expect, it } from 'vitest';

import { RUNTIME_ACTION_IDS_V1 } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';

// UX-3: the internal projection-contract copy must never leak to a user-facing surface for an
// ENABLED runtime action. Enabled actions are those projected onto the `ui` surface (real executor);
// disabled projection-only specs legitimately retain the fail-closed stub.
const PROJECTION_CONTRACT_FRAGMENT = 'Runtime-unification action projection contract';
const PROJECTION_CONTRACT_HINT_FRAGMENT = 'No UI, tool, RPC, or SDK surface is enabled';

describe('runtime action descriptions (UX-3)', () => {
    const enabledRuntimeActionIds = RUNTIME_ACTION_IDS_V1.filter(
        (id) => getActionSpec(id).surfaces.ui === true,
    );

    it('exercises a non-trivial set of enabled runtime actions', () => {
        expect(enabledRuntimeActionIds.length).toBeGreaterThan(10);
    });

    it('no enabled runtime action surfaces the internal projection-contract description', () => {
        const leaking = enabledRuntimeActionIds.filter((id) => {
            const spec = getActionSpec(id);
            return spec.description.includes(PROJECTION_CONTRACT_FRAGMENT)
                || (spec.inputHints?.description?.includes(PROJECTION_CONTRACT_HINT_FRAGMENT) ?? false);
        });
        expect(leaking).toEqual([]);
    });

    it('enabled runtime actions carry a non-empty human description', () => {
        for (const id of enabledRuntimeActionIds) {
            const spec = getActionSpec(id);
            expect(spec.description.trim().length).toBeGreaterThan(0);
        }
    });

    it('disabled runtime actions retain the fail-closed projection-contract stub', () => {
        const disabled = RUNTIME_ACTION_IDS_V1.filter((id) => getActionSpec(id).surfaces.ui !== true);
        // At least one runtime action is still projection-only; it must keep the stub copy so the
        // honesty-net continues to flag unimplemented surfaced actions.
        const stubbed = disabled.filter((id) => getActionSpec(id).description.includes(PROJECTION_CONTRACT_FRAGMENT));
        expect(stubbed).toEqual(disabled);
    });
});
