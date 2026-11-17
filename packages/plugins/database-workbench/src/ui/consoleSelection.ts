export type ConsoleSelection = Readonly<{ start: number; end: number }>;
export type SelectedStatement = Readonly<{ sql: string; range: ConsoleSelection }>;
/** Ranges are supplied by P1's dialect lexer. This function only applies editor selection. */
export function selectConsoleStatements(text: string, selection: ConsoleSelection, mode: 'read' | 'write', ranges: readonly ConsoleSelection[]): readonly SelectedStatement[] {
    if (selection.start !== selection.end && mode === 'read') return [{ sql: text.slice(selection.start, selection.end), range: selection }];
    const chosen = mode === 'write'
        ? selection.start === selection.end ? ranges : ranges.filter(range => range.end > selection.start && range.start < selection.end)
            .map(range => ({ start: Math.max(range.start, selection.start), end: Math.min(range.end, selection.end) }))
        : [ranges.find(range => selection.start >= range.start && selection.start <= range.end) ?? ranges.find(range => range.start > selection.start)].filter((range): range is ConsoleSelection => range !== undefined);
    return chosen.map(range => ({ sql: text.slice(range.start, range.end), range }));
}
