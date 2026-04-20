import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';

const navigateToSessionSpy = vi.hoisted(() => vi.fn());
const useSessionCanvasEligibilitySpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('./useSessionCanvasEligibility', () => ({
    useSessionCanvasEligibility: (
        sessionId: string,
        options?: Readonly<{
            routeServerId?: string | null;
        }>,
    ) => useSessionCanvasEligibilitySpy(sessionId, options),
}));

function createScope(workspaceCacheKey: string): SessionSplitCanvasScope {
    return {
        workspaceCacheKey,
        serverId: 'server-a',
        machineId: 'machine-1',
        rootPath: '/repo',
    };
}

describe('useSessionSplitCanvasRowActions', () => {
    let unregisterRuntime: (() => void) | null = null;

    afterEach(() => {
        unregisterRuntime?.();
        unregisterRuntime = null;
        navigateToSessionSpy.mockReset();
        useSessionCanvasEligibilitySpy.mockReset();
        standardCleanup();
    });

    it('returns no split affordance when there is no compatible active session canvas', async () => {
        useSessionCanvasEligibilitySpy.mockReturnValue({
            isCanvasEligible: true,
            reason: 'eligible',
            scope: createScope('server-a:machine-1:/repo'),
        });

        const { useSessionSplitCanvasRowActions } = await import('./useSessionSplitCanvasRowActions');
        const hook = await renderHook(() => useSessionSplitCanvasRowActions({
            sessionId: 'sess_2',
            serverId: 'server-a',
        }));

        expect(hook.getCurrent().mode).toBe('none');

        await hook.unmount();
    });

    it('opens a compatible session in a split without churning the singular route', async () => {
        const scope = createScope('server-a:machine-1:/repo');
        useSessionCanvasEligibilitySpy.mockReturnValue({
            isCanvasEligible: true,
            reason: 'eligible',
            scope,
        });

        const openSessionInSplitSpy = vi.fn();
        const focusSessionSpy = vi.fn();
        const { registerSessionSplitCanvasRuntime } = await import('./sessionSplitCanvasRuntime');
        unregisterRuntime = registerSessionSplitCanvasRuntime({
            snapshot: {
                routeSessionId: 'sess_1',
                focusedSessionId: 'sess_1',
                openSessionIds: ['sess_1'],
                scope,
            },
            controller: {
                openSessionInSplit: openSessionInSplitSpy,
                focusSession: focusSessionSpy,
            },
        });

        const { useSessionSplitCanvasRowActions } = await import('./useSessionSplitCanvasRowActions');
        const hook = await renderHook(() => useSessionSplitCanvasRowActions({
            sessionId: 'sess_2',
            serverId: 'server-a',
        }));

        expect(hook.getCurrent().mode).toBe('open');

        await act(async () => {
            hook.getCurrent().openInSplitRight();
        });

        expect(openSessionInSplitSpy).toHaveBeenCalledWith({
            sessionId: 'sess_2',
            direction: 'right',
        });
        expect(focusSessionSpy).not.toHaveBeenCalled();
        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('reveals an already-open compatible session inside the active split canvas without navigating', async () => {
        const scope = createScope('server-a:machine-1:/repo');
        useSessionCanvasEligibilitySpy.mockReturnValue({
            isCanvasEligible: true,
            reason: 'eligible',
            scope,
        });

        const openSessionInSplitSpy = vi.fn();
        const focusSessionSpy = vi.fn();
        const { registerSessionSplitCanvasRuntime } = await import('./sessionSplitCanvasRuntime');
        unregisterRuntime = registerSessionSplitCanvasRuntime({
            snapshot: {
                routeSessionId: 'sess_1',
                focusedSessionId: 'sess_1',
                openSessionIds: ['sess_1', 'sess_2'],
                scope,
            },
            controller: {
                openSessionInSplit: openSessionInSplitSpy,
                focusSession: focusSessionSpy,
            },
        });

        const { useSessionSplitCanvasRowActions } = await import('./useSessionSplitCanvasRowActions');
        const hook = await renderHook(() => useSessionSplitCanvasRowActions({
            sessionId: 'sess_2',
            serverId: 'server-a',
        }));

        expect(hook.getCurrent().mode).toBe('reveal');

        await act(async () => {
            hook.getCurrent().revealInSplit();
        });

        expect(focusSessionSpy).toHaveBeenCalledWith('sess_2');
        expect(openSessionInSplitSpy).not.toHaveBeenCalled();
        expect(navigateToSessionSpy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('does not rerender a row action hook for focus-only runtime changes that keep the same row mode', async () => {
        const scope = createScope('server-a:machine-1:/repo');
        useSessionCanvasEligibilitySpy.mockReturnValue({
            isCanvasEligible: true,
            reason: 'eligible',
            scope,
        });

        const openSessionInSplitSpy = vi.fn();
        const focusSessionSpy = vi.fn();
        const { registerSessionSplitCanvasRuntime } = await import('./sessionSplitCanvasRuntime');
        unregisterRuntime = registerSessionSplitCanvasRuntime({
            snapshot: {
                routeSessionId: 'sess_1',
                focusedSessionId: 'sess_1',
                openSessionIds: ['sess_1'],
                scope,
            },
            controller: {
                openSessionInSplit: openSessionInSplitSpy,
                focusSession: focusSessionSpy,
            },
        });

        const { useSessionSplitCanvasRowActions } = await import('./useSessionSplitCanvasRowActions');
        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useSessionSplitCanvasRowActions({
                sessionId: 'sess_2',
                serverId: 'server-a',
            });
        });

        expect(hook.getCurrent().mode).toBe('open');
        expect(renderCount).toBe(1);

        await act(async () => {
            unregisterRuntime?.();
            unregisterRuntime = registerSessionSplitCanvasRuntime({
                snapshot: {
                    routeSessionId: 'sess_1',
                    focusedSessionId: 'sess_2',
                    openSessionIds: ['sess_1'],
                    scope,
                },
                controller: {
                    openSessionInSplit: openSessionInSplitSpy,
                    focusSession: focusSessionSpy,
                },
            });
        });

        expect(hook.getCurrent().mode).toBe('open');
        expect(renderCount).toBe(1);

        await hook.unmount();
    });
});
