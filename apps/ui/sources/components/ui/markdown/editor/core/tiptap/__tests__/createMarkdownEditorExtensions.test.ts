import { describe, expect, it, vi } from 'vitest';
import { getSchema, type AnyExtension } from '@tiptap/core';

import {
    MARKDOWN_EDITOR_HEADING_LEVELS,
    createMarkdownEditorExtensions,
} from '../createMarkdownEditorExtensions';

/**
 * F3 / Lane F: the Phase-1 extension set must expose exactly the nodes/marks the
 * formatting scope (R-A9) admits, configure Link for preserve/autolink/paste
 * without an insert dialog (R-A13), and exclude everything deferred to Phase 2.
 *
 * We resolve the full ProseMirror schema via `getSchema(extensions)` (DOM-free)
 * so the assertions reflect what StarterKit actually expands into, not just the
 * top-level list.
 */

function extensionByName(extensions: readonly AnyExtension[], name: string): AnyExtension | undefined {
    return extensions.find((ext) => ext.name === name);
}

describe('createMarkdownEditorExtensions', () => {
    it('offers only H1-H3 heading levels', () => {
        expect(MARKDOWN_EDITOR_HEADING_LEVELS).toEqual([1, 2, 3]);
    });

    it('resolves a schema containing the Phase-1 block nodes', () => {
        const schema = getSchema(createMarkdownEditorExtensions());
        const nodeNames = Object.keys(schema.nodes);

        for (const node of [
            'doc',
            'paragraph',
            'text',
            'heading',
            'bulletList',
            'orderedList',
            'listItem',
            'taskList',
            'taskItem',
            'blockquote',
            'codeBlock',
            'horizontalRule',
        ]) {
            expect(nodeNames).toContain(node);
        }
    });

    it('resolves a schema containing the Phase-1 marks (bold/italic/strike/code/link)', () => {
        const schema = getSchema(createMarkdownEditorExtensions());
        const markNames = Object.keys(schema.marks);

        for (const mark of ['bold', 'italic', 'strike', 'code', 'link']) {
            expect(markNames).toContain(mark);
        }
    });

    it('excludes the underline mark (no plain-markdown syntax, would not round-trip)', () => {
        const schema = getSchema(createMarkdownEditorExtensions());
        expect(Object.keys(schema.marks)).not.toContain('underline');
    });

    it('excludes Phase-2 nodes (tables, math, image, placeholder)', () => {
        const schema = getSchema(createMarkdownEditorExtensions());
        const nodeNames = Object.keys(schema.nodes);

        for (const deferred of ['table', 'tableRow', 'tableCell', 'image', 'math', 'mathInline']) {
            expect(nodeNames).not.toContain(deferred);
        }
    });

    it('configures the StarterKit link for preserve/autolink/paste with no auto-open', () => {
        const extensions = createMarkdownEditorExtensions();
        const starterKit = extensionByName(extensions, 'starterKit');
        expect(starterKit).toBeDefined();

        const linkOptions = (starterKit?.options as { link?: Record<string, unknown> }).link;
        expect(linkOptions).toMatchObject({
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
        });
    });

    it('disables the StarterKit underline option explicitly', () => {
        const extensions = createMarkdownEditorExtensions();
        const starterKit = extensionByName(extensions, 'starterKit');
        const underlineOption = (starterKit?.options as { underline?: unknown }).underline;
        expect(underlineOption).toBe(false);
    });

    it('includes the markdown extension so the editor can parse/serialize markdown', () => {
        const extensions = createMarkdownEditorExtensions();
        expect(extensionByName(extensions, 'markdown')).toBeDefined();
    });

    it('includes the Phase-1.5 raw-HTML atom nodes', () => {
        const schema = getSchema(createMarkdownEditorExtensions());
        const nodeNames = Object.keys(schema.nodes);
        expect(nodeNames).toContain('rawMarkdownHtmlInline');
        expect(nodeNames).toContain('rawMarkdownHtmlBlock');
    });

    it('registers the raw-HTML nodes BEFORE the markdown extension', () => {
        const extensions = createMarkdownEditorExtensions();
        const names = extensions.map((ext) => ext.name);
        const markdownIndex = names.indexOf('markdown');
        expect(markdownIndex).toBeGreaterThanOrEqual(0);
        expect(names.indexOf('rawMarkdownHtmlInline')).toBeLessThan(markdownIndex);
        expect(names.indexOf('rawMarkdownHtmlBlock')).toBeLessThan(markdownIndex);
    });

    it('includes the task list + nested task item extensions', () => {
        const extensions = createMarkdownEditorExtensions();
        expect(extensionByName(extensions, 'taskList')).toBeDefined();

        const taskItem = extensionByName(extensions, 'taskItem');
        expect(taskItem).toBeDefined();
        expect((taskItem?.options as { nested?: boolean }).nested).toBe(true);
    });

    it('registers the slash-menu trigger extension after the core editing extensions', () => {
        const extensions = createMarkdownEditorExtensions();
        const names = extensions.map((ext) => ext.name);

        expect(names).toContain('menuTrigger');
        expect(names.indexOf('menuTrigger')).toBeGreaterThan(names.indexOf('listContinuation'));
    });

    it('passes the onMenuTriggerChange callback to the menuTrigger extension', () => {
        const callback = vi.fn();
        const extensions = createMarkdownEditorExtensions({ onMenuTriggerChange: callback });
        const menuTrigger = extensionByName(extensions, 'menuTrigger');

        expect(menuTrigger).toBeDefined();
        expect((menuTrigger?.options as { onMenuTriggerChange?: unknown }).onMenuTriggerChange).toBe(callback);
    });

    it('passes the onMenuTriggerKeyDown callback to the menuTrigger extension', () => {
        const callback = vi.fn(() => true);
        const extensions = createMarkdownEditorExtensions({ onMenuTriggerKeyDown: callback });
        const menuTrigger = extensionByName(extensions, 'menuTrigger');

        expect(menuTrigger).toBeDefined();
        expect((menuTrigger?.options as { onMenuTriggerKeyDown?: unknown }).onMenuTriggerKeyDown).toBe(callback);
    });
});
