import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

export type ResolvedTranscriptMarkdownFileLink = Readonly<{
    filePath: string;
    line?: number;
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
    column?: number;
}> {
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
    anchor: Readonly<{ line?: number; column?: number }>,
): ResolvedTranscriptMarkdownFileLink {
    return {
        filePath,
        ...(typeof anchor.line === 'number' ? { line: anchor.line } : {}),
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
            if (parsed.host) {
                return `//${parsed.host}${pathname}`;
            }
            return pathname;
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
            return decodeURIComponent(parsed.pathname);
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

export function resolveTranscriptMarkdownFileLink(params: Readonly<{
    url: string;
    workspacePath: string | null | undefined;
}>): ResolvedTranscriptMarkdownFileLink | null {
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
