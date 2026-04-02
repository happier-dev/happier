import * as React from 'react';

import { SetupThisComputerChecklistStep } from '../checklists/setupThisComputer/SetupThisComputerChecklistStep';

export const SetupThisComputerWizardStep = React.memo(function SetupThisComputerWizardStep(
    props: React.ComponentProps<typeof SetupThisComputerChecklistStep>,
) {
    return <SetupThisComputerChecklistStep {...props} />;
});
