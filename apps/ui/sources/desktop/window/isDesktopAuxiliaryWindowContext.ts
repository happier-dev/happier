import type { DesktopGlassPanelLabel } from '@/utils/platform/desktopGlassMaterial';
import { isDesktopHost } from '@/utils/platform/desktopHost';

export type DesktopWindowContext = Readonly<{
    role: 'primary' | 'secondary' | 'presenter';
    chrome: 'full' | 'destination';
}>;

const PRIMARY: DesktopWindowContext = { role: 'primary', chrome: 'full' };
const SECONDARY_FULL: DesktopWindowContext = { role: 'secondary', chrome: 'full' };
const SECONDARY_DESTINATION: DesktopWindowContext = { role: 'secondary', chrome: 'destination' };
const PRESENTER: DesktopWindowContext = { role: 'presenter', chrome: 'destination' };
export const DESTINATION_WINDOW_PATH = '/desktop/window';
let bootWindow: Window | undefined;
let bootContext: DesktopWindowContext = PRIMARY;

function windowPathname(): string | null {
    if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return null;
    try {
        return new URL(window.location.href).pathname.replace(/\/+$/u, '');
    } catch {
        return null;
    }
}

/** The boot route owns the realm's data role and chrome for both hosts. */
export function resolveDesktopWindowContext(): DesktopWindowContext {
    if (typeof window === 'undefined') return PRIMARY;
    if (bootWindow === window) return bootContext;
    bootWindow = window;
    const pathname = windowPathname();
    bootContext = pathname === DESTINATION_WINDOW_PATH ? SECONDARY_DESTINATION
        : isDesktopHost() ? resolveNativeBootPathnameContext(pathname) : PRIMARY;
    return bootContext;
}

function resolveNativeBootPathnameContext(pathname: string | null): DesktopWindowContext {
    switch (pathname) {
        case '/desktop/app-window': return SECONDARY_FULL;
        case '/desktop/activity-overlay':
        case '/desktop/pet-overlay':
        case '/desktop/capture':
        case '/desktop/opening':
        case '/desktop/capture-selection': return PRESENTER;
        default: return PRIMARY;
    }
}

/** Presenter compatibility API: secondary app windows own ordinary authenticated data. */
export function isDesktopAuxiliaryWindowContext(): boolean {
    return resolveDesktopWindowContext().role === 'presenter';
}

/**
 * Whether this webview is a floating panel that shows the main window's glass behind its card
 * (`GLASS_PANEL_WINDOW_LABELS` in `window_chrome.rs`). The selection layer's dim is not a glass surface.
 */
export function resolveDesktopGlassPanelLabel(): DesktopGlassPanelLabel | null {
    if (!isDesktopHost()) return null;
    switch (windowPathname()) {
        case '/desktop/capture': return 'capture';
        case '/desktop/activity-overlay': return 'activity_overlay';
        default: return null;
    }
}
