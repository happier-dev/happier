/**
 * On web, we only want to auto-redirect legacy/root deep-links when the user is
 * actually at the root route; otherwise we'd disrupt navigation.
 *
 * On native, `window` may exist without `window.location` (Hermes/JSC globals),
 * so treat missing location as "allowed" instead of crashing.
 */
export function isAuthenticatedRootDeepLinkRedirectAllowed(): boolean {
    const win = (globalThis as any)?.window;
    const pathnameRaw = win?.location?.pathname;
    const pathname = typeof pathnameRaw === 'string' ? pathnameRaw.trim() : '';

    // Native/hybrid environments: no meaningful pathname, so allow.
    if (!pathname) return true;

    return pathname === '/' || pathname === '/index.html';
}
