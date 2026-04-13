import type { Page } from '@playwright/test';

export async function installFakeTauriDesktopBridge(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as typeof window & {
            __TAURI_INTERNALS__?: {
                invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            };
        }).__TAURI_INTERNALS__ = {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                switch (command) {
                    case 'desktop_fetch_update':
                        return null;
                    case 'desktop_install_update':
                        return false;
                    case 'desktop_set_tray_state':
                        return null;
                    case 'desktop_get_autostart_enabled':
                        return false;
                    case 'desktop_set_autostart_enabled':
                        return Boolean(args?.enabled);
                    default:
                        return null;
                }
            },
        };
    });
}

export async function navigateSpa(page: Page, path: string): Promise<void> {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}
