import { Extension, Node, type AnyExtension, type NodeViewRenderer } from '@tiptap/core';
import { history, undo, redo } from '@tiptap/pm/history';
import { keymap } from '@tiptap/pm/keymap';
import { baseKeymap } from '@tiptap/pm/commands';
import type { Command } from '@tiptap/pm/state';

/** No rich text, parsing rules, input rules or paste rules can create references. */
export function createComposerEditorExtensions(nodeView?: NodeViewRenderer): AnyExtension[] {
    return [
        Node.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
        Node.create({ name: 'paragraph', group: 'block', content: 'inline*', renderHTML: () => ['p', 0] }),
        Node.create({ name: 'text', group: 'inline' }),
        Node.create({ name: 'hardBreak', group: 'inline', inline: true, selectable: false, renderHTML: () => ['br'] }),
        Node.create({
            name: 'composerReference', group: 'inline', inline: true, atom: true, selectable: true,
            addAttributes: () => ({ ref: { default: null } }),
            renderHTML: ({ HTMLAttributes }) => ['span', { 'data-composer-reference': HTMLAttributes.ref }],
            ...(nodeView ? { addNodeView: () => nodeView } : {}),
        }),
        Extension.create({
            name: 'composerEditing',
            addProseMirrorPlugins() {
                // A line break is the only block split this plain-text document has. Shift+Enter needs its
                // own binding: unhandled, the browser inserts a <br> the schema cannot parse, so nothing appears.
                const insertLineBreak: Command = (state, dispatch) => {
                    dispatch?.(state.tr.replaceSelectionWith(state.schema.nodes.hardBreak.create()).scrollIntoView());
                    return true;
                };
                return [history(), keymap({
                    'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
                    Enter: insertLineBreak,
                    'Shift-Enter': insertLineBreak,
                }), keymap(baseKeymap)];
            },
        }),
    ];
}
