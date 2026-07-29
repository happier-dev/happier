import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/components/settings/agents/setup/AgentSetupFlow', () => ({
    AgentSetupFlow: (props: Record<string, unknown>) => React.createElement('AgentSetupFlow', props),
}));

describe('WizardAgentSetupStep', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('forces AgentSetupFlow into wizard presentation', async () => {
        const { WizardAgentSetupStep } = await import('./WizardAgentSetupStep');

        const screen = await renderScreen(
            <WizardAgentSetupStep machineId="machine-1" />,
        );

        const flow = screen.findByType('AgentSetupFlow' as never);
        expect(flow.props.presentation).toBe('wizard');
        expect(flow.props.machineId).toBe('machine-1');
    });
});
