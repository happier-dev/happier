import type { MarkdownEditorCommand } from '../markdownEditorTypes';

/**
 * Maps a slash-menu item id to the concrete `MarkdownEditorCommand` the editor
 * understands. Returns `null` for unknown ids.
 *
 * Item ids are UI-level identifiers (e.g. `'heading1'`); they must NOT be sent
 * over the bridge as-is. Always resolve through this function first (D8).
 *
 * `link` is intentionally absent — deferred per D50.
 */
export function resolveMarkdownSlashCommand(id: string): MarkdownEditorCommand | null {
    switch (id) {
        case 'heading1':
            return { kind: 'setHeading', level: 1 };
        case 'heading2':
            return { kind: 'setHeading', level: 2 };
        case 'heading3':
            return { kind: 'setHeading', level: 3 };
        case 'bulletList':
            return { kind: 'toggleBulletList' };
        case 'orderedList':
            return { kind: 'toggleOrderedList' };
        case 'taskList':
            return { kind: 'toggleTaskList' };
        case 'blockquote':
            return { kind: 'toggleBlockquote' };
        case 'codeBlock':
            return { kind: 'toggleCodeBlock' };
        case 'horizontalRule':
            return { kind: 'setHorizontalRule' };
        default:
            return null;
    }
}
