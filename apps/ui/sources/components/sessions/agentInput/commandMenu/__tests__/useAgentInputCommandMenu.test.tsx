import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { useAgentInputCommandMenu } from '../useAgentInputCommandMenu';

type HookArgs = Parameters<typeof useAgentInputCommandMenu>[0];

function buildDefaultArgs(overrides?: Partial<HookArgs>): HookArgs {
    return {
        suggestions: [
            { kind: 'slashCommand', key: 'cmd-goal', text: '/goal', label: 'goal', description: 'Set a goal', rowHeight: 52 },
            { kind: 'slashCommand', key: 'cmd-help', text: '/help', label: 'help', description: 'Show help' },
        ],
        selected: 0,
        activeWord: '/g',
        activeWordRange: { start: 0, end: 2 },
        inputTextLength: 2,
        moveUp: vi.fn(),
        moveDown: vi.fn(),
        handleSuggestionSelect: vi.fn(),
        ...overrides,
    };
}

describe('useAgentInputCommandMenu', () => {
    it('returns commandMenuOpen=true when suggestions are present and there is an active word', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs() },
        );

        expect(getCurrent().commandMenuOpen).toBe(true);
    });

    it('returns commandMenuOpen=false when suggestions are empty', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ suggestions: [] }) },
        );

        expect(getCurrent().commandMenuOpen).toBe(false);
    });

    it('returns commandMenuOpen=false when activeWord is null', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ activeWord: null }) },
        );

        expect(getCurrent().commandMenuOpen).toBe(false);
    });

    it('builds CommandMenuItem array from suggestions', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs() },
        );

        expect(getCurrent().items).toHaveLength(2);
        expect(getCurrent().items[0]!.id).toBe('cmd-goal');
        expect(getCurrent().items[1]!.id).toBe('cmd-help');
    });

    it('returns the selected index as-is', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ selected: 1 }) },
        );

        expect(getCurrent().selectedIndex).toBe(1);
    });

    it('onSelectFromMenu calls handleSuggestionSelect with the current selected index', async () => {
        const handleSuggestionSelect = vi.fn();
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ selected: 1, handleSuggestionSelect }) },
        );

        getCurrent().onSelectFromMenu();

        expect(handleSuggestionSelect).toHaveBeenCalledWith(1);
    });

    it('onSelectFromMenu defaults to index 0 when selected is -1', async () => {
        const handleSuggestionSelect = vi.fn();
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ selected: -1, handleSuggestionSelect }) },
        );

        getCurrent().onSelectFromMenu();

        expect(handleSuggestionSelect).toHaveBeenCalledWith(0);
    });

    it('returns the active word as query', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ activeWord: '/goal' }) },
        );

        expect(getCurrent().query).toBe('/goal');
    });

    it('returns empty query when activeWord is null', async () => {
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ activeWord: null }) },
        );

        expect(getCurrent().query).toBe('');
    });

    describe('dismissed-trigger-key escape pattern (D46)', () => {
        it('suppresses the menu after onCloseMenu is called with an active trigger', async () => {
            const args = buildDefaultArgs();
            const { getCurrent, rerender } = await renderHook(
                (props: HookArgs) => useAgentInputCommandMenu(props),
                { initialProps: args },
            );

            expect(getCurrent().commandMenuOpen).toBe(true);

            await act(async () => {
                getCurrent().onCloseMenu();
            });

            // Re-render with same args to flush state
            await rerender(args);

            expect(getCurrent().commandMenuOpen).toBe(false);
        });

        it('clears the suppression when the active word changes', async () => {
            const args = buildDefaultArgs();
            const { getCurrent, rerender } = await renderHook(
                (props: HookArgs) => useAgentInputCommandMenu(props),
                { initialProps: args },
            );

            // Suppress the current trigger
            await act(async () => {
                getCurrent().onCloseMenu();
            });
            await rerender(args);
            expect(getCurrent().commandMenuOpen).toBe(false);

            // Change the active word to a different trigger
            await rerender(buildDefaultArgs({ activeWord: '/he', inputTextLength: 3 }));

            // Menu should reopen because the trigger key changed
            expect(getCurrent().commandMenuOpen).toBe(true);
        });

        it('remains suppressed when the active word stays the same after escape', async () => {
            const args = buildDefaultArgs();
            const { getCurrent, rerender } = await renderHook(
                (props: HookArgs) => useAgentInputCommandMenu(props),
                { initialProps: args },
            );

            await act(async () => {
                getCurrent().onCloseMenu();
            });
            await rerender(args);
            expect(getCurrent().commandMenuOpen).toBe(false);

            // Re-render with the same args
            await rerender(args);
            expect(getCurrent().commandMenuOpen).toBe(false);
        });

        it('reopens for an identical trigger at a different range in same-length text', async () => {
            const firstTriggerArgs = buildDefaultArgs({
                activeWord: '/foo',
                activeWordRange: { start: 0, end: 4 },
                inputTextLength: 24,
            });
            const { getCurrent, rerender } = await renderHook(
                (props: HookArgs) => useAgentInputCommandMenu(props),
                { initialProps: firstTriggerArgs },
            );

            await act(async () => {
                getCurrent().onCloseMenu();
            });
            await rerender(firstTriggerArgs);
            expect(getCurrent().commandMenuOpen).toBe(false);

            await rerender(buildDefaultArgs({
                activeWord: '/foo',
                activeWordRange: { start: 10, end: 14 },
                inputTextLength: 24,
            }));

            expect(getCurrent().commandMenuOpen).toBe(true);
        });
    });
});
