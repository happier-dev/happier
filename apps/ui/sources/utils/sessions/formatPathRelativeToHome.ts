export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const normalizedPath = path;

    if (normalizedPath === normalizedHome) {
        return '~';
    }

    if (normalizedPath.startsWith(`${normalizedHome}/`)) {
        return `~${normalizedPath.slice(normalizedHome.length)}`;
    }

    return path;
}
