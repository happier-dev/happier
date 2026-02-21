export function isPublicRouteForUnauthenticated(segments: string[]): boolean {
    // expo-router includes route groups like "(app)" in segments.
    const normalized = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));

    if (normalized.length === 0) return true;
    const first = normalized[0];

    // Home (welcome / login / create account)
    if (first === 'index') return true;

    // Server configuration must be reachable before authentication.
    if (first === 'server') return true;

    // Terminal connect links must be reachable before authentication so users can sign in and continue.
    if (first === 'terminal') return true;

    // Restore / link account flows must work unauthenticated.
    if (first === 'restore') return true;

    // OAuth return routes must be reachable before authentication so the callback can finalize.
    if (first === 'oauth') return true;

    // Public share links must work unauthenticated.
    if (first === 'share') return true;

    return false;
}
