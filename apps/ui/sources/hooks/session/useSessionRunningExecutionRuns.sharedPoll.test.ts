import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, registerStandardCleanupTarget, standardCleanup } from '@/dev/testkit';

const sessionExecutionRunListSpy = vi.fn();

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: (...args: unknown[]) => sessionExecutionRunListSpy(...args),
}));

import { useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A real session mounts this hook from several places at once (session shell, session header,
 * Agents pane, subagent details, message details). Each of those is an independent surface, so the
 * only thing that can hold the request rate down is the hook itself.
 */
const observedRuns = new Map<string, readonly unknown[]>();

function Subscriber(props: Readonly<{ surfaceId: string; sessionId: string; enabled: boolean }>) {
    observedRuns.set(props.surfaceId, useSessionRunningExecutionRuns({
        sessionId: props.sessionId,
        enabled: props.enabled,
    }));
    return null;
}

function buildSubscriberTree(surfaceIds: readonly string[], sessionId: string): React.ReactElement {
    return React.createElement(
        React.Fragment,
        null,
        ...surfaceIds.map((surfaceId) => React.createElement(Subscriber, {
            key: surfaceId,
            surfaceId,
            sessionId,
            enabled: true,
        })),
    );
}

async function mountSubscribers(surfaceIds: readonly string[], sessionId = 's1') {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
        tree = renderer.create(buildSubscriberTree(surfaceIds, sessionId));
    });
    registerStandardCleanupTarget(tree);
    await flushHookEffects({ cycles: 1, turns: 2 });

    return {
        tree,
        setSurfaces: async (nextSurfaceIds: readonly string[]) => {
            await act(async () => {
                tree.update(buildSubscriberTree(nextSurfaceIds, sessionId));
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
        },
        unmount: async () => {
            await act(async () => {
                tree.unmount();
            });
            await flushHookEffects({ cycles: 1, turns: 2 });
        },
    };
}

describe('useSessionRunningExecutionRuns shared session poll', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sessionExecutionRunListSpy.mockReset();
        sessionExecutionRunListSpy.mockResolvedValue({ runs: [{ runId: 'run_1', status: 'running' }] });
        observedRuns.clear();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('issues one list request per interval no matter how many surfaces subscribe', async () => {
        const mounted = await mountSubscribers(['shell', 'agentsPane', 'messageDetails']);

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 5_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 5_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(3);

        // Every surface observes the same rows, from the same fetch.
        expect(observedRuns.get('shell')).toBe(observedRuns.get('agentsPane'));
        expect(observedRuns.get('shell')).toBe(observedRuns.get('messageDetails'));
        expect((observedRuns.get('shell') as any[]).map((run) => run.runId)).toEqual(['run_1']);

        await mounted.unmount();
    });

    it('does not fetch again when a later surface joins an in-flight cadence', async () => {
        const mounted = await mountSubscribers(['shell']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        await mounted.setSurfaces(['shell', 'agentsPane', 'messageDetails']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect((observedRuns.get('agentsPane') as any[]).map((run) => run.runId)).toEqual(['run_1']);

        await mounted.unmount();
    });

    it('keeps polling for the remaining surfaces when one unmounts', async () => {
        const mounted = await mountSubscribers(['shell', 'agentsPane', 'messageDetails']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        await mounted.setSurfaces(['shell', 'agentsPane']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 5_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect((observedRuns.get('shell') as any[]).map((run) => run.runId)).toEqual(['run_1']);

        await mounted.unmount();
    });

    it('tears the poll down when the last surface unmounts', async () => {
        const mounted = await mountSubscribers(['shell', 'agentsPane']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        await mounted.unmount();

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 60_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
    });

    it('does not share runs between sessions', async () => {
        sessionExecutionRunListSpy.mockReset();
        sessionExecutionRunListSpy.mockImplementation(async (sessionId: string) => ({
            runs: [{ runId: `run_for_${sessionId}`, status: 'running' }],
        }));

        const first = await mountSubscribers(['shellA'], 's1');
        const second = await mountSubscribers(['shellB'], 's2');

        expect((observedRuns.get('shellA') as any[]).map((run) => run.runId)).toEqual(['run_for_s1']);
        expect((observedRuns.get('shellB') as any[]).map((run) => run.runId)).toEqual(['run_for_s2']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 5_000 });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(4);

        await first.unmount();
        await second.unmount();
    });

    it('keeps the object identity of a run a poll did not change', async () => {
        sessionExecutionRunListSpy.mockReset();
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({
                runs: [
                    { runId: 'run_1', status: 'running', turnInFlight: false },
                    { runId: 'run_2', status: 'running', turnInFlight: false },
                ],
            })
            .mockResolvedValue({
                runs: [
                    { runId: 'run_1', status: 'running', turnInFlight: false },
                    { runId: 'run_2', status: 'running', turnInFlight: true },
                ],
            });

        const mounted = await mountSubscribers(['shell']);
        const before = observedRuns.get('shell') as readonly any[];
        expect(before.map((run) => run.runId)).toEqual(['run_1', 'run_2']);

        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 5_000 });

        const after = observedRuns.get('shell') as readonly any[];
        expect(after).not.toBe(before);
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
        expect(after[1].turnInFlight).toBe(true);

        await mounted.unmount();
    });

    it('refreshes once for every surface when execution-run activity is observed', async () => {
        const mounted = await mountSubscribers(['shell', 'agentsPane', 'messageDetails']);
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);

        notifyExecutionRunActivity('s1');
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);

        await mounted.unmount();
    });
});
