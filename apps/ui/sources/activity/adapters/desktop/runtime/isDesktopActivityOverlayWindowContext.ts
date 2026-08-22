import { isDesktopHost } from '@/utils/platform/desktopHost';

function normalizePathname(pathname: string): string {
    if (pathname.length <= 1) {
        return '/';
    }
    return pathname.replace(/\/+$/u, '');
}

export function isDesktopActivityOverlayWindowContext(): boolean {
    if (!isDesktopHost()) {
        return false;
    }
    if (typeof window === 'undefined' || typeof window.location?.href !== 'string') {
        return false;
    }

    try {
        const current = new URL(window.location.href);
        // The overlay window is intentionally owned by a dedicated route path.
        // Keep the path itself as the canonical marker so the window still stays
        // recognized if a navigation step drops the auxiliary query string.
        return normalizePathname(current.pathname) === '/desktop/activity-overlay';
    } catch {
        return false;
    }
}
