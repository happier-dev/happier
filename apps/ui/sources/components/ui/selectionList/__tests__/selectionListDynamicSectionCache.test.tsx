import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';

import {
    buildDynamicSectionCacheKey,
    createDefaultDynamicSectionCache,
    createTestDynamicSectionCache,
    getDefaultDynamicSectionCache,
    __resetDefaultDynamicSectionCacheForTests,
    type SelectionListDynamicSectionCache,
} from '../selectionListDynamicSectionCache';
import { useSelectionListDynamicSections } from '../useSelectionListDynamicSections';
import type { SelectionListDynamicSection } from '../_types';

/**
 * FR4-12 — explicit cache adapter for cross-mount dynamic section caching.
 *
 * The adapter replaces the implicit module-level LRU global. Tests can pass
 * an isolated instance to fully sandbox state; production code falls back to
 * the singleton so back-compat is preserved.
 */

describe('selectionListDynamicSectionCache adapter', () => {
    describe('createDefaultDynamicSectionCache', () => {
        it('round-trips a single entry', () => {
            const cache = createDefaultDynamicSectionCache();
            cache.set('k1', [{ id: 'a', label: 'A' }]);
            expect(cache.get('k1')?.map((o) => o.id)).toEqual(['a']);
            expect(cache.size()).toBe(1);
        });

        it('returns undefined for missing keys', () => {
            const cache = createDefaultDynamicSectionCache();
            expect(cache.get('nope')).toBeUndefined();
        });

        it('promotes entries to MRU on get (LRU semantics)', () => {
            const cache = createDefaultDynamicSectionCache({ maxEntries: 3 });
            cache.set('k1', [{ id: '1', label: '1' }]);
            cache.set('k2', [{ id: '2', label: '2' }]);
            cache.set('k3', [{ id: '3', label: '3' }]);
            // Promote k1 to MRU. Now order is k2, k3, k1.
            void cache.get('k1');
            // Insert k4 — should evict the LRU end (k2).
            cache.set('k4', [{ id: '4', label: '4' }]);
            expect(cache.get('k1')).toBeDefined();
            expect(cache.get('k2')).toBeUndefined();
            expect(cache.get('k3')).toBeDefined();
            expect(cache.get('k4')).toBeDefined();
        });

        it('evicts the oldest entry when exceeding the configured cap', () => {
            const cache = createDefaultDynamicSectionCache({ maxEntries: 2 });
            cache.set('k1', [{ id: '1', label: '1' }]);
            cache.set('k2', [{ id: '2', label: '2' }]);
            cache.set('k3', [{ id: '3', label: '3' }]);
            expect(cache.size()).toBe(2);
            expect(cache.get('k1')).toBeUndefined();
            expect(cache.get('k2')).toBeDefined();
            expect(cache.get('k3')).toBeDefined();
        });

        it('falls back to the default cap when given a non-positive maxEntries', () => {
            const cache = createDefaultDynamicSectionCache({ maxEntries: 0 });
            for (let i = 0; i < 65; i += 1) {
                cache.set(`k${i}`, [{ id: `id-${i}`, label: '' }]);
            }
            // Default cap is 64; 65 inserts means one eviction.
            expect(cache.size()).toBe(64);
        });

        it('delete removes a single entry without affecting others', () => {
            const cache = createDefaultDynamicSectionCache();
            cache.set('k1', [{ id: '1', label: '1' }]);
            cache.set('k2', [{ id: '2', label: '2' }]);
            cache.delete('k1');
            expect(cache.get('k1')).toBeUndefined();
            expect(cache.get('k2')).toBeDefined();
            expect(cache.size()).toBe(1);
        });

        it('clear empties the cache', () => {
            const cache = createDefaultDynamicSectionCache();
            cache.set('k1', [{ id: '1', label: '1' }]);
            cache.set('k2', [{ id: '2', label: '2' }]);
            cache.clear();
            expect(cache.size()).toBe(0);
            expect(cache.get('k1')).toBeUndefined();
        });

        it('overwriting an existing key promotes it to MRU and updates value', () => {
            const cache = createDefaultDynamicSectionCache({ maxEntries: 2 });
            cache.set('k1', [{ id: 'v1', label: '' }]);
            cache.set('k2', [{ id: 'v2', label: '' }]);
            // Re-set k1 with a new value; it should become MRU.
            cache.set('k1', [{ id: 'v1-updated', label: '' }]);
            // Insert k3 — LRU now is k2, so k2 evicts.
            cache.set('k3', [{ id: 'v3', label: '' }]);
            expect(cache.get('k1')?.[0]?.id).toBe('v1-updated');
            expect(cache.get('k2')).toBeUndefined();
            expect(cache.get('k3')).toBeDefined();
        });
    });

    describe('createTestDynamicSectionCache', () => {
        it('returns an isolated instance with no shared state', () => {
            const a = createTestDynamicSectionCache();
            const b = createTestDynamicSectionCache();
            a.set('k', [{ id: 'a', label: '' }]);
            expect(b.get('k')).toBeUndefined();
        });
    });

    describe('buildDynamicSectionCacheKey', () => {
        it('defaults the resolver-key component to the section id when undefined', () => {
            expect(buildDynamicSectionCacheKey('section-a', undefined, 'seed-1')).toBe(
                'section-a::section-a::seed-1',
            );
        });

        it('includes the explicit resolverKey when provided', () => {
            expect(buildDynamicSectionCacheKey('section-a', 'machine:m1', 'seed-1')).toBe(
                'section-a::machine:m1::seed-1',
            );
        });
    });

    describe('getDefaultDynamicSectionCache singleton', () => {
        beforeEach(() => {
            __resetDefaultDynamicSectionCacheForTests();
        });

        it('returns the same instance on repeated calls', () => {
            const a = getDefaultDynamicSectionCache();
            const b = getDefaultDynamicSectionCache();
            expect(a).toBe(b);
        });

        it('is reset between specs by __resetDefaultDynamicSectionCacheForTests', () => {
            const a = getDefaultDynamicSectionCache();
            a.set('k', [{ id: 'x', label: '' }]);
            __resetDefaultDynamicSectionCacheForTests();
            const b = getDefaultDynamicSectionCache();
            expect(b.get('k')).toBeUndefined();
            expect(b).not.toBe(a);
        });
    });
});

