import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';

const runAutomationNowMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/sync', () => ({
    sync: { runAutomationNow: runAutomationNowMock },
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => null,
}));

describe('useAutomationRunNowController', () => {
    afterEach(() => {
        vi.useRealTimers();
        runAutomationNowMock.mockReset();
    });

    it('uses command-state vocabulary and never presents its acknowledgement as a canonical Run state', async () => {
        vi.useFakeTimers();
        const request = createDeferred<unknown>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocation!: Promise<void>;
        await act(async () => {
            invocation = hook.getCurrent().runNow('automation-1');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        await act(async () => {
            request.resolve({ id: 'run-1', state: 'running' });
            await invocation;
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('acknowledged');

        await act(async () => {
            vi.advanceTimersByTime(2_500);
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
    });
});
