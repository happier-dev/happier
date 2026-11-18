import { useMemo } from 'react';
import { resolveCrossSessionAuthoringFieldControl } from './crossSessionAuthoringFieldControls';

/** Catalog/selection identities are semantic inputs; transcript arrivals do no intersection work. */
export function useCrossSessionAuthoringFieldControl(
    params: Parameters<typeof resolveCrossSessionAuthoringFieldControl>[0],
) {
    const { field, targets, selection, agentSwitchingEnabled, mixedLabel, capabilityEditing } = params;
    return useMemo(() => resolveCrossSessionAuthoringFieldControl({ field, targets, selection, agentSwitchingEnabled, mixedLabel, capabilityEditing }),
        [field, targets, selection, agentSwitchingEnabled, mixedLabel, capabilityEditing]);
}
