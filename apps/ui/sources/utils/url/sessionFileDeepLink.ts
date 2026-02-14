import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

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
        `startLine=${encodeURIComponent(String(anchor.startLine))}`,
    ];

    if (anchor.kind === 'diffLine') {
        parts.push(`side=${encodeURIComponent(anchor.side)}`);
        if (typeof anchor.oldLine === 'number') parts.push(`oldLine=${encodeURIComponent(String(anchor.oldLine))}`);
        if (typeof anchor.newLine === 'number') parts.push(`newLine=${encodeURIComponent(String(anchor.newLine))}`);
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

    if (anchorKind === 'fileLine') {
        return { source, anchor: { kind: 'fileLine', startLine } };
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
            },
        };
    }

    return null;
}

