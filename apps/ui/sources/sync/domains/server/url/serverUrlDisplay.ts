import { canonicalizeServerUrl } from './serverUrlCanonical';
import { redactPublicShareCapabilityUrl } from '@happier-dev/protocol';

export function toServerUrlDisplay(raw: string): string {
    const canonical = canonicalizeServerUrl(raw);
    if (!canonical) return '';
    try {
        const parsed = new URL(canonical);
        const port = parsed.port ? `:${parsed.port}` : '';
        const path = redactPublicShareCapabilityUrl(parsed.pathname).replace(/\/+$/, '');
        return `${parsed.protocol}//${parsed.hostname}${port}${path}`;
    } catch {
        return canonical;
    }
}
