import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';

import { useSelectionListDynamicSections } from '../useSelectionListDynamicSections';
import type {
    SelectionListDynamicSection,
    SelectionListInputBehavior,
    SelectionListOption,
} from '../_types';

type DeferredResolver = {
    promise: Promise<{ options: ReadonlyArray<SelectionListOption>; emptyHint?: string }>;
    resolve: (value: { options: ReadonlyArray<SelectionListOption>; emptyHint?: string }) => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
};

function defer(): DeferredResolver {
    let resolve!: DeferredResolver['resolve'];
    let reject!: DeferredResolver['reject'];
    const promise = new Promise<{ options: ReadonlyArray<SelectionListOption>; emptyHint?: string }>(
        (res, rej) => {
            resolve = res;
            reject = rej;
        },
    );
    return { promise, resolve, reject };
}

type Capture = ReturnType<typeof useSelectionListDynamicSections>;

function HostHarness(props: {
    dynamicSections: ReadonlyArray<SelectionListDynamicSection>;
    inputValue: string;
    inputBehavior?: SelectionListInputBehavior;
    onState: (state: Capture) => void;
}): null {
    const state = useSelectionListDynamicSections({
        dynamicSections: props.dynamicSections,
        inputValue: props.inputValue,
        inputBehavior: props.inputBehavior,
    });
    React.useEffect(() => {
        props.onState(state);
    });
    return null;
}

let renderer: ReactTestRenderer | null = null;
let onState: ReturnType<typeof vi.fn>;
const ORIGINAL_TIMERS = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

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
    // Restore fetch-like primitives if mocked elsewhere
    globalThis.setTimeout = ORIGINAL_TIMERS.setTimeout;
    globalThis.clearTimeout = ORIGINAL_TIMERS.clearTimeout;
});

function lastState(): Capture {
    expect(onState).toHaveBeenCalled();
    return onState.mock.calls[onState.mock.calls.length - 1]![0] as Capture;
}