// ─── Hook integration via injection ──────────────────────────────────────────

type Capture = ReturnType<typeof useSelectionListDynamicSections>;

function HostHarness(props: {
    dynamicSections: ReadonlyArray<SelectionListDynamicSection>;
    inputValue: string;
    cache?: SelectionListDynamicSectionCache;
    onState: (state: Capture) => void;
}): null {
    const state = useSelectionListDynamicSections({
        dynamicSections: props.dynamicSections,
        inputValue: props.inputValue,
        cache: props.cache,
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
    __resetDefaultDynamicSectionCacheForTests();
});

afterEach(() => {
    if (renderer) {
        act(() => {
            renderer!.unmount();
        });
        renderer = null;
    }
    vi.useRealTimers();
    __resetDefaultDynamicSectionCacheForTests();
});

function lastState(): Capture {
    expect(onState).toHaveBeenCalled();
    return onState.mock.calls[onState.mock.calls.length - 1]![0] as Capture;
}

describe('useSelectionListDynamicSections — cache injection (FR4-12)', () => {
    it('uses the injected cache to seed lastSuccessOptions on a fresh mount', async () => {
        const injected = createTestDynamicSectionCache();
        // Pre-seed the injected cache (simulating a prior successful resolve in
        // a previous mount that reused this cache instance).
        injected.set(
            buildDynamicSectionCacheKey('in-this-folder', 'machine:m1', '~/Documents/'),
            [{ id: 'a', label: 'Apple' }],
        );

        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            // Never-resolving so we observe the seeded value before the resolver
            // overwrites it.
            resolve: () => new Promise(() => {}),
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="~/Documents/"
                    cache={injected}
                    onState={onState}
                />,
            );
        });
        const initial = lastState().get('in-this-folder');
        expect(initial?.lastSuccessOptions?.map((o) => o.id)).toEqual(['a']);
    });

    it('writes successful resolves to the injected cache (not the singleton)', async () => {
        const injected = createTestDynamicSectionCache();
        const singleton = getDefaultDynamicSectionCache();
        const resolver = vi.fn(async () => ({
            options: [{ id: 'a', label: 'Apple' }],
        }));
        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: resolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="~/Documents/"
                    cache={injected}
                    onState={onState}
                />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });

        const cacheKey = buildDynamicSectionCacheKey('in-this-folder', 'machine:m1', '~/Documents/');
        expect(injected.get(cacheKey)?.map((o) => o.id)).toEqual(['a']);
        // Singleton was NOT written.
        expect(singleton.get(cacheKey)).toBeUndefined();
    });

    it('uses two independent injected caches without cross-talk', async () => {
        const cacheA = createTestDynamicSectionCache();
        const cacheB = createTestDynamicSectionCache();
        const resolver = vi.fn(async () => ({
            options: [{ id: 'a', label: 'Apple' }],
        }));
        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: resolver,
            debounceMs: 0,
        };
        // Populate cacheA via hook integration.
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="~/Documents/"
                    cache={cacheA}
                    onState={onState}
                />,
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

        // Fresh mount with cacheB; never-resolving resolver so the initial state
        // reflects whatever cacheB seeded (it should be empty).
        onState = vi.fn();
        const sectionB: SelectionListDynamicSection = {
            ...section,
            resolve: () => new Promise(() => {}),
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[sectionB]}
                    inputValue="~/Documents/"
                    cache={cacheB}
                    onState={onState}
                />,
            );
        });
        const initial = lastState().get('in-this-folder');
        // cacheB was never populated; nothing should seed the new mount.
        expect(initial?.lastSuccessOptions).toBeUndefined();
        // cacheA still has the value (no cross-talk).
        const cacheKey = buildDynamicSectionCacheKey('in-this-folder', 'machine:m1', '~/Documents/');
        expect(cacheA.get(cacheKey)?.map((o) => o.id)).toEqual(['a']);
    });

    it('falls back to the singleton when no cache is injected (back-compat)', async () => {
        const resolver = vi.fn(async () => ({
            options: [{ id: 'a', label: 'Apple' }],
        }));
        const section: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine:m1',
            resolve: resolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="~/Documents/"
                    onState={onState}
                />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const singleton = getDefaultDynamicSectionCache();
        const cacheKey = buildDynamicSectionCacheKey('in-this-folder', 'machine:m1', '~/Documents/');
        expect(singleton.get(cacheKey)?.map((o) => o.id)).toEqual(['a']);
    });
});
