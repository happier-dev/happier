import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createNewSessionWizardTestProps } from './newSessionWizardTestFixtures';

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.native ?? values.default },
            Dimensions: { get: () => ({ width: 390, height: 700, scale: 1, fontScale: 1 }) },
            useWindowDimensions: () => ({ width: 390, height: 700, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();

describe('NewSessionWizard real keyboard scaffold', () => {
    it('renders through the shared scaffold and caps the real AgentInput panel to the native viewport', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const { ComposerKeyboardScaffold } = await import('@/components/sessions/keyboardAvoidance');
        const props = createNewSessionWizardTestProps();
        props.machine.serverId = runtime.serverId;
        const screen = await renderScreen(<runtime.Wrapper>
            <NewSessionWizard {...props} popoverBoundaryRef={{ current: null }} />
        </runtime.Wrapper>);
        const scaffold = screen.findByType(ComposerKeyboardScaffold);
        expect(scaffold.props.mode).toBe('newSession');
        expect(screen.findHostByTestId('new-session-wizard-keyboard-content')).not.toBeNull();
        expect(screen.findHostByTestId('new-session-wizard-composer-keyboard-host')).not.toBeNull();
        const input = screen.findByType(AgentInput);
        expect(input.props.maxPanelHeight).toBe(280);
        expect(input.props.retainKeyboardLift).toBeTypeOf('function');
    });

    it('shows the selected-agent setup blocker supplied by the canonical composer without duplicate banners', async () => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const props = createNewSessionWizardTestProps();
        props.machine.serverId = runtime.serverId;
        props.agent.cliAvailability = { ...props.agent.cliAvailability, available: { codex: false } };
        props.footer.composerTopContent = React.createElement('Text', { testID: 'selected-agent-blocker' }, 'Set up Codex');
        const screen = await renderScreen(<runtime.Wrapper>
            <NewSessionWizard {...props} popoverBoundaryRef={{ current: null }} />
        </runtime.Wrapper>);
        expect(screen.findHostByTestId('selected-agent-blocker')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('newSession.cliBanners.');
    });
});
