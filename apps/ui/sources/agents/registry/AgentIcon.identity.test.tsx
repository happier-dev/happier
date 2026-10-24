import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputAssetLoader, installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';

installAgentInputCommonModuleMocks();
beforeEach(installAgentInputAssetLoader);

describe('AgentIcon identity', () => {
    it('renders a neutral mark for unresolved Session identity', async () => {
        const { AgentIcon } = await import('./AgentIcon');
        const screen = await renderScreen(<AgentIcon agentId={null} size={20} color="#777777" testID="unknown-agent" />);

        expect(screen.tree.root.findByProps({ name: 'stack-simple' }).props).toMatchObject({
            size: 20,
            color: '#777777',
            testID: 'unknown-agent',
        });
    });
});
