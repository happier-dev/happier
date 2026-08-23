import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit';

const forkSessionMock = vi.hoisted(() => vi.fn());
const completeSessionForkNavigationMock = vi.hoisted(() => vi.fn());
const refreshSessionsMock = vi.hoisted(() => vi.fn());
const sessionsRef = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/sync/ops', () => ({ forkSession: forkSessionMock }));
vi.mock('@/components/sessions/transcript/forkContext/completeSessionForkNavigation', () => ({
    completeSessionForkNavigation: completeSessionForkNavigationMock,
}));
vi.mock('@/sync/sync', () => ({ sync: {
    refreshSessions: refreshSessionsMock,
    acquireUserRequestLease: () => () => {},
} }));
vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => ({ sessions: sessionsRef.current }) },
}));

import { useSessionForkStrategyFlow } from './useSessionForkStrategyFlow';

const REQUEST = {
    parentSessionId: 'parent_1',
    serverId: 'server_1',
    machineId: 'machine_1',
    forkPoint: { type: 'seq', upToSeqInclusive: 12 },
    restoredDraftText: 'draft text',
    sourceMessageId: 'msg_1',
    writeForkInitialPrompt: true,
} as const;

async function mountFlow(overrides?: Partial<Parameters<typeof useSessionForkStrategyFlow>[0]>) {
    const navigate = vi.fn();
    const onNavigated = vi.fn();
    const harness = await renderHook(() => useSessionForkStrategyFlow({
        request: REQUEST as any,
        navigate,
        onNavigated,
        ...overrides,
    }));
    return { harness, navigate, onNavigated };
}

beforeEach(() => {
    forkSessionMock.mockReset();
    completeSessionForkNavigationMock.mockReset();
    completeSessionForkNavigationMock.mockResolvedValue(undefined);
    refreshSessionsMock.mockReset();
    refreshSessionsMock.mockResolvedValue(undefined);
    sessionsRef.current = {};
});

afterEach(async () => {
    await standardCleanup();
});

