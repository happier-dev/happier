/**
 * Phase-1 command registry: maps a `MarkdownEditorCommand` (the platform-agnostic
 * union from `markdownEditorTypes`) onto operations against a live TipTap
 * `Editor`, plus `readSelectionState` which projects the editor state down to the
 * `MarkdownSelectionState` the RN chrome consumes.
 *
 * Both the web surface (direct calls) and the headless WebView bundle entry use
 * these so command behavior is identical on every platform.
 *
 * R18: imports `@tiptap/*` and therefore lives in `core/tiptap/` only.
 */

import type { Editor } from '@tiptap/core';

import type {
    MarkdownBlockType,
    MarkdownEditorCommand,
    MarkdownSelectionState,
} from '../../markdownEditorTypes';
import { isMutatingMarkdownEditorCommand } from '../../markdownEditorTypes';
import { MARKDOWN_EDITOR_HEADING_LEVELS } from './createMarkdownEditorExtensions';

/**
 * Opens a resolved link href. Injected so the registry stays platform-agnostic:
 * the web surface passes `window.open`-backed opener; the native bundle passes a
 * bridge-message opener (so the RN host can use `Linking`).
 */
export type MarkdownLinkOpener = (href: string) => void;

/**
 * Options for running a command. `openLink` needs an opener; everything else is
 * a pure editor mutation.
 */
export type RunMarkdownEditorCommandOptions = Readonly<{
    /** Opener used by the `openLink` command. Defaults to `window.open` on web. */
    openLink?: MarkdownLinkOpener;
}>;

/** Default opener: best-effort `window.open` when a DOM is available. */
function defaultOpenLink(href: string): void {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(href, '_blank', 'noopener,noreferrer');
    }
}

/**
 * Reads the active link href for the current selection, or `undefined` when no
 * link is active.
 */
export function readActiveLinkHref(editor: Editor): string | undefined {
    const attrs = editor.getAttributes('link');
    const href = attrs?.href;
    return typeof href === 'string' && href.length > 0 ? href : undefined;
}

/**
 * Runs a Phase-1 formatting command against the editor's current selection.
 *
 * Mutating commands are chained + focused so the editor keeps focus after a
 * toolbar tap. `openLink` is read-only (resolves the href + delegates to the
 * opener); `unlink` removes the link mark across the full link range.
 */
export function runMarkdownEditorCommand(
    editor: Editor,
    command: MarkdownEditorCommand,
    options?: RunMarkdownEditorCommandOptions,
): void {
    if (isMutatingMarkdownEditorCommand(command) && editor.isEditable === false) {
        return;
    }

    const chain = () => editor.chain().focus();

    switch (command.kind) {
        case 'toggleBold':
            chain().toggleBold().run();
            return;
        case 'toggleItalic':
            chain().toggleItalic().run();
            return;
        case 'toggleStrike':
            chain().toggleStrike().run();
            return;
        case 'toggleCode':
            chain().toggleCode().run();
            return;
        case 'setHeading': {
            const level = command.level;
            // Toggling the same level returns to a paragraph (matches toolbar UX).
            if (editor.isActive('heading', { level })) {
                chain().setParagraph().run();
                return;
            }
            chain().setHeading({ level }).run();
            return;
        }
        case 'toggleBulletList':
            chain().toggleBulletList().run();
            return;
        case 'toggleOrderedList':
            chain().toggleOrderedList().run();
            return;
        case 'toggleTaskList':
            chain().toggleTaskList().run();
            return;
        case 'toggleBlockquote':
            chain().toggleBlockquote().run();
            return;
        case 'toggleCodeBlock':
            chain().toggleCodeBlock().run();
            return;
        case 'setHorizontalRule':
            chain().setHorizontalRule().run();
            return;
        case 'setLink':
            // Extend across the whole link first so editing from a collapsed caret
            // inside a link updates the active link mark, not just future text (D27).
            chain().extendMarkRange('link').setLink({ href: command.href }).run();
            return;
        case 'unlink':
            // Extend across the whole link first so unlink removes the entire mark
            // even when the caret is collapsed inside it.
            chain().extendMarkRange('link').unsetLink().run();
            return;
        case 'openLink': {
            const href = readActiveLinkHref(editor);
            if (href) {
                (options?.openLink ?? defaultOpenLink)(href);
            }
            return;
        }
        default: {
            // Exhaustiveness guard: a new command kind must be handled above.
            const exhaustive: never = command;
            void exhaustive;
            return;
        }
    }
}

/** Resolves the block type the current selection sits in. */
function readBlockType(editor: Editor): MarkdownBlockType {
    for (const level of MARKDOWN_EDITOR_HEADING_LEVELS) {
        if (editor.isActive('heading', { level })) {
            return (`heading${level}` as MarkdownBlockType);
        }
    }
    if (editor.isActive('taskList')) {
        return 'taskList';
    }
    if (editor.isActive('bulletList')) {
        return 'bulletList';
    }
    if (editor.isActive('orderedList')) {
        return 'orderedList';
    }
    if (editor.isActive('blockquote')) {
        return 'blockquote';
    }
    if (editor.isActive('codeBlock')) {
        return 'codeBlock';
    }
    return 'paragraph';
}

/**
 * Projects the editor state to the selection snapshot consumed by the RN chrome
 * (active marks, block type, link state for open/unlink, and undo/redo
 * availability).
 */
export function readSelectionState(editor: Editor): MarkdownSelectionState {
    const isLinkActive = editor.isActive('link');
    const linkHref = isLinkActive ? readActiveLinkHref(editor) : undefined;

    return {
        marks: {
            bold: editor.isActive('bold'),
            italic: editor.isActive('italic'),
            strike: editor.isActive('strike'),
            code: editor.isActive('code'),
        },
        blockType: readBlockType(editor),
        isLinkActive,
        linkHref,
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
    };
}
