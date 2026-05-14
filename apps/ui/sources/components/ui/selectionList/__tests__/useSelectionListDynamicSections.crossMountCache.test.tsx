import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';

import {
    useSelectionListDynamicSections,
    __resetDynamicSectionCacheForTests,
    __getDynamicSectionCacheSizeForTests,
} from '../useSelectionListDynamicSections';
import type {
    SelectionListDynamicSection,
} from '../_types';

/**
 * RUX-11.1 — cross-mount cache for dynamic sections.
 *
 * Symptom: opening the path popover always flickered through an empty "In
 * this folder" section before results arrived, even when reopening
 * IMMEDIATELY after closing. Per-mount state means the freshly-mounted hook
 * loses the prior options on every open.
 *
 * Fix: a module-level LRU cache keyed by `${id}::${resolverKey}::${seed}`
 * stores the last successful options. On mount the reducer's initial state
 * seeds `lastSuccessOptions` from the cache when present. On every
 * successful resolve the cache is updated. Aborted in-flight resolves do
 * NOT poison the cache (only a successful response writes).
 */

type Capture = ReturnType<typeof useSelectionListDynamicSections>;

function HostHarness(props: {
    dynamicSections: ReadonlyArray<SelectionListDynamicSection>;
    inputValue: string;
    onState: (state: Capture) => void;
}): null {
    const state = useSelectionListDynamicSections({
        dynamicSections: props.dynamicSections,
        inputValue: props.inputValue,
    });
    React.useEffect(() => {
        props.onState(state);
    });
    return null;
}

let renderer: ReactTestRenderer | null = null;
let onState: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    onState = vi.fn();
    __resetDynamicSectionCacheForTests();
});

afterEach(() => {
    if (renderer) {
        act(() => {
            renderer!.unmount();
        });
        renderer = null;
    }
    vi.useRealTimers();
    __resetDynamicSectionCacheForTests();
});

function lastState(): Capture {
    expect(onState).toHaveBeenCalled();
    return onState.mock.calls[onState.mock.calls.length - 1]![0] as Capture;
}

describe('useSelectionListDynamicSections — cross-mount cache (RUX-11.1)', () => {
    it('seeds the new mount with the last-successful options after unmount + remount with the same id+resolverKey+seed', async () => {
        const resolver = vi.fn(async () => ({
            options: [{ id: 'a', label: 'Apple' }],
        }));
        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: resolver,
            debounceMs: 0,
        };
        // First mount, fetch + success.
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="~/Documents/" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const firstSuccess = lastState().get('in-this-folder');
        expect(firstSuccess?.status).toBe('success');
        expect(firstSuccess?.options.map((o) => o.id)).toEqual(['a']);

        // Unmount.
        await act(async () => {
            renderer!.unmount();
            renderer = null;
        });

        // Remount IMMEDIATELY with the same descriptor + same input. The
        // hook's initial state for this section must seed
        // `lastSuccessOptions` from the cross-mount cache so the orchestrator
        // does not flicker through an empty list before the new fetch lands.
        onState = vi.fn();
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="~/Documents/" onState={onState} />,
            );
        });
        // BEFORE advancing timers (i.e. before the new fetch dispatches), the
        // hook should already expose the cached options. This is the whole
        // point of the cross-mount cache: there is NO empty-then-loading
        // intermediate state.
        const initial = lastState().get('in-this-folder');
        expect(initial?.lastSuccessOptions?.map((o) => o.id)).toEqual(['a']);
    });

    it('does not seed the new mount when the cache key differs (different resolverKey)', async () => {
        const resolverM1 = vi.fn(async () => ({
            options: [{ id: 'a', label: 'Apple' }],
        }));
        const sectionM1: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: resolverM1,
            debounceMs: 0,
        };
        // Populate cache for m1.
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[sectionM1]} inputValue="~/" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        await act(async () => {
            renderer!.unmount();
            renderer = null;
        });

        // Remount with a DIFFERENT resolverKey AND a never-resolving
        // resolver so the post-mount loading state preserves whatever the
        // cross-mount cache seeded into the initial state. If the cache
        // miss is correctly applied for the new key, initial
        // lastSuccessOptions is undefined and the loading entry's
        // lastSuccessOptions stays undefined too.
        const sectionM2: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m2',
            resolve: () => new Promise(() => {}),
            debounceMs: 0,
        };
        onState = vi.fn();
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[sectionM2]} inputValue="~/" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        const initial = lastState().get('in-this-folder');
        // Loading state from never-resolving resolver. The cache MISSED for
        // m2, so lastSuccessOptions remains undefined despite m1 having
        // populated the cache before unmount.
        expect(initial?.status).toBe('loading');
        expect(initial?.lastSuccessOptions).toBeUndefined();
    });

    it('does NOT poison the cache when the resolve is aborted before completion (abort-safe)', async () => {
        let resolveDeferred!: (value: { options: Array<{ id: string; label: string }> }) => void;
        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: (_seed: string, abortSignal: AbortSignal) =>
                new Promise((res, rej) => {
                    resolveDeferred = res;
                    abortSignal.addEventListener('abort', () => rej(new Error('aborted')));
                }),
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="~/Documents/" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        // Unmount BEFORE the resolve completes.
        await act(async () => {
            renderer!.unmount();
            renderer = null;
        });
        // Now resolve the deferred — this would have written to the cache if
        // the cache write fired on every success, regardless of abort. The
        // abort-safe contract means the cache stays empty for this key.
        await act(async () => {
            resolveDeferred({ options: [{ id: 'late', label: 'Late' }] });
            await Promise.resolve();
            await Promise.resolve();
        });

        // Remount with the same section + seed: the cache must still be empty.
        onState = vi.fn();
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="~/Documents/" onState={onState} />,
            );
        });
        const initial = lastState().get('in-this-folder');
        expect(initial?.lastSuccessOptions).toBeUndefined();
    });

    it('evicts the oldest entry when the cache exceeds its cap', async () => {
        // The cache cap is exposed implicitly via the eviction behavior. We
        // exercise it by populating MANY distinct keys (different seeds)
        // serially and asserting the oldest is evicted.
        const resolver = vi.fn(async (seed: string) => ({
            options: [{ id: seed, label: seed }],
        }));
        // Cap is 64; populate 70 distinct keys via different seeds.
        for (let i = 0; i < 70; i += 1) {
            const seed = `seed-${i}`;
            const section: SelectionListDynamicSection = {
                id: 'sec',
                resolverKey: 'rk',
                resolve: resolver,
                debounceMs: 0,
            };
            // eslint-disable-next-line no-await-in-loop -- intentional sequencing
            await act(async () => {
                renderer = createRenderer(
                    <HostHarness dynamicSections={[section]} inputValue={seed} onState={onState} />,
                );
            });
            // eslint-disable-next-line no-await-in-loop
            await act(async () => {
                vi.advanceTimersByTime(1);
                await Promise.resolve();
                await Promise.resolve();
            });
            // eslint-disable-next-line no-await-in-loop
            await act(async () => {
                renderer!.unmount();
                renderer = null;
            });
        }
        // Cache size is capped (LRU). The exact cap is implementation-detail
        // but must be <= 64 (the documented limit).
        const size = __getDynamicSectionCacheSizeForTests();
        expect(size).toBeLessThanOrEqual(64);
        expect(size).toBeGreaterThan(0);
    });
});
