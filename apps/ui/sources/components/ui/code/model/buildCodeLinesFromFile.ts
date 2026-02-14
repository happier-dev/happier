import type { CodeLine } from './codeLineTypes';

export function buildCodeLinesFromFile(params: { text: string }): CodeLine[] {
    const rawLines = params.text.replace(/\r\n/g, '\n').split('\n');
    // Drop trailing empty line from final newline.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

    return rawLines.map((line, index) => ({
        id: `f:${index + 1}`,
        sourceIndex: index,
        kind: 'file',
        oldLine: null,
        newLine: index + 1,
        renderPrefixText: '',
        renderCodeText: line,
        renderIsHeaderLine: false,
        selectable: true,
    }));
}