describe('useSessionForkStrategyFlow', () => {
    it('starts in the choosing phase with no effect issued', async () => {
        const { harness } = await mountFlow();
        expect(harness.getCurrent().phase).toEqual({ type: 'choosing' });
        expect(harness.getCurrent().failure).toBeNull();
        expect(forkSessionMock).not.toHaveBeenCalled();
    });

    it('sends the explicit native intent and never a replay fallback', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });

        expect(forkSessionMock).toHaveBeenCalledTimes(1);
        expect(forkSessionMock.mock.calls[0]?.[0]).toMatchObject({
            parentSessionId: 'parent_1',
            forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            strategy: 'native',
        });
    });

    it('carries the restored draft through navigation and finishes after navigating once', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        const { harness, onNavigated } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });

        expect(completeSessionForkNavigationMock).toHaveBeenCalledTimes(1);
        expect(completeSessionForkNavigationMock.mock.calls[0]?.[0]).toMatchObject({
            childSessionId: 'child_1',
            parentSessionId: 'parent_1',
            serverId: 'server_1',
            restoredDraftText: 'draft text',
            sourceMessageId: 'msg_1',
            writeForkInitialPrompt: true,
        });
        expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
        expect(onNavigated).toHaveBeenCalledTimes(1);
    });

    it('reuses one requestId across retries of the same route so a transport retry cannot double-fork', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'nope' });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });
        await act(async () => { await harness.getCurrent().submit('native'); });

        const first = forkSessionMock.mock.calls[0]?.[0]?.requestId;
        const second = forkSessionMock.mock.calls[1]?.[0]?.requestId;
        expect(typeof first).toBe('string');
        expect(second).toBe(first);
    });

    it('gives each route its own requestId so choosing the other route is a distinct fork', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'nope' });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });
        await act(async () => { await harness.getCurrent().submit('replay'); });
        expect(forkSessionMock.mock.calls[1]?.[0]?.requestId)
            .not.toBe(forkSessionMock.mock.calls[0]?.[0]?.requestId);
    });

    it('returns to choosing with an inline reason after a definite failure', async () => {
        forkSessionMock.mockResolvedValue({ ok: false, errorCode: 'SPAWN_FAILED', errorMessage: 'boom' });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });

        expect(harness.getCurrent().phase).toEqual({ type: 'choosing' });
        expect(harness.getCurrent().failure).toEqual({
            route: 'native', kind: 'error', message: 'boom',
        });
        expect(completeSessionForkNavigationMock).not.toHaveBeenCalled();
    });

    it('reports an unavailable daemon method as an update requirement', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'DAEMON_RPC_UNAVAILABLE', errorMessage: 'no rpc',
        });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });
        expect(harness.getCurrent().failure).toMatchObject({ kind: 'update_required' });
    });

    it('enters outcome-unknown on an ambiguous result and never resubmits the fork', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });

        expect(harness.getCurrent().phase).toEqual({
            type: 'unknown', route: 'replay', checking: false, lastCheck: null,
        });

        await act(async () => { await harness.getCurrent().submit('replay'); });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
    });

    it('reconciles outcome-unknown by finding the real child and navigating to it exactly once', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { harness, onNavigated } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });
        const requestId = forkSessionMock.mock.calls[0]?.[0]?.requestId;
        expect(typeof requestId).toBe('string');

        refreshSessionsMock.mockImplementation(async () => {
            sessionsRef.current = {
                child_late: {
                    id: 'child_late',
                    metadata: {
                        forkV1: {
                            v: 1,
                            parentSessionId: 'parent_1',
                            parentCutoffSeqInclusive: 11,
                            createdAtMs: 5,
                            strategy: 'replay',
                            requestId,
                        },
                    },
                },
            };
        });

        await act(async () => { await harness.getCurrent().checkForFork(); });

        expect(refreshSessionsMock).toHaveBeenCalledWith({ awaitSessionListHydration: true });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
        expect(completeSessionForkNavigationMock).toHaveBeenCalledWith(
            expect.objectContaining({ childSessionId: 'child_late', serverId: 'server_1' }),
        );
        expect(onNavigated).toHaveBeenCalledTimes(1);
    });

    it('reports that no fork was found without creating a duplicate', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });
        await act(async () => { await harness.getCurrent().checkForFork(); });

        expect(harness.getCurrent().phase).toMatchObject({ type: 'unknown', lastCheck: 'none' });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
        expect(completeSessionForkNavigationMock).not.toHaveBeenCalled();
    });

    it('refuses to guess when several new children match', async () => {
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });
        const requestId = forkSessionMock.mock.calls[0]?.[0]?.requestId;
        expect(typeof requestId).toBe('string');

        const lineage = {
            v: 1,
            parentSessionId: 'parent_1',
            parentCutoffSeqInclusive: 12,
            createdAtMs: 5,
            strategy: 'replay',
            requestId,
        };
        refreshSessionsMock.mockImplementation(async () => {
            sessionsRef.current = {
                child_a: { id: 'child_a', metadata: { forkV1: lineage } },
                child_b: { id: 'child_b', metadata: { forkV1: lineage } },
            };
        });

        await act(async () => { await harness.getCurrent().checkForFork(); });

        expect(harness.getCurrent().phase).toMatchObject({ type: 'unknown', lastCheck: 'ambiguous' });
        expect(completeSessionForkNavigationMock).not.toHaveBeenCalled();
    });

    it('does not adopt a child that already existed when the request was submitted', async () => {
        sessionsRef.current = {
            child_old: {
                id: 'child_old',
                metadata: {
                    forkV1: {
                        v: 1,
                        parentSessionId: 'parent_1',
                        parentCutoffSeqInclusive: 12,
                        createdAtMs: 1,
                        strategy: 'replay',
                    },
                },
            },
        };
        forkSessionMock.mockResolvedValue({
            ok: false, errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'timed out',
        });
        const { harness } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });
        await act(async () => { await harness.getCurrent().checkForFork(); });

        expect(harness.getCurrent().phase).toMatchObject({ lastCheck: 'none' });
        expect(completeSessionForkNavigationMock).not.toHaveBeenCalled();
    });

    it('keeps the created child recoverable when hydration has not caught up yet', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        completeSessionForkNavigationMock.mockRejectedValueOnce(new Error('not visible locally'));
        const { harness, onNavigated } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('native'); });

        expect(harness.getCurrent().phase).toEqual({
            type: 'opening', route: 'native', childSessionId: 'child_1', stalled: true,
        });
        expect(onNavigated).not.toHaveBeenCalled();

        completeSessionForkNavigationMock.mockResolvedValueOnce(undefined);
        await act(async () => { await harness.getCurrent().retryOpen(); });
        expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
        expect(onNavigated).toHaveBeenCalledTimes(1);
    });

    it('treats a follow-up failure after navigation as success rather than a stalled fork', async () => {
        forkSessionMock.mockResolvedValue({ ok: true, childSessionId: 'child_1' });
        completeSessionForkNavigationMock.mockImplementationOnce(async (args: any) => {
            await args.navigate('child_1');
            throw new Error('metadata failed');
        });
        const { harness, onNavigated } = await mountFlow();
        await act(async () => { await harness.getCurrent().submit('replay'); });

        expect(harness.getCurrent().phase).toEqual({ type: 'navigated' });
        expect(onNavigated).toHaveBeenCalledTimes(1);
    });

    it('ignores a duplicate submit while a request is in flight', async () => {
        let release: (() => void) | null = null;
        forkSessionMock.mockImplementation(() => new Promise((resolve) => {
            release = () => resolve({ ok: true, childSessionId: 'child_1' });
        }));
        const { harness } = await mountFlow();
        let first: Promise<void> | null = null;
        await act(async () => {
            first = harness.getCurrent().submit('replay');
            await Promise.resolve();
        });
        await act(async () => { await harness.getCurrent().submit('replay'); });
        expect(forkSessionMock).toHaveBeenCalledTimes(1);
        await act(async () => { release?.(); await first; });
    });
});
