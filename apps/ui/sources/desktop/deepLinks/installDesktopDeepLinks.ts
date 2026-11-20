import { isTeamEntryRoute, isTerminalConnectEntryRoute } from '@/auth/routing/authRouting';
import { desktopHostKind, getDesktopHostWindowLabel, invokeDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { isAcceptedHappierUrlProtocol } from '@/utils/url/appScheme';
import { resolveNativeAppLinkHref } from '@/utils/url/nativeAppLink';

function resolveDesktopHref(url: string): string | Promise<string | null> | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (!isAcceptedHappierUrlProtocol(parsed.protocol)) return null;
    const href = resolveNativeAppLinkHref(url);
    const providerPath = href?.match(/^\/oauth\/([^/?#]+)(?:[?#]|$)/)?.[1];
    if (!href || !providerPath || parsed.searchParams.get('flow') !== 'auth') return href;
    return admitOAuthReturn(href, providerPath, parsed.searchParams);
}

/** Keep cancelled or superseded browser returns from taking over the current sign-in UI. */
async function admitOAuthReturn(href: string, providerPath: string, params: URLSearchParams): Promise<string | null> {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const provider = decodeURIComponent(providerPath).toLowerCase();
    const attempt = params.get('desktopAttemptId') ?? undefined;
    if (params.get('purpose') === 'account_directory') {
        const endpoint = params.get('endpointUrl');
        const serverIdentityId = params.get('endpointServerIdentityId');
        if (!endpoint || !serverIdentityId) return attempt === undefined ? href : null;
        const pending = await TokenStorage.getPendingAccountDirectoryAuth({ endpoint, serverIdentityId });
        if (attempt === undefined && pending?.desktopAttemptId === undefined) return href;
        return pending?.provider === provider && pending.desktopAttemptId === attempt ? href : null;
    }
    const pending = await TokenStorage.readPendingExternalAuthContinuationState();
    if (attempt === undefined && pending.value?.desktopAttemptId === undefined) return href;
    return !pending.serverMismatch && pending.value?.provider === provider
        && pending.value.desktopAttemptId === attempt ? href : null;
}

function startDesktopLinkDelivery(navigate: (href: string) => void) {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let receivedLiveUrl = false;
    const deliver = (urls: string[] | null) => {
        if (disposed) return;
        for (const url of urls ?? []) {
            const href = resolveDesktopHref(url);
            if (typeof href === 'string') navigate(href);
            else if (href) void href.then((admitted) => {
                if (admitted && !disposed) navigate(admitted);
            }).catch(() => {
                console.error('Desktop OAuth return could not be admitted');
            });
        }
    };

    // Subscribe before reading the startup snapshot so a URL arriving during boot isn't lost.
    const ready = listenDesktopHostEvent<string[]>('deep-link://new-url', (urls) => {
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

    const stop = () => {
        disposed = true;
        unlisten?.();
    };
    return { ready, stop };
}

/** Seed the admitted startup leaf before the router reads its first address. */
export function prepareDesktopStartupRoute(seed: (href: string) => void) {
    const pending: string[] = [];
    let navigate: ((href: string) => void) | undefined;
    const delivery = startDesktopLinkDelivery(href => {
        if (navigate) navigate(href);
        else pending.push(href);
    });
    const ready = delivery.ready.then(() => {
        const last = pending.length - 1;
        const href = pending[last];
        if (href === undefined) return;
        const segments = href.split(/[?#]/, 1)[0].split('/').filter(Boolean);
        if (isTeamEntryRoute(segments) || isTerminalConnectEntryRoute(segments)) {
            seed(href);
            pending.length = 0;
        }
    });
    return {
        ready,
        attach(next: (href: string) => void) {
            navigate = next;
            for (const href of pending.splice(0)) next(href);
            return () => { if (navigate === next) navigate = undefined; };
        },
        stop: delivery.stop,
    };
}

let startup: ReturnType<typeof prepareDesktopStartupRoute> | undefined;

export function prepareTauriMainStartupRoute(): Promise<void> | undefined {
    if (typeof window === 'undefined' || desktopHostKind() !== 'tauri' || getDesktopHostWindowLabel() !== 'main') return;
    startup ??= prepareDesktopStartupRoute(href => window.history.replaceState(window.history.state, '', href));
    return startup.ready;
}

/** Native deep-link IPC, using the existing Tauri transport and pairing route owners. */
export function installDesktopDeepLinks(navigate: (href: string) => void): () => void {
    return startup?.attach(navigate) ?? startDesktopLinkDelivery(navigate).stop;
}
