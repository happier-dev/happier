import { isDevRouteEnabled } from './devRoutePolicy';

export function isPublicRouteForUnauthenticated(segments: string[]): boolean {
    // expo-router includes route groups like "(app)" in segments.
    const normalized = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));

    if (normalized.length === 0) return true;
    const first = normalized[0];

    // Home (welcome / login / create account)
    if (first === 'index') return true;

    // Desktop setup/onboarding must be reachable before authentication.
    if (first === 'setup') return true;

    // Server configuration must be reachable before authentication.
    if (first === 'server') return true;

    // Terminal connect links must be reachable before authentication so users can sign in and continue.
    if (first === 'terminal') return true;

    // Account-connect links must reach their route so signed-out users get recovery guidance.
    if (first === 'account') return true;

    // Restore / link account flows must work unauthenticated.
    if (first === 'restore') return true;

    // OAuth return routes must be reachable before authentication so the callback can finalize.
    if (first === 'oauth') return true;

    // Public share links must work unauthenticated.
    if (first === 'share') return true;

    // Desktop activity overlay must stay reachable so the separate Tauri overlay window
    // can bootstrap its own public utility surface before auth state settles.
    if (first === 'desktop' && normalized[1] === 'activity-overlay') return true;

    // The stage performance route must be reachable without credentials because its demo seed
    // guard intentionally refuses to run when real credentials are present. Keep it closed in
    // ordinary production builds because it seeds local demo data.
    if (isDevRouteEnabled() && first === 'dev' && normalized[1] === 'stage-dperf') return true;

    // Loaded native terminal acceptance must work from a clean embedded QA build. The screen is
    // still dev-only and exposes deterministic local bytes, not credentials or PTY controls.
    if (isDevRouteEnabled() && first === 'dev' && normalized[1] === 'terminal-qa') return true;

    return false;
}
