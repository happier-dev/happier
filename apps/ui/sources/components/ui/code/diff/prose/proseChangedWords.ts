import { diffWords } from 'diff';

export type ProseChangedRun = Readonly<{ text: string; changed: boolean }>;

/**
 * One version read against its base (an update review's author or recipient side): only the lines this side
 * changed, each a run of words with the words it changed marked. Words only the base has are left out, unchanged
 * lines and blank lines drop, so a reader sees the edit itself rather than the whole section.
 */
export function buildProseChangedLines(base: string, side: string): readonly (readonly ProseChangedRun[])[] {
    const lines: ProseChangedRun[][] = [[]];
    for (const part of diffWords(base, side)) {
        if (part.removed) continue;
        part.value.split('\n').forEach((piece, index) => {
            if (index > 0) lines.push([]);
            if (piece.length > 0) lines.at(-1)!.push({ text: piece, changed: part.added === true });
        });
    }
    return lines
        .filter(line => line.some(run => run.changed && run.text.trim().length > 0))
        // A line keeps its words, not the indentation or trailing space a split leaves behind.
        .map(line => line.map((run, index) => {
            let text = index === 0 ? run.text.trimStart() : run.text;
            if (index === line.length - 1) text = text.trimEnd();
            return { ...run, text };
        }).filter(run => run.text.length > 0));
}
