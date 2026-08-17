import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
import { useAgentInputCommandMenu } from '../useAgentInputCommandMenu';

type HookArgs = Parameters<typeof useAgentInputCommandMenu>[0];

function buildDefaultArgs(overrides: Partial<HookArgs> = {}): HookArgs {
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
    it('opens only when suggestions and an active trigger are present', async () => {
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs() },
        );

        expect(getCurrent().commandMenuOpen).toBe(true);

        await rerender(buildDefaultArgs({ suggestions: [] }));
        expect(getCurrent().commandMenuOpen).toBe(false);

        await rerender(buildDefaultArgs({ activeWord: null }));
        expect(getCurrent().commandMenuOpen).toBe(false);
    });

    it('selects the current suggestion and falls back to the first item', async () => {
        const handleSuggestionSelect = vi.fn();
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ selected: 1, handleSuggestionSelect }) },
        );

        getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenCalledWith(1);

        await rerender(buildDefaultArgs({ selected: -1, handleSuggestionSelect }));
        getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenLastCalledWith(0);
    });

    it('does not fall back to the first row while a pinned candidate awaits a current partial update', async () => {
        const handleSuggestionSelect = vi.fn();
        const pendingSelectionArgs = buildDefaultArgs({
            selected: -1,
            selectionPending: true,
            handleSuggestionSelect,
        });
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: pendingSelectionArgs },
        );

        getCurrent().onSelectFromMenu();

        expect(handleSuggestionSelect).not.toHaveBeenCalled();
    });

    it('suppresses a dismissed trigger until the active trigger changes', async () => {
        const firstTrigger = buildDefaultArgs({
            activeWord: '/foo',
            activeWordRange: { start: 0, end: 4 },
            inputTextLength: 24,
        });
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: firstTrigger },
        );

        expect(getCurrent().commandMenuOpen).toBe(true);

        await act(async () => {
            getCurrent().onCloseMenu();
        });
        await rerender(firstTrigger);
        expect(getCurrent().commandMenuOpen).toBe(false);

        await rerender(buildDefaultArgs({
            activeWord: '/foo',
            activeWordRange: { start: 10, end: 14 },
            inputTextLength: 24,
        }));
        expect(getCurrent().commandMenuOpen).toBe(true);
    });
});
