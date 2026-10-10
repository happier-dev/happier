import * as React from 'react';
import { Platform } from 'react-native';
import { installWorkspaceBrowserHistory } from '@/components/appShell/workspace/workspaceBrowserTransport';
import { BROWSER_HISTORY_NAVIGATION_CHANGED, readBrowserHistoryNavigationAvailability, type BrowserHistoryNavigationAvailability } from '@/utils/navigation/browserHistoryNavigation';

export type DesktopSidebarHistoryNavigationAvailability = BrowserHistoryNavigationAvailability;
const UNAVAILABLE_NAVIGATION: DesktopSidebarHistoryNavigationAvailability = {
    canNavigateBack: false,
    canNavigateForward: false,
};

function resolveBrowserHistory(): History | null {
    if (Platform.OS !== 'web') {
        return null;
    }
    const history = (globalThis as typeof globalThis & { history?: History }).history;
    if (
        !history
        || typeof history.pushState !== 'function'
        || typeof history.replaceState !== 'function'
    ) {
        return null;
    }
    return history;
}

function resolveBrowserHistoryEventTarget(): Pick<typeof globalThis, 'addEventListener' | 'removeEventListener'> | null {
    if (
        typeof globalThis.addEventListener !== 'function'
        || typeof globalThis.removeEventListener !== 'function'
    ) {
        return null;
    }
    return globalThis;
}

export function useDesktopSidebarHistoryNavigationAvailability(): DesktopSidebarHistoryNavigationAvailability {
    const [availability, setAvailability] = React.useState<DesktopSidebarHistoryNavigationAvailability>(() => {
        const history = resolveBrowserHistory();
        return history ? readBrowserHistoryNavigationAvailability(history) ?? UNAVAILABLE_NAVIGATION : UNAVAILABLE_NAVIGATION;
    });

    React.useEffect(() => {
        const history = resolveBrowserHistory();
        if (!history) {
            setAvailability(UNAVAILABLE_NAVIGATION);
            return undefined;
        }

        installWorkspaceBrowserHistory();
        const updateAvailability = () => {
            setAvailability(readBrowserHistoryNavigationAvailability(history) ?? UNAVAILABLE_NAVIGATION);
        };
        updateAvailability();

        const eventTarget = resolveBrowserHistoryEventTarget();
        eventTarget?.addEventListener('popstate', updateAvailability);
        eventTarget?.addEventListener(BROWSER_HISTORY_NAVIGATION_CHANGED, updateAvailability);

        return () => {
            eventTarget?.removeEventListener('popstate', updateAvailability);
            eventTarget?.removeEventListener(BROWSER_HISTORY_NAVIGATION_CHANGED, updateAvailability);
        };
    }, []);

    return availability;
}
