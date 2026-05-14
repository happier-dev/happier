import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { isLineContentHash } from '@/utils/text/lineContentHash';

type ExpoLocalSearchParams = Record<string, string | string[] | undefined>;

function firstString(value: string | string[] | undefined): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
}

function parseOptionalInt(value: string | null): number | null {
    if (!value) return null;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
}

function getAnchorStartLine(anchor: ReviewCommentAnchor): number {
    if (anchor.kind === 'line') return anchor.line;
    return anchor.startLine;
}

export function buildSessionFileDeepLink(params: {
    sessionId: string;
    filePath: string;
    source?: ReviewCommentSource;
    anchor?: ReviewCommentAnchor;
}): string {
    const base = `/session/${params.sessionId}/file?path=${encodeURIComponent(params.filePath)}`;
    if (!params.anchor || !params.source) return base;

    const anchor = params.anchor;
    const parts: string[] = [
        `source=${encodeURIComponent(params.source)}`,
        `anchor=${encodeURIComponent(anchor.kind)}`,
        `startLine=${encodeURIComponent(String(getAnchorStartLine(anchor)))}`,
    ];

    if (anchor.kind === 'diffLine') {
        parts.push(`side=${encodeURIComponent(anchor.side)}`);
        if (typeof anchor.oldLine === 'number') parts.push(`oldLine=${encodeURIComponent(String(anchor.oldLine))}`);
        if (typeof anchor.newLine === 'number') parts.push(`newLine=${encodeURIComponent(String(anchor.newLine))}`);
    }
    if (anchor.kind === 'line' && anchor.side) {
        parts.push(`side=${encodeURIComponent(anchor.side)}`);
    }
    if ((anchor.kind === 'fileLine' || anchor.kind === 'diffLine' || anchor.kind === 'line') && anchor.lineHash) {
        parts.push(`lineHash=${encodeURIComponent(anchor.lineHash)}`);
    }
    if (anchor.kind === 'range') {
        parts.push(`endLine=${encodeURIComponent(String(anchor.endLine))}`);
        if (anchor.side) parts.push(`side=${encodeURIComponent(anchor.side)}`);
        if (anchor.startLineHash) parts.push(`startLineHash=${encodeURIComponent(anchor.startLineHash)}`);
        if (anchor.endLineHash) parts.push(`endLineHash=${encodeURIComponent(anchor.endLineHash)}`);
    }

    return `${base}&${parts.join('&')}`;
}

export function parseSessionFileDeepLinkAnchor(params: ExpoLocalSearchParams): {
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
} | null {
    const sourceRaw = firstString(params.source);
    const anchorKind = firstString(params.anchor);
    const startLine = parseOptionalInt(firstString(params.startLine));
    if (!sourceRaw || (sourceRaw !== 'file' && sourceRaw !== 'diff')) return null;
    if (!anchorKind || !startLine || startLine <= 0) return null;

    const source: ReviewCommentSource = sourceRaw;
    const filePath = firstString(params.path) ?? '';
    const lineHashRaw = firstString(params.lineHash);
    const lineHash = isLineContentHash(lineHashRaw) ? lineHashRaw : undefined;

    if (anchorKind === 'fileLine') {
        return { source, anchor: { kind: 'fileLine', startLine, lineHash } };
    }

    if (anchorKind === 'diffLine') {
        const sideRaw = firstString(params.side);
        if (sideRaw !== 'before' && sideRaw !== 'after') return null;
        const oldLine = parseOptionalInt(firstString(params.oldLine));
        const newLine = parseOptionalInt(firstString(params.newLine));
        return {
            source,
            anchor: {
                kind: 'diffLine',
                startLine,
                side: sideRaw,
                oldLine,
                newLine,
                lineHash,
            },
        };
    }

    if (anchorKind === 'line') {
        const sideRaw = firstString(params.side);
        const side = sideRaw === 'before' || sideRaw === 'after' ? sideRaw : undefined;
        return { source, anchor: { kind: 'line', filePath, line: startLine, ...(side ? { side } : {}), ...(lineHash ? { lineHash } : {}) } };
    }

    if (anchorKind === 'range') {
        const endLine = parseOptionalInt(firstString(params.endLine));
        if (!endLine || endLine < startLine) return null;
        const sideRaw = firstString(params.side);
        const side = sideRaw === 'before' || sideRaw === 'after' ? sideRaw : undefined;
        const startLineHashRaw = firstString(params.startLineHash);
        const endLineHashRaw = firstString(params.endLineHash);
        const startLineHash = isLineContentHash(startLineHashRaw) ? startLineHashRaw : undefined;
        const endLineHash = isLineContentHash(endLineHashRaw) ? endLineHashRaw : undefined;
        return {
            source,
            anchor: {
                kind: 'range',
                filePath,
                startLine,
                endLine,
                ...(side ? { side } : {}),
                ...(startLineHash ? { startLineHash } : {}),
                ...(endLineHash ? { endLineHash } : {}),
            },
        };
    }

    return null;
}
