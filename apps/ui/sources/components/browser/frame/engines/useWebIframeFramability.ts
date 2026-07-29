import * as React from 'react';

/**
 * The framability verdict for a web external URL embedded in an iframe. Cross-origin framability is
 * NOT detectable synchronously (same-origin policy blocks `contentWindow`/`contentDocument` and the
 * `X-Frame-Options`/CSP `frame-ancestors` response headers are not observable from the parent
 * document). The ONLY viable client-side signal is the load-vs-timeout heuristic on the iframe's
 * existing `onLoad`/`onError` handlers (BRW-4 / §3.4): this owner is the single place the web
 * platform decides framable vs. non-framable; the engine selector never decides it.
 *
 * - `pending`: still within the detection window, awaiting `onLoad`/`onError`.
 * - `framable`: `onLoad` fired before the timeout and no `onError` — keep the site inline.
 * - `nonFramable`: the window elapsed with no `onLoad`, OR `onError` fired (the typical signature of
 *   an `X-Frame-Options: DENY`/CSP-blocked frame, which the browser refuses to render without
 *   surfacing a readable error). The caller renders the non-framable fallback and fulfils the
 *   open-in-system-browser escape hatch.
 */
export type WebIframeFramabilityVerdict = 'pending' | 'framable' | 'nonFramable';

export const WEB_IFRAME_FRAMABILITY_TIMEOUT_MS = 4000;

export type WebIframeFramabilityController = Readonly<{
    verdict: WebIframeFramabilityVerdict;
    /** Wire to the iframe `onLoad`. A load within the window concludes the site is framable. */
    onLoad: () => void;
    /** Wire to the iframe `onError`. Concludes the site is non-framable. */
    onError: () => void;
}>;

/**
 * Drive the load-vs-timeout framability heuristic for a single iframe URL. Resets whenever the URL
 * or `navigationKey` changes so each navigation is judged afresh. `timeoutMs` is injectable for
 * deterministic tests.
 */
export function useWebIframeFramability(params: Readonly<{
    url: string | null;
    navigationKey?: string;
    timeoutMs?: number;
}>): WebIframeFramabilityController {
    const timeoutMs = params.timeoutMs ?? WEB_IFRAME_FRAMABILITY_TIMEOUT_MS;
    const resetKey = `${params.url ?? ''}:${params.navigationKey ?? ''}`;
    const [verdict, setVerdict] = React.useState<WebIframeFramabilityVerdict>('pending');
    const settledRef = React.useRef(false);

    React.useEffect(() => {
        settledRef.current = false;
        setVerdict('pending');
        if (!params.url) {
            return undefined;
        }
        const handle = setTimeout(() => {
            if (settledRef.current) {
                return;
            }
            settledRef.current = true;
            setVerdict('nonFramable');
        }, timeoutMs);
        return () => {
            clearTimeout(handle);
        };
        // resetKey captures url + navigationKey; timeoutMs is stable per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey, timeoutMs]);

    const onLoad = React.useCallback(() => {
        if (settledRef.current) {
            return;
        }
        settledRef.current = true;
        setVerdict('framable');
    }, []);

    const onError = React.useCallback(() => {
        if (settledRef.current) {
            return;
        }
        settledRef.current = true;
        setVerdict('nonFramable');
    }, []);

    return { verdict, onLoad, onError };
}
