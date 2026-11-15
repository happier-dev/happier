import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import {
    isAbsoluteLocalPath,
    normalizeLocalPathForComparison,
    normalizeRelativeLocalPath,
    normalizeAbsoluteLocalPath,
    resolvePathRelativeToRoot,
} from '@/utils/path/resolvePathRelativeToRoot';
import type { ReviewCommentAnchor, ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { MarkdownImageSource } from '@happier-dev/plugin-ui/components';
import { hasRenderedTextPreview, resolveFileViewerKind } from '@/scm/utils/filePresentation';

export type WorkspaceFileReferenceAnchor = Extract<ReviewCommentAnchor, { kind: 'line' | 'range' }>;

export type ResolvedWorkspaceFileReference = Readonly<{
    filePath: string;
    anchor?: WorkspaceFileReferenceAnchor;
    line?: number;
    endLine?: number;
    column?: number;
}>;

function normalizeRelativePath(value: string): string {
    return normalizeRelativeLocalPath(value.trim());
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
    const trimmed = unquoteGitPath(String(rawUrl ?? '').trim());
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

    // Markdown supplies the authored destination. HTTP links retain their URL
    // identity, including loopback links that open on the Session's Machine.
    if (/^https?:\/\//i.test(trimmed)) return null;

    try {
        return decodeURIComponent(trimmed.replace(/\?[^#]*/, ''));
    } catch {
        return trimmed;
    }
}

function unquoteGitPath(value: string): string {
    if (!value.startsWith('"') || !value.endsWith('"')) return value;
    return value.slice(1, -1).replace(/((?:\\[0-7]{3})+)|\\([\\"tnr])/g, (_match, encoded: string | undefined, escaped: string | undefined) => {
        if (encoded) return new TextDecoder().decode(Uint8Array.from(encoded.match(/[0-7]{3}/g)!.map(octal => Number.parseInt(octal, 8))));
        if (escaped === 't') return '\t';
        if (escaped === 'n') return '\n';
        if (escaped === 'r') return '\r';
        return escaped ?? '';
    });
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

/** Raw file identities retain filename bytes; URL interpretation belongs to the reference boundary below. */
export function resolveWorkspaceFilePath(params: Readonly<{
    path: string;
    workspacePath: string | null | undefined;
    allowOutsideWorkspace?: boolean;
}>): string | null {
    const path = params.path.replace(/\\/g, '/').replace(/^\/+([A-Za-z]:\/)/, '$1');
    const candidate = isAbsoluteLocalPath(path) ? path : normalizeRelativeLocalPath(path);
    if (!candidate || candidate.includes('\0') || candidate === '~' || candidate.startsWith('~/')) return null;
    if (!isAbsoluteLocalPath(candidate)) {
        if (isSafeWorkspaceRelativePath(candidate)) return candidate;
        const root = params.workspacePath?.replace(/\\/g, '/');
        // Keep dot segments until the session's agent root has been mapped onto its machine root.
        return params.allowOutsideWorkspace && root && isAbsoluteLocalPath(root)
            ? `${root.endsWith('/') ? root : `${root}/`}${candidate}` : null;
    }
    const relative = params.workspacePath
        ? resolvePathRelativeToRoot({ path: candidate, root: params.workspacePath, preservePathSpelling: true }) : null;
    if (relative !== null && isSafeWorkspaceRelativePath(relative)) return relative;
    return params.allowOutsideWorkspace ? candidate : null;
}

export function resolveWorkspaceFileReference(params: Readonly<{
    url: string;
    workspacePath: string | null | undefined;
    /** Transcript references may address another readable machine path; rendered documents stay contained. */
    allowOutsideWorkspace?: boolean;
}>): ResolvedWorkspaceFileReference | null {
    const rawPath = readUrlPath(params.url);
    if (!rawPath) return null;
    const location = splitLineSuffix(rawPath);
    if (params.allowOutsideWorkspace && /^[a-z][a-z\d+.-]*:/i.test(location.path)
        && !/^[a-z]:[\\/]/i.test(location.path)) return null;
    const parsed = { ...location, path: location.path.replace(/#.*$/, '') };
    const filePath = resolveWorkspaceFilePath({ path: parsed.path, workspacePath: params.workspacePath,
        allowOutsideWorkspace: params.allowOutsideWorkspace });
    return filePath === null ? null : withOptionalAnchor(filePath, parsed);
}

type WorkspaceMarkdownReferenceInput = Readonly<{
    destination: string;
    workspacePath: string | null | undefined;
    sourceFilePath: string;
}>;

/** Local Markdown paths use URI percent escapes, not renderer-dependent HTML entity decoding. */
export function hasMarkdownPathCharacterReference(value: string): boolean {
    return /&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*;)/i.test(value);
}


function resolveMarkdownLocalReference(input: WorkspaceMarkdownReferenceInput): ResolvedWorkspaceFileReference | null {
    const raw = input.destination.trim();
    if (hasMarkdownPathCharacterReference(raw)) return null;
    if (!raw || /^(?:data|javascript|vbscript|mailto):/i.test(raw)
        || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !/^file:\/\//i.test(raw)) return null;
    if ((raw.startsWith('//') || raw.startsWith('\\\\'))
        && resolvePathRelativeToRoot({ path: raw, root: input.workspacePath ?? '' }) === null) return null;
    const path = readUrlPath(raw);
    const root = normalizeLocalPathForComparison(input.workspacePath ?? '');
    if (!path || !root) return null;
    const rootPrefix = root.endsWith('/') ? root : `${root}/`;
    const parsed = splitLineSuffix(path);
    const candidate = parsed.path.replace(/#.*$/, '').replace(/\\/g, '/');
    if (!candidate || candidate.includes('\0') || candidate.startsWith('~')) return null;
    const absolute = isAbsoluteLocalPath(candidate);
    let joined: string;
    if (/^file:\/\//i.test(raw) || /^[A-Za-z]:\//.test(candidate) || candidate.startsWith('//')) {
        joined = candidate;
    } else if (absolute) {
        // Existing absolute workspace paths retain their meaning; other slash-prefixed Markdown paths are root-relative.
        const contained = resolvePathRelativeToRoot({ path: candidate, root });
        joined = contained === null ? `${rootPrefix}${candidate.replace(/^\/+/, '')}` : candidate;
    } else {
        const source = resolveWorkspaceFileReference({ url: input.sourceFilePath, workspacePath: root });
        if (!source) return null;
        const directory = source.filePath.includes('/') ? source.filePath.slice(0, source.filePath.lastIndexOf('/')) : '';
        joined = `${rootPrefix}${directory ? `${directory}/` : ''}${candidate}`;
    }
    const normalized = normalizeAbsoluteLocalPath(joined);
    const relative = resolvePathRelativeToRoot({ path: normalized, root, preservePathSpelling: true });
    if (!relative || !isSafeWorkspaceRelativePath(relative)) return null;
    return withOptionalAnchor(relative, parsed);
}

export function resolveWorkspaceMarkdownImage(input: WorkspaceMarkdownReferenceInput): MarkdownImageSource {
    const destination = input.destination.trim();
    if (/^https?:\/\//i.test(destination)) {
        try {
            const url = new URL(destination);
            if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'remote', url: destination };
        } catch { /* Invalid URLs stay inert. */ }
        return { kind: 'blocked' };
    }
    if (/^(?:data|javascript|mailto):/i.test(destination)) return { kind: 'blocked' };
    const resolved = resolveMarkdownLocalReference(input);
    return resolved ? { kind: 'workspace', path: resolved.filePath } : { kind: 'blocked' };
}

export type ResolvedWorkspaceMarkdownLink = Readonly<
    | { kind: 'anchor'; anchor: string }
    | { kind: 'external'; url: string }
    | { kind: 'markdown' | 'file'; path: string; line?: number; column?: number }
    | { kind: 'blocked' }
>;

export function resolveWorkspaceMarkdownLink(input: WorkspaceMarkdownReferenceInput): ResolvedWorkspaceMarkdownLink {
    const destination = input.destination.trim();
    if (destination.startsWith('#')) return { kind: 'anchor', anchor: destination.slice(1) };
    if (/^(?:https?:\/\/|mailto:)/i.test(destination)) return { kind: 'external', url: destination };
    const resolved = resolveMarkdownLocalReference(input);
    if (!resolved) return { kind: 'blocked' };
    return {
        kind: hasRenderedTextPreview(resolveFileViewerKind({ path: resolved.filePath }).kind) ? 'markdown' : 'file',
        path: resolved.filePath,
        ...(resolved.line ? { line: resolved.line } : {}),
        ...(resolved.column ? { column: resolved.column } : {}),
    };
}
