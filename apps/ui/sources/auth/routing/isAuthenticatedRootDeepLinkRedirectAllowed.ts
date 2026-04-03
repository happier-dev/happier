export function isAuthenticatedRootDeepLinkRedirectAllowed(): boolean {
    // On native, some environments define `global.window` without a browser-like `location`.
    // Treat missing values as root, and allow redirects.
    const w: any = (globalThis as any).window;
    const pathname = typeof w?.location?.pathname === 'string' ? w.location.pathname : '';
    const normalized = pathname.trim();
    return normalized === '' || normalized === '/' || normalized === '/index.html';
}