describe('useSelectionListDynamicSections', () => {
    it('starts in idle status for sections with empty input and no resolver call yet', async () => {
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: vi.fn(async () => ({ options: [] })),
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="" onState={onState} />,
            );
        });
        const state = lastState();
        const entry = state.get('s1');
        expect(entry).toBeDefined();
        expect(entry?.status).toBe('idle');
        expect(section.resolve).not.toHaveBeenCalled();
    });

    it('debounces resolve calls by debounceMs before invoking the resolver', async () => {
        const resolver = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: resolver,
            debounceMs: 200,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="a" onState={onState} />,
            );
        });
        // Before debounce, no call yet
        expect(resolver).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(199);
        });
        expect(resolver).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(2);
        });
        expect(resolver).toHaveBeenCalledTimes(1);
        expect((resolver.mock.calls[0] as unknown as [string])?.[0]).toBe('a');
    });

    it('renders loading skeleton rows while the resolver is pending', async () => {
        const d = defer();
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: async () => d.promise,
            loadingSkeletonRows: 4,
            debounceMs: 50,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="x" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(51);
        });
        const entry = lastState().get('s1');
        expect(entry?.status).toBe('loading');
        expect(entry?.options.length).toBe(4);
        expect(entry?.options[0]?.disabled).toBe(true);
        expect(entry?.options[0]?.id.startsWith('skeleton:')).toBe(true);
    });

    it('uses the section seedFromInput override over inputBehavior.getDynamicSectionSeed', async () => {
        const resolver = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: resolver,
            seedFromInput: (input) => `section-seed:${input}`,
            debounceMs: 0,
        };
        const behavior: SelectionListInputBehavior = {
            getDynamicSectionSeed: (input) => `behavior-seed:${input}`,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="abc"
                    inputBehavior={behavior}
                    onState={onState}
                />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(resolver).toHaveBeenCalledTimes(1);
        expect((resolver.mock.calls[0] as unknown as [string])?.[0]).toBe('section-seed:abc');
    });

    it('falls back to inputBehavior.getDynamicSectionSeed when section has no override', async () => {
        const resolver = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: resolver,
            debounceMs: 0,
        };
        const behavior: SelectionListInputBehavior = {
            getDynamicSectionSeed: (input) => `seed:${input}`,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness
                    dynamicSections={[section]}
                    inputValue="hello"
                    inputBehavior={behavior}
                    onState={onState}
                />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect((resolver.mock.calls[0] as unknown as [string])?.[0]).toBe('seed:hello');
    });

    it('falls back to raw input when neither override nor behavior seed is provided', async () => {
        const resolver = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: resolver,
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="raw-seed" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect((resolver.mock.calls[0] as unknown as [string])?.[0]).toBe('raw-seed');
    });

    it('hides the section (idle, no fetch) when visibleWhen returns false', async () => {
        const resolver = vi.fn(async () => ({ options: [] }));
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: resolver,
            debounceMs: 0,
            visibleWhen: (input) => input.startsWith('/'),
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="abc" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(5);
        });
        expect(resolver).not.toHaveBeenCalled();
        expect(lastState().get('s1')?.status).toBe('idle');
    });

    it('drops stale responses via the sequence guard when 5 rapid inputs all resolve out of order', async () => {
        const deferreds: DeferredResolver[] = [];
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: async (seed: string, abortSignal: AbortSignal) => {
                const d = defer();
                d.signal = abortSignal;
                deferreds.push(d);
                const result = await d.promise;
                return { options: result.options.map((o) => ({ ...o, id: `${seed}:${o.id}` })) };
            },
            debounceMs: 0,
        };
        const HOST = (props: { input: string }) => (
            <HostHarness
                dynamicSections={[section]}
                inputValue={props.input}
                onState={onState}
            />
        );
        await act(async () => {
            renderer = createRenderer(<HOST input="a" />);
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        await act(async () => {
            renderer!.update(<HOST input="ab" />);
            vi.advanceTimersByTime(1);
        });
        await act(async () => {
            renderer!.update(<HOST input="abc" />);
            vi.advanceTimersByTime(1);
        });
        await act(async () => {
            renderer!.update(<HOST input="abcd" />);
            vi.advanceTimersByTime(1);
        });
        await act(async () => {
            renderer!.update(<HOST input="abcde" />);
            vi.advanceTimersByTime(1);
        });
        expect(deferreds.length).toBe(5);
        // Resolve the first four in arbitrary order; they must be IGNORED.
        await act(async () => {
            deferreds[2]!.resolve({ options: [{ id: 'two', label: 'two' }] });
        });
        await act(async () => {
            deferreds[0]!.resolve({ options: [{ id: 'zero', label: 'zero' }] });
        });
        await act(async () => {
            deferreds[3]!.resolve({ options: [{ id: 'three', label: 'three' }] });
        });
        await act(async () => {
            deferreds[1]!.resolve({ options: [{ id: 'one', label: 'one' }] });
        });
        // The latest sequence's response arrives last; it MUST be the one rendered.
        await act(async () => {
            deferreds[4]!.resolve({ options: [{ id: 'four', label: 'four' }] });
        });
        const final = lastState().get('s1');
        expect(final?.status).toBe('success');
        expect(final?.options.map((o) => o.id)).toEqual(['abcde:four']);
    });

    it('aborts the previous request when input changes (signal.aborted === true)', async () => {
        let firstSignal: AbortSignal | undefined;
        let secondSignal: AbortSignal | undefined;
        let callCount = 0;
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: async (_seed, abortSignal) => {
                callCount += 1;
                if (callCount === 1) firstSignal = abortSignal;
                else secondSignal = abortSignal;
                return new Promise(() => {}); // never resolves
            },
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="a" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(firstSignal?.aborted).toBe(false);
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[section]} inputValue="ab" onState={onState} />,
            );
            vi.advanceTimersByTime(1);
        });
        expect(firstSignal?.aborted).toBe(true);
        expect(secondSignal?.aborted).toBe(false);
    });

    it('transitions to error status when the resolver rejects, keeping prior options visible (stale-cache)', async () => {
        let attempt = 0;
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: async () => {
                attempt += 1;
                if (attempt === 1) return { options: [{ id: 'cached-a', label: 'Cached A' }] };
                throw new Error('boom');
            },
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="a" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });
        expect(lastState().get('s1')?.status).toBe('success');
        // Trigger new input → second call rejects
        await act(async () => {
            renderer!.update(
                <HostHarness dynamicSections={[section]} inputValue="ab" onState={onState} />,
            );
            vi.advanceTimersByTime(1);
            // Allow microtasks
            await Promise.resolve();
            await Promise.resolve();
        });
        const errored = lastState().get('s1');
        expect(errored?.status).toBe('error');
        expect(errored?.error?.message).toBe('boom');
        // Cached options preserved
        expect(errored?.options.length).toBeGreaterThan(0);
    });

    it('exposes emptyHint when resolver returns zero options with a hint', async () => {
        const section: SelectionListDynamicSection = {
            id: 's1',
            resolve: async () => ({ options: [], emptyHint: 'No files here' }),
            debounceMs: 0,
        };
        await act(async () => {
            renderer = createRenderer(
                <HostHarness dynamicSections={[section]} inputValue="a" onState={onState} />,
            );
        });
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
        });
        const entry = lastState().get('s1');
        expect(entry?.status).toBe('success');
        expect(entry?.options.length).toBe(0);
        expect(entry?.emptyHint).toBe('No files here');
    });
});
