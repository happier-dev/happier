import * as React from 'react';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';

import { useDestinationInstanceFacts } from '@/components/appShell/workspace/destinationInstanceContext';

/**
 * The deployments pages' read demand. A hosted destination reads while it is visible: a split pane beside the
 * focused one still shows its Environment, as Session hydration does. Only a Stack screen with no destination host
 * falls back to its screen focus. A hidden retained tab does no reads.
 */
export function useDeploymentPresentationDemand(isFocused: boolean): DeploymentReadDemandV1 {
    const destination = useDestinationInstanceFacts();
    const presented = destination ? destination.visible : isFocused;
    return React.useMemo(() => ({ mounted: true, visible: presented, focused: presented }), [presented]);
}
