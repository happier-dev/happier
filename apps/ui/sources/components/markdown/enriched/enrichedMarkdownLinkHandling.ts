import { openExternalUrl } from '@/utils/url/openExternalUrl';

export function normalizeMarkdownLinkUrl(raw: string): string | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;

    const lowerTrimmed = trimmed.toLowerCase();
    const candidate = lowerTrimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
    const lower = candidate.toLowerCase();

    // Reject common unsafe URL schemes (XSS on web) and any URL containing whitespace/control characters.
    if (lower.startsWith('javascript:') || lower.startsWith('data:')) return null;
    if (/\s|[\u0000-\u001F\u007F]/.test(candidate)) return null;

    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
        return candidate;
    }

    return null;
}

export async function openMarkdownLinkUrl(raw: string): Promise<void> {
    const normalized = normalizeMarkdownLinkUrl(raw);
    if (!normalized) return;
    await openExternalUrl(normalized);
}
