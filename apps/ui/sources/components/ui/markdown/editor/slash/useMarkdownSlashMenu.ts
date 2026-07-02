import * as React from 'react';

import type { CommandMenuAnchor, CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { filterCommandMenuItemsBySubstring } from '@/components/ui/commandMenu/filterCommandMenuItemsBySubstring';
import { t } from '@/text';

import type {
    EditorViewportWindowRect,
    MarkdownEditorCommand,
    MarkdownEditorController,
} from '../markdownEditorTypes';
import type { MenuTriggerKeyDownEvent, MenuTriggerState } from '../core/tiptap/menuTriggerExtensionTypes';
import { buildMarkdownSlashCommands } from './buildMarkdownSlashCommands';
import { resolveMarkdownSlashCommand } from './resolveMarkdownSlashCommand';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarkdownSlashMenuState = Readonly<{
    /** Whether the slash menu should be rendered open. */
    open: boolean;
    /** Anchor for the CommandMenu (rect from caret or fallback). */
    anchor: CommandMenuAnchor;
    /** The current filter query (text after the `/`). */
    query: string;
    /** Pre-filtered items. */
    items: readonly CommandMenuItem[];
    /** Currently highlighted row index. */
    selectedIndex: number;
    /** Move highlight up. */
    onMoveUp: () => void;
    /** Move highlight down. */
    onMoveDown: () => void;
    /** Select the currently highlighted (or tapped) item. */
    onSelect: (item: CommandMenuItem, index: number) => void;
    /** Request the menu to close. */
    onRequestClose: () => void;
}>;

// ---------------------------------------------------------------------------
// Stable empty anchor (avoids re-rendering when closed)
// ---------------------------------------------------------------------------

const CLOSED_ANCHOR: CommandMenuAnchor = {
    kind: 'rect',
    rect: { left: 0, top: 0, height: 0 },
};

function menuTriggerDismissKey(trigger: MenuTriggerState): string {
    return `${trigger.from}:${trigger.to}:${trigger.query}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to the editor controller's slash-trigger state, builds a filtered
 * command list, and returns props ready to spread onto `<CommandMenu>`.
 *
 * On native, the caret rect from `MenuTriggerState.caretRect` is translated from
 * WebView viewport coordinates to screen coordinates by adding the editor
 * viewport's window offset (D20, D40). The hook subscribes to both the trigger
 * and the editor viewport layout so the menu tracks correctly during keyboard
 * animations / orientation changes.
 */
export function useMarkdownSlashMenu(
    controller: MarkdownEditorController | null,
): MarkdownSlashMenuState {
    // -----------------------------------------------------------------------
    // Menu trigger subscription
    // -----------------------------------------------------------------------

    const [trigger, setTrigger] = React.useState<MenuTriggerState | null>(null);
    const dismissedTriggerKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!controller?.subscribeMenuTrigger) {
            setTrigger(null);
            return;
        }
        const unsubscribe = controller.subscribeMenuTrigger((next) => {
            if (!next) {
                dismissedTriggerKeyRef.current = null;
                setTrigger(null);
                return;
            }

            const key = menuTriggerDismissKey(next);
            if (dismissedTriggerKeyRef.current === key) {
                setTrigger(null);
                return;
            }

            dismissedTriggerKeyRef.current = null;
            setTrigger(next);
        });
        return () => {
            unsubscribe();
            dismissedTriggerKeyRef.current = null;
            setTrigger(null);
        };
    }, [controller]);

    // -----------------------------------------------------------------------
    // Editor viewport layout subscription (D40)
    // -----------------------------------------------------------------------

    const [viewportRect, setViewportRect] = React.useState<EditorViewportWindowRect | null>(null);

    React.useEffect(() => {
        if (!controller?.subscribeEditorViewportLayout) {
            return;
        }
        const unsubscribe = controller.subscribeEditorViewportLayout(setViewportRect);
        return () => {
            unsubscribe();
        };
    }, [controller]);

    // Eagerly measure once on mount when no layout event has fired yet.
    React.useEffect(() => {
        if (viewportRect !== null) return;
        controller?.measureEditorViewportInWindow?.().then((rect) => {
            if (rect) setViewportRect(rect);
        });
    }, [controller, viewportRect]);

    // -----------------------------------------------------------------------
    // Build the registry (re-built when the language changes via `t`)
    // -----------------------------------------------------------------------

    const allItems = React.useMemo(() => buildMarkdownSlashCommands(t), []);

    // -----------------------------------------------------------------------
    // Filter items by the current query
    // -----------------------------------------------------------------------

    const query = trigger?.query ?? '';
    const filteredItems = React.useMemo(
        () => filterCommandMenuItemsBySubstring(allItems, query),
        [allItems, query],
    );
    const triggerRef = React.useRef<MenuTriggerState | null>(trigger);
    const filteredItemsRef = React.useRef<readonly CommandMenuItem[]>(filteredItems);
    triggerRef.current = trigger;
    filteredItemsRef.current = filteredItems;

    // -----------------------------------------------------------------------
    // Selection index
    // -----------------------------------------------------------------------

    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const selectedIndexRef = React.useRef(selectedIndex);
    selectedIndexRef.current = selectedIndex;

    // Reset selection when the filtered list changes.
    React.useEffect(() => {
        setSelectedIndex(0);
    }, [filteredItems]);

    const onMoveUp = React.useCallback(() => {
        if (filteredItems.length === 0) return;
        setSelectedIndex((prev) => (prev <= 0 ? filteredItems.length - 1 : prev - 1));
    }, [filteredItems.length]);

    const onMoveDown = React.useCallback(() => {
        if (filteredItems.length === 0) return;
        setSelectedIndex((prev) => (prev >= filteredItems.length - 1 ? 0 : prev + 1));
    }, [filteredItems.length]);

    // -----------------------------------------------------------------------
    // Select handler: resolve + dispatch command
    // -----------------------------------------------------------------------

    const commitItem = React.useCallback(
        (item: CommandMenuItem, activeTrigger: MenuTriggerState) => {
            if (!controller?.runMenuCommand) return;

            const command: MarkdownEditorCommand | null = resolveMarkdownSlashCommand(item.id);
            if (!command) return;

            dismissedTriggerKeyRef.current = menuTriggerDismissKey(activeTrigger);
            setTrigger(null);
            controller.runMenuCommand(command, { from: activeTrigger.from, to: activeTrigger.to });
        },
        [controller],
    );

    const onSelect = React.useCallback(
        (item: CommandMenuItem, _index: number) => {
            const activeTrigger = triggerRef.current;
            if (!activeTrigger) return;
            commitItem(item, activeTrigger);
        },
        [commitItem],
    );

    // -----------------------------------------------------------------------
    // Close handler
    // -----------------------------------------------------------------------

    const onRequestClose = React.useCallback(() => {
        if (trigger) {
            dismissedTriggerKeyRef.current = menuTriggerDismissKey(trigger);
        }
        setTrigger(null);
    }, [trigger]);

    const handleMenuKeyDown = React.useCallback((event: MenuTriggerKeyDownEvent): boolean => {
        const activeTrigger = triggerRef.current;
        if (!activeTrigger) return false;

        switch (event.key) {
            case 'ArrowDown': {
                onMoveDown();
                return true;
            }
            case 'ArrowUp': {
                onMoveUp();
                return true;
            }
            case 'Enter':
            case 'Tab': {
                const items = filteredItemsRef.current;
                const item = items[selectedIndexRef.current];
                if (!item) return false;
                commitItem(item, activeTrigger);
                return true;
            }
            case 'Escape': {
                dismissedTriggerKeyRef.current = menuTriggerDismissKey(event.trigger);
                setTrigger(null);
                return true;
            }
        }
    }, [commitItem, onMoveDown, onMoveUp]);

    React.useEffect(() => {
        if (!controller?.subscribeMenuKeyDown) {
            return;
        }
        return controller.subscribeMenuKeyDown(handleMenuKeyDown);
    }, [controller, handleMenuKeyDown]);

    // -----------------------------------------------------------------------
    // Anchor: translate caret rect with viewport offset (D20, D40)
    // -----------------------------------------------------------------------

    const anchor: CommandMenuAnchor = React.useMemo(() => {
        if (!trigger) return CLOSED_ANCHOR;

        const { caretRect } = trigger;
        const offsetLeft = viewportRect?.left ?? 0;
        const offsetTop = viewportRect?.top ?? 0;

        return {
            kind: 'rect',
            rect: {
                left: caretRect.left + offsetLeft,
                top: caretRect.top + offsetTop,
                height: caretRect.height,
            },
        };
    }, [trigger, viewportRect]);

    // -----------------------------------------------------------------------
    // Return
    // -----------------------------------------------------------------------

    const open = trigger !== null && filteredItems.length > 0;

    return {
        open,
        anchor,
        query,
        items: filteredItems,
        selectedIndex: open ? selectedIndex : -1,
        onMoveUp,
        onMoveDown,
        onSelect,
        onRequestClose,
    };
}
