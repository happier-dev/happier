import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { installTimerCensus, reactNativeWebAppState, renderScreen } from '@/dev/testkit';

import { MachineWatchLine } from './add/MachineAddPanes';
import { AgentSignInTerminalView } from './agents/AgentSignInTerminalView';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function signIn(startedAtMs: number, layout: 'pane' | 'sheet') {
    return <AgentSignInTerminalView
        testID="sign-in"
        layout={layout}
        agentTitle="Codex"
        mark={null}
        machineName="devbox"
        session={{ phase: 'waiting', terminalKey: null, authUrl: null, startedAtMs, failure: null }}
        accountLabel={null}
        terminal={null}
        handlers={{ onOpenUrl: () => {}, onCheckAgain: () => {}, onClose: () => {} }}
    />;
}

describe('Machine wait clocks', () => {
    it.each([
        ['add a machine', (start: number) => <MachineWatchLine testID="arrival" subject="devbox" homeName="Home" startedAtMs={start} />],
        ['Agent sign-in pane', (start: number) => signIn(start, 'pane')],
        ['Agent sign-in sheet', (start: number) => signIn(start, 'sheet')],
    ] as const)('%s stops ticking when hidden and catches up on return', async (_label, renderWait) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
        const timers = installTimerCensus();
        const content = renderWait(Date.now());
        const panel = (active: boolean) => <RetainedPanelSurface isActive={active}>{content}</RetainedPanelSurface>;
        const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(panel(true));
            await advance(1000);
            expect(screen.getTextContent()).toContain('0:01');
            expect(timers.readFires().interval).toBe(1);

            await screen.update(panel(false));
            await advance(60_000);
            expect(timers.readFires().interval).toBe(1);
            await screen.update(panel(true));
            expect(screen.getTextContent()).toContain('1:01');

            await act(async () => { reactNativeWebAppState.emit('background'); });
            await advance(60_000);
            expect(timers.readFires().interval).toBe(1);
            await act(async () => { reactNativeWebAppState.emit('active'); });
            expect(screen.getTextContent()).toContain('2:01');
            await advance(1000);
            expect(screen.getTextContent()).toContain('2:02');
            expect(timers.readFires().interval).toBe(2);
        } finally {
            await screen?.unmount();
            reactNativeWebAppState.emit('active');
            timers.stop();
            vi.useRealTimers();
        }
    });
});
