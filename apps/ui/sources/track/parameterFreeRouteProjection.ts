/**
 * `useSegments()` returns Expo Router file-pattern segments, not concrete
 * pathname values. Preserve static file names and project bracket patterns to
 * an opaque placeholder before this route identity reaches analytics/context.
 */
const DYNAMIC_ROUTE_SEGMENT = /^\[\[?(?:\.\.\.)?[^/\]]+\]\]?$/;

export type ParameterFreeRouteProjection = Readonly<{
    route: string;
    segments: readonly string[];
}>;

function normalizeRouteSegment(segment: unknown): string | null {
    if (typeof segment !== 'string') return null;
    const raw = segment.trim();
    if (!raw || raw.startsWith('(')) return null;

    // `useSegments()` normally returns file-pattern segments. The split also
    // makes this safe for alternate router implementations that hand us a
    // pathname-like segment with a query or fragment attached.
    const routeSegment = raw.split(/[?#]/, 1)[0]?.trim() ?? '';
    if (!routeSegment) return null;
    return routeSegment;
}

function projectRouteSegment(segment: string): string {
    return DYNAMIC_ROUTE_SEGMENT.test(segment) ? ':id' : segment;
}

/**
 * Produces the sole route projection shared by analytics and current UI
 * context. It never returns a dynamic value, raw URL, query, or fragment.
 */
export function projectParameterFreeRoute(segments: readonly string[]): ParameterFreeRouteProjection {
    const normalizedSegments = segments
        .map(normalizeRouteSegment)
        .filter((segment): segment is string => segment !== null);
    const projectedSegments = normalizedSegments.map(projectRouteSegment);
    return Object.freeze({
        route: projectedSegments.join('/') || 'home',
        segments: Object.freeze(projectedSegments),
    });
}
