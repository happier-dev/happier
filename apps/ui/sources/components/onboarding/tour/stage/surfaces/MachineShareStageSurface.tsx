import * as React from 'react';

import { ShareSheet } from '@/components/sharing/ShareSheet';
import { createMachineShareAdapter } from '@/components/sharing/machines/machineShareAdapter';
import { buildDemoMachineShareController } from '@/demoMode/world/machineShare';

/** The real Machine share sheet with the owner-user trust disclosure and Northstar roster. */
export function MachineShareStageSurface(): React.ReactElement {
    const [controller] = React.useState(buildDemoMachineShareController);
    const adapter = createMachineShareAdapter({ machineName: 'MacBook Pro', online: true, controller });
    return <ShareSheet model={controller.model} actions={controller.actions} adapter={adapter}
        presentation="full" testID="demo-machine-share" />;
}
