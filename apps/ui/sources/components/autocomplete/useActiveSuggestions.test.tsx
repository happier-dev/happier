import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { useActiveSuggestions, type ActiveSuggestionsHandler } from './useActiveSuggestions';

function suggestion(key: string): AutocompleteSuggestion {
    return {
        kind: 'slashCommand',
        key,
        text: `/${key}`,
    };
}

describe('useActiveSuggestions', () => {
    it('does not expose stale suggestions while a newer query is pending', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (
            query === '/' ? first.promise : second.promise
        ));

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );

        first.resolve([suggestion('root')]);
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toEqual([suggestion('root')]);

        await hook.rerender({ query: '/h' });

        expect(handler).toHaveBeenLastCalledWith('/h', expect.any(AbortSignal), expect.any(Function));
        expect(hook.getCurrent()[0]).toEqual([]);

        second.resolve([suggestion('help')]);
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);
    });

    it('stops queued suggestion work when the component unmounts', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (
            query === '/' ? first.promise : second.promise
        ));

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );

        await hook.rerender({ query: '/h' });
        await hook.unmount();

        first.resolve([suggestion('root')]);
        await flushHookEffects();

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('ignores in-flight suggestions from a replaced handler for the same query', async () => {
        const oldHandlerResult = createDeferred<AutocompleteSuggestion[]>();
        const newHandlerResult = createDeferred<AutocompleteSuggestion[]>();
        const oldHandler = vi.fn(() => oldHandlerResult.promise);
        const newHandler = vi.fn(() => newHandlerResult.promise);

        const hook = await renderHook(
            ({ handler }: { handler: ActiveSuggestionsHandler }) => (
                useActiveSuggestions('/h', handler)
            ),
            { initialProps: { handler: oldHandler as ActiveSuggestionsHandler } },
        );

        await hook.rerender({ handler: newHandler as ActiveSuggestionsHandler });
        newHandlerResult.resolve([suggestion('help')]);
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);

        oldHandlerResult.resolve([suggestion('stale')]);
        await flushHookEffects();

        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);
    });

    // D-15: without this, a superseded query keeps ValueSync's serial queue for the
    // full duration of its slowest kind before the next keystroke even starts.
    it('settles a provider rejection caused by supersession without terminating the newer query', async () => {
        const signals: AbortSignal[] = [];
        const handler = vi.fn((query: string, signal: AbortSignal) => {
            signals.push(signal);
            if (query === '/') {
                return new Promise<AutocompleteSuggestion[]>((_, reject) => {
                    signal.addEventListener('abort', () => {
                        const error = Object.assign(new Error('superseded'), { retryable: false });
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
            }
            return Promise.resolve([suggestion('help')]);
        });

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );

        await hook.rerender({ query: '/h' });
        await flushHookEffects();

        expect(handler).toHaveBeenNthCalledWith(1, '/', expect.any(AbortSignal), expect.any(Function));
        expect(handler).toHaveBeenNthCalledWith(2, '/h', expect.any(AbortSignal), expect.any(Function));
        expect(signals[0]!.aborted).toBe(true);
        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);
    });

    it('aborts the outstanding query on unmount', async () => {
        const signals: AbortSignal[] = [];
        const handler = vi.fn((_query: string, signal: AbortSignal) => {
            signals.push(signal);
            return new Promise<AutocompleteSuggestion[]>((_, reject) => {
                signal.addEventListener('abort', () => {
                    reject(Object.assign(new Error('unmounted'), { retryable: false }));
                }, { once: true });
            });
        });

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );
        await hook.unmount();
        await flushHookEffects();

        expect(signals[0]!.aborted).toBe(true);
    });

    // INV-6 / D-11: the picker is sectioned, so the number of rows above the
    // selected candidate changes between keystrokes. An index-tracking selection
    // silently lands on a different row when that happens.
    it('follows the selected candidate when a section above it grows', async () => {
        const firstResult = createDeferred<AutocompleteSuggestion[]>();
        const secondResult = createDeferred<AutocompleteSuggestion[]>();
        const firstHandler = vi.fn(() => firstResult.promise);
        const secondHandler = vi.fn(() => secondResult.promise);

        const hook = await renderHook(
            ({ handler }: { handler: ActiveSuggestionsHandler }) => (
                useActiveSuggestions('@re', handler)
            ),
            { initialProps: { handler: firstHandler as ActiveSuggestionsHandler } },
        );

        firstResult.resolve([suggestion('file-a'), suggestion('plugin-a'), suggestion('plugin-b')]);
        await flushHookEffects();

        // Select the first plugin row.
        await act(async () => { hook.getCurrent()[3](); });
        await flushHookEffects();
        expect(hook.getCurrent()[1]).toBe(1);
        expect(hook.getCurrent()[0][1]?.key).toBe('plugin-a');

        // The Files section resolves two more rows; every plugin row shifts down.
        await hook.rerender({ handler: secondHandler as ActiveSuggestionsHandler });
        secondResult.resolve([
            suggestion('file-a'),
            suggestion('file-b'),
            suggestion('file-c'),
            suggestion('plugin-a'),
            suggestion('plugin-b'),
        ]);
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(3);
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('plugin-a');
    });

    it('keeps a user-selected candidate pinned when a current provider settlement moves its row', async () => {
        const final = createDeferred<AutocompleteSuggestion[]>();
        let publish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        const candidate = suggestion('reference-42');
        const handler = vi.fn((
            _query: string,
            _signal: AbortSignal,
            onUpdate?: (suggestions: AutocompleteSuggestion[]) => void,
        ) => {
            publish = onUpdate;
            return final.promise;
        });

        const hook = await renderHook(
            () => useActiveSuggestions('@issue', handler),
        );
        await flushHookEffects();

        // The controller needs a current-query publication channel; waiting for
        // the final Promise would make a slow provider hide the built-in rows.
        expect(publish).toBeTypeOf('function');
        if (!publish) throw new Error('expected incremental suggestion publisher');

        await act(async () => {
            publish?.([suggestion('file-issues'), candidate]);
        });
        await flushHookEffects();
        await act(async () => { hook.getCurrent()[3](); });
        await flushHookEffects();
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('reference-42');

        // A later section settles above the chosen reference. Numeric selection
        // would now make Enter insert `file-issues-2` instead.
        await act(async () => {
            publish?.([suggestion('file-issues'), suggestion('file-issues-2'), candidate]);
        });
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(2);
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('reference-42');

        final.resolve([suggestion('file-issues'), suggestion('file-issues-2'), candidate]);
        await flushHookEffects();
    });

    it('ignores a late incremental publication from a superseded query', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        let firstPublish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        let secondPublish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        const handler = vi.fn((
            query: string,
            signal: AbortSignal,
            onUpdate?: (suggestions: AutocompleteSuggestion[]) => void,
        ) => {
            if (query === '@i') {
                firstPublish = onUpdate;
                signal.addEventListener('abort', () => first.resolve([]), { once: true });
                return first.promise;
            }
            secondPublish = onUpdate;
            return second.promise;
        });

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '@i' as string | null } },
        );
        await flushHookEffects();
        expect(firstPublish).toBeTypeOf('function');

        await hook.rerender({ query: '@is' });
        await vi.waitFor(() => expect(secondPublish).toBeTypeOf('function'));
        if (!firstPublish || !secondPublish) throw new Error('expected incremental suggestion publishers');

        await act(async () => {
            secondPublish?.([suggestion('current-issue')]);
            firstPublish?.([suggestion('stale-issue')]);
        });
        await flushHookEffects();

        expect(hook.getCurrent()[0]).toEqual([suggestion('current-issue')]);

        second.resolve([suggestion('current-issue')]);
        await flushHookEffects();
    });

    it('ignores a provider publication after its current query has finalized', async () => {
        let publish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        const finalRows = [suggestion('current-issue')];
        const handler = vi.fn((
            _query: string,
            _signal: AbortSignal,
            onUpdate?: (suggestions: AutocompleteSuggestion[]) => void,
        ) => {
            publish = onUpdate;
            return Promise.resolve(finalRows);
        });

        const hook = await renderHook(() => useActiveSuggestions('@issue', handler));
        await flushHookEffects();
        if (!publish) throw new Error('expected incremental suggestion publisher');
        expect(hook.getCurrent()[0]).toEqual(finalRows);

        await act(async () => {
            publish?.([suggestion('late-provider-row')]);
        });
        await flushHookEffects();

        expect(hook.getCurrent()[0]).toEqual(finalRows);
    });

    it('does not rerender for the final marker when it repeats the current snapshot', async () => {
        const final = createDeferred<AutocompleteSuggestion[]>();
        const rows = [suggestion('file-issues'), suggestion('reference-42')];
        let publish: ((suggestions: AutocompleteSuggestion[]) => void) | undefined;
        let renderCount = 0;
        const handler = vi.fn((
            _query: string,
            _signal: AbortSignal,
            onUpdate?: (suggestions: AutocompleteSuggestion[]) => void,
        ) => {
            publish = onUpdate;
            return final.promise;
        });

        const hook = await renderHook(() => {
            renderCount += 1;
            return useActiveSuggestions('@issue', handler);
        });
        await flushHookEffects();
        if (!publish) throw new Error('expected incremental suggestion publisher');

        await act(async () => { publish?.(rows); });
        await flushHookEffects();
        const rendersAfterPartial = renderCount;

        final.resolve(rows);
        await flushHookEffects();

        expect(hook.getCurrent()[0]).toEqual(rows);
        expect(renderCount).toBe(rendersAfterPartial);
    });

    it('does not treat a same-key row from another kind as the selected candidate', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (query === '@next' ? second.promise : first.promise));
        const file = { kind: 'file', key: 'shared-candidate', text: '@README.md' } as const;
        const plugin = { kind: 'vendorPlugin', key: 'shared-candidate', text: '@plugin' } as const;

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '@' as string | null } },
        );

        first.resolve([file, plugin]);
        await flushHookEffects();
        await act(async () => { hook.getCurrent()[3](); });
        await flushHookEffects();
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.kind).toBe('vendorPlugin');

        await hook.rerender({ query: '@next' });
        // The same provider candidate remains at a different row. A bare `key`
        // would instead pin the File row simply because it appears first.
        second.resolve([file, plugin]);
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(1);
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.kind).toBe('vendorPlugin');
    });

    // INV-6 / D-11 names the KEYSTROKE case verbatim: "section sizes change between
    // keystrokes". A test that settles the same query twice passes against an
    // implementation that resets to the top on every keystroke, so it proves nothing.
    // This one changes the query between the two settlements and places the tracked
    // candidate somewhere other than index 0, so `autoSelectFirst` cannot fake a pass.
    it('follows the user-selected candidate across the keystroke that resizes the sections', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (query === '@s' ? second.promise : first.promise));

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '@' as string | null } },
        );

        first.resolve([suggestion('file-a'), suggestion('file-b'), suggestion('plugin-spreadsheets')]);
        await flushHookEffects();

        // The user explicitly moves onto the plugin row.
        await act(async () => {
            hook.getCurrent()[3]();
            hook.getCurrent()[3]();
        });
        await flushHookEffects();
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('plugin-spreadsheets');

        // One more keystroke: the Files section shrinks and the chosen candidate moves.
        await hook.rerender({ query: '@s' });
        second.resolve([suggestion('file-s'), suggestion('plugin-spreadsheets')]);
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(1);
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('plugin-spreadsheets');
    });

    // The complement, and the reason the pin is a user action rather than "whatever
    // was selected": an auto-selection is not a choice. Typing must re-select the
    // best match, or "type to filter, Enter to take the top row" silently breaks.
    it('re-selects the best match across a keystroke when the user never moved the selection', async () => {
        const first = createDeferred<AutocompleteSuggestion[]>();
        const second = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((query: string) => (query === '@sp' ? second.promise : first.promise));

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '@s' as string | null } },
        );

        first.resolve([suggestion('file-sites'), suggestion('plugin-spreadsheets')]);
        await flushHookEffects();
        expect(hook.getCurrent()[1]).toBe(0);

        await hook.rerender({ query: '@sp' });
        second.resolve([suggestion('plugin-spreadsheets'), suggestion('file-sites')]);
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(0);
        expect(hook.getCurrent()[0][hook.getCurrent()[1]]?.key).toBe('plugin-spreadsheets');
    });

    it('falls back to the nearest position when the selected candidate disappears', async () => {
        const firstResult = createDeferred<AutocompleteSuggestion[]>();
        const secondResult = createDeferred<AutocompleteSuggestion[]>();
        const firstHandler = vi.fn(() => firstResult.promise);
        const secondHandler = vi.fn(() => secondResult.promise);

        const hook = await renderHook(
            ({ handler }: { handler: ActiveSuggestionsHandler }) => (
                useActiveSuggestions('@re', handler)
            ),
            { initialProps: { handler: firstHandler as ActiveSuggestionsHandler } },
        );

        firstResult.resolve([suggestion('a'), suggestion('b'), suggestion('c')]);
        await flushHookEffects();
        await act(async () => {
            hook.getCurrent()[3]();
            hook.getCurrent()[3]();
        });
        await flushHookEffects();
        expect(hook.getCurrent()[1]).toBe(2);

        await hook.rerender({ handler: secondHandler as ActiveSuggestionsHandler });
        secondResult.resolve([suggestion('x'), suggestion('y')]);
        await flushHookEffects();

        expect(hook.getCurrent()[1]).toBe(1);
    });
});
