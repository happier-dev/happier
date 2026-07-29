import * as React from 'react';

import { AgentSetupFlow } from '@/components/settings/agents/setup/AgentSetupFlow';

export const WizardAgentSetupStep = React.memo(function WizardAgentSetupStep(
    props: React.ComponentProps<typeof AgentSetupFlow>,
) {
    return <AgentSetupFlow {...props} presentation="wizard" />;
});
