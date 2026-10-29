import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';

import { useSelectionListDynamicSections } from '../useSelectionListDynamicSections';
import type {
    SelectionListDynamicSection,
    SelectionListOption,
} from '../_types';
import {
    createDefaultDynamicSectionCache,
    type SelectionListDynamicSectionCache,
} from '../selectionListDynamicSectionCache';

type Capture = ReturnType<typeof useSelectionListDynamicSections>;

function HostHarness(props: {
    dynamicSections: ReadonlyArray<SelectionListDynamicSection>;
    inputValue: string;
    onState: (state: Capture) => void;
    cache?: SelectionListDynamicSectionCache;
}): null {
    const state = useSelectionListDynamicSections({
        dynamicSections: props.dynamicSections,
        inputValue: props.inputValue,
        ...(props.cache ? { cache: props.cache } : {}),
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
});

afterEach(() => {
    if (renderer) {
        act(() => {
            renderer!.unmount();
        });
        renderer = null;
    }
    vi.useRealTimers();
});

function lastState(): Capture {
    expect(onState).toHaveBeenCalled();
    return onState.mock.calls[onState.mock.calls.length - 1]![0] as Capture;
}

/**
 * R16a — Resolver-identity guard tightening.
 *
 * R9 (blocker 2) keyed descriptor refresh by an internal WeakMap that tagged
 * EVERY new resolver closure as a meaningful identity change. In React it's
 * normal for parent re-renders to pass new closures to the same section id —
 * R9's approach therefore caused constant cache invalidation + spurious
 * loading-skeleton flicker on every parent re-render of any consumer that
 * didn't memoize `resolve`/closures captured by `resolve`.
 *
 * R16a tightens the contract:
 *   - Default identity = `descriptor.id` only — plain re-renders never
 *     invalidate the cached state.
 *   - Callers that NEED the invalidation behavior (e.g. machine swap rebinds
 *     the underlying RPC behind the same section id) MUST opt in by bumping
 *     the explicit `resolverKey` field.
 *
 * Behavior we still want from R9:
 *   - hidden→visible transitions (visibilityKey) MUST still trigger fresh
 *     fetches (covered by the second test below — unchanged).
 */
describe('useSelectionListDynamicSections — resolverKey-driven invalidation (R16a)', () => {
    it('dispatches only the section whose query inputs changed, not its unchanged siblings', async () => {
        const settings = vi.fn(async (_seed: string) => ({ options: [{ id: 'settings-hit', label: 'Settings hit' }] }));
        const transcript = vi.fn(async () => ({ options: [] }));
        const sections = (key: string): readonly SelectionListDynamicSection[] => [
            { id: 'settings', resolverKey: 'catalog', debounceMs: 0, resolve: settings },
            { id: 'transcript', resolverKey: key, debounceMs: 0, resolve: transcript },
        ];
        const update = async (query: string, key: string) => act(async () => {
            renderer!.update(<HostHarness dynamicSections={sections(key)} inputValue={query} onState={onState} />);
        });
        await act(async () => {
            renderer = createRenderer(<HostHarness dynamicSections={sections('before')} inputValue="theme" onState={onState} />);
        });
        expect(settings).toHaveBeenCalledTimes(1);
        await update('theme', 'after');
        expect(settings).toHaveBeenCalledTimes(1);
        expect(transcript).toHaveBeenCalledTimes(2);
        await update('security', 'after');
        expect(settings).toHaveBeenCalledTimes(2);
        expect(settings.mock.calls[1]?.[0]).toBe('security');
        expect(lastState().get('settings')?.options.map(option => option.id)).toEqual(['settings-hit']);
    });

    it('keeps an unchanged pending request through sibling removal and still cancels it for a new query', async () => {
        const signals: AbortSignal[] = [];
        const pending: SelectionListDynamicSection = {
            id: 'pending', debounceMs: 0,
            resolve: (_seed, signal) => {
                signals.push(signal);
                return new Promise(() => {});
            },
        };
        const sibling: SelectionListDynamicSection = { id: 'sibling', debounceMs: 0, resolve: async () => ({ options: [] }) };
        await act(async () => {
            renderer = createRenderer(<HostHarness dynamicSections={[pending, sibling]} inputValue="first" onState={onState} />);
        });
        await act(async () => {
            renderer!.update(<HostHarness dynamicSections={[pending]} inputValue="first" onState={onState} />);
        });
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(false);
        await act(async () => {
            renderer!.update(<HostHarness dynamicSections={[pending]} inputValue="second" onState={onState} />);
        });
        expect(signals).toHaveLength(2);
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
    });

    it('cancels a removed section before its pending debounce can dispatch', async () => {
        const resolve = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 'pending',
            debounceMs: 100,
            resolve,
        };

        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="needle" onState={onState} />,
            );
        });
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[]} inputValue="needle" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(101);
        });

        expect(resolve).not.toHaveBeenCalled();
        expect(lastState().has('pending')).toBe(false);
    });

    it('retires removed sections and prevents their late work from repopulating state or cache', async () => {
        let resolveRemoved!: (value: { options: ReadonlyArray<SelectionListOption> }) => void;
        let removedSignal: AbortSignal | undefined;
        const cache = createDefaultDynamicSectionCache();
        const removedSection: SelectionListDynamicSection = {
            id: 'removed',
            resolverKey: 'target-a',
            debounceMs: 0,
            resolve: (_seed, signal) => {
                removedSignal = signal;
                return new Promise((resolve) => { resolveRemoved = resolve; });
            },
        };

        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[removedSection]}
                    inputValue="needle"
                    onState={onState}
                    cache={cache}
                />,
            );
            vi.advanceTimersByTime(1);
        });
        expect(removedSignal?.aborted).toBe(false);

        await act(async () => {
            renderer!.update(
                <HostHarness
                    dynamicSections={[]}
                    inputValue="needle"
                    onState={onState}
                    cache={cache}
                />,
            );
        });

        expect(removedSignal?.aborted).toBe(true);
        expect(lastState().has('removed')).toBe(false);

        await act(async () => {
            resolveRemoved({ options: [{ id: 'late', label: 'Late result' }] });
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(lastState().has('removed')).toBe(false);
        expect(cache.size()).toBe(0);
    });

    it('does not publish an aborted rejection while the replacement query is still debouncing', async () => {
        let rejectFirst!: (error: Error) => void;
        let firstSignal: AbortSignal | undefined;
        const section: SelectionListDynamicSection = {
            id: 'replace',
            debounceMs: 100,
            resolve: (seed, signal) => {
                if (seed === 'first') {
                    firstSignal = signal;
                    return new Promise((_resolve, reject) => { rejectFirst = reject; });
                }
                return Promise.resolve({ options: [{ id: 'fresh', label: 'Fresh' }] });
            },
        };

        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="first" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(101);
        });
        expect(firstSignal?.aborted).toBe(false);

        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[section]} inputValue="second" onState={onState} />,
            );
        });
        expect(firstSignal?.aborted).toBe(true);

        await act(async () => {
            rejectFirst(new Error('aborted request'));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(lastState().get('replace')?.status).not.toBe('error');
    });

    it('does NOT invalidate cached state when only the resolver closure identity changes (no resolverKey bump)', async () => {
        const baseOptions: ReadonlyArray<SelectionListOption> = [
            { id: 'cached-a', label: 'Cached A' },
        ];
        // Two distinct closures — both produce the SAME logical result. This
        // simulates the common case of a parent re-render handing the
        // SelectionList a fresh inline resolver each render.
        const firstResolver = vi.fn(async () => ({ options: baseOptions }));
        const secondResolver = vi.fn(async () => ({ options: baseOptions }));

        const firstSection: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolve: firstResolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[firstSection]} inputValue="x" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });
        expect(firstResolver).toHaveBeenCalledTimes(1);
        expect(lastState().get('in-this-folder')?.status).toBe('success');

        // Re-render multiple times with NEW closures but same id and same
        // (omitted) resolverKey. None of these should invalidate the cache.
        for (let i = 0; i < 3; i += 1) {
            await act(async () => {
                const churningSection: SelectionListDynamicSection = {
                    id: 'in-this-folder',
                    resolve: secondResolver,
                    debounceMs: 0,
                };
                renderer!.update(
                    <HostHarness dynamicSections={[churningSection]} inputValue="x" onState={onState} />,
                );
            });
            await act(async () => {
                vi.advanceTimersByTime(1);
                await Promise.resolve();
            });
        }

        // The second resolver MUST NOT be called — same id + same (default)
        // resolverKey means the cache stays warm.
        expect(secondResolver).not.toHaveBeenCalled();
        const finalEntry = lastState().get('in-this-folder');
        // Status stays 'success' across the churn — no loading flicker.
        expect(finalEntry?.status).toBe('success');
        expect(finalEntry?.options.map((o) => o.id)).toEqual(['cached-a']);
    });

    it('refetches and clears stale state when the explicit resolverKey changes (e.g. machine swap)', async () => {
        const machineAOptions: ReadonlyArray<SelectionListOption> = [
            { id: 'machineA-a', label: 'A on Machine A' },
            { id: 'machineA-b', label: 'B on Machine A' },
        ];
        const machineBOptions: ReadonlyArray<SelectionListOption> = [
            { id: 'machineB-a', label: 'A on Machine B' },
        ];
        const machineAResolver = vi.fn(async () => ({ options: machineAOptions }));
        const machineBResolver = vi.fn(async () => ({ options: machineBOptions }));

        const machineASection: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine-A',
            resolve: machineAResolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[machineASection]} inputValue="x" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });
        expect(machineAResolver).toHaveBeenCalledTimes(1);
        expect(lastState().get('in-this-folder')?.options.map((o) => o.id))
            .toEqual(['machineA-a', 'machineA-b']);

        // Swap to a new resolverKey ('machine-B') — invalidation MUST happen
        // and a fresh fetch is dispatched.
        const machineBSection: SelectionListDynamicSection = {
            id: 'in-this-folder',
            resolverKey: 'machine-B',
            resolve: machineBResolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[machineBSection]} inputValue="x" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(machineBResolver).toHaveBeenCalledTimes(1);
        const finalEntry = lastState().get('in-this-folder');
        expect(finalEntry?.options.map((o) => o.id)).toEqual(['machineB-a']);
        // Stale options from the old resolverKey MUST NOT linger as
        // lastSuccessOptions (machine identity changed → cache no longer valid).
        expect(finalEntry?.lastSuccessOptions?.map((o) => o.id)).toEqual(['machineB-a']);
    });

    it('does NOT replay a late stale response after a section is re-toggled visible', async () => {
        // Section is initially visible. We dispatch a request, then toggle the
        // section hidden (via visibleWhen flipping false) BEFORE the resolver
        // returns. The late response must not become rendered state for the
        // newly-visible section. After re-enabling visibleWhen, the section
        // must trigger a fresh fetch (not surface the abandoned in-flight response).
        let resolveFn!: (v: { options: ReadonlyArray<SelectionListOption> }) => void;
        let resolverCallCount = 0;
        let visibleWhen: (input: string) => boolean = () => true;
        const section: SelectionListDynamicSection = {
            id: 'late-stale',
            resolve: () => {
                resolverCallCount += 1;
                if (resolverCallCount === 1) {
                    return new Promise((resolve) => {
                        resolveFn = resolve as never;
                    });
                }
                return Promise.resolve({ options: [{ id: 'fresh', label: 'Fresh' }] });
            },
            debounceMs: 0,
            visibleWhen: (input) => visibleWhen(input),
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="abc" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        // First in-flight resolver is captured. Now flip visible to false (via
        // re-render with same section but visibleWhen returning false).
        visibleWhen = () => false;
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[section]} inputValue="abc" onState={onState} />,
            );
            vi.advanceTimersByTime(1);
        });
        // Now resolve the FIRST request. It must be dropped (section is hidden,
        // sequence guard / visibility check should prevent it from becoming state).
        await act(async () => {
            resolveFn({ options: [{ id: 'stale', label: 'Stale' }] });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(lastState().get('late-stale')?.status).toBe('idle');

        // Re-toggle visible. This MUST trigger a NEW fetch (not replay the
        // late stale response captured earlier).
        visibleWhen = () => true;
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[section]} inputValue="abc" onState={onState} />,
            );
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(resolverCallCount).toBeGreaterThanOrEqual(2);
        const finalEntry = lastState().get('late-stale');
        expect(finalEntry?.status).toBe('success');
        expect(finalEntry?.options.map((o) => o.id)).toEqual(['fresh']);
    });
});
