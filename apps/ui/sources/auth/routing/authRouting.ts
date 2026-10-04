import { isDevRouteEnabled } from './devRoutePolicy';

export function isPublicRouteForUnauthenticated(segments: string[]): boolean {
    // expo-router includes route groups like "(app)" in segments.
    const normalized = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));

    if (normalized.length === 0) return true;
    const first = normalized[0];

    // Home (welcome / login / create account)
    if (first === 'index') return true;

    // Issued account-service callbacks still land at the exact legacy wizard leaf.
    // The former setup index is also public so its root redirect can settle.
    if (first === 'setup') {
        return normalized.length === 1
            || (normalized.length === 2 && (normalized[1] === 'index' || normalized[1] === 'wizard'));
    }

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

    // Team invitations and the Team-scoped authentication entry must remain
    // reachable before a Home Account exists. Keep ordinary Team surfaces
    // private: only the exact entry leaf is an unauthenticated destination.
    if (first === 'join' && normalized.length === 2) return true;
    if (first === 'teams' && normalized.length === 3 && normalized[2] === 'sign-in') return true;
    // The account service's sign-in returns to `/homes/sign-in` before this device is signed in to a
    // Home; only that exact leaf is public (Add a Home and the Homes page stay private).
    if (first === 'homes' && normalized.length === 2 && normalized[1] === 'sign-in') return true;

    // Native verification and password-reset links carry their one-time bearer
    // in the final path segment. Only these exact landing families are public;
    // Account Security and every other /auth surface still require a session.
    if (first === 'auth' && normalized.length === 4) {
        if (normalized[1] === 'email' && normalized[2] === 'verify') return true;
        if (normalized[1] === 'password' && normalized[2] === 'reset') return true;
    }
    if (first === 'auth' && normalized.length === 3
        && normalized[1] === 'password' && normalized[2] === 'recover') return true;

    // Only the exact public-share bearer landing is unauthenticated. Publication
    // does not make sibling or future nested application routes public.
    if (first === 'share' && normalized.length === 2) return true;

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

    // The agent-setup specimen draws fixture agents through the real components (no account, no
    // machine RPC), so its side by side pairs run from a clean dev browser. Dev builds only.
    if (isDevRouteEnabled() && first === 'dev' && normalized[1] === 'agent-setup' && normalized.length === 2) return true;

    // Changes draws captured fixture bytes with inert actions, not account or machine data.
    // Only its exact dev/debug specimen is public so clean-browser visual QA can reach it.
    if (isDevRouteEnabled() && first === 'dev' && normalized[1] === 'changes' && normalized.length === 2) return true;

    return false;
}
