import type { ReviewCommentAnchor } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { isSessionFilePath } from '@/utils/path/isSessionFilePath';
import {
    isAbsoluteLocalPath,
    normalizeLocalPathForComparison,
    resolvePathRelativeToRoot,
} from '@/utils/path/resolvePathRelativeToRoot';

export type ResolvedWorkspaceFileReference = Readonly<{
    filePath: string;
    anchor?: Extract<ReviewCommentAnchor, { kind: 'line' | 'range' }>;
    line?: number;
    endLine?: number;
    column?: number;
}>;

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

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
    const normalizedAnchor = typeof anchor.line === 'number'
        ? typeof anchor.endLine === 'number' && anchor.endLine > anchor.line
            ? { kind: 'range' as const, filePath, startLine: anchor.line, endLine: anchor.endLine }
            : { kind: 'line' as const, filePath, line: anchor.line }
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

export function resolveWorkspaceFileReference(params: Readonly<{
    url: string;
    workspacePath: string | null | undefined;
}>): ResolvedWorkspaceFileReference | null {
    const rawPath = readUrlPath(params.url);
    if (!rawPath) return null;

    const parsed = splitLineSuffix(rawPath);
    if (/^[a-z][a-z0-9+.-]*:/i.test(parsed.path) && !/^[a-z]:[\\/]/i.test(parsed.path)) return null;
    const normalizedCandidate = normalizeLocalPathForComparison(parsed.path);
    if (!normalizedCandidate || /[\u0000-\u001f\u007f]/.test(normalizedCandidate)) return null;

    const workspacePath = typeof params.workspacePath === 'string' ? normalizeLocalPathForComparison(params.workspacePath) : null;

    if (!isAbsoluteLocalPath(normalizedCandidate)) {
        const relative = normalizeRelativePath(normalizedCandidate);
        if (isSafeWorkspaceRelativePath(relative)) return withOptionalAnchor(relative, parsed);
        if (!workspacePath || !isAbsoluteLocalPath(workspacePath) || relative.startsWith('~')) return null;
        // Keep resolution at the machine boundary, including its platform and container mapping.
        const absolute = `${workspacePath.replace(/\/$/, '')}/${relative}`;
        return isSessionFilePath(absolute) ? withOptionalAnchor(absolute, parsed) : null;
    }

    if (!isSessionFilePath(normalizedCandidate)) return null;
    const relative = workspacePath ? resolvePathRelativeToRoot({ path: normalizedCandidate, root: workspacePath }) : null;
    if (relative !== null && isSafeWorkspaceRelativePath(relative)) return withOptionalAnchor(relative, parsed);
    return withOptionalAnchor(normalizedCandidate, parsed);
}
