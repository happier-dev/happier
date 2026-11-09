import * as React from 'react';

/**
 * The framability verdict for a web external URL embedded in an iframe. Cross-origin framability is
 * NOT detectable synchronously (same-origin policy blocks `contentWindow`/`contentDocument` and the
 * `X-Frame-Options`/CSP `frame-ancestors` response headers are not observable from the parent
 * document). This owner is the single place the web platform decides framable vs. non-framable; the
 * engine selector never decides it.
 *
 * - `pending`: loading, no signal yet.
 * - `slow`: still no signal after {@link WEB_IFRAME_SLOW_HINT_MS}. NOT a refusal: plenty of real
 *   pages take longer than that (a cold dev server, a big bundle). The caller keeps the page and
 *   offers a quiet "Open in your browser" hint; a late `onLoad` still recovers to `framable`.
 * - `framable`: `onLoad` fired and no `onError` — keep the site inline.
 * - `nonFramable`: a positive refusal signal. The iframe's own `onError` is one; the other is the
 *   refusal probe below. The caller renders the non-framable fallback and fulfils the
 *   open-in-system-browser escape hatch.
 *
 * Chromium fires the iframe `load` even for a frame it blocks (`X-Frame-Options`, CSP
 * `frame-ancestors`) and paints its broken-frame page, so an iframe load proves nothing (RU2 J1,
 * github.com). An `<object>` loading the same URL reports `error` for exactly that refusal and `load`
 * for an embeddable page (measured on Chromium 155). The caller renders the hidden {@link
 * WebIframeFramabilityController.probe} while it is set; its refusal wins over an earlier iframe load.
 *
 * A timer used to flip every page slower than 4 s to "This site refuses to be embedded" (H-UX F-15,
 * E-OE F07): a false negative from a timer standing in for a signal. The timer now only decides when
 * to *offer* the escape, never what the page is.
 */
export type WebIframeFramabilityVerdict = 'pending' | 'slow' | 'framable' | 'nonFramable';

/**
 * When a still-loading frame starts offering the escape. A presentation delay, not a limit: long
 * enough that a normal load never flashes the hint, short enough that a user looking at a blank
 * frame is not left without a way out. Nothing is decided or cancelled when it fires.
 */
export const WEB_IFRAME_SLOW_HINT_MS = 4000;

export type WebIframeFramabilityController = Readonly<{
    verdict: WebIframeFramabilityVerdict;
    /** Wire to the iframe `onLoad`. A load at any time concludes the site is framable. */
    onLoad: () => void;
    /** Wire to the iframe `onError`. Concludes the site is non-framable. */
    onError: () => void;
    /**
     * The refusal probe to render as a hidden `<object data={url}>` until it answers, or null. Only
     * for a cross-origin http(s) page: an unsandboxed same-origin `<object>` could read the app.
     */
    probe: Readonly<{ url: string; onLoad: () => void; onError: () => void }> | null;
}>;

function isRefusalProbeEligible(url: string | null): url is string {
    const appOrigin = (globalThis as { location?: { origin?: string } }).location?.origin;
    if (!url || !appOrigin) return false;
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && parsed.origin !== appOrigin;
    } catch {
        return false;
    }
}

/**
 * Track one iframe URL's framability. Resets whenever the URL or `navigationKey` changes so each
 * navigation is judged afresh. `timeoutMs` (the slow-hint delay) is injectable for tests.
 */
export function useWebIframeFramability(params: Readonly<{
    url: string | null;
    navigationKey?: string;
    timeoutMs?: number;
}>): WebIframeFramabilityController {
    const timeoutMs = params.timeoutMs ?? WEB_IFRAME_SLOW_HINT_MS;
    const resetKey = `${params.url ?? ''}:${params.navigationKey ?? ''}`;
    const [verdict, setVerdict] = React.useState<WebIframeFramabilityVerdict>('pending');
    const settledRef = React.useRef(false);
    const [probeAnswered, setProbeAnswered] = React.useState(false);

    React.useEffect(() => {
        settledRef.current = false;
        setVerdict('pending');
        setProbeAnswered(false);
        if (!params.url) {
            return undefined;
        }
        const handle = setTimeout(() => {
            if (settledRef.current) {
                return;
            }
            // Not settled: a late load or error still decides.
            setVerdict('slow');
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

    const onProbeLoad = React.useCallback(() => {
        setProbeAnswered(true);
    }, []);

    // A refusal is a positive signal: it overrides an iframe `load` that may have been the browser's
    // own broken-frame page.
    const onProbeError = React.useCallback(() => {
        settledRef.current = true;
        setProbeAnswered(true);
        setVerdict('nonFramable');
    }, []);

    const probeUrl = !probeAnswered && verdict !== 'nonFramable' && isRefusalProbeEligible(params.url) ? params.url : null;
    const probe = React.useMemo(
        () => (probeUrl ? { url: probeUrl, onLoad: onProbeLoad, onError: onProbeError } : null),
        [probeUrl, onProbeLoad, onProbeError],
    );

    return { verdict, onLoad, onError, probe };
}
