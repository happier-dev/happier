import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { randomUUID } from '@/platform/randomUUID';
import type {
    ReviewCommentAnchor,
    ReviewCommentDraft,
    ReviewCommentSnapshot,
    ReviewCommentSource,
} from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { nowServerMs } from '@/sync/runtime/time';

function formatSnapshotLine(params: { source: ReviewCommentSource; line: CodeLine }): string {
    if (params.source === 'diff') {
        const prefix = params.line.renderPrefixText ?? '';
        const code = params.line.renderCodeText ?? '';
        return `${prefix}${code}`.trimEnd();
    }
    return (params.line.renderCodeText ?? '').trimEnd();
}

function buildAnchor(params: { source: ReviewCommentSource; line: CodeLine }): ReviewCommentAnchor {
    if (params.source === 'file') {
        const startLine = typeof params.line.newLine === 'number' && params.line.newLine > 0
            ? params.line.newLine
            : params.line.sourceIndex + 1;
        return { kind: 'fileLine', startLine };
    }

    const side: 'before' | 'after' = params.line.kind === 'remove' ? 'before' : 'after';
    return {
        kind: 'diffLine',
        startLine: params.line.sourceIndex + 1,
        side,
        oldLine: params.line.oldLine,
        newLine: params.line.newLine,
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
        before.unshift(formatSnapshotLine({ source: params.source, line }));
    }
    for (let i = params.targetIndex + 1; i < params.lines.length && after.length < params.contextRadius; i++) {
        const line = params.lines[i];
        if (!line || line.renderIsHeaderLine) continue;
        after.push(formatSnapshotLine({ source: params.source, line }));
    }

    const selected = params.lines[params.targetIndex];
    const selectedLines = selected && !selected.renderIsHeaderLine
        ? [formatSnapshotLine({ source: params.source, line: selected })]
        : [];

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

