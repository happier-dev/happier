import { describe, expect, it } from 'vitest';

import type {
    MarkdownEditorCommand,
    MarkdownEditorHandle,
    MarkdownEditorProps,
    MarkdownSelectionState,
} from './markdownEditorTypes';
import type { CodeEditorHandle } from '../../code/editor/codeEditorTypes';

describe('markdownEditorTypes', () => {
    it('keeps MarkdownEditorHandle structurally compatible with CodeEditorHandle', () => {
        // If the handle shapes ever diverge this assignment stops compiling, which
        // would break the reuse of useSessionFileEditorState (it expects the code
        // editor handle shape).
        const handle: MarkdownEditorHandle = {
            getValue: () => 'doc',
            flushPendingChange: async () => {},
        };
        const asCodeHandle: CodeEditorHandle = handle;
        const backToMarkdown: MarkdownEditorHandle = asCodeHandle;

        expect(backToMarkdown.getValue()).toBe('doc');
    });

    it('allows the onUnavailable prop to carry the latest markdown', () => {
        let received: string | null = null;
        const props: MarkdownEditorProps = {
            resetKey: 'r1',
            value: 'hello',
            onChange: () => {},
            onUnavailable: (latest) => {
                received = latest;
            },
        };

        props.onUnavailable?.('fresh markdown');
        expect(received).toBe('fresh markdown');
    });

    it('models the Phase-1 command union including the heading level', () => {
        const heading: MarkdownEditorCommand = { kind: 'setHeading', level: 3 };
        const bold: MarkdownEditorCommand = { kind: 'toggleBold' };
        const unlink: MarkdownEditorCommand = { kind: 'unlink' };

        expect(heading).toEqual({ kind: 'setHeading', level: 3 });
        expect(bold.kind).toBe('toggleBold');
        expect(unlink.kind).toBe('unlink');
    });

    it('models selection state with link metadata for the toolbar', () => {
        const state: MarkdownSelectionState = {
            marks: { bold: true, italic: false, strike: false, code: false },
            blockType: 'heading2',
            isLinkActive: true,
            linkHref: 'https://example.com',
            canUndo: true,
            canRedo: false,
        };

        expect(state.isLinkActive).toBe(true);
        expect(state.linkHref).toBe('https://example.com');
        expect(state.marks.bold).toBe(true);
    });
});
