import { canonicalizeServerUrl } from './serverUrlCanonical';
import { isLoopbackServerUrl } from './serverUrlClassification';

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeShareableServerUrlValidationTarget(raw: string | null | undefined): string | null {
    const canonical = canonicalizeServerUrl(String(raw ?? ''));
    return canonical || null;
}

export function sanitizeServerUrlForShareableLink(raw: string | null | undefined): string | null {
    const canonical = canonicalizeServerUrl(String(raw ?? ''));
    if (!canonical) return null;
    try {
        const parsed = new URL(canonical);
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
        if (isLoopbackServerUrl(parsed.toString())) return null;
        if (parsed.username || parsed.password) {
            parsed.username = '';
            parsed.password = '';
        }
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

export function resolvePreferredShareableServerUrl(params: Readonly<{
    preferredShareableServerUrl?: string | null | undefined;
    canonicalServerUrl: string | null | undefined;
    activeServerUrl: string | null | undefined;
}>): string | null {
    const preferred = sanitizeServerUrlForShareableLink(params.preferredShareableServerUrl);
    if (preferred) return preferred;
    const canonical = sanitizeServerUrlForShareableLink(params.canonicalServerUrl);
    if (canonical) return canonical;
    return sanitizeServerUrlForShareableLink(params.activeServerUrl);
}

export function resolveValidatedShareableServerUrl(params: Readonly<{
    shareableServerUrl?: string | null | undefined;
    validatedAgainstServerUrl?: string | null | undefined;
    currentServerUrl?: string | null | undefined;
}>): string | null {
    const shareableServerUrl = sanitizeServerUrlForShareableLink(params.shareableServerUrl);
    if (!shareableServerUrl) {
        return null;
    }

    const validatedAgainstServerUrl = normalizeShareableServerUrlValidationTarget(params.validatedAgainstServerUrl);
    const currentServerUrl = normalizeShareableServerUrlValidationTarget(params.currentServerUrl);
    if (!validatedAgainstServerUrl || !currentServerUrl) {
        return null;
    }
    return validatedAgainstServerUrl === currentServerUrl
        ? shareableServerUrl
        : null;
}
