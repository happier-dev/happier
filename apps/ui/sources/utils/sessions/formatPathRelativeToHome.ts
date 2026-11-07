import { readMachineMemberWorkspaceRelativePathV1 } from '@happier-dev/protocol/machines/agentIsolationV1';

import { t } from '@/text';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * A separated member's workspace is a place of its own, apart from the member's home: its root reads
 * as "Your workspace" and what sits below reads relative to it, the way `~` stands for home. Its digest
 * directory is never shown.
 */
function formatMemberWorkspacePath(path: string): string | null {
    const relative = readMachineMemberWorkspaceRelativePathV1(path);
    if (relative === null) return null;
    const name = t('workspacePresentation.memberWorkspace');
    return relative ? `${name}/${relative.replace(/\/+/g, '/')}` : name;
}

export function formatPathRelativeToHome(
    path: string,
    homeDir?: string | null,
    presentation?: Readonly<{ homeLabel?: string }>,
): string {
    const memberWorkspacePath = formatMemberWorkspacePath(path);
    if (memberWorkspacePath !== null) return memberWorkspacePath;
    // Named folder summaries can recognize literal home aliases before Machine metadata hydrates.
    const home = homeDir || (presentation?.homeLabel === undefined ? undefined : '~');
    if (!home) return path;

    const normalizedHome = home.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const normalizedPath = resolveAbsolutePath(path, normalizedHome).replace(/[\\/]+/g, '/');

    if (normalizedPath === normalizedHome || normalizedPath.replace(/[\\/]+$/, '') === normalizedHome) {
        return presentation?.homeLabel ?? '~';
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

/**
 * Session workspace labels share one home-directory rule, including the composer chip. A path Session
 * at the machine home is `~`; "No folder" belongs only to managed Sessions, which never reach this.
 */
export function formatSessionPath(path: string, homeDir?: string): string {
    // Literal home aliases remain meaningful before the machine's home metadata hydrates.
    return formatPathRelativeToHome(path, homeDir || '~');
}

/**
 * What a Session working in `path` is called when nothing else names it: the folder's own name, and the
 * member workspace by its name rather than its digest. `null` when the path names no folder.
 */
export function readSessionPathName(path: string): string | null {
    const relative = readMachineMemberWorkspaceRelativePathV1(path);
    if (relative === '') return t('workspacePresentation.memberWorkspace');
    return path.split('/').filter(Boolean).pop() ?? null;
}
