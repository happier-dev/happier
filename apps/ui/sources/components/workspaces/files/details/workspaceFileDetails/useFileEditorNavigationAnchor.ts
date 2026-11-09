import * as React from 'react';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { resolveCodeLineAnchor } from '@/components/ui/code/reviewComments/resolveCodeLineAnchor';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

/** File-page navigation uses the incumbent engine, leaving its buffer and undo history intact. */
export function useFileEditorNavigationAnchor(input: Readonly<{
    filePath: string;
    anchorKey: string;
    anchor: ReviewCommentAnchor | null;
    source: ReviewCommentSource | null;
    active: boolean;
    editing: boolean;
    enteringEdit: boolean;
    editor: TextEditorHandle | null;
}>) {
    const consumedKey = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!input.active) return;
        if (!input.editing) {
            // View consumes its own navigation. Starting Edit later must keep the reader's newer position.
            if (!input.enteringEdit) consumedKey.current = input.anchorKey;
            return;
        }
        if (!input.editor?.revealLine || consumedKey.current === input.anchorKey) return;
        consumedKey.current = input.anchorKey;
        if (!input.anchor || input.source !== 'file') return;
        const resolved = resolveCodeLineAnchor({ filePath: input.filePath, source: 'file', anchor: input.anchor,
            lines: buildCodeLinesFromFile({ text: input.editor.getValue() }) });
        const line = resolved.lines[0]?.newLine;
        if (line !== null && line !== undefined) input.editor.revealLine(line, { focus: true });
    }, [input.active, input.anchorKey, input.editing, input.enteringEdit, input.editor, input.filePath]);
}
