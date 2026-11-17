import type { HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';

import { parseAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { classifyLegacyPairingDeepLink, parseHomeQrInviteDeepLink } from '@/auth/pairing/pairingUrl';
import { parseTerminalConnectUrl, type ParsedTerminalConnectUrl } from '@/utils/path/terminalConnectUrl';
import { parseProjectSourceSetupLink, type ProjectSourceSetupLink } from '@/components/projects/sources/projectSourceNavigation';

export type ClassifiedPairingLink =
    | Readonly<{ kind: 'home_qr_invite'; rawLink: string; invite: HomeQrInviteV2 }>
    | Readonly<{ kind: 'legacy_pairing' }>
    | Readonly<{ kind: 'account_connect'; publicKeyB64Url: string }>
    | Readonly<{ kind: 'terminal_connect'; terminal: ParsedTerminalConnectUrl }>
    /** A Team join link: `path` is its in-app join destination, carrying the bearer and Home target verbatim. */
    | Readonly<{ kind: 'team_join'; path: `/join/${string}` }>
    | (Readonly<{ kind: 'source_setup' }> & ProjectSourceSetupLink)
    | Readonly<{ kind: 'unknown' }>;

const UNKNOWN: ClassifiedPairingLink = Object.freeze({ kind: 'unknown' });

/**
 * The one classifier for a scanned, pasted or deep-linked pairing link.
 *
 * Precedence: a canonical Home QR invite, then a legacy V1 pairing link, then a
 * legacy account-connect link, then a terminal-connect link, then a Team join or Source setup link. The formats do not
 * overlap today; the fixed order keeps every entry point deciding identically
 * if one ever does. Consumers own only their policy for each kind (which kinds
 * they admit, where they route); they never re-parse the link.
 *
 * `expectedInvite` pins a recovery to one exact Home invite: every other link,
 * including another Home's invite, is `unknown`.
 */
export function classifyPairingLink(
    raw: string,
    options?: Readonly<{
        expectedInvite?: Readonly<{ homeServerIdentityId: string; direction: HomeQrInviteV2['direction'] }>;
    }>,
): ClassifiedPairingLink {
    const rawLink = String(raw ?? '').trim();
    if (!rawLink) return UNKNOWN;

    const invite = parseHomeQrInviteDeepLink(rawLink, options?.expectedInvite);
    if (invite) return { kind: 'home_qr_invite', rawLink, invite: invite.invite };
    if (options?.expectedInvite) return UNKNOWN;

    if (classifyLegacyPairingDeepLink(rawLink)) return { kind: 'legacy_pairing' };

    const accountConnect = parseAccountConnectDeepLink(rawLink);
    if (accountConnect) return { kind: 'account_connect', publicKeyB64Url: accountConnect.publicKeyB64Url };

    const terminal = parseTerminalConnectUrl(rawLink);
    if (terminal) return { kind: 'terminal_connect', terminal };

    const teamJoinPath = readTeamJoinPath(rawLink);
    if (teamJoinPath) return { kind: 'team_join', path: teamJoinPath };

    const sourceSetup = parseProjectSourceSetupLink(rawLink);
    if (sourceSetup) return { kind: 'source_setup', ...sourceSetup };

    return UNKNOWN;
}

const TEAM_JOIN_PATH = /\/join\/([^/]+)\/?$/u;

/**
 * The in-app join destination of a Team join link (`buildTeamJoinUrl`: the bearer in the path, the
 * explicit-Home target in the query). Only the shape is recognised here; the join screen validates the
 * token and its Home binding, as it does for a link opened any other way. A link without a Home target
 * is not a join link: one is never issued without it.
 */
function readTeamJoinPath(rawLink: string): `/join/${string}` | null {
    let url: URL;
    try {
        url = new URL(rawLink);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const token = TEAM_JOIN_PATH.exec(url.pathname)?.[1];
    const target = url.searchParams.get('target')?.trim();
    if (!token || !target) return null;
    const targetBinding = url.searchParams.get('targetBinding')?.trim();
    return `/join/${token}?target=${encodeURIComponent(target)}${targetBinding ? `&targetBinding=${encodeURIComponent(targetBinding)}` : ''}`;
}
