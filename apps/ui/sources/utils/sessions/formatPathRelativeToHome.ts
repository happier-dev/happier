export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const normalizedPath = path.replace(/[\\/]+/g, '/');

    if (normalizedPath === normalizedHome || normalizedPath.replace(/[\\/]+$/, '') === normalizedHome) {
        return '~';
    }

    if (!normalizedPath.startsWith(normalizedHome)) {
        return path;
    }

    const remainder = normalizedPath.slice(normalizedHome.length);
    if (!/^[\\/]+/.test(remainder)) {
        return path;
    }

    return `~/${remainder.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/')}`;
}
