import * as React from 'react';
import { createDeploymentReadControllerV1 } from '@happier-dev/deployments';

import { AllDeploymentsView } from '@/components/projects/deployments/AllDeploymentsScreen';
import { useDeploymentCollection } from '@/components/projects/deployments/useDeploymentReads';
import { useDeploymentPresentationDemand } from '@/components/projects/deployments/useDeploymentPresentationDemand';
import { buildDemoDeploymentTransport } from '@/demoMode/world/deployments';

/** The production page and read controller over the demo world's local read boundary. */
export function DeploymentsStageSurface(): React.ReactElement {
    const controller = React.useMemo(() => createDeploymentReadControllerV1({
        scope: { serverId: 'demo-home', accountId: 'demo-account' },
        transport: buildDemoDeploymentTransport(),
    }), []);
    React.useEffect(() => () => controller.retire(), [controller]);
    const demand = useDeploymentPresentationDemand(true);
    const read = useDeploymentCollection(controller, demand);
    return <AllDeploymentsView read={read} serverId="demo-home" />;
}
