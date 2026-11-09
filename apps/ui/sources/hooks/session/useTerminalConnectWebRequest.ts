import * as React from 'react';
import { Platform } from 'react-native';
import { captureTerminalConnect } from '@/auth/terminal/terminalConnectContinuation';
import { getPendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect';
import { consumeTerminalConnectWebBootstrapHash } from '@/utils/path/terminalConnectWebBootstrap';
import { parseTerminalConnectUrl, TERMINAL_CONNECT_WEB_PATH, type ParsedTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { usePendingTerminalConnect } from './usePendingTerminalConnect';

function scrubResumableRequest(request: ParsedTerminalConnectUrl) {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const pending = getPendingTerminalConnect();
    // Custody reads are Home-scoped. Keep the input until the target is focused and resumable.
    if (request.compatibility || (pending?.publicKeyB64Url === request.publicKeyB64Url
        && pending.serverIdentityId === request.serverIdentityId
        && pending.pairing?.secretB64Url === request.pairing?.secretB64Url)) {
        window.history.replaceState(null, '', window.location.pathname);
    }
}

/** Web-only input/bootstrap adapter. Continuation and approval have no browser-location dependency. */
export function useTerminalConnectWebRequest(routeHash: string | undefined) {
    const processedRouteHashRef = React.useRef<string | undefined>(undefined);
    const [request, setRequest] = React.useState<ParsedTerminalConnectUrl | null>(null);
    const [hashProcessed, setHashProcessed] = React.useState(false);
    const pending = usePendingTerminalConnect(hashProcessed && request === null && !routeHash && !processedRouteHashRef.current);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        if (hashProcessed && (!routeHash || processedRouteHashRef.current === routeHash)) return;
        processedRouteHashRef.current = routeHash || window.location.hash || undefined;
        let sourceUrl = routeHash
            ? new URL(`${TERMINAL_CONNECT_WEB_PATH}#${routeHash}`, window.location.href).href
            : window.location.href;
        let parsed = parseTerminalConnectUrl(sourceUrl);
        if (!parsed) {
            try {
                const hash = window.sessionStorage ? consumeTerminalConnectWebBootstrapHash(window.sessionStorage) : null;
                if (hash) {
                    processedRouteHashRef.current = hash;
                    sourceUrl = new URL(`${TERMINAL_CONNECT_WEB_PATH}${hash.startsWith('#') ? hash : `#${hash}`}`, window.location.href).href;
                    parsed = parseTerminalConnectUrl(sourceUrl);
                }
            } catch {
                // The visible URL remains authoritative when browser storage is unavailable.
            }
        }
        if (parsed) {
            if (parsed.compatibility?.admission !== 'update_required') captureTerminalConnect(parsed);
            scrubResumableRequest(parsed);
        }
        setRequest(parsed);
        setHashProcessed(true);
    }, [hashProcessed, routeHash]);
    const scrubIfResumable = React.useCallback(() => {
        if (request) scrubResumableRequest(request);
    }, [request]);
    return { request: request ?? pending, hashProcessed, scrubIfResumable };
}
