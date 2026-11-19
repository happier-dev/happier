import type { AppWindowAddress } from './appWindowBoot';
import { DESTINATION_WINDOW_PATH } from './isDesktopAuxiliaryWindowContext';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type BrowserAppWindowAddress = Extract<AppWindowAddress, { kind: 'destination' | 'paneTab' }>;

export function canOpenBrowserAppWindow(): boolean {
    return typeof window !== 'undefined' && typeof window.open === 'function' && !isDesktopHost();
}

/** Keep the browser's transient user activation and give the new realm no opener. */
export function openBrowserAppWindow(scope: ServerAccountScope, address: BrowserAppWindowAddress): void {
    const params = new URLSearchParams({ serverId: scope.serverId, accountId: scope.accountId, address: JSON.stringify(address) });
    window.open(`${DESTINATION_WINDOW_PATH}?${params}`, '_blank', 'popup,noopener');
}
