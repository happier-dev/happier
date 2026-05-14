import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { MarkdownSourceRange } from '@/components/markdown/MarkdownView';
import { randomUUID } from '@/platform/randomUUID';
import type {
    ReviewCommentAnchor,
    ReviewCommentDraft,
    ReviewCommentSnapshot,
    ReviewCommentSource,
} from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { nowServerMs } from '@/sync/runtime/time';
import { computeLineContentHash } from '@/utils/text/lineContentHash';

export function formatReviewCommentCodeLineContent(params: { source: ReviewCommentSource; line: CodeLine }): string {
    if (params.source === 'diff') {
        const prefix = params.line.renderPrefixText ?? '';
        const code = params.line.renderCodeText ?? '';
        return `${prefix}${code}`.trimEnd();
    }
    return (params.line.renderCodeText ?? '').trimEnd();
}

function buildAnchor(params: { source: ReviewCommentSource; line: CodeLine }): ReviewCommentAnchor {
    const lineHash = computeLineContentHash(formatReviewCommentCodeLineContent(params));

    if (params.source === 'file') {
        const startLine = typeof params.line.newLine === 'number' && params.line.newLine > 0
            ? params.line.newLine
            : params.line.sourceIndex + 1;
        return { kind: 'fileLine', startLine, lineHash };
    }

    const side: 'before' | 'after' = params.line.kind === 'remove' ? 'before' : 'after';
    return {
        kind: 'diffLine',
        startLine: params.line.sourceIndex + 1,
        side,
        oldLine: params.line.oldLine,
        newLine: params.line.newLine,
        lineHash,
    };
}

function resolveAnchorLineNumber(params: { source: ReviewCommentSource; side?: 'before' | 'after'; line: CodeLine }): number {
    if (params.source === 'file') {
        return typeof params.line.newLine === 'number' && params.line.newLine > 0
            ? params.line.newLine
            : params.line.sourceIndex + 1;
    }
    if (params.side === 'before') {
        return typeof params.line.oldLine === 'number' && params.line.oldLine > 0
            ? params.line.oldLine
            : params.line.sourceIndex + 1;
    }
    return typeof params.line.newLine === 'number' && params.line.newLine > 0
        ? params.line.newLine
        : params.line.sourceIndex + 1;
}

function buildRangeAnchor(params: {
    filePath: string;
    source: ReviewCommentSource;
    startLine: CodeLine;
    endLine: CodeLine;
    selectedLines: readonly string[];
}): ReviewCommentAnchor {
    const side: 'before' | 'after' | undefined = params.source === 'diff'
        ? (params.startLine.kind === 'remove' ? 'before' : 'after')
        : undefined;
    const startLine = resolveAnchorLineNumber({ source: params.source, side, line: params.startLine });
    const endLine = resolveAnchorLineNumber({ source: params.source, side, line: params.endLine });
    const normalizedStartLine = Math.min(startLine, endLine);
    const normalizedEndLine = Math.max(startLine, endLine);

    return {
        kind: 'range',
        filePath: params.filePath,
        startLine: normalizedStartLine,
        endLine: normalizedEndLine,
        ...(side ? { side } : {}),
        startLineHash: computeLineContentHash(formatReviewCommentCodeLineContent({ source: params.source, line: params.startLine })),
        endLineHash: computeLineContentHash(formatReviewCommentCodeLineContent({ source: params.source, line: params.endLine })),
        selectedTextHash: computeLineContentHash(params.selectedLines.join('\n')),
    };
}

function buildSnapshot(params: {
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    targetIndex: number;
    contextRadius: number;
}): ReviewCommentSnapshot {
    const before: string[] = [];
    const after: string[] = [];

    for (let i = params.targetIndex - 1; i >= 0 && before.length < params.contextRadius; i--) {
        const line = params.lines[i];
        if (!line || line.renderIsHeaderLine) continue;
        before.unshift(formatReviewCommentCodeLineContent({ source: params.source, line }));
    }
    for (let i = params.targetIndex + 1; i < params.lines.length && after.length < params.contextRadius; i++) {
        const line = params.lines[i];
        if (!line || line.renderIsHeaderLine) continue;
        after.push(formatReviewCommentCodeLineContent({ source: params.source, line }));
    }

    const selected = params.lines[params.targetIndex];
    const selectedLines = selected && !selected.renderIsHeaderLine
        ? [formatReviewCommentCodeLineContent({ source: params.source, line: selected })]
        : [];

    return {
        selectedLines,
        beforeContext: before,
        afterContext: after,
    };
}

function buildRangeSnapshot(params: {
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    rangeLines: readonly CodeLine[];
    contextRadius: number;
}): ReviewCommentSnapshot {
    const rangeIds = new Set(params.rangeLines.map((line) => line.id));
    const indexes = params.lines
        .map((line, index) => ({ line, index }))
        .filter((entry) => rangeIds.has(entry.line.id))
        .map((entry) => entry.index);
    const startIndex = indexes.length > 0 ? Math.min(...indexes) : 0;
    const endIndex = indexes.length > 0 ? Math.max(...indexes) : startIndex;

    const selectedLines = params.lines
        .slice(startIndex, endIndex + 1)
        .filter((line) => !line.renderIsHeaderLine)
        .map((line) => formatReviewCommentCodeLineContent({ source: params.source, line }));

    const before: string[] = [];
    for (let i = startIndex - 1; i >= 0 && before.length < params.contextRadius; i--) {
        const line = params.lines[i];
        if (!line || line.renderIsHeaderLine) continue;
        before.unshift(formatReviewCommentCodeLineContent({ source: params.source, line }));
    }

    const after: string[] = [];
    for (let i = endIndex + 1; i < params.lines.length && after.length < params.contextRadius; i++) {
        const line = params.lines[i];
        if (!line || line.renderIsHeaderLine) continue;
        after.push(formatReviewCommentCodeLineContent({ source: params.source, line }));
    }

    return {
        selectedLines,
        beforeContext: before,
        afterContext: after,
    };
}

