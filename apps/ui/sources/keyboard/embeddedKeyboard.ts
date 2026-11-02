import type { KeyboardShortcutHandlers } from './runtime';

/** The host commands an embedded renderer may forward before handling its own keys. */
export function selectEmbeddedKeyboardHandlers(handlers: KeyboardShortcutHandlers, surface: 'find' | 'editor' | 'browser' = 'find'): KeyboardShortcutHandlers {
    if (surface === 'browser') return Object.fromEntries(Object.entries(handlers).filter(([id]) => id.startsWith('browser.')));
    const find: KeyboardShortcutHandlers = {
        'find.open': handlers['find.open'],
        'find.next': handlers['find.next'],
        'find.previous': handlers['find.previous'],
    };
    return surface === 'editor' ? {
        ...find,
        'files.editor.save': handlers['files.editor.save'],
        'editor.selection.ask': handlers['editor.selection.ask'],
    } : find;
}
