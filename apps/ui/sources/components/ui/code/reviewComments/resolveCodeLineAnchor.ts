import type { WorkspaceAnchorResolutionStatusV1 } from '@happier-dev/protocol';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { computeLineContentHash } from '@/utils/text/lineContentHash';
import { isWorkspaceFileReferenceAnchorForFile } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';

import { formatReviewCommentCodeLineContent, reviewCommentCodeLineMatchesHash } from './buildReviewCommentDraftFromCodeLine';

type CodeLineAnchorResolution = Readonly<{
    status: WorkspaceAnchorResolutionStatusV1;
    lines: readonly CodeLine[];
}>;

/** Resolves navigation against the displayed source. Never establishes change authority. */
export function resolveCodeLineAnchor(params: Readonly<{
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    anchor: ReviewCommentAnchor;
}>): CodeLineAnchorResolution {
    const { anchor } = params;
    const unresolved = (status: WorkspaceAnchorResolutionStatusV1): CodeLineAnchorResolution => ({ status, lines: [] });
    if ((anchor.kind === 'line' || anchor.kind === 'range') && anchor.filePath
        && !isWorkspaceFileReferenceAnchorForFile({ anchor, filePath: params.filePath })) return unresolved('unsupported');
    const side = 'side' in anchor ? anchor.side : undefined;
    if (params.source === 'file' && (side || anchor.kind === 'diffLine')) return unresolved('unsupported');
    if (params.source === 'diff' && (!side || anchor.kind === 'fileLine')) return unresolved('unsupported');

    const candidates = params.lines.filter((line) => !line.renderIsHeaderLine && (
        params.source === 'file' || (side === 'before' ? line.oldLine !== null : line.newLine !== null)
    ));
    const lineNumber = (line: CodeLine) => params.source === 'diff' && side === 'before'
        ? line.oldLine : line.newLine ?? line.sourceIndex + 1;
    const lineByNumber = new Map(candidates.map((line) => [lineNumber(line), line]));
    const matchesHash = (line: CodeLine, hash?: string) => !hash || reviewCommentCodeLineMatchesHash({ source: params.source, line, lineHash: hash });
    const target = anchor.kind === 'fileLine' ? anchor.startLine
        : anchor.kind === 'diffLine' ? (side === 'before' ? anchor.oldLine : anchor.newLine)
            : anchor.kind === 'range' ? anchor.endLine : anchor.line;
    const hash = anchor.kind === 'range' ? anchor.selectedTextHash ?? anchor.endLineHash : anchor.lineHash;

    const matchSelection = (endLine: CodeLine): readonly CodeLine[] | null => {
        if (anchor.kind !== 'range') return matchesHash(endLine, anchor.lineHash) ? [endLine] : null;
        if (!matchesHash(endLine, anchor.endLineHash)) return null;
        const end = lineNumber(endLine);
        if (end === null) return null;
        const start = end - (anchor.endLine - anchor.startLine);
        const first = lineByNumber.get(start);
        if (!first || !matchesHash(first, anchor.startLineHash)) return null;
        const selected: CodeLine[] = [];
        for (let number = start; number <= end; number += 1) {
            const line = lineByNumber.get(number);
            if (!line) return null;
            selected.push(line);
        }
        if (!anchor.selectedTextHash) return selected;
        const raw = selected.map((line) => formatReviewCommentCodeLineContent({ source: params.source, line }));
        if (computeLineContentHash(raw.join('\n')) === anchor.selectedTextHash) return selected;
        // Retained predecessor ranges used diff prefixes; earlier development
        // ranges used trimmed display text. Neither spelling is a new writer.
        if (params.source !== 'diff') return null;
        const legacy = selected.map((line) => `${line.renderPrefixText}${line.renderCodeText}`);
        return computeLineContentHash(legacy.join('\n')) === anchor.selectedTextHash
            || computeLineContentHash(legacy.map((line) => line.trimEnd()).join('\n')) === anchor.selectedTextHash
            ? selected : null;
    };

    const exact = candidates.find((line) => lineNumber(line) === target);
    if (exact) {
        const selected = matchSelection(exact);
        if (selected) {
            const rawMatches = anchor.kind === 'range'
                ? !!anchor.selectedTextHash && computeLineContentHash(selected.map((line) => line.renderCodeText).join('\n')) === anchor.selectedTextHash
                : !!anchor.lineHash && computeLineContentHash(exact.renderCodeText) === anchor.lineHash;
            return { status: rawMatches ? 'exact' : 'context', lines: selected };
        }
    }
    if (hash) {
        const selections = candidates.map(matchSelection).filter((selection) => selection !== null);
        if (selections.length === 1) return { status: 'hash', lines: selections[0]! };
        if (selections.length > 1) return unresolved('ambiguous');
    }
    return unresolved(exact ? 'stale' : 'missing');
}
