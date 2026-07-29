import { describe, expect, it, vi } from 'vitest';

vi.mock('../normalizeSoftBreaks', () => ({
    normalizeSoftBreaks: vi.fn((editor: any) => {
        editor.state.doc.content.size = editor.nextDocSize;
    }),
}));

import { seedMarkdown } from '../seedMarkdown';

function createEditorFixture() {
    const scrollElement = { scrollTop: 84, scrollLeft: 9 };
    const editor: any = {
        nextDocSize: 20,
        state: {
            selection: { from: 7, to: 7 },
            doc: { content: { size: 12 } },
        },
        view: {
            dom: { parentElement: scrollElement },
        },
        commands: {
            setContent: vi.fn(),
            setTextSelection: vi.fn(),
        },
    };
    return { editor, scrollElement };
}

describe('seedMarkdown', () => {
    it('preserves selection and scroll when requested', () => {
        const { editor, scrollElement } = createEditorFixture();

        seedMarkdown(editor, 'external update', { preserveViewState: true });

        expect(editor.commands.setTextSelection).toHaveBeenCalledWith({ from: 7, to: 7 });
        expect(scrollElement.scrollTop).toBe(84);
        expect(scrollElement.scrollLeft).toBe(9);
    });

    it('clamps restored selection to the new document size', () => {
        const { editor } = createEditorFixture();
        editor.state.selection = { from: 1000, to: 1005 };
        editor.nextDocSize = 3;

        seedMarkdown(editor, 'short', { preserveViewState: true });

        expect(editor.commands.setTextSelection).toHaveBeenCalledWith({ from: 3, to: 3 });
    });
});
