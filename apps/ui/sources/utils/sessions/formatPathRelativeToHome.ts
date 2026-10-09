import { t } from '@/text';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const normalizedPath = resolveAbsolutePath(path, normalizedHome).replace(/[\\/]+/g, '/');

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

/** Session workspace labels share one home-directory rule, including the composer chip. */
export function formatSessionPath(path: string, homeDir?: string): string {
    const relativePath = formatPathRelativeToHome(path, homeDir);
    return homeDir && relativePath === '~' ? t('sessions.workspace.noFolder') : relativePath;
}
