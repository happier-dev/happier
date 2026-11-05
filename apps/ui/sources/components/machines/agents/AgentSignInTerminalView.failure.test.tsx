import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { AgentSignInTerminalView } = await import('./AgentSignInTerminalView');

const handlers = { onOpenUrl: () => {}, onCheckAgain: vi.fn(), onClose: () => {} };

function view(layout: 'pane' | 'sheet') {
    return (
        <AgentSignInTerminalView
            testID="sign-in"
            layout={layout}
            agentTitle="Codex"
            mark={null}
            machineName="devbox"
            session={{ phase: 'failed', failure: 'Machine is unreachable.', authUrl: null, startedAtMs: null } as never}
            accountLabel={null}
            terminal={null}
            handlers={handlers}
        />
    );
}

describe('AgentSignInTerminalView failure', () => {
    it.each(['pane', 'sheet'] as const)('says the failure once, with one way to check again (%s)', async (layout) => {
        const screen = await renderScreen(view(layout));
        const text = screen.getTextContent();
        expect(text).toContain('Machine is unreachable.');
        expect(text.split('Machine is unreachable.')).toHaveLength(2);
        expect(text.split(t('machineAgents.checkAgain'))).toHaveLength(2);
        await screen.unmount();
    });

    it('stops telling the person to finish in a browser that never opened', async () => {
        const screen = await renderScreen(view('pane'));
        expect(t('machineAgents.panelLead').length).toBeGreaterThan(0);
        expect(screen.getTextContent()).not.toContain(t('machineAgents.panelLead'));
        await screen.unmount();
    });
});
