import * as React from 'react';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutDisposition, KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { ESCAPE_LAYER_PRIORITIES, getMaxEscapeKeyBlockerPriority, useEscapeLayer } from '@/keyboard/escape';
import { resolveInboxItemPageRoute } from '@/components/inbox/inboxItemFocus';
import type { InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { findInboxItemForFocus, moveInboxItem,
    readInboxItemSelectionKey as selectionKey } from '@/components/inbox/inboxItemNavigation';
import { selectInboxItemsForView, type InboxItem, type InboxItemView } from '@/components/inbox/inboxItems';

/** URL selection and explicit mail-key navigation; source owners keep every lifecycle. */
export function useInboxItemNavigation(options: Readonly<{
    items: readonly InboxItem[];
    view: InboxItemView;
    focus: InboxItemFocus | null;
    enabled: boolean;
    select: (focus: InboxItemFocus) => void;
    open: (route: string) => void;
    close: () => void;
    markOpened: (item: InboxItem) => Promise<void>;
}>): void {
    const current = React.useRef(options);
    current.current = options;
    const focusKey = selectionKey(options.focus);
    // Found once per Inbox change or selection change, not on every render.
    const selected = React.useMemo(() => findInboxItemForFocus(options.items, options.focus),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is identified by its key, not its object.
        [options.items, focusKey]);
    // Selection is a real read intent only in the two informational views. Answering remains at the request owner.
    React.useEffect(() => {
        if (options.enabled && selected && selected.view === options.view && selected.view !== 'needs_you' && !selected.read) void options.markOpened(selected);
    }, [options.enabled, options.markOpened, options.view, selected]);

    const navigate = React.useCallback((direction: -1 | 1): KeyboardShortcutDisposition => {
        const active = current.current;
        if (!active.enabled || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
        const items = selectInboxItemsForView(active.items, active.view);
        const focused = findInboxItemForFocus(items, active.focus);
        const next = moveInboxItem(items, focused?.key ?? null, direction);
        if (!next) return 'pass';
        active.select(next.focus);
        return 'handled';
    }, []);
    const open = React.useCallback((): KeyboardShortcutDisposition => {
        const active = current.current;
        if (!active.enabled || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
        const focused = findInboxItemForFocus(active.items.filter(item => item.view === active.view), active.focus);
        if (!focused) return 'pass';
        active.open(active.focus?.kind === 'session' ? resolveInboxItemPageRoute(active.focus) : focused.pageRoute);
        return 'handled';
    }, []);
    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => options.enabled ? {
        'inbox.item.next': () => navigate(1), 'inbox.item.previous': () => navigate(-1), 'inbox.item.open': open,
        'inbox.item.close': () => {
            const active = current.current;
            if (!active.focus || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
            active.close();
            return 'handled';
        },
    } : {}, [navigate, open, options.enabled]);
    useKeyboardShortcutHandlers(handlers);
    useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.pane, enabled: options.enabled && options.focus !== null,
        onEscape: () => { current.current.close(); } });
}
