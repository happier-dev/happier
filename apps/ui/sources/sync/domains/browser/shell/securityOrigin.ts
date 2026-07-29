import type { BrowserControlViewState } from '../control';

/**
 * Presentation model for the toolbar SecurityOriginIndicator. The browser already TRACKS the
 * resolved `securityOrigin` (and the navigated URL) on the view state; this selector is the ONE
 * place that turns those facts into a rendered security posture so the indicator never re-derives
 * scheme/host logic inline.
 *
 * `securityLevel` semantics:
 * - `secure`   — an `https:`/`wss:` origin (shown with a closed-lock affordance).
 * - `local`    — a loopback origin (localhost / 127.0.0.1 / [::1]); trusted-by-locality, not TLS.
 * - `insecure` — a plaintext `http:`/`ws:` non-loopback origin (shown with an open-lock warning).
 * - `internal` — a non-web surface (hosted plugin, simulator preview) where TLS posture is N/A.
 * - `unknown`  — no origin resolved yet (fresh/blank view).
 */
export type BrowserSecurityLevel = 'secure' | 'local' | 'insecure' | 'internal' | 'unknown';

export type BrowserSecurityOriginModel = Readonly<{
    securityLevel: BrowserSecurityLevel;
    /** The host to render (`example.test`, `localhost:5173`), or `null` when unknown. */
    originLabel: string | null;
}>;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
    // 127.0.0.0/8 is entirely loopback.
    return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseOrigin(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

/**
 * Non-web surfaces resolve their TLS posture as `internal` (it is not a TLS question): a hosted
 * plugin webview is host-trusted, a simulator preview is a streamed frame, etc.
 */
function isInternalSurface(view: BrowserControlViewState): boolean {
    return view.target.kind === 'hostedPluginWeb'
        || view.target.kind === 'simulatorPreview'
        || view.target.kind === 'streamedBrowser';
}

export function selectBrowserSecurityOriginModel(
    view: BrowserControlViewState | null,
): BrowserSecurityOriginModel {
    if (!view) {
        return { securityLevel: 'unknown', originLabel: null };
    }

    const source = view.securityOrigin ?? view.currentUrl ?? null;
    const parsed = source ? parseOrigin(source) : null;

    if (isInternalSurface(view)) {
        return {
            securityLevel: 'internal',
            originLabel: parsed ? parsed.host || parsed.hostname || null : null,
        };
    }

    if (!parsed) {
        return { securityLevel: 'unknown', originLabel: null };
    }

    const host = parsed.host || parsed.hostname;
    const originLabel = host.length > 0 ? host : null;

    if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
        return { securityLevel: 'secure', originLabel };
    }

    if ((parsed.protocol === 'http:' || parsed.protocol === 'ws:') && isLoopbackHostname(parsed.hostname)) {
        return { securityLevel: 'local', originLabel };
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') {
        return { securityLevel: 'insecure', originLabel };
    }

    return { securityLevel: 'unknown', originLabel };
}
