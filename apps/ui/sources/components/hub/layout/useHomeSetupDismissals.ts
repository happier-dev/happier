import * as React from 'react';
import { listHiddenHomeSetupSteps } from './homeHubLayout';
import { useHomeHubArtifactLayout } from './useHomeHubArtifactLayout';

export type HomeSetupDismissals = Readonly<{ hasSnapshot: boolean; hidden: ReadonlySet<string>; dismiss(stepId: string): Promise<void> }>;
/** Setup and layout edit the same mode-aware Home Artifact through one semantic Action. */
export function useHomeSetupDismissals(): HomeSetupDismissals {
    const { layout, hasSnapshot, dispatch } = useHomeHubArtifactLayout();
    const ids = listHiddenHomeSetupSteps(layout);
    const signature = JSON.stringify(ids);
    const hidden = React.useMemo(() => new Set<string>(JSON.parse(signature)), [signature]);
    const dismiss = React.useCallback((stepId: string) => dispatch({ kind: 'setup_visibility', stepId, hidden: true }), [dispatch]);
    return React.useMemo(() => ({ hasSnapshot, hidden, dismiss }), [hasSnapshot, hidden, dismiss]);
}
