import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { buildAccountConnectRoutePath } from '@/auth/pairing/accountConnectUrl';
import { buildHomeQrInviteRestoreRoutePath } from '@/auth/pairing/pairingUrl';
import { LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PATH } from '@/auth/pairing/legacyPairingUpdateRequiredRoute';
import { resolveTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { isAcceptedHappierUrlProtocol } from './appScheme';

function resolvePairingSystemPath(path: string): string {
    const link = classifyPairingLink(path);
    switch (link.kind) {
        case 'legacy_pairing':
            return LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PATH;
        case 'home_qr_invite':
            return buildHomeQrInviteRestoreRoutePath(link.rawLink, 'enter_home') ?? path;
        case 'account_connect':
            return buildAccountConnectRoutePath(link);
        case 'terminal_connect':
        case 'team_join':
        case 'unknown':
            return path;
    }
}

/** Expo owns ordinary route normalization; redirect only framework and pairing intents. */
export function redirectNativeSystemPath({ path }: Readonly<{ path: string; initial: boolean }>): string {
    try {
        // Expo's launcher intent opens Home after selecting its development bundle.
        if (new URL(path).hostname === 'expo-development-client') return '/';
    } catch {
        // Relative Router paths pass through to Expo unchanged.
    }
    return resolvePairingSystemPath(path);
}

/** One native URI codec for OS Linking and desktop deep-link delivery. */
export function resolveNativeAppLinkHref(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    // Universal links already carry their internal route in the pathname.
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return `${parsed.pathname}${parsed.search}`;
    if (!isAcceptedHappierUrlProtocol(parsed.protocol)) return null;
    if (parsed.hostname === 'notification-action') return null;
    const systemPath = resolvePairingSystemPath(url);
    if (systemPath !== url) return systemPath;
    const terminalHref = resolveTerminalConnectWebHref(url);
    if (terminalHref) return terminalHref;
    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    const path = parsed.hostname ? `/${parsed.hostname}${pathname === '/' ? '' : pathname}` : pathname;
    return path.startsWith('//') ? null : `${path}${parsed.search}`;
}
