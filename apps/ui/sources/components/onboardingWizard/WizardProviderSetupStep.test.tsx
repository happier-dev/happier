import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));

describe('WizardProviderSetupStep', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('forces ProviderSetupFlow into wizard presentation', async () => {
        const { WizardProviderSetupStep } = await import('./WizardProviderSetupStep');

        const screen = await renderScreen(
            <WizardProviderSetupStep machineId="machine-1" />,
        );

        const flow = screen.findByType('ProviderSetupFlow' as never);
        expect(flow.props.presentation).toBe('wizard');
        expect(flow.props.machineId).toBe('machine-1');
    });
});
