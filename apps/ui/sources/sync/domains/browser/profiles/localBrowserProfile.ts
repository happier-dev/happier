import type { BrowserProfileV1 } from '@happier-dev/protocol';

/**
 * Canonical identity of the host-local in-app browser profile. The in-app browser engines
 * (desktop WebKit child view, web iframe, native WebView) are not daemon-backed
 * `chromiumSidecar` surfaces, so they have no daemon-issued profile; they browse under a single
 * persistent, user-owned host profile. This is the profile the target policy
 * ({@link evaluateBrowserTargetPolicy}) evaluates an opened external URL against so the view
 * actually materializes instead of failing closed with `profile_missing`.
 *
 * It is intentionally `user`/`user`-owned (not `session`/`plugin`): the in-app browser is a
 * host-level affordance shared across sessions, and the policy only restricts external-URL
 * browsing for plugin-owned/plugin-storage profiles.
 */
export const LOCAL_BROWSER_PROFILE_ID = 'browser_profile_local';

/**
 * The default host-local browser profile used by the in-app browser surfaces when no explicit
 * profile is supplied. Returned as a stable singleton so memoized seed/selection inputs keyed on
 * the profile reference stay referentially stable across renders.
 */
export const LOCAL_BROWSER_PROFILE: BrowserProfileV1 = {
    profileId: LOCAL_BROWSER_PROFILE_ID,
    storageMode: 'user',
    owner: { kind: 'user', id: 'local' },
    lifecycleState: 'active',
    cleanupOnSessionClose: false,
};

/**
 * Resolve the browser profile the in-app browser surface should use. Prefers an explicitly
 * supplied profile (e.g. a daemon/session-issued one threaded through product models) and falls
 * back to the host-local default for a `null`/`undefined` input, so the surface is never left
 * profile-less (which would deny all external-URL navigation with `profile_missing`). Always
 * returns a usable profile.
 */
export function resolveLocalBrowserProfile(
    explicit?: BrowserProfileV1 | null,
): BrowserProfileV1 {
    return explicit ?? LOCAL_BROWSER_PROFILE;
}
