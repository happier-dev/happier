import { resolveSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

export function resolvePaneFocusModeRouteScopeId(pathname: string | null | undefined): string | null {
    if (!pathname) return null;

    const pathWithoutQuery = pathname.split(/[?#]/, 1)[0] ?? '';
    const match = pathWithoutQuery.match(/^\/(?:\(app\)\/)?session\/([^/]+)/);
    if (!match) return null;

    try {
        return resolveSessionPaneScopeId(decodeURIComponent(match[1]!));
    } catch {
        return resolveSessionPaneScopeId(match[1]!);
    }
}
