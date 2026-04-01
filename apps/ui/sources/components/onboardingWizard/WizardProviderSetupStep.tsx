import * as React from 'react';

import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';

export const WizardProviderSetupStep = React.memo(function WizardProviderSetupStep(
    props: React.ComponentProps<typeof ProviderSetupFlow>,
) {
    return <ProviderSetupFlow {...props} presentation="wizard" />;
});
