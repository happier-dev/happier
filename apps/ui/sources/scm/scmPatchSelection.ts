const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

type ParsedHunkLine = {
    index: number;
    text: string;
    kind: 'context' | 'add' | 'delete' | 'marker' | 'other';
    oldRef: number | null;
    newRef: number | null;
};

type ParsedHunk = {
    sectionHeading: string;
    lines: ParsedHunkLine[];
};

type EmittedHunkLine = {
    text: string;
    oldRef: number | null;
    newRef: number | null;
    carriesChange: boolean;
};

type PatchSelectionMode = 'stage' | 'unstage';

function parseHunkHeader(line: string): {
    oldStart: number;
    newStart: number;
    sectionHeading: string;
} | null {
    const match = HUNK_HEADER_REGEX.exec(line);
    if (!match) return null;
    return {
        oldStart: Number(match[1] ?? 0),
        newStart: Number(match[3] ?? 0),
        sectionHeading: (match[5] ?? '').trim(),
    };
}

function emitHunk(
    lines: ParsedHunkLine[],
    selectedLineIndexes: Set<number>,
    mode: PatchSelectionMode
): EmittedHunkLine[] | null {
    const emitted: EmittedHunkLine[] = [];
    let hasSelectedChange = false;

    for (const line of lines) {
        switch (line.kind) {
            case 'context': {
                emitted.push({
                    text: line.text,
                    oldRef: line.oldRef,
                    newRef: line.newRef,
                    carriesChange: false,
                });
                break;
            }
            case 'add': {
                if (selectedLineIndexes.has(line.index)) {
                    hasSelectedChange = true;
                    emitted.push({
                        text: line.text,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: true,
                    });
                } else if (mode === 'unstage') {
                    // Reverse-apply unstage patches must keep unselected staged additions as context.
                    emitted.push({
                        text: ` ${line.text.slice(1)}`,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: false,
                    });
                }
                break;
            }
            case 'delete': {
                if (selectedLineIndexes.has(line.index)) {
                    hasSelectedChange = true;
                    emitted.push({
                        text: line.text,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: true,
                    });
                } else if (mode === 'stage') {
                    // Keep removed lines as context when not selected so patch positions stay stable.
                    emitted.push({
                        text: ` ${line.text.slice(1)}`,
                        oldRef: line.oldRef,
                        newRef: line.newRef,
                        carriesChange: false,
                    });
                }
                break;
            }
            case 'marker': {
                if (emitted.length > 0) {
                    emitted.push({
                        text: line.text,
                        oldRef: null,
                        newRef: null,
                        carriesChange: emitted[emitted.length - 1]?.carriesChange === true,
                    });
                }
                break;
            }
            case 'other': {
                emitted.push({
                    text: line.text,
                    oldRef: line.oldRef,
                    newRef: line.newRef,
                    carriesChange: false,
                });
                break;
            }
        }
    }

    if (!hasSelectedChange) {
        return null;
    }

    // Drop markers that don't follow a selected change to avoid noisy hunks.
    return emitted.filter((line, index) => {
        if (line.text !== NO_NEWLINE_MARKER) return true;
        const previous = emitted[index - 1];
        return previous?.carriesChange === true;
    });
}

function computeHunkHeaderLines(emitted: EmittedHunkLine[]): {
    header: string;
    body: string[];
} | null {
    const body = emitted.map((line) => line.text);
    const contentLines = emitted.filter((line) => line.text !== NO_NEWLINE_MARKER);
    if (contentLines.length === 0) return null;

    const first = contentLines[0];
    const oldStart = first?.oldRef ?? 0;
    const newStart = first?.newRef ?? 0;
    const oldCount = contentLines.filter((line) => line.text.startsWith(' ') || line.text.startsWith('-')).length;
    const newCount = contentLines.filter((line) => line.text.startsWith(' ') || line.text.startsWith('+')).length;

    return {
        header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        body,
    };
}

