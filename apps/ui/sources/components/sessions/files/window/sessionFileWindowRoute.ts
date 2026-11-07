import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

/**
 * The route of a window that shows one session file and nothing else (no sidebar, no chat). The
 * desktop shell only opens new windows on this pathname, so keep it in step with
 * `src-tauri/src/file_window.rs`.
 */
export const SESSION_FILE_WINDOW_PATHNAME = '/file-window';

export type SessionFileWindowTarget = Readonly<{
    sessionId: string;
    serverId: string | null;
    path: string;
}>;

export function buildSessionFileWindowHref(target: SessionFileWindowTarget): string {
    const query = new URLSearchParams();
    query.set('sessionId', target.sessionId);
    if (target.serverId) query.set('serverId', target.serverId);
    query.set('path', target.path);
    return `${SESSION_FILE_WINDOW_PATHNAME}?${query.toString()}`;
}

function readParam(value: unknown): string {
    if (Array.isArray(value)) return readParam(value[0]);
    return typeof value === 'string' ? value.trim() : '';
}

export function parseSessionFileWindowParams(params: Readonly<Record<string, unknown>>): SessionFileWindowTarget | null {
    const sessionId = readParam(params.sessionId);
    const path = readParam(params.path);
    if (!sessionId || !isSafeWorkspaceRelativePath(path)) return null;
    const serverId = readParam(params.serverId);
    return { sessionId, serverId: serverId || null, path };
}

/** True in a window opened by "Open in new window" (desktop app or browser tab). */
export function isSessionFileWindowContext(): boolean {
    if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return false;
    try {
        const pathname = new URL(window.location.href).pathname.replace(/\/+$/u, '');
        return pathname === SESSION_FILE_WINDOW_PATHNAME;
    } catch {
        return false;
    }
}
