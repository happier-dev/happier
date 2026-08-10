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

        expect(handler).toHaveBeenLastCalledWith('/h', expect.any(AbortSignal));
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
    it('aborts the outstanding query when a newer one supersedes it', async () => {
        const signals: AbortSignal[] = [];
        const pending = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((_query: string, signal: AbortSignal) => {
            signals.push(signal);
            return pending.promise;
        });

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );

        expect(signals).toHaveLength(1);
        expect(signals[0]!.aborted).toBe(false);

        await hook.rerender({ query: '/h' });

        expect(signals[0]!.aborted).toBe(true);
    });

    it('aborts the outstanding query on unmount', async () => {
        const signals: AbortSignal[] = [];
        const pending = createDeferred<AutocompleteSuggestion[]>();
        const handler = vi.fn((_query: string, signal: AbortSignal) => {
            signals.push(signal);
            return pending.promise;
        });

        const hook = await renderHook(
            ({ query }: { query: string | null }) => useActiveSuggestions(query, handler),
            { initialProps: { query: '/' } },
        );
        await hook.unmount();

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
