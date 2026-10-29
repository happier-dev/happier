import { invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { isAcceptedHappierUrlProtocol } from '@/utils/url/appScheme';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';

function resolveDesktopHref(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!isAcceptedHappierUrlProtocol(parsed.protocol)) return null;
    return resolveNativeAppLinkHref(url);
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
    void listenDesktopHostEvent<string[]>('deep-link://new-url', (urls) => {
        receivedLiveUrl = true;
        deliver(urls);
    }).then(async (stop) => {
        if (disposed) {
            stop();
            return;
        }
        unlisten = stop;
        // tauri-plugin-deep-link 2.4.9's public getCurrent IPC contract.
        const current = await invokeDesktopHost<string[] | null>('plugin:deep-link|get_current');
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
