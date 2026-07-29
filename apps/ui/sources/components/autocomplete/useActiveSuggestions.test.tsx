import { describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { AutocompleteSuggestion } from './autocompleteTypes';
import { useActiveSuggestions } from './useActiveSuggestions';

function suggestion(key: string): AutocompleteSuggestion {
    return {
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

        expect(handler).toHaveBeenLastCalledWith('/h');
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
            ({ handler }: { handler: (query: string) => Promise<AutocompleteSuggestion[]> }) => (
                useActiveSuggestions('/h', handler)
            ),
            { initialProps: { handler: oldHandler } },
        );

        await hook.rerender({ handler: newHandler });
        newHandlerResult.resolve([suggestion('help')]);
        await flushHookEffects();
        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);

        oldHandlerResult.resolve([suggestion('stale')]);
        await flushHookEffects();

        expect(hook.getCurrent()[0]).toEqual([suggestion('help')]);
    });
});
