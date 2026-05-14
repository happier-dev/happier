import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export type WorkspaceFileReferenceAnchor = Extract<ReviewCommentAnchor, { kind: 'line' | 'range' }>;

export type ResolvedWorkspaceFileReference = Readonly<{
    filePath: string;
    anchor?: WorkspaceFileReferenceAnchor;
    line?: number;
    endLine?: number;
    column?: number;
}>;

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

function collapseRepeatedSlashesPreservingUncPrefix(path: string): string {
    if (path.startsWith('//')) {
        return `//${path.slice(2).replace(/\/{2,}/g, '/')}`;
    }
    return path.replace(/^([a-z]:)\/{2,}/i, (_match, drive: string) => `${drive}/`).replace(/\/{2,}/g, '/');
}

function normalizeLocalPathForComparison(value: string): string | null {
    const withForwardSlashes = value.trim().replace(/\\/g, '/');
    const withoutBrowserExpandedDriveSlash = withForwardSlashes.replace(/^\/+([A-Za-z]:\/)/, '$1');
    const normalized = normalizeFileSystemPath(withoutBrowserExpandedDriveSlash);
    return normalized ? collapseRepeatedSlashesPreservingUncPrefix(normalized) : null;
}

function normalizeRelativePath(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
}

function splitLineSuffix(value: string): Readonly<{
    path: string;
    line?: number;
    endLine?: number;
    column?: number;
}> {
    const hashMatch = /^(.*?)#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i.exec(value);
    if (hashMatch?.[1] && hashMatch[2]) {
        const line = Number.parseInt(hashMatch[2], 10);
        const endLine = hashMatch[3] ? Number.parseInt(hashMatch[3], 10) : undefined;
        if (!Number.isSafeInteger(line) || line <= 0) return { path: value };
        if (typeof endLine === 'number') {
            if (!Number.isSafeInteger(endLine) || endLine < line) return { path: value };
            return { path: hashMatch[1], line, endLine };
        }
        return { path: hashMatch[1], line };
    }

    const rangeMatch = /^(.*?):([1-9]\d*)-([1-9]\d*)$/.exec(value);
    if (rangeMatch?.[1] && rangeMatch[2] && rangeMatch[3]) {
        const line = Number.parseInt(rangeMatch[2], 10);
        const endLine = Number.parseInt(rangeMatch[3], 10);
        if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(endLine) || endLine < line) {
            return { path: value };
        }
        return { path: rangeMatch[1], line, endLine };
    }

    const match = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(value);
    if (!match?.[1]) return { path: value };
    const rawLine = match[2];
    if (!rawLine) return { path: value };
    const line = Number.parseInt(rawLine, 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    if (!Number.isSafeInteger(line) || line <= 0) return { path: value };
    return {
        path: match[1],
        line,
        ...(typeof column === 'number' && Number.isSafeInteger(column) && column > 0 ? { column } : {}),
    };
}

function withOptionalAnchor(
    filePath: string,
    anchor: Readonly<{ line?: number; endLine?: number; column?: number }>,
): ResolvedWorkspaceFileReference {
    const normalizedAnchor: WorkspaceFileReferenceAnchor | undefined = typeof anchor.line === 'number'
        ? typeof anchor.endLine === 'number' && anchor.endLine > anchor.line
            ? { kind: 'range', filePath, startLine: anchor.line, endLine: anchor.endLine }
            : { kind: 'line', filePath, line: anchor.line }
        : undefined;

    return {
        filePath,
        ...(normalizedAnchor ? { anchor: normalizedAnchor } : {}),
        ...(typeof anchor.line === 'number' ? { line: anchor.line } : {}),
        ...(typeof anchor.endLine === 'number' ? { endLine: anchor.endLine } : {}),
        ...(typeof anchor.column === 'number' ? { column: anchor.column } : {}),
    };
}

function readUrlPath(rawUrl: string): string | null {
    const trimmed = String(rawUrl ?? '').trim();
    if (!trimmed) return null;

    if (/^file:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const pathname = decodeURIComponent(parsed.pathname);
            const hash = parsed.hash ? decodeURIComponent(parsed.hash) : '';
            if (parsed.host) {
                return `//${parsed.host}${pathname}${hash}`;
            }
            return `${pathname}${hash}`;
        } catch {
            return null;
        }
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
            if (!LOOPBACK_HTTP_HOSTS.has(hostname)) {
                return null;
            }
            return `${decodeURIComponent(parsed.pathname)}${parsed.hash ? decodeURIComponent(parsed.hash) : ''}`;
        } catch {
            return null;
        }
    }

    try {
        return decodeURIComponent(trimmed);
    } catch {
        return trimmed;
    }
}

function isAbsoluteLocalPath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function isSameOrChildPath(candidate: string, root: string): boolean {
    if (candidate === root) return true;
    const prefix = root === '/' ? '/' : `${root}/`;
    return candidate.startsWith(prefix);
}

function relativizeWorkspacePath(candidate: string, root: string): string {
    if (candidate === root) return '.';
    return root === '/' ? candidate.slice(1) : candidate.slice(root.length + 1);
}

export function isWorkspaceFileReferenceAnchorForFile(params: Readonly<{
    anchor: WorkspaceFileReferenceAnchor;
    filePath: string;
}>): boolean {
    const anchorPath = normalizeRelativePath(params.anchor.filePath);
    const filePath = normalizeRelativePath(params.filePath);
    return anchorPath === filePath;
}

export function buildWorkspaceFileReferenceAnchorKey(params: Readonly<{
    filePath: string;
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
}>): string {
    const { anchor, filePath, source } = params;
    if (anchor.kind === 'fileLine') {
        return `${filePath}:${source}:fileLine:${anchor.startLine}:${anchor.lineHash ?? ''}`;
    }
    if (anchor.kind === 'diffLine') {
        return `${filePath}:${source}:diffLine:${anchor.startLine}:${anchor.side}:${anchor.oldLine ?? ''}:${anchor.newLine ?? ''}:${anchor.lineHash ?? ''}`;
    }
    if (anchor.kind === 'line') {
        return `${anchor.filePath || filePath}:${source}:line:${anchor.line}:${anchor.side ?? ''}:${anchor.lineHash ?? ''}`;
    }
    return `${anchor.filePath || filePath}:${source}:range:${anchor.startLine}:${anchor.endLine}:${anchor.side ?? ''}:${anchor.startLineHash ?? ''}:${anchor.endLineHash ?? ''}`;
}

export function resolveWorkspaceFileReference(params: Readonly<{
    url: string;
    workspacePath: string | null | undefined;
}>): ResolvedWorkspaceFileReference | null {
    const rawPath = readUrlPath(params.url);
    if (!rawPath) return null;

    const parsed = splitLineSuffix(rawPath);
    const normalizedCandidate = normalizeLocalPathForComparison(parsed.path);
    if (!normalizedCandidate) return null;

    if (!isAbsoluteLocalPath(normalizedCandidate)) {
        const relative = normalizeRelativePath(normalizedCandidate);
        if (!relative || !isSafeWorkspaceRelativePath(relative)) return null;
        return withOptionalAnchor(relative, parsed);
    }

    const workspacePath = typeof params.workspacePath === 'string' ? normalizeLocalPathForComparison(params.workspacePath) : null;
    if (!workspacePath) return null;

    if (!isSameOrChildPath(normalizedCandidate, workspacePath)) return null;
    const relative = relativizeWorkspacePath(normalizedCandidate, workspacePath);
    if (!isSafeWorkspaceRelativePath(relative)) return null;
    return withOptionalAnchor(relative, parsed);
}
