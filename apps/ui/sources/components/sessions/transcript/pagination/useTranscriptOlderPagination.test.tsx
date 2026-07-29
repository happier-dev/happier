import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup, type Deferred } from '@/dev/testkit';

import {
    useTranscriptOlderPagination,
    type TranscriptOlderPaginationLoadResult,
    type UseTranscriptOlderPaginationInput,
} from './useTranscriptOlderPagination';

type HarnessOverrides = Partial<Omit<UseTranscriptOlderPaginationInput, 'loadOlder'>>;
type PaginationResult = ReturnType<typeof useTranscriptOlderPagination>;

const neverSettles = new Promise<never>(() => {});

function CommitTimingChild(props: Readonly<{ onLayout: () => void }>) {
    React.useLayoutEffect(props.onLayout, [props.onLayout]);
    return null;
}

function CommitTimingHarness(props: Readonly<{
    input: UseTranscriptOlderPaginationInput;
    resultRef: { current: PaginationResult | null };
    sessionId: string;
    invokeScrollInChildLayout?: boolean;
    shouldSuspend?: boolean;
}>) {
    const result = useTranscriptOlderPagination(props.input);

    React.useLayoutEffect(() => {
        props.resultRef.current = result;
    });

    if (props.shouldSuspend === true) throw neverSettles;
    return props.invokeScrollInChildLayout === true
        ? (
            <CommitTimingChild
                onLayout={() => result.onScrollObservation({
                    offsetY: 120,
                    scrollable: true,
                    trigger: 'scroll',
                })}
            />
        )
        : null;
}

function renderCommitTimingHarness(props: React.ComponentProps<typeof CommitTimingHarness>): React.ReactElement {
    return (
        <React.Suspense fallback={null}>
            <CommitTimingHarness key={props.sessionId} {...props} />
        </React.Suspense>
    );
}

function createHarness(overrides?: HarnessOverrides) {
    const pendingLoads: Deferred<TranscriptOlderPaginationLoadResult | null>[] = [];
    const loadOlder = vi.fn(() => {
        const deferred = createDeferred<TranscriptOlderPaginationLoadResult | null>();
        pendingLoads.push(deferred);
        return deferred.promise;
    });
    const input: UseTranscriptOlderPaginationInput = {
        enabled: true,
        loadOlder,
        thresholdPx: 400,
        cooldownMs: 500,
        spinnerDelayMs: 200,
        isFillDone: () => true,
        isTransactionOpen: () => false,
        ...overrides,
    };
    return { input, loadOlder, pendingLoads };
}

async function observe(
    hook: { getCurrent: () => ReturnType<typeof useTranscriptOlderPagination> },
    metrics: {
        offsetY: number;
        scrollable?: boolean;
        trigger?: 'scroll' | 'edge-reached' | 'layout-committed';
    },
) {
    await act(async () => {
        hook.getCurrent().onScrollObservation({
            offsetY: metrics.offsetY,
            scrollable: metrics.scrollable ?? true,
            trigger: metrics.trigger,
        });
    });
}

async function resolveLoad(
    pendingLoads: Deferred<TranscriptOlderPaginationLoadResult | null>[],
    result: TranscriptOlderPaginationLoadResult | null,
) {
    const deferred = pendingLoads.shift();
    if (!deferred) throw new Error('No pending loadOlder call to resolve');
    await act(async () => {
        deferred.resolve(result);
        await Promise.resolve();
    });
}

