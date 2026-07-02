import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { MarkdownEditorController, EditorViewportWindowRect } from '../../markdownEditorTypes';
import type { MenuTriggerKeyDownEvent, MenuTriggerState } from '../../core/tiptap/menuTriggerExtensionTypes';
import type { MarkdownSlashTranslate } from '../buildMarkdownSlashCommands';
import { useMarkdownSlashMenu } from '../useMarkdownSlashMenu';
import { renderHook } from '@/dev/testkit';

/**
 * Minimal mock controller that exposes subscribeMenuTrigger, runMenuCommand, and
 * subscribeEditorViewportLayout as vi.fn() spies, and a helper to fire the
 * callback.
 */
function createMockController(): MarkdownEditorController & {
    fireTrigger: (state: MenuTriggerState | null) => void;
    fireKeyDown: (event: MenuTriggerKeyDownEvent) => boolean;
    fireViewportLayout: (rect: EditorViewportWindowRect | null) => void;
} {
    let triggerCb: ((state: MenuTriggerState | null) => void) | null = null;
    let keyCb: ((event: MenuTriggerKeyDownEvent) => boolean) | null = null;
    let viewportCb: ((rect: EditorViewportWindowRect | null) => void) | null = null;

    return {
        runCommand: vi.fn(),
        subscribeSelection: vi.fn(() => () => {}),
        subscribeMenuTrigger: vi.fn((cb) => {
            triggerCb = cb;
            return () => {
                triggerCb = null;
            };
        }),
        runMenuCommand: vi.fn(),
        subscribeMenuKeyDown: vi.fn((cb) => {
            keyCb = cb;
            return () => {
                keyCb = null;
            };
        }),
        subscribeEditorViewportLayout: vi.fn((cb) => {
            viewportCb = cb;
            return () => {
                viewportCb = null;
            };
        }),
        measureEditorViewportInWindow: vi.fn(() => Promise.resolve(null)),
        fireTrigger: (state) => triggerCb?.(state),
        fireKeyDown: (event) => keyCb?.(event) ?? false,
        fireViewportLayout: (rect) => viewportCb?.(rect),
    };
}

function makeTriggerState(overrides?: Partial<MenuTriggerState>): MenuTriggerState {
    return {
        kind: 'slash',
        query: '',
        from: 0,
        to: 1,
        caretRect: { left: 10, top: 20, height: 16 },
        ...overrides,
    };
}

// Since useMarkdownSlashMenu is a React hook, we test it via renderHook.
// However, due to the heavy test infra setup needed for React hooks with these
// mocks, we test the behavior via a functional approach: import the hook and
// call it within a test render context.
//
// For the initial TDD RED phase, we test the core logic:
// - Subscribes to menu trigger
// - Filters items by query
// - Returns correct props shape

