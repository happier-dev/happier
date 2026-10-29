import { redirectSystemPath } from '@/app/+native-intent';
import { resolveTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { isAcceptedHappierUrlProtocol } from './appScheme';

/** One native URI codec for OS Linking and desktop deep-link delivery. */
export function resolveNativeAppLinkHref(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    // Universal links already carry their internal route in the pathname.
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `${parsed.pathname}${parsed.search}`;
    if (!isAcceptedHappierUrlProtocol(parsed.protocol)) return null;
    if (parsed.hostname === 'notification-action') return null;
    const systemPath = redirectSystemPath({ path: url, initial: false });
    if (systemPath !== url) return systemPath;
    const terminalHref = resolveTerminalConnectWebHref(url);
    if (terminalHref) return terminalHref;
    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    const path = parsed.hostname ? `/${parsed.hostname}${pathname === '/' ? '' : pathname}` : pathname;
    return path.startsWith('//') ? null : `${path}${parsed.search}`;
}
