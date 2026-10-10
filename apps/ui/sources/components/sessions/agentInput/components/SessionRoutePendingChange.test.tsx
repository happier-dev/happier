import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionRoutePendingChange } from './SessionRoutePendingChange';

describe('SessionRoutePendingChange', () => {
    it('names what applies now and next, restarts through the given action and keeps the change pending otherwise', async () => {
        const onRestart = vi.fn();
        const onKeepCurrent = vi.fn();
        const screen = await renderScreen(<SessionRoutePendingChange
            now="ChatGPT · Codex pool · gpt-6.1-sol" next="Main gateway · fable-5.1" nowSource="ChatGPT · Codex pool"
            agentName="Codex" onRestart={onRestart} onKeepCurrent={onKeepCurrent} />);

        expect(screen.findByTestId('session-route-pending-change.now')?.props.children).toBe('ChatGPT · Codex pool · gpt-6.1-sol');
        expect(screen.findByTestId('session-route-pending-change.next')?.props.children).toBe('Main gateway · fable-5.1');
        await screen.pressByTestIdAsync('session-route-pending-change.keep-current');
        expect(onKeepCurrent).toHaveBeenCalledTimes(1);
        expect(onRestart).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-route-pending-change.restart');
        expect(onRestart).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('offers no restart where the session has none to run', async () => {
        const screen = await renderScreen(<SessionRoutePendingChange now="a" next="b" nowSource="a" agentName="Codex" onKeepCurrent={() => {}} />);
        expect(screen.findByTestId('session-route-pending-change.restart')).toBeNull();
        await screen.unmount();
    });
});
