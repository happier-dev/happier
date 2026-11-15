import { redirectSystemPath } from '@/app/+native-intent';
import { invokeTauri, listenTauriEvent } from '@/utils/platform/tauri';
import { buildTerminalConnectWebHref, parseTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { parseHappierCustomSchemeUrl } from '@/utils/url/parseHappierCustomSchemeUrl';

function resolveDesktopHref(url: string): string | null {
    const parsed = parseHappierCustomSchemeUrl(url);
    if (!parsed) return null;
    // The native notification owner admits these commands and wakes its pending-click consumer.
    if (parsed.hostname.toLowerCase() === 'notification-action') return null;

    const systemPath = redirectSystemPath({ path: url, initial: false });
    if (systemPath !== url) return systemPath;

    const terminal = parseTerminalConnectUrl(url);
    if (terminal) return buildTerminalConnectWebHref(terminal);

    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    const path = parsed.hostname ? `/${parsed.hostname}${pathname === '/' ? '' : pathname}` : pathname;
    // A system URL can navigate only inside this webview, never to an external authority.
    return path.startsWith('//') ? null : `${path}${parsed.search}`;
}

/** Native deep-link IPC, using the existing Tauri transport and pairing route owners. */
export function installDesktopDeepLinks(navigate: (href: string) => void): () => void {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let receivedLiveUrl = false;
    const deliver = (urls: string[] | null) => {
        if (disposed) return;
        for (const url of urls ?? []) {
            const href = resolveDesktopHref(url);
            if (href) navigate(href);
        }
    };

    // Subscribe before reading the startup snapshot so a URL arriving during boot isn't lost.
    void listenTauriEvent<string[]>('deep-link://new-url', (urls) => {
        receivedLiveUrl = true;
        deliver(urls);
    }).then(async (stop) => {
        if (disposed) {
            stop();
            return;
        }
        unlisten = stop;
        // tauri-plugin-deep-link 2.4.9's public getCurrent IPC contract.
        const current = await invokeTauri<string[] | null>('plugin:deep-link|get_current');
        if (!receivedLiveUrl) deliver(current);
    }).catch(() => {
        // Pairing URLs contain secrets; do not include payloads or transport error text.
        console.error('Desktop deep-link delivery could not be initialized');
    });

    return () => {
        disposed = true;
        unlisten?.();
    };
}
