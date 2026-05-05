function decodeRouteSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function getSessionRouteSegments(pathname: string): string[] {
    return String(pathname ?? '')
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
}

function isMatchingSessionRouteSegment(segment: string | undefined, sessionId: string): boolean {
    return decodeRouteSegment(segment ?? '') === String(sessionId ?? '').trim();
}

export function isSessionRoutePathActive(pathname: string, sessionId: string): boolean {
    const segments = getSessionRouteSegments(pathname);

    return segments[0] === 'session' && isMatchingSessionRouteSegment(segments[1], sessionId);
}

export function isSessionRootRoutePathActive(pathname: string, sessionId: string): boolean {
    const segments = getSessionRouteSegments(pathname);

    return segments.length === 2
        && segments[0] === 'session'
        && isMatchingSessionRouteSegment(segments[1], sessionId);
}
