import { realpath, stat } from 'node:fs/promises';
import { extname, posix, resolve, sep } from 'node:path';
import {
    buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
    type PluginHostedWebSecurityPolicyV1,
} from '@happier-dev/protocol/plugins/ui';

export type HostedWebStaticAssetResolveFailureCode =
    | 'asset_not_declared'
    | 'asset_root_escape'
    | 'asset_unavailable'
    | 'directory_listing_disabled'
    | 'invalid_request_path'
    | 'mime_type_not_allowed'
    | 'source_map_unavailable';

export type HostedWebStaticAssetResolveResult =
    | Readonly<{
        ok: true;
        filePath: string;
        relativePath: string;
        contentType: string;
        fallback?: 'spa';
        headers: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        ok: false;
        code: HostedWebStaticAssetResolveFailureCode;
        status: number;
    }>;

export type HostedWebStaticAssetResolveInput = Readonly<{
    installedRoot: string;
    assetRootId: string;
    entryPath: string;
    files: readonly string[];
    digest: string;
    routeMode: 'hostOrigin' | 'pathFallback';
    requestPath: string;
    security: PluginHostedWebSecurityPolicyV1;
    sourceMaps?: Readonly<{
        enabled: boolean;
        allowedDigests?: ReadonlySet<string>;
    }>;
}>;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
});

function failure(code: HostedWebStaticAssetResolveFailureCode, status: number): HostedWebStaticAssetResolveResult {
    return Object.freeze({ ok: false, code, status });
}

function trimArtifactPath(path: string): string {
    return path.trim().replace(/^\/+/u, '').replace(/\/+$/u, '');
}

function normalizeArtifactPath(path: string): string | null {
    const trimmed = trimArtifactPath(path);
    if (trimmed.length === 0) {
        return null;
    }
    const normalized = posix.normalize(trimmed);
    if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
        return null;
    }
    return normalized;
}

function normalizeRequestPath(requestPath: string): Readonly<{ ok: true; path: string; directoryRequest: boolean }>
    | Readonly<{ ok: false }> {
    const rawPath = requestPath.split('?')[0] ?? requestPath;
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch {
        return { ok: false };
    }
    if (decoded.includes('\0')) {
        return { ok: false };
    }
    const directoryRequest = decoded.endsWith('/');
    const trimmed = decoded.replace(/^\/+/u, '');
    if (trimmed.length === 0) {
        return { ok: true, path: '', directoryRequest: false };
    }
    const normalized = normalizeArtifactPath(trimmed);
    return normalized === null ? { ok: false } : { ok: true, path: normalized, directoryRequest };
}

function contentTypeFor(relativePath: string): string | null {
    return MIME_BY_EXTENSION[extname(relativePath).toLowerCase()] ?? null;
}

function isSourceMap(relativePath: string): boolean {
    return relativePath.toLowerCase().endsWith('.map');
}

function canServeSourceMap(input: HostedWebStaticAssetResolveInput): boolean {
    return input.sourceMaps?.enabled === true
        && input.sourceMaps.allowedDigests?.has(input.digest) === true;
}

function hasFileExtension(path: string): boolean {
    return extname(path).length > 0;
}

function isInside(parent: string, child: string): boolean {
    const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
    return child === parent || child.startsWith(normalizedParent);
}

async function resolveContainedFile(params: Readonly<{
    installedRoot: string;
    assetRootId: string;
    relativePath: string;
}>): Promise<Readonly<{ ok: true; filePath: string }> | HostedWebStaticAssetResolveResult> {
    const installedRootReal = await realpath(params.installedRoot);
    const assetRootReal = await realpath(resolve(installedRootReal, params.assetRootId));
    if (!isInside(installedRootReal, assetRootReal)) {
        return failure('asset_root_escape', 403);
    }
    const filePath = resolve(installedRootReal, params.relativePath);
    let filePathReal: string;
    try {
        filePathReal = await realpath(filePath);
    } catch {
        return failure('asset_unavailable', 404);
    }
    if (!isInside(assetRootReal, filePathReal)) {
        return failure('asset_root_escape', 403);
    }
    const fileStat = await stat(filePathReal);
    if (!fileStat.isFile()) {
        return failure('directory_listing_disabled', 404);
    }
    return { ok: true, filePath: filePathReal };
}

export async function resolveHostedWebStaticAssetRequest(
    input: HostedWebStaticAssetResolveInput,
): Promise<HostedWebStaticAssetResolveResult> {
    const assetRootId = normalizeArtifactPath(input.assetRootId);
    const entryPath = normalizeArtifactPath(input.entryPath);
    if (assetRootId === null || entryPath === null) {
        return failure('invalid_request_path', 400);
    }

    const requestPath = normalizeRequestPath(input.requestPath);
    if (!requestPath.ok) {
        return failure('invalid_request_path', 400);
    }
    if (requestPath.directoryRequest && requestPath.path.length > 0) {
        return failure('directory_listing_disabled', 404);
    }

    const requestedRelativePath = requestPath.path.length === 0
        ? entryPath
        : posix.join(assetRootId, requestPath.path);
    const declaredFiles = new Set(input.files.map((file) => normalizeArtifactPath(file)).filter((file): file is string => file !== null));
    const declared = declaredFiles.has(requestedRelativePath);
    const isMap = isSourceMap(requestedRelativePath);
    const sourceMapAllowed = !isMap || canServeSourceMap(input);

    let relativePath = requestedRelativePath;
    let fallback: 'spa' | undefined;
    if (!declared || !sourceMapAllowed) {
        if (isMap && declared && !sourceMapAllowed) {
            return failure('source_map_unavailable', 404);
        }
        if (
            input.routeMode === 'pathFallback'
            && !requestPath.directoryRequest
            && !hasFileExtension(requestPath.path)
            && declaredFiles.has(entryPath)
        ) {
            relativePath = entryPath;
            fallback = 'spa';
        } else {
            return failure('asset_not_declared', 404);
        }
    }

    const contentType = contentTypeFor(relativePath);
    if (!contentType) {
        return failure('mime_type_not_allowed', 415);
    }

    const contained = await resolveContainedFile({
        installedRoot: input.installedRoot,
        assetRootId,
        relativePath,
    });
    if (!contained.ok) {
        return contained;
    }

    return Object.freeze({
        ok: true,
        filePath: contained.filePath,
        relativePath,
        contentType,
        fallback,
        headers: Object.freeze({
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Content-Security-Policy': buildPluginHostedWebStaticAssetContentSecurityPolicyV1(input.security),
            ETag: `"${input.digest}"`,
            'X-Content-Type-Options': 'nosniff',
        }),
    });
}
