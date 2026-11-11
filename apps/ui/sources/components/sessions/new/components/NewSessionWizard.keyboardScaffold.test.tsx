import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { createNewSessionWizardTestProps } from './newSessionWizardTestFixtures';
import { english } from '@/text/translations/teamsTranslations.shared';

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.native ?? values.default },
            Dimensions: { get: () => ({ width: 390, height: 700, scale: 1, fontScale: 1 }) },
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();

describe('NewSessionWizard real keyboard scaffold', () => {
    it.each(['team', 'group'] as const)('attributes a fresh member permission default to its %s source', async source => {
        const { NewSessionWizard } = await import('./NewSessionWizard');
        const { useNewSessionPermissionModeState } = await import('../hooks/screenModel/useNewSessionPermissionModeState');
        const { ManagedDefaultsV1Schema } = await import('@happier-dev/protocol/teams/managedDefaults');
        const values = { permissionModeByAgentTargetKey: { 'agent:happier.agent.claude/claude': 'read-only' } };
        function MemberSession() {
            const permission = useNewSessionPermissionModeState({
                agentType: 'claude', backendTarget: { kind: 'backend', backendId: 'claude' },
                hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
                selectedProfileId: null, profileMap: new Map(), enabledAgentIds: ['claude'],
                sessionDefaultPermissionModeByTargetKey: {},
                managedDefaults: { teamDefaults: ManagedDefaultsV1Schema.parse({
                    team: values, groups: source === 'group' ? { engineering: values } : {},
                }), groupIds: source === 'group' ? ['engineering'] : [] },
            });
            const props = createNewSessionWizardTestProps();
            props.machine.serverId = runtime.serverId;
            return <NewSessionWizard {...props} agent={{ ...props.agent, ...permission }} popoverBoundaryRef={{ current: null }} />;
        }
        const screen = await renderScreen(<runtime.Wrapper><MemberSession /></runtime.Wrapper>);
        expect(screen.getTextContent()).toContain(english.teams.settings.memberDefaults[
            source === 'team' ? 'teamDefault' : 'groupDefault']);
    });

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