describe('useTranscriptOlderPagination', () => {
    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('starts exactly one load on threshold ENTER and keeps a single load in flight', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(loadOlder).toHaveBeenCalledWith({ trigger: 'threshold-enter' });

        await observe(hook, { offsetY: 90 });
        await observe(hook, { offsetY: 60 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().hasMore).toBe(true);
    });

    it('exposes the current reducer snapshot immediately after threshold dispatch starts loading', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });

        expect(hook.getCurrent().getSnapshot()).toEqual({
            hasMore: true,
            insideThreshold: true,
            phase: 'loading',
            suspendedReasons: [],
        });

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
    });

    it('exposes active suspension reasons in the reducer snapshot', async () => {
        vi.useFakeTimers();
        let transactionOpen = true;
        const { input } = createHarness({ isTransactionOpen: () => transactionOpen });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });

        expect(hook.getCurrent().getSnapshot()).toEqual({
            hasMore: true,
            insideThreshold: true,
            phase: 'armed',
            suspendedReasons: ['transaction-open'],
        });

        transactionOpen = false;
        await observe(hook, { offsetY: 110 });
        expect(hook.getCurrent().getSnapshot()).toMatchObject({
            phase: 'loading',
            suspendedReasons: [],
        });
    });

    it('delays the loading indicator by spinnerDelayMs and clears it when the loaded page commits', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness({ spinnerDelayMs: 200 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(199);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);
        await observe(hook, { offsetY: 800, trigger: 'layout-committed' });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('never shows the loading indicator when the load settles before spinnerDelayMs', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness({ spinnerDelayMs: 200 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('requires threshold EXIT then ENTER (plus cooldown) before the next load', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        // Still inside the threshold: neither time nor repeat observations may retrigger.
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        await observe(hook, { offsetY: 100 });
        await observe(hook, { offsetY: 80 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('honors the cooldown for an EXIT/ENTER that lands during it, loading at cooldown end', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });

        // Prepend growth pushed the viewport out; the user scrolls back in during cooldown.
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(loadOlder).toHaveBeenLastCalledWith({ trigger: 'post-cooldown' });
    });

    it('suspends loads while a viewport transaction is open and loads once it closes', async () => {
        vi.useFakeTimers();
        let transactionOpen = true;
        const { input, loadOlder } = createHarness({ isTransactionOpen: () => transactionOpen });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();

        transactionOpen = false;
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('suspends loads until the initial fill is done', async () => {
        vi.useFakeTimers();
        let fillDone = false;
        const { input, loadOlder } = createHarness({ isFillDone: () => fillDone });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();

        fillDone = true;
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('drains the armed machine when readiness re-opens, with zero further scroll observations', async () => {
        vi.useFakeTimers();
        let fillDone = false;
        const { input, loadOlder } = createHarness({ isFillDone: () => fillDone });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        // The reader scrolls to the top and STOPS. The machine arms; readiness suspends the load.
        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();
        expect(hook.getCurrent().getSnapshot().phase).toBe('armed');

        // Readiness re-opens. The reader does not move: no scroll, edge or layout observation
        // follows, and no cooldown is pending. The pager must still drain its own decision.
        fillDone = true;
        await hook.rerender();

        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(loadOlder).toHaveBeenLastCalledWith({ trigger: 'readiness-open' });
    });

    it('never double-fires from the readiness drain (in flight, and parked after the page settles)', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        // Commits while the page is in flight must not start a second load.
        await hook.rerender();
        await hook.rerender();
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });

        // Parked inside the threshold with no EXIT -> ENTER: no follow-up load is owed, and
        // commits must not manufacture one (anti-burst).
        await hook.rerender();
        await hook.rerender();
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('continues a successful exact-top load when its committed layout remains at the edge', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 0, trigger: 'edge-reached' });
        expect(loadOlder).toHaveBeenCalledTimes(1);
        await observe(hook, { offsetY: 0, trigger: 'layout-committed' });

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await act(async () => {
            vi.advanceTimersByTime(500);
        });

        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(loadOlder).toHaveBeenLastCalledWith({ trigger: 'post-cooldown' });
    });

    it('suspends loads while the observed offset is <= 0 (negative-offset settling)', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 0 });
        await observe(hook, { offsetY: -30 });
        expect(loadOlder).not.toHaveBeenCalled();

        await observe(hook, { offsetY: 40 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('treats hasMore=false as terminal and exposes it until reset()', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, { status: 'no_more', loaded: 0, hasMore: false });
        expect(hook.getCurrent().hasMore).toBe(false);

        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 100 });
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().reset();
        });
        expect(hook.getCurrent().hasMore).toBe(true);

        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('enters cooldown after a null result without a tight retry loop', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await resolveLoad(pendingLoads, null);
        expect(hook.getCurrent().hasMore).toBe(true);

        await observe(hook, { offsetY: 100 });
        await observe(hook, { offsetY: 90 });
        expect(loadOlder).toHaveBeenCalledTimes(1);

        // Recovery still requires EXIT -> ENTER after the cooldown.
        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 100 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
    });

    it('enters cooldown when loadOlder rejects', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        const deferred = pendingLoads.shift();
        if (!deferred) throw new Error('No pending loadOlder call to reject');
        await act(async () => {
            deferred.reject(new Error('network down'));
            await Promise.resolve();
        });

        expect(hook.getCurrent().hasMore).toBe(true);
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
        await observe(hook, { offsetY: 100 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('ignores observations and never loads while disabled', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness({ enabled: false });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 120 });
        expect(loadOlder).not.toHaveBeenCalled();
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('treats non-scrollable observations as outside the threshold (no optimistic arming)', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness();
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120, scrollable: false });
        expect(loadOlder).not.toHaveBeenCalled();

        // The first scrollable observation inside the threshold is an ENTER.
        await observe(hook, { offsetY: 120 });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('reset() invalidates the pending operation before a fresh load starts', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ spinnerDelayMs: 0 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await act(async () => {
            hook.getCurrent().reset();
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);

        // Fresh dataset state can load while the old operation is still pending.
        await observe(hook, { offsetY: 110 });
        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        // The stale dataset reports exhaustion while the fresh load is pending. It
        // must not finish or exhaust the fresh dataset's machine.
        await resolveLoad(pendingLoads, { status: 'no_more', loaded: 0, hasMore: false });
        expect(hook.getCurrent().getSnapshot().phase).toBe('loading');
        expect(hook.getCurrent().isLoadingOlder).toBe(true);
        expect(hook.getCurrent().hasMore).toBe(true);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await observe(hook, { offsetY: 800, trigger: 'layout-committed' });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
        expect(hook.getCurrent().hasMore).toBe(true);
    });

    it('invalidates an awaited load on unmount before it can schedule a cooldown', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 150 });

        await hook.unmount();
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('keeps committed A inputs through an abandoned same-session B render and publishes committed B before child layout events', async () => {
        vi.useFakeTimers();
        const harnessA = createHarness({ cooldownMs: 500 });
        const harnessB = createHarness({ cooldownMs: 50 });
        const resultRef: { current: PaginationResult | null } = { current: null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderCommitTimingHarness({
                input: harnessA.input,
                resultRef,
                sessionId: 'session-a',
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });

        await act(async () => {
            resultRef.current?.onScrollObservation({ offsetY: 120, scrollable: true, trigger: 'scroll' });
            resultRef.current?.onScrollObservation({ offsetY: 5_000, scrollable: true, trigger: 'scroll' });
            resultRef.current?.onScrollObservation({ offsetY: 100, scrollable: true, trigger: 'scroll' });
        });
        expect(harnessA.loadOlder).toHaveBeenCalledTimes(1);

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderCommitTimingHarness({
                    input: harnessB.input,
                    resultRef,
                    sessionId: 'session-a',
                    shouldSuspend: true,
                }));
            });
            await Promise.resolve();
        });

        await resolveLoad(harnessA.pendingLoads, { status: 'loaded', loaded: 20, hasMore: true });
        await act(async () => {
            vi.advanceTimersByTime(50);
        });
        expect(harnessA.loadOlder).toHaveBeenCalledTimes(1);
        expect(harnessB.loadOlder).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(450);
        });
        expect(harnessA.loadOlder).toHaveBeenCalledTimes(2);
        expect(harnessA.loadOlder).toHaveBeenLastCalledWith({ trigger: 'post-cooldown' });

        await act(async () => {
            resultRef.current?.reset();
            tree.update(renderCommitTimingHarness({
                input: harnessB.input,
                resultRef,
                sessionId: 'session-a',
                invokeScrollInChildLayout: true,
            }));
        });
        expect(harnessB.loadOlder).toHaveBeenCalledTimes(1);
        expect(harnessB.loadOlder).toHaveBeenLastCalledWith({ trigger: 'threshold-enter' });

        await act(async () => {
            tree.unmount();
        });
    });
});

