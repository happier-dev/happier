import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

function trimTrailingSeparators(path: string): string {
    return path.trim().replace(/[\\/]+$/, '');
}

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/[\\/]+/g, '/');
}

function isWindowsAbsolutePath(path: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path);
}

function normalizePathForComparison(path: string): string {
    const normalizedPath = normalizeRelativePath(trimTrailingSeparators(path));
    return isWindowsAbsolutePath(path)
        ? normalizedPath.toLowerCase()
        : normalizedPath;
}

/**
 * Returns the remainder of `path` relative to `basePath` when `path` is `basePath`
 * itself (`''`) or nested within it, otherwise `null`. Windows-safe: drive-letter /
 * absolute Windows paths are case-folded, trailing separators trimmed, mixed `\`/`/`
 * normalized, and sibling-prefix collisions (`C:\Users\alice` vs `C:\Users\alice2`)
 * are rejected. This is the canonical containment owner — do not hand-roll a second
 * normalizer for path containment.
 */
export function getPathRemainderWithinBase(path: string, basePath: string): string | null {
    const displayPath = normalizeRelativePath(trimTrailingSeparators(path));
    const displayBasePath = normalizeRelativePath(trimTrailingSeparators(basePath));
    const normalizedBasePath = normalizePathForComparison(basePath);
    const normalizedPath = normalizePathForComparison(path);

    if (normalizedPath === normalizedBasePath) {
        return '';
    }
    if (!normalizedPath.startsWith(normalizedBasePath)) {
        return null;
    }

    const remainder = displayPath.slice(displayBasePath.length);
    if (!remainder.startsWith('/')) {
        return null;
    }

    return remainder.replace(/^\/+/, '');
}

export function resolveSessionHandoffWorkspaceSessionPath(input: Readonly<{
    targetRoot: string;
    sessionRelativeCwd: string;
}>): string {
    const targetRoot = trimTrailingSeparators(input.targetRoot);
    const relativeCwd = normalizeRelativePath(input.sessionRelativeCwd.trim()).replace(/^\.\/+/, '');
    if (!targetRoot || relativeCwd.startsWith('/') || isWindowsAbsolutePath(relativeCwd)) {
        throw new Error('Workspace session path is not contained by its target repository root');
    }
    const segments = relativeCwd.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (segments.some((segment) => segment === '..')) {
        throw new Error('Workspace session path is not contained by its target repository root');
    }
    if (segments.length === 0) return targetRoot;
    const separator = isWindowsAbsolutePath(targetRoot) ? '\\' : '/';
    return `${targetRoot}${separator}${segments.join(separator)}`;
}

export function expandHomeRelativePath(params: Readonly<{
    path: string;
    homeDir: string;
}>): string {
    return expandHomeDirPath(params.path.trim(), { HOME: params.homeDir, USERPROFILE: params.homeDir });
}

export async function resolveSessionHandoffLocalDirectory(params: Readonly<{
    path: string;
    homeDir: string;
}>): Promise<string | null> {
    const expanded = expandHomeRelativePath(params);
    if (!expanded || expanded.includes('\0') || !isAbsolute(expanded)) return null;
    const absolute = resolve(expanded);
    const canonical = await realpath(absolute).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
        throw error;
    });
    return normalizePathForComparison(canonical);
}
