import type { CodeLine } from './codeLineTypes';
import type { IntraLineDiffSegment } from './codeLineTypes';
import { diffWordsWithSpace } from 'diff';

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
    // @@ -a,b +c,d @@
    const match = /^\s*@@\s+-([0-9]+)(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/.exec(line);
    if (!match) return null;
    return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function isDiffHeaderLine(line: string): boolean {
    const trimmed = line.trimStart();
    return (
        trimmed.startsWith('diff --git ')
        || trimmed.startsWith('index ')
        || trimmed.startsWith('--- ')
        || trimmed.startsWith('+++ ')
        || trimmed.startsWith('@@')
    );
}

export function buildCodeLinesFromUnifiedDiff(params: Readonly<{
    unifiedDiff: string;
    hideFilePrelude?: boolean;
    intraLineDiff?: Readonly<{
        enabled: boolean;
        maxLines: number;
        maxLineLength: number;
        maxPairs?: number;
    }>;
}>): CodeLine[] {
    const rawLines = params.unifiedDiff.replace(/\r\n/g, '\n').split('\n');

    const out: CodeLine[] = [];

    const shouldHidePrelude = params.hideFilePrelude !== false;
    const firstHunkIndex = shouldHidePrelude
        ? rawLines.findIndex((l) => (l ?? '').trimStart().startsWith('@@'))
        : -1;
    const skipPrelude = shouldHidePrelude && firstHunkIndex >= 0;

    const intraLineMaxPairs = typeof params.intraLineDiff?.maxPairs === 'number'
        ? params.intraLineDiff.maxPairs
        : Number.POSITIVE_INFINITY;
    const intraLineEnabled = params.intraLineDiff?.enabled === true
        && rawLines.length <= (params.intraLineDiff?.maxLines ?? 0);
    const intraLineMaxLineLength = params.intraLineDiff?.maxLineLength ?? 0;
    let remainingIntraLinePairs = intraLineEnabled ? intraLineMaxPairs : 0;

    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    const pendingRemovals: Array<{ outIndex: number; text: string }> = [];

    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i] ?? '';
        const normalized = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
        const trimmed = normalized.trimStart();

        if (skipPrelude && i < firstHunkIndex) {
            // Hide the redundant file-level prelude emitted by `git diff` (diff --git/index/---/+++ plus
            // rename metadata) when we know hunks exist and the file is already shown in surrounding UI.
            continue;
        }

        if (trimmed.startsWith('@@')) {
            pendingRemovals.length = 0;
            const header = parseHunkHeader(trimmed);
            if (header) {
                oldLine = header.oldStart;
                newLine = header.newStart;
                inHunk = true;
            }
            out.push({
                id: `h:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk && isDiffHeaderLine(trimmed)) {
            pendingRemovals.length = 0;
            out.push({
                id: `hd:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        if (!inHunk) {
            pendingRemovals.length = 0;
            // Unknown prelude content; treat as header-style.
            out.push({
                id: `p:${i}`,
                sourceIndex: i,
                kind: 'header',
                oldLine: null,
                newLine: null,
                renderPrefixText: '',
                renderCodeText: trimmed,
                renderIsHeaderLine: true,
                selectable: false,
            });
            continue;
        }

        const prefix = normalized.slice(0, 1);
        const codeText = normalized.slice(1);

        if (prefix === '+' && !normalized.startsWith('+++')) {
            let renderIntraLineDiffSegments: readonly IntraLineDiffSegment[] | null = null;
            if (intraLineEnabled && remainingIntraLinePairs > 0 && pendingRemovals.length > 0) {
                const pending = pendingRemovals.shift()!;
                const removalLine = out[pending.outIndex];
                if (removalLine && !removalLine.renderIsHeaderLine) {
                    const oldText = pending.text;
                    const newText = codeText;
                    const lengthOk = intraLineMaxLineLength <= 0
                        || (oldText.length <= intraLineMaxLineLength && newText.length <= intraLineMaxLineLength);
                    if (lengthOk) {
                        remainingIntraLinePairs -= 1;
                        const parts = diffWordsWithSpace(oldText, newText);
                        const oldSegments: IntraLineDiffSegment[] = [];
                        const newSegments: IntraLineDiffSegment[] = [];

                        for (const part of parts) {
                            const value = part.value ?? '';
                            if (!value) continue;
                            if (part.added) {
                                newSegments.push({ text: value, kind: 'added' });
                            } else if (part.removed) {
                                oldSegments.push({ text: value, kind: 'removed' });
                            } else {
                                oldSegments.push({ text: value, kind: 'context' });
                                newSegments.push({ text: value, kind: 'context' });
                            }
                        }

                        out[pending.outIndex] = {
                            ...removalLine,
                            renderIntraLineDiffSegments: oldSegments,
                        };
                        renderIntraLineDiffSegments = newSegments;
                    }
                }
            } else if (intraLineEnabled && remainingIntraLinePairs <= 0) {
                pendingRemovals.length = 0;
            }

            const line: CodeLine = {
                id: `a:${i}`,
                sourceIndex: i,
                kind: 'add',
                oldLine: null,
                newLine,
                renderPrefixText: '+',
                renderCodeText: codeText,
                renderIntraLineDiffSegments,
                renderIsHeaderLine: false,
                selectable: true,
            };
            out.push(line);
            newLine += 1;
            continue;
        }

        if (prefix === '-' && !normalized.startsWith('---')) {
            const line: CodeLine = {
                id: `r:${i}`,
                sourceIndex: i,
                kind: 'remove',
                oldLine,
                newLine: null,
                renderPrefixText: '-',
                renderCodeText: codeText,
                renderIntraLineDiffSegments: null,
                renderIsHeaderLine: false,
                selectable: true,
            };
            if (intraLineEnabled && remainingIntraLinePairs > 0 && pendingRemovals.length < intraLineMaxPairs) {
                pendingRemovals.push({ outIndex: out.length, text: codeText });
            }
            out.push(line);
            oldLine += 1;
            continue;
        }

        // Context line (" ") or blank line inside hunk.
        if (prefix === ' ') {
            pendingRemovals.length = 0;
            out.push({
                id: `c:${i}`,
                sourceIndex: i,
                kind: 'context',
                oldLine,
                newLine,
                renderPrefixText: ' ',
                renderCodeText: codeText,
                renderIntraLineDiffSegments: null,
                renderIsHeaderLine: false,
                selectable: false,
            });
            oldLine += 1;
            newLine += 1;
            continue;
        }

        pendingRemovals.length = 0;
        out.push({
            id: `x:${i}`,
            sourceIndex: i,
            kind: 'context',
            oldLine,
            newLine,
            renderPrefixText: '',
            renderCodeText: normalized,
            renderIntraLineDiffSegments: null,
            renderIsHeaderLine: false,
            selectable: false,
        });
    }

    return out;
}
