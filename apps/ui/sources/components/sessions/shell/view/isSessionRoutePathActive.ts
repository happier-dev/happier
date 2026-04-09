export function isSessionRoutePathActive(pathname: string, sessionId: string): boolean {
    const segments = String(pathname ?? '')
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

    return segments[0] === 'session' && segments[1] === String(sessionId ?? '').trim();
}
