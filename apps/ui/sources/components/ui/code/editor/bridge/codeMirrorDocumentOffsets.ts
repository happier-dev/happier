import type { Text } from '@codemirror/state';

/** CodeMirror counts each normalized line break once; public offsets count the original separator. */
export function codeMirrorDocumentOffset(doc: Text, offset: number, separator: string): number {
    return offset + (doc.lineAt(offset).number - 1) * (separator.length - 1);
}

export function codeMirrorEditorOffset(doc: Text, offset: number, separator: string): number {
    if (separator.length === 1) return offset;
    let first = 1, last = doc.lines;
    while (first < last) {
        const middle = Math.ceil((first + last) / 2);
        const start = doc.line(middle).from + (middle - 1) * (separator.length - 1);
        if (start <= offset) first = middle;
        else last = middle - 1;
    }
    return offset - (first - 1) * (separator.length - 1);
}