export function buildReviewCommentDraftFromCodeLine(params: {
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    targetLine: CodeLine;
    body: string;
    contextRadius: number;
    existing?: Pick<ReviewCommentDraft, 'id' | 'createdAt'> | null;
    nowMs?: number;
    id?: string;
}): ReviewCommentDraft {
    const idx = params.lines.findIndex((l) => l.id === params.targetLine.id);
    const targetIndex = idx >= 0 ? idx : 0;

    const anchor = buildAnchor({ source: params.source, line: params.targetLine });
    const snapshot = buildSnapshot({
        source: params.source,
        lines: params.lines,
        targetIndex,
        contextRadius: params.contextRadius,
    });

    const id = params.existing?.id ?? params.id ?? randomUUID();
    const createdAt = params.existing?.createdAt ?? params.nowMs ?? nowServerMs();

    return {
        id,
        filePath: params.filePath,
        source: params.source,
        anchor,
        snapshot,
        body: params.body,
        createdAt,
    };
}

export function buildReviewCommentDraftFromCodeLineRange(params: {
    filePath: string;
    source: ReviewCommentSource;
    lines: readonly CodeLine[];
    rangeLines: readonly CodeLine[];
    body: string;
    contextRadius: number;
    existing?: Pick<ReviewCommentDraft, 'id' | 'createdAt'> | null;
    nowMs?: number;
    id?: string;
}): ReviewCommentDraft {
    const filteredRangeLines = params.rangeLines.filter((line) => !line.renderIsHeaderLine);
    const first = filteredRangeLines[0];
    const last = filteredRangeLines[filteredRangeLines.length - 1];
    if (!first || !last) {
        throw new Error('review_comment_range_requires_lines');
    }

    const snapshot = buildRangeSnapshot({
        source: params.source,
        lines: params.lines,
        rangeLines: filteredRangeLines,
        contextRadius: params.contextRadius,
    });
    const anchor = buildRangeAnchor({
        filePath: params.filePath,
        source: params.source,
        startLine: first,
        endLine: last,
        selectedLines: snapshot.selectedLines,
    });

    const id = params.existing?.id ?? params.id ?? randomUUID();
    const createdAt = params.existing?.createdAt ?? params.nowMs ?? nowServerMs();

    return {
        id,
        filePath: params.filePath,
        source: params.source,
        anchor,
        snapshot,
        body: params.body,
        createdAt,
    };
}

function readMarkdownSourceLines(markdown: string, range: MarkdownSourceRange): readonly string[] {
    const lines = markdown.split('\n');
    const start = Math.max(1, Math.floor(range.startLine));
    const end = Math.max(start, Math.floor(range.endLine));
    return lines.slice(start - 1, end);
}

function buildMarkdownSnapshot(params: {
    markdown: string;
    sourceRange: MarkdownSourceRange;
    contextRadius: number;
}): ReviewCommentSnapshot {
    const lines = params.markdown.split('\n');
    const startIndex = Math.max(0, Math.floor(params.sourceRange.startLine) - 1);
    const endIndex = Math.max(startIndex, Math.floor(params.sourceRange.endLine) - 1);
    const selectedLines = lines.slice(startIndex, endIndex + 1).filter((line) => line.trim().length > 0);
    const beforeContext: string[] = [];
    const afterContext: string[] = [];

    for (let index = startIndex - 1; index >= 0 && beforeContext.length < params.contextRadius; index--) {
        const line = lines[index] ?? '';
        if (line.trim().length === 0) continue;
        beforeContext.unshift(line);
    }
    for (let index = endIndex + 1; index < lines.length && afterContext.length < params.contextRadius; index++) {
        const line = lines[index] ?? '';
        if (line.trim().length === 0) continue;
        afterContext.push(line);
    }

    return {
        selectedLines,
        beforeContext,
        afterContext,
    };
}

export function buildReviewCommentDraftFromMarkdownRange(params: {
    filePath: string;
    markdown: string;
    sourceRange: MarkdownSourceRange;
    body: string;
    contextRadius: number;
    existing?: Pick<ReviewCommentDraft, 'id' | 'createdAt'> | null;
    nowMs?: number;
    id?: string;
}): ReviewCommentDraft {
    const selectedLines = readMarkdownSourceLines(params.markdown, params.sourceRange);
    const firstLine = selectedLines[0] ?? '';
    const lastLine = selectedLines[selectedLines.length - 1] ?? firstLine;
    const selectedText = selectedLines.join('\n');
    const id = params.existing?.id ?? params.id ?? randomUUID();
    const createdAt = params.existing?.createdAt ?? params.nowMs ?? nowServerMs();

    return {
        id,
        filePath: params.filePath,
        source: 'file',
        anchor: {
            kind: 'range',
            filePath: params.filePath,
            startLine: params.sourceRange.startLine,
            endLine: params.sourceRange.endLine,
            startLineHash: computeLineContentHash(firstLine),
            endLineHash: computeLineContentHash(lastLine),
            selectedTextHash: computeLineContentHash(selectedText),
        },
        snapshot: buildMarkdownSnapshot({
            markdown: params.markdown,
            sourceRange: params.sourceRange,
            contextRadius: params.contextRadius,
        }),
        body: params.body,
        createdAt,
    };
}
