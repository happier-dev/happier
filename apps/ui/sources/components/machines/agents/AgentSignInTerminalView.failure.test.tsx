import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { AgentSignInTerminalView } = await import('./AgentSignInTerminalView');

const handlers = { onOpenUrl: () => {}, onCheckAgain: vi.fn(), onClose: () => {} };

function view(layout: 'pane' | 'sheet', failure = 'Machine is unreachable.') {
    return (
        <AgentSignInTerminalView
            testID="sign-in"
            layout={layout}
            agentTitle="Codex"
            mark={null}
            machineName="devbox"
            session={{ phase: 'failed', failure, terminalKey: null, authUrl: null, startedAtMs: null }}
            accountLabel={null}
            terminal={null}
            handlers={handlers}
        />
    );
}

describe('AgentSignInTerminalView failure', () => {
    it.each([
        ['agent_login_unsupported', 'pane'],
        ['agent_login_unsupported', 'sheet'],
        ['connected_service_unsupported', 'pane'],
        ['sign_in_cancelled', 'pane'],
        ['sign_in_unavailable', 'pane'],
        ['sign_in_terminal_changed', 'pane'],
        ['sign_in_status_unavailable', 'pane'],
        ['agent_login_not_confirmed', 'pane'],
        ['action_disabled', 'pane'],
        ['approval_canceled', 'sheet'],
        ['approval_rejected', 'pane'],
        ['terminal_forbidden', 'pane'],
        ['terminal_spawn_failed', 'sheet'],
    ] as const)('explains the typed %s refusal with a next step (%s)', async (code, layout) => {
        const screen = await renderScreen(view(layout, code));
        try {
            expect(screen.getTextContent()).not.toContain(code);
            expect(screen.getTextContent()).toContain(t('machineAgents.checkAgain'));
            handlers.onCheckAgain.mockClear();
            await screen.pressByTestIdAsync('sign-in.checkAgain');
            expect(handlers.onCheckAgain).toHaveBeenCalledOnce();
        } finally { await screen.unmount(); }
    });

    it.each(['pane', 'sheet'] as const)('says the failure once, with one way to check again (%s)', async (layout) => {
        const screen = await renderScreen(view(layout));
        const text = screen.getTextContent();
        expect(text).toContain('Machine is unreachable.');
        expect(text.split('Machine is unreachable.')).toHaveLength(2);
        expect(text.split(t('machineAgents.checkAgain'))).toHaveLength(2);
        await screen.unmount();
    });

    it.each(['pane', 'sheet'] as const)('stops telling the person to finish in a browser that never opened (%s)', async layout => {
        const screen = await renderScreen(view(layout));
        expect(t('machineAgents.panelLead').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain(t('machineAgents.panelLead'));
        expect(screen.getTextContent()).not.toContain(t('machineAgents.phoneLead', { agent: 'Codex', machine: 'devbox' }));
        await screen.unmount();
    });
});