export function buildPatchFromSelectedDiffLines(
    unifiedDiff: string,
    selectedLineIndexes: Set<number>,
    options: { mode?: PatchSelectionMode } = {}
): string | null {
    const mode = options.mode ?? 'stage';
    if (!unifiedDiff || selectedLineIndexes.size === 0) {
        return null;
    }

    const lines = unifiedDiff.split('\n');
    const firstHunkIndex = lines.findIndex((line) => HUNK_HEADER_REGEX.test(line));
    if (firstHunkIndex < 0) {
        return null;
    }

    const headerLines = lines.slice(0, firstHunkIndex);
    const oldHeader = headerLines.find((line) => line.startsWith('--- ')) ?? '';
    const newHeader = headerLines.find((line) => line.startsWith('+++ ')) ?? '';
    if (!oldHeader || !newHeader) {
        return null;
    }

    let normalizedHeaderLines = [...headerLines];
    const hasDiffHeader = normalizedHeaderLines.some((line) => line.startsWith('diff --git '));
    if (!hasDiffHeader) {
        const oldPath = oldHeader.replace(/^---\s+/, '').replace(/^a\//, '');
        const newPath = newHeader.replace(/^\+\+\+\s+/, '').replace(/^b\//, '');
        normalizedHeaderLines = [`diff --git a/${oldPath} b/${newPath}`, ...normalizedHeaderLines];
    }

    const hunks: ParsedHunk[] = [];
    let cursor = firstHunkIndex;
    while (cursor < lines.length) {
        const header = parseHunkHeader(lines[cursor] ?? '');
        if (!header) {
            cursor += 1;
            continue;
        }

        const parsed: ParsedHunk = {
            sectionHeading: header.sectionHeading,
            lines: [],
        };

        let oldCursor = header.oldStart;
        let newCursor = header.newStart;
        cursor += 1;

        while (cursor < lines.length) {
            const line = lines[cursor] ?? '';
            if (line.startsWith('diff --git ') || HUNK_HEADER_REGEX.test(line)) {
                break;
            }

            if (line === NO_NEWLINE_MARKER) {
                parsed.lines.push({
                    index: cursor,
                    text: line,
                    kind: 'marker',
                    oldRef: null,
                    newRef: null,
                });
                cursor += 1;
                continue;
            }

            if (line.startsWith(' ')) {
                parsed.lines.push({
                    index: cursor,
                    text: line,
                    kind: 'context',
                    oldRef: oldCursor,
                    newRef: newCursor,
                });
                oldCursor += 1;
                newCursor += 1;
                cursor += 1;
                continue;
            }

            if (line.startsWith('-') && !line.startsWith('---')) {
                parsed.lines.push({
                    index: cursor,
                    text: line,
                    kind: 'delete',
                    oldRef: oldCursor,
                    newRef: newCursor,
                });
                oldCursor += 1;
                cursor += 1;
                continue;
            }

            if (line.startsWith('+') && !line.startsWith('+++')) {
                parsed.lines.push({
                    index: cursor,
                    text: line,
                    kind: 'add',
                    oldRef: oldCursor,
                    newRef: newCursor,
                });
                newCursor += 1;
                cursor += 1;
                continue;
            }

            parsed.lines.push({
                index: cursor,
                text: line,
                kind: 'other',
                oldRef: oldCursor,
                newRef: newCursor,
            });
            cursor += 1;
        }

        hunks.push(parsed);
    }

    const renderedHunks: string[] = [];
    for (const parsedHunk of hunks) {
        const emitted = emitHunk(parsedHunk.lines, selectedLineIndexes, mode);
        if (!emitted) continue;
        const rendered = computeHunkHeaderLines(emitted);
        if (!rendered) continue;

        const headingSuffix = parsedHunk.sectionHeading ? ` ${parsedHunk.sectionHeading}` : '';
        renderedHunks.push(`${rendered.header}${headingSuffix}`);
        renderedHunks.push(...rendered.body);
    }

    if (renderedHunks.length === 0) {
        return null;
    }

    const patchLines = [...normalizedHeaderLines, ...renderedHunks];
    if (patchLines[patchLines.length - 1] !== '') {
        patchLines.push('');
    }
    return patchLines.join('\n');
}
