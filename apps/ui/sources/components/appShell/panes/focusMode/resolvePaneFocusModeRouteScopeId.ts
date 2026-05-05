export function resolvePaneFocusModeRouteScopeId(pathname: string | null | undefined): string | null {
    if (!pathname) return null;

    const pathWithoutQuery = pathname.split(/[?#]/, 1)[0] ?? '';
    const match = pathWithoutQuery.match(/^\/(?:\(app\)\/)?(session|projects)\/([^/]+)/);
    if (!match) return null;

    const kind = match[1] === 'projects' ? 'project' : 'session';
    const rawId = match[2]!;

    try {
        return `${kind}:${decodeURIComponent(rawId)}`;
    } catch {
        return `${kind}:${rawId}`;
    }
}