describe('useMarkdownSlashMenu', () => {
    it('module exports useMarkdownSlashMenu', async () => {
        const mod = await import('../useMarkdownSlashMenu');
        expect(mod.useMarkdownSlashMenu).toBeDefined();
        expect(typeof mod.useMarkdownSlashMenu).toBe('function');
    });

    // The remaining tests verify the functional behavior of the hook by testing
    // the underlying logic. Since this is a hook that subscribes to a controller
    // and manages state, thorough testing requires either:
    // 1. A renderHook with the full provider stack, or
    // 2. Testing the logic functions it delegates to (which are already tested
    //    in the other test files).
    //
    // We verify:
    // - The hook is callable
    // - It accepts a MarkdownEditorController
    // - The underlying functions (buildMarkdownSlashCommands, filterCommandMenuItemsBySubstring,
    //   resolveMarkdownSlashCommand) are correctly composed
    //
    // Integration-level tests (hook + subscription lifecycle) are validated in
    // RichMarkdownEditorPanel integration tests and Lane I e2e.

    it('buildMarkdownSlashCommands produces filterable items', async () => {
        const { buildMarkdownSlashCommands } = await import('../buildMarkdownSlashCommands');
        const { filterCommandMenuItemsBySubstring } = await import(
            '@/components/ui/commandMenu/filterCommandMenuItemsBySubstring'
        );

        const stubT: MarkdownSlashTranslate = (key) => key;
        const items = buildMarkdownSlashCommands(stubT);

        // Filter for heading produces heading items
        const headingItems = filterCommandMenuItemsBySubstring(items, 'heading');
        expect(headingItems.length).toBe(3);
        expect(headingItems.every((i) => i.id.startsWith('heading'))).toBe(true);

        // Filter for h1 alias produces heading1 via alias
        const h1Items = filterCommandMenuItemsBySubstring(items, 'h1');
        expect(h1Items.length).toBe(1);
        expect(h1Items[0].id).toBe('heading1');
    });

    it('resolveMarkdownSlashCommand integrates with buildMarkdownSlashCommands', async () => {
        const { buildMarkdownSlashCommands } = await import('../buildMarkdownSlashCommands');
        const { resolveMarkdownSlashCommand } = await import('../resolveMarkdownSlashCommand');

        const stubT: MarkdownSlashTranslate = (key) => key;
        const items = buildMarkdownSlashCommands(stubT);

        // Every registry item should resolve to a valid command
        for (const item of items) {
            const command = resolveMarkdownSlashCommand(item.id);
            expect(command).not.toBeNull();
            expect(command).toHaveProperty('kind');
        }
    });

    it('moves the highlighted slash command with ArrowDown and ArrowUp from editor key events', async () => {
        const controller = createMockController();
        const hook = await renderHook(() => useMarkdownSlashMenu(controller));

        await act(async () => {
            controller.fireTrigger(makeTriggerState({ query: 'heading', from: 1, to: 9 }));
        });
        expect(hook.getCurrent().selectedIndex).toBe(0);

        await act(async () => {
            expect(controller.fireKeyDown({
                key: 'ArrowDown',
                trigger: makeTriggerState({ query: 'heading', from: 1, to: 9 }),
            })).toBe(true);
        });
        expect(hook.getCurrent().selectedIndex).toBe(1);

        await act(async () => {
            expect(controller.fireKeyDown({
                key: 'ArrowUp',
                trigger: makeTriggerState({ query: 'heading', from: 1, to: 9 }),
            })).toBe(true);
        });
        expect(hook.getCurrent().selectedIndex).toBe(0);

        await hook.unmount();
    });

    it('commits the highlighted slash command on Enter and Tab editor key events', async () => {
        const controller = createMockController();
        const hook = await renderHook(() => useMarkdownSlashMenu(controller));

        await act(async () => {
            controller.fireTrigger(makeTriggerState({ query: 'heading', from: 1, to: 9 }));
        });
        await act(async () => {
            controller.fireKeyDown({
                key: 'ArrowDown',
                trigger: makeTriggerState({ query: 'heading', from: 1, to: 9 }),
            });
        });

        await act(async () => {
            expect(controller.fireKeyDown({
                key: 'Enter',
                trigger: makeTriggerState({ query: 'heading', from: 1, to: 9 }),
            })).toBe(true);
        });
        expect(controller.runMenuCommand).toHaveBeenLastCalledWith(
            { kind: 'setHeading', level: 2 },
            { from: 1, to: 9 },
        );

        await act(async () => {
            controller.fireTrigger(makeTriggerState({ query: 'h1', from: 3, to: 6 }));
        });
        await act(async () => {
            expect(controller.fireKeyDown({
                key: 'Tab',
                trigger: makeTriggerState({ query: 'h1', from: 3, to: 6 }),
            })).toBe(true);
        });
        expect(controller.runMenuCommand).toHaveBeenLastCalledWith(
            { kind: 'setHeading', level: 1 },
            { from: 3, to: 6 },
        );

        await hook.unmount();
    });

    it('dismisses the active trigger on Escape until the trigger changes', async () => {
        const controller = createMockController();
        const sameTrigger = makeTriggerState({ query: 'heading', from: 1, to: 9 });
        const hook = await renderHook(() => useMarkdownSlashMenu(controller));

        await act(async () => {
            controller.fireTrigger(sameTrigger);
        });
        expect(hook.getCurrent().open).toBe(true);

        await act(async () => {
            expect(controller.fireKeyDown({ key: 'Escape', trigger: sameTrigger })).toBe(true);
        });
        expect(hook.getCurrent().open).toBe(false);

        await act(async () => {
            controller.fireTrigger(sameTrigger);
        });
        expect(hook.getCurrent().open).toBe(false);

        await act(async () => {
            controller.fireTrigger(makeTriggerState({ query: 'h2', from: 1, to: 4 }));
        });
        expect(hook.getCurrent().open).toBe(true);

        await hook.unmount();
    });
});
