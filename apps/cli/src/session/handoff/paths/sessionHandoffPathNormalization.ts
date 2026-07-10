import { join } from 'node:path';

function trimTrailingSeparators(path: string): string {
    return path.trim().replace(/[\\/]+$/, '');
}

function normalizeRelativePath(relativePath: string): string {
    return relativePath.replace(/[\\/]+/g, '/');
}

function isWindowsAbsolutePath(path: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function normalizePathForComparison(path: string): string {
    const normalizedPath = normalizeRelativePath(trimTrailingSeparators(path));
    return isWindowsAbsolutePath(normalizedPath)
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
    const normalizedBasePath = normalizePathForComparison(basePath);
    const normalizedPath = normalizePathForComparison(path);

    if (normalizedPath === normalizedBasePath) {
        return '';
    }
    if (!normalizedPath.startsWith(normalizedBasePath)) {
        return null;
    }

    const remainder = normalizedPath.slice(normalizedBasePath.length);
    if (!remainder.startsWith('/')) {
        return null;
    }

    return remainder.replace(/^\/+/, '');
}

export function resolveSessionHandoffLocalHomeDir(params: Readonly<{
    activeServerDir: string;
    fallbackHomeDir: string;
}>): string {
    const activeServerDir = trimTrailingSeparators(params.activeServerDir);
    const fallbackHomeDir = trimTrailingSeparators(params.fallbackHomeDir);
    const normalizedActiveServerDir = activeServerDir.replace(/\\/g, '/');

    const marker = '/.happier/';
    const markerIndex = normalizedActiveServerDir.indexOf(marker);
    if (markerIndex > 0) {
        return activeServerDir.slice(0, markerIndex);
    }
    if (markerIndex === 0) {
        return fallbackHomeDir;
    }

    if (normalizedActiveServerDir.endsWith('/.happier')) {
        const prefix = activeServerDir.slice(0, -'/.happier'.length);
        return prefix || fallbackHomeDir;
    }

    return fallbackHomeDir;
}

export function toHomeRelativePath(params: Readonly<{
    absolutePath: string;
    homeDir: string;
}>): string {
    const absolutePath = params.absolutePath.trim();
    const remainder = getPathRemainderWithinBase(absolutePath, params.homeDir);

    if (remainder !== null) {
        return remainder.length > 0 ? `~/${normalizeRelativePath(remainder)}` : '~';
    }
    return absolutePath;
}

export function expandHomeRelativePath(params: Readonly<{
    path: string;
    homeDir: string;
}>): string {
    const path = params.path.trim();
    const homeDir = trimTrailingSeparators(params.homeDir);

    if (path === '~') {
        return homeDir;
    }
    if (path.startsWith('~/') || path.startsWith('~\\')) {
        return join(homeDir, normalizeRelativePath(path.slice(2)));
    }
    return path;
}

export function normalizeSessionHandoffTargetPathForLocalMachine(params: Readonly<{
    requestedTargetPath: string;
    homeDir: string;
}>): string {
    const expanded = expandHomeRelativePath({ path: params.requestedTargetPath, homeDir: params.homeDir });
    const homeDir = trimTrailingSeparators(params.homeDir);
    const normalizedExpanded = expanded.replace(/\\/g, '/');

    if (getPathRemainderWithinBase(expanded, homeDir) !== null) {
        return expanded;
    }

    // Handoff commonly uses app-owned `~/.happier/**` roots. When the request carries an absolute path
    // from another machine (macOS `/Users/...` vs Linux `/home/...`), rebase that `/.happier/` suffix
    // onto the local home dir so the target machine always uses a machine-local writable root.
    const marker = '/.happier/';
    const markerIndex = normalizedExpanded.indexOf(marker);
    if (markerIndex >= 0) {
        const remainder = normalizedExpanded.slice(markerIndex + marker.length);
        return join(homeDir, '.happier', remainder);
    }
    if (normalizedExpanded.endsWith('/.happier')) {
        return join(homeDir, '.happier');
    }

    // General cross-machine normalization: when a caller passes a macOS/Linux home-rooted path
    // (`/Users/<user>/...` or `/home/<user>/...`), rebase the suffix onto the local machine home.
    // This avoids treating a source machine absolute path as portable across machines/OSes.
    const macHomeMatch = expanded.match(/^\/Users\/[^/]+(?:\/(.*))?$/);
    if (macHomeMatch) {
        const remainder = macHomeMatch[1] ?? '';
        return remainder ? join(homeDir, remainder) : homeDir;
    }
    const linuxHomeMatch = expanded.match(/^\/home\/[^/]+(?:\/(.*))?$/);
    if (linuxHomeMatch) {
        const remainder = linuxHomeMatch[1] ?? '';
        return remainder ? join(homeDir, remainder) : homeDir;
    }
    const windowsHomeMatch = normalizedExpanded.match(/^[a-zA-Z]:\/Users\/[^/]+(?:\/(.*))?$/);
    if (windowsHomeMatch) {
        const remainder = windowsHomeMatch[1] ?? '';
        return remainder ? join(homeDir, remainder) : homeDir;
    }

    return expanded;
}
