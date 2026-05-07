import { isTauriDesktop } from '@/utils/platform/tauri';

function normalizePathname(pathname: string): string {
    if (pathname.length <= 1) {
        return '/';
    }
    return pathname.replace(/\/+$/u, '');
}

export function isDesktopPetOverlayWindowContext(): boolean {
    if (!isTauriDesktop()) {
        return false;
    }
    if (typeof window === 'undefined' || typeof window.location?.href !== 'string') {
        return false;
    }

    try {
        const current = new URL(window.location.href);
        return normalizePathname(current.pathname) === '/desktop/pet-overlay';
    } catch {
        return false;
    }
}
