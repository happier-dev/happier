import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook } from '@/dev/testkit';

const runAutomationNowMock = vi.hoisted(() => vi.fn());

type AccountLifetimeState = {
    value: { scope: { serverId: string; accountId: string }; isCurrent: () => boolean } | null;
};

const activeAccountLifetime = vi.hoisted((): AccountLifetimeState => ({ value: null }));
const modalAlertSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/sync/sync', () => ({
    sync: { runAutomationNow: runAutomationNowMock },
}));
vi.mock('@/modal', () => ({ Modal: { alert: modalAlertSpy } }));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.value,
}));

function accountLifetime(scope: { serverId: string; accountId: string }): AccountLifetimeState['value'] {
    return Object.freeze({
        scope,
        isCurrent: () => activeAccountLifetime.value?.scope === scope
            || (activeAccountLifetime.value !== null
                && activeAccountLifetime.value.scope.serverId === scope.serverId
                && activeAccountLifetime.value.scope.accountId === scope.accountId),
    });
}

describe('useAutomationRunNowController', () => {
    afterEach(() => {
        vi.useRealTimers();
        runAutomationNowMock.mockReset();
        modalAlertSpy.mockClear();
        activeAccountLifetime.value = null;
    });

    it('uses command-state vocabulary and never presents its acknowledgement as a canonical Run state', async () => {
        vi.useFakeTimers();
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-a', accountId: 'account-a' });
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

    it('partitions transient state by the Account/server scope for one Automation id', async () => {
        const scopeA = { serverId: 'server-a', accountId: 'account-a' };
        const scopeB = { serverId: 'server-b', accountId: 'account-b' };
        activeAccountLifetime.value = accountLifetime(scopeA);
        const heldA = createDeferred<unknown>();
        runAutomationNowMock.mockReturnValueOnce(heldA.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocationA!: Promise<void>;
        await act(async () => {
            invocationA = hook.getCurrent().runNow('automation-1');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        // The same opaque Automation id under another Account/server must not
        // inherit A's submission presentation nor be suppressed by it.
        activeAccountLifetime.value = accountLifetime(scopeB);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');

        const heldB = createDeferred<unknown>();
        runAutomationNowMock.mockReturnValueOnce(heldB.promise);
        let invocationB!: Promise<void>;
        await act(async () => {
            invocationB = hook.getCurrent().runNow('automation-1');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');
        expect(runAutomationNowMock).toHaveBeenCalledTimes(2);

        // A's late success is retired by the authority change, so swapping back
        // to A must not resurface an acknowledged presentation; B's own run is
        // still submitting under B's key.
        await act(async () => {
            heldA.resolve({ id: 'run-a', state: 'running' });
            await invocationA;
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        activeAccountLifetime.value = accountLifetime(scopeA);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
        await act(async () => {
            heldB.resolve({ id: 'run-b', state: 'queued' });
            await invocationB;
        });
    });

    it('does not invoke or publish unscoped state without an active Account', async () => {
        activeAccountLifetime.value = null;
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        await act(async () => {
            await hook.getCurrent().runNow('automation-1');
        });

        expect(runAutomationNowMock).not.toHaveBeenCalled();
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
    });

    it('publishes idle without an error surface when the Account authority retires mid-request', async () => {
        const scope = { serverId: 'server-a', accountId: 'account-a' };
        activeAccountLifetime.value = accountLifetime(scope);
        const request = createDeferred<unknown>();
        runAutomationNowMock.mockReturnValueOnce(request.promise);
        const { useAutomationRunNowController } = await import('./useAutomationRunNowController');
        const hook = await renderHook(() => useAutomationRunNowController());

        let invocation!: Promise<void>;
        await act(async () => {
            invocation = hook.getCurrent().runNow('automation-1');
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('submitting');

        request.reject(new Error('request lost'));
        activeAccountLifetime.value = accountLifetime({ serverId: 'server-b', accountId: 'account-b' });
        await act(async () => {
            await invocation;
        });
        // Back on the original Account, the retired request left no lingering
        // submission state and surfaced no error alert.
        activeAccountLifetime.value = accountLifetime(scope);
        await act(async () => {
            hook.rerender();
        });
        expect(hook.getCurrent().stateFor('automation-1')).toBe('idle');
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });
});
