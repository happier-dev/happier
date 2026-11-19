import { isDevRouteEnabled } from './devRoutePolicy';

/**
 * The two public Team entries a person opens from a link: an invitation (`/join/:token`) and the
 * Team's own sign-in (`/teams/:teamId/sign-in`). Only these exact leaves; other Team surfaces stay private.
 */
export function isTeamEntryRoute(segments: readonly string[]): boolean {
  const normalized = segments.filter(
    (s) => !(s.startsWith('(') && s.endsWith(')')),
  );
  if (normalized[0] === 'join') return normalized.length === 2;
  return (
    normalized[0] === 'teams' &&
    normalized.length === 3 &&
    normalized[2] === 'sign-in'
  );
}

/** The signed-out welcome (`/`): the one place a person arrives without a task in hand. */
export function isWelcomeRoute(segments: readonly string[]): boolean {
  const normalized = segments.filter(
    (s) => !(s.startsWith('(') && s.endsWith(')')),
  );
  return normalized.length === 0 || normalized[0] === 'index';
}

export function isPublicRouteForUnauthenticated(segments: string[]): boolean {
  // Home (welcome / login / create account)
  if (isWelcomeRoute(segments)) return true;

  // expo-router includes route groups like "(app)" in segments.
  const normalized = segments.filter(
    (s) => !(s.startsWith('(') && s.endsWith(')')),
  );
  const first = normalized[0];

  // Issued account-service callbacks still land at the exact legacy wizard leaf.
  // The former setup index is also public so its root redirect can settle.
  if (first === 'setup') {
    return (
      normalized.length === 1 ||
      (normalized.length === 2 &&
        (normalized[1] === 'index' || normalized[1] === 'wizard'))
    );
  }

  // Server configuration must be reachable before authentication.
  if (first === 'server') return true;

  // /server now forwards to Settings → Homes. This device's saved Homes, connection
  // drafts and recovery must stay reachable after sign-out, including Desktop setup.
  // Home administration and all other Settings routes retain their auth boundary.
  if (first === 'settings' && normalized[1] === 'server') return true;

  // Terminal connect links must be reachable before authentication so users can sign in and continue.
  if (first === 'terminal') return true;

  // Account-connect links must reach their route so signed-out users get recovery guidance.
  if (first === 'account') return true;

  // Restore / link account flows must work unauthenticated.
  if (first === 'restore') return true;

  // OAuth return routes must be reachable before authentication so the callback can finalize.
  if (first === 'oauth') return true;

  // The certificate callback claims the pending sign-in before authentication.
  if (first === 'mtls' && normalized.length === 1) return true;

  // Team invitations and the Team-scoped authentication entry must remain
  // reachable before a Home Account exists. Keep ordinary Team surfaces
  // private: only the exact entry leaf is an unauthenticated destination.
  if (isTeamEntryRoute(segments)) return true;
  // The import landing owns its explicit Home/sign-in continuation. The Source collection stays private.
  if (first === 'projects' && normalized.length === 2 && normalized[1] === 'setup') return true;
  // The account service's sign-in returns to `/homes/sign-in` before this device is signed in to a
  // Home; only that exact leaf is public (Add a Home and the Homes page stay private).
  if (
    first === 'homes' &&
    normalized.length === 2 &&
    normalized[1] === 'sign-in'
  )
    return true;

  // Native verification and password-reset links carry their one-time bearer
  // in the final path segment. Only these exact landing families are public;
  // Account Security and every other /auth surface still require a session.
  if (first === 'auth' && normalized.length === 4) {
    if (normalized[1] === 'email' && normalized[2] === 'verify') return true;
    if (normalized[1] === 'password' && normalized[2] === 'reset') return true;
  }
  if (
    first === 'auth' &&
    normalized.length === 3 &&
    normalized[1] === 'password' &&
    normalized[2] === 'recover'
  )
    return true;

  // Only the exact public-share bearer landing is unauthenticated. Publication
  // does not make sibling or future nested application routes public.
  if (first === 'share' && normalized.length === 2) return true;
  // This landing captures the fragment before sign-in; joining still requires
  // the authenticated Account Action owner and the person's Open gesture.
  if (first === 'share' && normalized[1] === 'artifact' && normalized.length === 3) return true;
  // A people share's landing explains that signing in comes first; admission itself is the
  // authenticated Home's decision, made only after sign-in.
  if (first === 'preview-link' && normalized.length === 2) return true;

  // Desktop activity overlay must stay reachable so the separate Tauri overlay window
  // can bootstrap its own public utility surface before auth state settles.
  if (first === 'desktop' && normalized[1] === 'activity-overlay') return true;

  // The Capture window and the selection layer are thin aux webviews with no Sync: every Account
  // operation they offer runs in the main window, so they never wait on this webview's auth state.
  if (first === 'desktop' && (normalized[1] === 'capture' || normalized[1] === 'capture-selection') && normalized.length === 2) return true;

  // Loaded native terminal acceptance must work from a clean embedded QA build. The screen is
  // still dev-only and exposes deterministic local bytes, not credentials or PTY controls.
  if (isDevRouteEnabled() && first === 'dev' && normalized[1] === 'terminal-qa')
    return true;

  // The agent-setup specimen draws fixture agents through the real components (no account, no
  // machine RPC), so its side by side pairs run from a clean dev browser. Dev builds only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'agent-setup' &&
    normalized.length === 2
  )
    return true;

  // Changes draws captured fixture bytes with inert actions, not account or machine data.
  // Only its exact dev/debug specimen is public so clean-browser visual QA can reach it.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'changes' &&
    normalized.length === 2
  )
    return true;

  // The Scripts specimen draws the Scripts page, project file editor and setup review with fixture
  // inspections and inert controls (no account, no Action). Exact dev/debug route only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'scripts' &&
    normalized.length === 2
  )
    return true;

  // The Find bar specimen draws the shared bar with fixture states and inert callbacks, no account
  // or machine data. Only its exact dev/debug route is public so clean-browser visual QA can reach it.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'find' &&
    normalized.length === 2
  )
    return true;

  // The prompts specimen draws the composer prompt picker and library button with fixture prompts and
  // inert callbacks, no account or machine data. Only its exact dev/debug route is public.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'prompts' &&
    normalized.length === 2
  )
    return true;

  // The screen capture specimen draws the selection layer and Capture window over a stand-in desktop
  // with fixture pictures and inert delivery, no account or machine data. Exact dev/debug route only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'screen-capture' &&
    normalized.length === 2
  )
    return true;

  // The native approvals specimen draws the real approval card and answered line with fixture
  // requests and an inert responder, no account or machine data. Exact dev/debug route only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'native-approvals' &&
    normalized.length === 2
  )
    return true;

  // The media specimen opens the real Media stage on bundled sample pictures with inert edits,
  // no account or machine data. Exact dev/debug route only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    normalized[1] === 'media' &&
    normalized.length === 2
  )
    return true;

  // The Session defaults (loading, failed), Team "Shared with this Team" and New Session model pane specimens
  // draw their real views with fixture states and inert callbacks, no account or machine data. Exact dev/debug routes only.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    (normalized[1] === 'session-defaults' || normalized[1] === 'team-shared' || normalized[1] === 'model-picker-states') &&
    normalized.length === 2
  )
    return true;

  // Static real-component surface QA has no Account data, RPCs or persisted callbacks.
  if (
    isDevRouteEnabled() &&
    first === 'dev' &&
    (normalized[1] === 'soft-surfaces' || normalized[1] === 'glyphs' || normalized[1] === 'first-open') &&
    normalized.length === 2
  )
    return true;

  return false;
}
