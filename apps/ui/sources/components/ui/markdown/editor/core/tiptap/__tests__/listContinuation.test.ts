/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';

import { createMarkdownEditorExtensions } from '../createMarkdownEditorExtensions';
import {
    collapseEmptyListContinuationParagraph,
    commitEmptyOrderedListMarkerAsText,
    convertEmptyNestedOrderedItemToContinuation,
    isSingleEmptyTopLevelOrderedList,
} from '../listContinuation';

/**
 * Ported from Orca's `rich-markdown-list-continuation.test.ts` (and the
 * list-specific cases of `rich-markdown-key-handler.test.ts`). The behavior is
 * verified against a REAL headless `@tiptap/core` editor (no mocks) using JSON
 * doc seeds so the input shape is independent of any markdown parser quirks.
 */

function createEditor(content: object): Editor {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return new Editor({
        element,
        extensions: createMarkdownEditorExtensions(),
        content,
    });
}

function emptyTopLevelOrderedListDoc(): object {
    return {
        type: 'doc',
        content: [
            {
                type: 'orderedList',
                attrs: { start: 1, type: null },
                content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
            },
        ],
    };
}

describe('listContinuation', () => {
    it('preserves a typed empty ordered-list marker when commit fires', () => {
        const editor = createEditor(emptyTopLevelOrderedListDoc());

        try {
            editor.commands.setTextSelection(3);

            expect(isSingleEmptyTopLevelOrderedList(editor)).toBe(true);
            expect(commitEmptyOrderedListMarkerAsText(editor)).toBe(true);
            expect(editor.state.doc.toJSON()).toEqual({
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [{ type: 'text', text: '1.' }] },
                    { type: 'paragraph' },
                    // Trailing block our schema appends to keep a cursor-target
                    // after replacing the only top-level node (orderedList ->
                    // two paragraphs). Not present in Orca because their schema
                    // doesn't require it; behaviorally inert.
                    { type: 'paragraph' },
                ],
            });
        } finally {
            editor.destroy();
        }
    });

    it('converts an empty nested ordered item into a parent-list continuation paragraph', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'orderedList',
                    attrs: { start: 1, type: null },
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [{ type: 'text', text: 'Leverage an existing CLI/project' }],
                                },
                                {
                                    type: 'orderedList',
                                    attrs: { start: 1, type: null },
                                    content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
                                },
                            ],
                        },
                        {
                            type: 'listItem',
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [{ type: 'text', text: 'Implement CLI' }],
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        try {
            editor.commands.setTextSelection(39);

            expect(convertEmptyNestedOrderedItemToContinuation(editor)).toBe(true);
            expect(editor.state.doc.toJSON()).toEqual({
                type: 'doc',
                content: [
                    {
                        type: 'orderedList',
                        attrs: { start: 1, type: null },
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'Leverage an existing CLI/project' }],
                                    },
                                    { type: 'paragraph' },
                                ],
                            },
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'Implement CLI' }],
                                    },
                                ],
                            },
                        ],
                    },
                    // Trailing cursor-target our schema appends after a top-level
                    // orderedList. Behaviorally inert; absent in Orca's schema.
                    { type: 'paragraph' },
                ],
            });
        } finally {
            editor.destroy();
        }
    });

    it('leaves non-empty ordered list items to the default Enter behavior', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'orderedList',
                    attrs: { start: 1, type: null },
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
                            ],
                        },
                    ],
                },
            ],
        });

        try {
            editor.commands.setTextSelection(8);

            expect(isSingleEmptyTopLevelOrderedList(editor)).toBe(false);
            expect(commitEmptyOrderedListMarkerAsText(editor)).toBe(false);
        } finally {
            editor.destroy();
        }
    });

    it('collapses an empty continuation paragraph back to the parent list item text', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'orderedList',
                    attrs: { start: 1, type: null },
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'fsdfsf' }] },
                                { type: 'paragraph' },
                            ],
                        },
                    ],
                },
            ],
        });

        try {
            editor.commands.setTextSelection(11);

            expect(collapseEmptyListContinuationParagraph(editor)).toBe(true);
            expect(editor.state.doc.toJSON()).toEqual({
                type: 'doc',
                content: [
                    {
                        type: 'orderedList',
                        attrs: { start: 1, type: null },
                        content: [
                            {
                                type: 'listItem',
                                content: [
                                    {
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: 'fsdfsf' }],
                                    },
                                ],
                            },
                        ],
                    },
                    // Trailing cursor-target our schema appends after a top-level
                    // orderedList. Behaviorally inert; absent in Orca's schema.
                    { type: 'paragraph' },
                ],
            });
            expect(editor.state.selection.from).toBe(9);
        } finally {
            editor.destroy();
        }
    });

    it('leaves non-empty nested ordered items to the default Backspace behavior', () => {
        const editor = createEditor({
            type: 'doc',
            content: [
                {
                    type: 'orderedList',
                    attrs: { start: 1, type: null },
                    content: [
                        {
                            type: 'listItem',
                            content: [
                                { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
                                {
                                    type: 'orderedList',
                                    attrs: { start: 1, type: null },
                                    content: [
                                        {
                                            type: 'listItem',
                                            content: [
                                                {
                                                    type: 'paragraph',
                                                    content: [{ type: 'text', text: 'Child' }],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        try {
            editor.commands.setTextSelection(13);

            expect(convertEmptyNestedOrderedItemToContinuation(editor)).toBe(false);
        } finally {
            editor.destroy();
        }
    });
});
