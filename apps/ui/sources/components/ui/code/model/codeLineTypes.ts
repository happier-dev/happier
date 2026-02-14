export type CodeLineKind = 'header' | 'context' | 'add' | 'remove' | 'file';

export type CodeLine = Readonly<{
    id: string;
    // Index in the original source list used to build these lines.
    // For unified diffs: index into `diff.split('\\n')`.
    // For file views: 0-based file line index.
    sourceIndex: number;
    kind: CodeLineKind;
    oldLine: number | null;
    newLine: number | null;
    renderPrefixText: string;
    renderCodeText: string;
    renderIsHeaderLine: boolean;
    selectable: boolean;
}>;
