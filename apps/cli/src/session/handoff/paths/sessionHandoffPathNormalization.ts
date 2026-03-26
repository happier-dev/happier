import { join } from 'node:path';

export function resolveSessionHandoffLocalHomeDir(params: Readonly<{
    activeServerDir: string;
    fallbackHomeDir: string;
}>): string {
    const activeServerDir = params.activeServerDir.trim().replace(/\/+$/, '');
    const fallbackHomeDir = params.fallbackHomeDir.trim().replace(/\/+$/, '');

    const marker = '/.happier/';
    const markerIndex = activeServerDir.indexOf(marker);
    if (markerIndex > 0) {
        return activeServerDir.slice(0, markerIndex);
    }
    if (markerIndex === 0) {
        return fallbackHomeDir;
    }

    if (activeServerDir.endsWith('/.happier')) {
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
    const homeDir = params.homeDir.trim().replace(/\/+$/, '');

    if (absolutePath === homeDir) {
        return '~';
    }
    if (absolutePath.startsWith(`${homeDir}/`)) {
        return `~/${absolutePath.slice(homeDir.length + 1)}`;
    }
    return absolutePath;
}

export function expandHomeRelativePath(params: Readonly<{
    path: string;
    homeDir: string;
}>): string {
    const path = params.path.trim();
    const homeDir = params.homeDir.trim().replace(/\/+$/, '');

    if (path === '~') {
        return homeDir;
    }
    if (path.startsWith('~/')) {
        return join(homeDir, path.slice(2));
    }
    return path;
}

export function normalizeSessionHandoffTargetPathForLocalMachine(params: Readonly<{
    requestedTargetPath: string;
    homeDir: string;
}>): string {
    const expanded = expandHomeRelativePath({ path: params.requestedTargetPath, homeDir: params.homeDir });
    const homeDir = params.homeDir.trim().replace(/\/+$/, '');

    // Handoff commonly uses app-owned `~/.happier/**` roots. When the request carries an absolute path
    // from another machine (macOS `/Users/...` vs Linux `/home/...`), rebase that `/.happier/` suffix
    // onto the local home dir so the target machine always uses a machine-local writable root.
    const marker = '/.happier/';
    const markerIndex = expanded.indexOf(marker);
    if (markerIndex >= 0) {
        const remainder = expanded.slice(markerIndex + marker.length);
        return join(homeDir, '.happier', remainder);
    }
    if (expanded.endsWith('/.happier')) {
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

    return expanded;
}
