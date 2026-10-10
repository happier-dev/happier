import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { Text } from '@/components/ui/text/Text';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { useAgentActivityClockNow, useWorkRelativeTime } from './agentActivityClock';

installSessionSubagentCommonModuleMocks();
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared Work clock', () => {
    it('shares one interval between elapsed and relative leaves without repainting their parent', async () => {
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.useFakeTimers({ now });
        const interval = vi.spyOn(globalThis, 'setInterval');
        const clear = vi.spyOn(globalThis, 'clearInterval');
        const paints = vi.fn();
        function Relative() { return <Text>{useWorkRelativeTime(now)}</Text>; }
        function Elapsed() { return <Text>{Math.floor((useAgentActivityClockNow() - now) / 1000)}</Text>; }
        function Row() { paints(); return <><Relative /><Elapsed /></>; }
        const screen = await renderScreen(<Row />);
        expect(interval).toHaveBeenCalledTimes(1);
        const before = paints.mock.calls.length;
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(screen.getTextContent()).toContain('1m');
        expect(paints.mock.calls.length).toBe(before);
        await act(async () => screen.tree.unmount());
        expect(clear).toHaveBeenCalledTimes(1);
    });
});
