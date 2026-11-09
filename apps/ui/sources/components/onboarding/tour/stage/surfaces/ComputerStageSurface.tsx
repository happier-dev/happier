import * as React from 'react';

import { ComputerScreenViewer } from '@/components/computer/ComputerScreenViewer';
import { useComputerScreen } from '@/components/computer/useComputerScreen';
import { buildDemoComputerWorld } from '@/demoMode/world/computer';
import { useDeviceType } from '@/utils/platform/responsive';

/** The real Computer controller and viewer, fed only at machine RPC and relay transport boundaries. */
export function ComputerStageSurface(): React.ReactElement {
    const [world] = React.useState(buildDemoComputerWorld);
    React.useEffect(() => () => world.dispose(), [world]);
    const model = useComputerScreen({ scope: world.scope, execute: world.execute, transport: world.transport,
        agent: { agentId: 'claude', name: 'Claude' } });
    const { resolveChooseWindow: _picker, ...viewer } = model;
    return <ComputerScreenViewer {...viewer} compact={useDeviceType() === 'phone'} testID="demo-stage-computer" />;
}