describe('useTranscriptOlderPagination item-space proximity + continuous indicator', () => {
    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
    });

    it('arms and loads via itemsToOlderEdge when the estimated px offset is far outside the threshold', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness({ thresholdItems: 12 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await act(async () => {
            hook.getCurrent().onScrollObservation({ offsetY: 20_000, scrollable: true, itemsToOlderEdge: 40 });
            hook.getCurrent().onScrollObservation({ offsetY: 20_000, scrollable: true, itemsToOlderEdge: 5 });
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('does not stall on a negative estimated px offset while the item signal is valid', async () => {
        vi.useFakeTimers();
        const { input, loadOlder } = createHarness({ thresholdItems: 12 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await act(async () => {
            hook.getCurrent().onScrollObservation({ offsetY: -700, scrollable: true, itemsToOlderEdge: 30 });
            hook.getCurrent().onScrollObservation({ offsetY: -700, scrollable: true, itemsToOlderEdge: 4 });
        });
        expect(loadOlder).toHaveBeenCalledTimes(1);
    });

    it('keeps the loading indicator on across the between-pages gap when a follow-up load is coming', async () => {
        vi.useFakeTimers();
        const { input, loadOlder, pendingLoads } = createHarness({ spinnerDelayMs: 200, cooldownMs: 500 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        // The prepend pushed the threshold out and the user scrolled back in while the
        // page was landing: the indicator must span the cooldown, not flicker off.
        await observe(hook, { offsetY: 5_000 });
        await observe(hook, { offsetY: 100 });
        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 50, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(loadOlder).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await resolveLoad(pendingLoads, { status: 'no_more', loaded: 0, hasMore: false });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });

    it('settles the indicator with the committed page for a parked user (no follow-up load coming)', async () => {
        vi.useFakeTimers();
        const { input, pendingLoads } = createHarness({ spinnerDelayMs: 200 });
        const hook = await renderHook(() => useTranscriptOlderPagination(input));

        await observe(hook, { offsetY: 120 });
        await act(async () => {
            vi.advanceTimersByTime(200);
        });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);

        await resolveLoad(pendingLoads, { status: 'loaded', loaded: 50, hasMore: true });
        expect(hook.getCurrent().isLoadingOlder).toBe(true);
        await observe(hook, { offsetY: 800, trigger: 'layout-committed' });
        expect(hook.getCurrent().isLoadingOlder).toBe(false);
    });
});
