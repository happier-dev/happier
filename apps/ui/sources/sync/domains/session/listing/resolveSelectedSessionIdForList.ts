export function resolveSelectedSessionIdForList(params: Readonly<{
    selectable: boolean;
    pathname: string;
    focusedSessionId?: string | null;
}>): string | null {
    if (!params.selectable) {
        return null;
    }
    const focusedSessionId = String(params.focusedSessionId ?? '').trim();
    if (focusedSessionId) {
        return focusedSessionId;
    }
    if (!params.pathname.startsWith('/session/')) {
        return null;
    }
    const sessionIdCandidate = params.pathname.slice('/session/'.length).split('/')[0] ?? '';
    if (!sessionIdCandidate) {
        return null;
    }
    try {
        const decoded = decodeURIComponent(sessionIdCandidate).trim();
        return decoded || null;
    } catch {
        const trimmed = sessionIdCandidate.trim();
        return trimmed || null;
    }
}
