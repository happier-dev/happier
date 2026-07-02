import { isAllowedUri as isAllowedTiptapLinkUri } from '@tiptap/extension-link';

const NATIVE_OPENABLE_PROTOCOLS = new Set([
    'http:',
    'https:',
    'ftp:',
    'ftps:',
    'mailto:',
    'tel:',
    'callto:',
    'sms:',
    'cid:',
    'xmpp:',
]);

/**
 * Normalize a markdown link href to something the native host can safely pass to
 * `Linking.openURL()`. This mirrors TipTap's default validation first, then
 * narrows to absolute schemes React Native can open without a browser-relative
 * base URL.
 */
export function resolveNativeOpenableMarkdownHref(href: string): string | null {
    const trimmedHref = href.trim();
    if (!trimmedHref || !isAllowedTiptapLinkUri(trimmedHref)) {
        return null;
    }

    try {
        const parsedHref = new URL(trimmedHref);
        if (!NATIVE_OPENABLE_PROTOCOLS.has(parsedHref.protocol)) {
            return null;
        }
        return trimmedHref;
    } catch {
        return null;
    }
}
