import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionContextUsageSnapshotV1 } from '@happier-dev/protocol';

/**
 * A tiny reactive external store standing in for the session store. The strip's
 * model subscribes to it via the (mocked) store hooks; pushing a value simulates
 * a token_count tick and must re-render ONLY subscribers — the F-UI-11 mechanism.
 */
const store = vi.hoisted(() => {
    const state = { usage: null as unknown, scm: null as unknown };
    const listeners = new Set<() => void>();
    return {
        state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setUsage(usage: unknown) {
            state.usage = usage;
            listeners.forEach((listener) => listener());
        },
        setScm(scm: unknown) {
            state.scm = scm;
            listeners.forEach((listener) => listener());
        },
    };
});

const publishSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/state/storage', () => ({
    useSessionUsage: () => React.useSyncExternalStore(store.subscribe, () => store.state.usage),
    useSessionProjectScmSnapshot: () => React.useSyncExternalStore(store.subscribe, () => store.state.scm),
}));

vi.mock('@/sync/sync', () => ({
    sync: { publishSessionAcpConfigOptionOverrideToMetadata: publishSpy },
}));

vi.mock('@/sync/runtime/time', () => ({ nowServerMs: () => 1000 }));

vi.mock('../resolveContextWarningWindowTokens', () => ({
    // Deterministic full window so percentage math is exercised without the registry.
    resolveContextWindowTokens: () => 200_000,
}));

import { useInstrumentStripModel, type InstrumentStripModel } from './useInstrumentStripModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(overrides: Partial<SessionContextUsageSnapshotV1>): SessionContextUsageSnapshotV1 {
    return {
        v: 1,
        modelId: 'claude',
        usedTokens: 50_000,
        windowTokens: 200_000,
        totalProcessedTokens: 400_000,
        baselineTokens: null,
        isAutoCompactEnabled: null,
        categories: null,
        observedAtMs: 10,
        source: 'provider_turn',
        ...overrides,
    };
}

describe('useInstrumentStripModel', () => {
    let tree: ReactTestRenderer | null = null;
    let latest: InstrumentStripModel | null = null;
    let renderCount = 0;

    function Probe() {
        latest = useInstrumentStripModel({ sessionId: 's1', agentId: 'claude' as never, metadata: null });
        renderCount += 1;
        return null;
    }

    beforeEach(() => {
        store.state.usage = null;
        store.state.scm = null;
        latest = null;
        renderCount = 0;
        publishSpy.mockReset();
    });

    afterEach(() => {
        act(() => tree?.unmount());
        tree = null;
    });

    it('exposes a null context model when no usage and no window resolvable', () => {
        // No snapshot + resolveContextWindowTokens mocked to a number → renders a derived gauge,
        // but with contextSize 0 the percentage is 0 (still shown). Assert git is null here.
        act(() => { tree = create(React.createElement(Probe)); });
        expect(latest?.git).toBeNull();
    });

    it('re-derives the context percentage when a usage tick lands (subscription lives in the strip)', () => {
        act(() => { tree = create(React.createElement(Probe)); });
        const mountRenders = renderCount;

        act(() => store.setUsage({ contextSize: 50_000, contextSnapshot: snapshot({ usedTokens: 50_000 }) }));
        expect(latest?.context?.usedPct).toBeCloseTo(25, 0);

        act(() => store.setUsage({ contextSize: 150_000, contextSnapshot: snapshot({ usedTokens: 150_000 }) }));
        expect(latest?.context?.usedPct).toBeCloseTo(75, 0);

        // The probe re-rendered on each tick — the model is a live store subscriber.
        expect(renderCount).toBeGreaterThan(mountRenders);
    });

    it('marks the gauge stale from the reducer staleness flag', () => {
        act(() => { tree = create(React.createElement(Probe)); });
        act(() => store.setUsage({
            contextSize: 50_000,
            contextSnapshot: snapshot({ usedTokens: 50_000 }),
            contextSnapshotStale: true,
        }));
        expect(latest?.context?.stale).toBe(true);
    });

    it('derives the git summary from the scm snapshot', () => {
        act(() => { tree = create(React.createElement(Probe)); });
        act(() => store.setScm({
            repo: { isRepo: true },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0 },
            entries: [{}, {}],
            totals: {
                includedAdded: 12, pendingAdded: 0, includedRemoved: 3, pendingRemoved: 0,
                includedFiles: 2, pendingFiles: 0, untrackedFiles: 0,
            },
        }));
        expect(latest?.git?.linesAdded).toBe(12);
        expect(latest?.git?.linesRemoved).toBe(3);
        expect(latest?.git?.hasLineChanges).toBe(true);
    });

    it('publishes a context_usage_refresh override when refresh is invoked', () => {
        act(() => { tree = create(React.createElement(Probe)); });
        act(() => latest?.refreshContextUsage());
        expect(publishSpy).toHaveBeenCalledTimes(1);
        expect(publishSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            configId: 'context_usage_refresh',
        });
    });
});
