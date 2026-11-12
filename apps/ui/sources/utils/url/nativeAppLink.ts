import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { buildAccountConnectRoutePath } from '@/auth/pairing/accountConnectUrl';
import { buildHomeQrInviteRestoreRoutePath } from '@/auth/pairing/pairingUrl';
import { LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PATH } from '@/auth/pairing/legacyPairingUpdateRequiredRoute';
import { resolveTerminalConnectWebHref } from '@/utils/path/terminalConnectUrl';
import { isAcceptedHappierUrlProtocol } from './appScheme';
import { captureNativeArtifactSignedInLinkSecret } from './artifactSignedInLinkSecret';

function resolvePairingSystemPath(path: string): string {
    const link = classifyPairingLink(path);
    switch (link.kind) {
        case 'legacy_pairing': return LEGACY_PAIRING_UPDATE_REQUIRED_RESTORE_ROUTE_PATH;
        case 'home_qr_invite': return buildHomeQrInviteRestoreRoutePath(link.rawLink, 'enter_home') ?? path;
        case 'account_connect': return buildAccountConnectRoutePath(link);
        case 'terminal_connect':
        case 'team_join':
        case 'unknown': return path;
    }
}

/** Expo owns ordinary routes; secret-bearing Artifact links enter custody before routing. */
export function redirectNativeSystemPath({ path }: Readonly<{ path: string; initial: boolean }>): string {
    try {
        // Expo's launcher intent opens Home after selecting its development bundle.
        if (new URL(path).hostname === 'expo-development-client') return '/';
    } catch {
        // Scheme-less Router paths have no development-launcher hostname.
    }
    const systemPath = resolvePairingSystemPath(path);
    if (systemPath !== path) return systemPath;
    const href = resolveNativeAppLinkPath(path);
    if (href && captureNativeArtifactSignedInLinkSecret(path, href)) return href;
    return path;
}

/** One native URI codec for OS Linking and desktop deep-link delivery. */
export function resolveNativeAppLinkHref(url: string): string | null {
    const href = resolveNativeAppLinkPath(url);
    if (href) captureNativeArtifactSignedInLinkSecret(url, href);
    return href;
}

function resolveNativeAppLinkPath(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url, 'https://native.invalid'); } catch { return null; }
    // Universal links already carry their internal route in the pathname.
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return `${parsed.pathname}${parsed.search}`;
    }
    if (!isAcceptedHappierUrlProtocol(parsed.protocol)) return null;
    // Native capture is an intent handled before renderer readiness, like notification activation.
    if (parsed.hostname === 'notification-action' || parsed.hostname === 'capture'
        || (!parsed.hostname && (parsed.pathname === '/capture' || parsed.pathname === '/capture/'))) return null;
    const systemPath = resolvePairingSystemPath(url);
    if (systemPath !== url) return systemPath;
    const terminalHref = resolveTerminalConnectWebHref(url);
    if (terminalHref) return terminalHref;
    const pathname = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
    const path = parsed.hostname ? `/${parsed.hostname}${pathname === '/' ? '' : pathname}` : pathname;
    if (path.startsWith('//')) return null;
    return `${path}${parsed.search}`;
}
