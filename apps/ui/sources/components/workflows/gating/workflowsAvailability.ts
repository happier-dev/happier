import * as React from 'react';

import { useFeatureDecision, type FeatureDecisionScopeParams } from '@/hooks/server/useFeatureDecision';

/**
 * The one canonical Workflows availability decision.
 *
 * `workflows` is the single availability decision for structured Workflow
 * authoring, and it declares `automations` as its catalog dependency, so the
 * shared dependency resolver — never a caller — decides what an enabled
 * Automations bit implies. Automations enabled with Workflows unavailable is a
 * supported configuration: the released one-shot Automation recipe stays fully
 * authorable while the Workflow-v2 arms that Run admission refuses must not be
 * reachable.
 *
 * Every structured-Workflow entry point resolves availability here, at the exact
 * scope {@link WorkflowsGate} already uses, so the dedicated Workflow routes and
 * the Automation recipe editor cannot diverge into two decisions.
 */
export type WorkflowsAvailability = Readonly<{
    /** True only for the canonical enabled decision; unknown is never permission. */
    available: boolean;
    /** The decision has not resolved yet, so a route may still wait rather than refuse. */
    resolving: boolean;
}>;

export function useWorkflowsAvailability(scope?: FeatureDecisionScopeParams): WorkflowsAvailability {
    const decision = useFeatureDecision('workflows', scope ?? { scopeKind: 'runtime' });
    return React.useMemo(() => ({
        available: decision?.state === 'enabled',
        resolving: decision === null || decision.state === 'unknown',
    }), [decision]);
}
