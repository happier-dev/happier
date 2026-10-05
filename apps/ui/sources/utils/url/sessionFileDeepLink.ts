import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { isLineContentHash } from '@/utils/text/lineContentHash';

type ExpoLocalSearchParams = Readonly<Record<string, unknown>>;

export type FileTargetAnchor = ReviewCommentAnchor;
export const FILE_TARGET_ANCHOR_PARAM_KEYS = ['source', 'anchor', 'line', 'startLine', 'endLine', 'side', 'oldLine', 'newLine', 'lineHash', 'startLineHash', 'endLineHash', 'selectedTextHash'] as const;

export type SearchFileTarget = Readonly<{
    path: string;
    anchor?: FileTargetAnchor;
    anchorSource?: ReviewCommentSource;
    column?: number;
    sessionId?: string;
    serverId?: string;
    workspaceRefId?: string;
}>;

function firstString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
}

function parseOptionalInt(value: string | null): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

function getAnchorStartLine(anchor: ReviewCommentAnchor): number {
    if (anchor.kind === 'line') return anchor.line;
    return anchor.startLine;
}

export function buildSessionFileDeepLink(params: {
    sessionId: string;
    serverId?: string | null;
    filePath: string;
    source?: ReviewCommentSource;
    anchor?: ReviewCommentAnchor;
}): string {
    const base = `/session/${params.sessionId}/file?path=${encodeURIComponent(params.filePath)}${params.serverId ? `&serverId=${encodeURIComponent(params.serverId)}` : ''}`;
    if (!params.anchor || !params.source) return base;
    const parts = Object.entries(serializeFileTargetAnchor(params.anchor, params.source))
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
    return `${base}&${parts.join('&')}`;
}

/** All file routes use the standalone file link's anchor vocabulary. */
export function serializeFileTargetAnchor(anchor: FileTargetAnchor, source: ReviewCommentSource = anchor.kind === 'diffLine' ? 'diff' : 'file'): Record<string, string> {
    const out: Record<string, string> = { source, anchor: anchor.kind, startLine: String(getAnchorStartLine(anchor)) };
    if (anchor.kind === 'diffLine') {
        out.side = anchor.side;
        if (typeof anchor.oldLine === 'number') out.oldLine = String(anchor.oldLine);
        if (typeof anchor.newLine === 'number') out.newLine = String(anchor.newLine);
    }
    if (anchor.kind === 'line' && anchor.side) out.side = anchor.side;
    if ((anchor.kind === 'fileLine' || anchor.kind === 'diffLine' || anchor.kind === 'line') && anchor.lineHash) out.lineHash = anchor.lineHash;
    if (anchor.kind === 'range') {
        out.endLine = String(anchor.endLine);
        if (anchor.side) out.side = anchor.side;
        if (anchor.startLineHash) out.startLineHash = anchor.startLineHash;
        if (anchor.endLineHash) out.endLineHash = anchor.endLineHash;
        if (anchor.selectedTextHash) out.selectedTextHash = anchor.selectedTextHash;
    }
    return out;
}

/** Search grammar only: a final positive line, with an optional positive column. */
export function parseSearchFileTarget(query: string): SearchFileTarget | null {
    const value = query.trim();
    if (!value) return null;
    try {
        const url = new URL(value, 'https://happier.invalid');
        const session = /^\/session\/([^/]+)\/file$/.exec(url.pathname);
        const project = /^\/projects\/([^/]+)(?:\/(?:details|files))?$/.exec(url.pathname);
        const path = url.searchParams.get(session ? 'path' : 'initialFile');
        if ((session || project) && path) {
            const parsed = parseSessionFileDeepLinkAnchor({ ...Object.fromEntries(url.searchParams), path });
            const serverId = url.searchParams.get('serverId');
            return { path, ...(parsed ? { anchor: parsed.anchor } : {}),
                ...(parsed?.source === 'diff' ? { anchorSource: parsed.source } : {}),
                ...(session ? { sessionId: decodeURIComponent(session[1]) } : {}),
                ...(project ? { workspaceRefId: decodeURIComponent(project[1]) } : {}),
                ...(serverId ? { serverId } : {}) };
        }
    } catch { /* Ordinary filesystem paths are not URLs. */ }
    const driveLength = /^[a-zA-Z]:[\\/]/.test(value) ? 2 : 0;
    const suffix = /:(\d+)(?::(\d+))?$/.exec(value.slice(driveLength));
    if (!suffix || suffix.index === 0) return null;
    const line = parseOptionalInt(suffix[1]);
    const column = suffix[2] === undefined ? null : parseOptionalInt(suffix[2]);
    if (!line || line <= 0 || (suffix[2] !== undefined && (!column || column <= 0))) return null;
    return { path: value.slice(0, driveLength + suffix.index), anchor: { kind: 'fileLine', startLine: line }, ...(column ? { column } : {}) };
}

/** Validate typed resources through the route parser instead of trusting renderer casts. */
export function readFileTargetAnchorResource(resource: unknown): ReturnType<typeof parseSessionFileDeepLinkAnchor> {
    if (!resource || typeof resource !== 'object') return null;
    const record = resource as Record<string, unknown>;
    const legacy = record.deepLinkAnchor;
    const value = legacy && typeof legacy === 'object' ? legacy as Record<string, unknown> : record;
    const anchor = value.anchor;
    if (!anchor || typeof anchor !== 'object') return null;
    const candidate = anchor as Record<string, unknown>;
    const params: Record<string, unknown> = {
        path: typeof record.path === 'string' ? record.path : '', source: value.source ?? record.anchorSource ?? (candidate.kind === 'diffLine' ? 'diff' : 'file'),
        anchor: candidate.kind, startLine: String(candidate.kind === 'line' ? candidate.line : candidate.startLine),
    };
    for (const key of FILE_TARGET_ANCHOR_PARAM_KEYS) {
        if (key !== 'source' && key !== 'anchor' && key !== 'startLine' && candidate[key] != null) params[key] = String(candidate[key]);
    }
    return parseSessionFileDeepLinkAnchor(params);
}

export function parseSessionFileDeepLinkAnchor(params: ExpoLocalSearchParams): {
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
} | null {
    const sourceRaw = firstString(params.source);
    const anchorKind = firstString(params.anchor);
    const startLine = anchorKind === 'line' ? parseOptionalInt(firstString(params.line)) ?? parseOptionalInt(firstString(params.startLine))
        : parseOptionalInt(firstString(params.startLine));
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
        const selectedTextHashRaw = firstString(params.selectedTextHash);
        const startLineHash = isLineContentHash(startLineHashRaw) ? startLineHashRaw : undefined;
        const endLineHash = isLineContentHash(endLineHashRaw) ? endLineHashRaw : undefined;
        const selectedTextHash = isLineContentHash(selectedTextHashRaw) ? selectedTextHashRaw : undefined;
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
                ...(selectedTextHash ? { selectedTextHash } : {}),
            },
        };
    }

    return null;
}
