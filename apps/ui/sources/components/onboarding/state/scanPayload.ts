import { parseAccountConnectDeepLink } from '@/auth/pairing/accountConnectUrl';
import { parsePairingDeepLink } from '@/auth/pairing/pairingUrl';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';

export type ParsedOnboardingScanPayload =
    | Readonly<{ kind: 'pairing_link'; pairId: string; secret: string; serverUrl: string | null }>
    | Readonly<{ kind: 'account_connect'; publicKeyB64Url: string }>
    | Readonly<{ kind: 'relay_url'; serverUrl: string }>
    | Readonly<{ kind: 'unknown' }>;

function isLikelyRelayUrlCandidate(raw: string): boolean {
    return raw.includes('://') || raw.startsWith('localhost') || raw.startsWith('[') || /[.:]/.test(raw);
}

export function parseOnboardingScanPayload(raw: string): ParsedOnboardingScanPayload {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return { kind: 'unknown' };

    const pairing = parsePairingDeepLink(trimmed);
    if (pairing) {
        return {
            kind: 'pairing_link',
            pairId: pairing.pairId,
            secret: pairing.secret,
            serverUrl: pairing.serverUrl,
        };
    }

    const accountConnect = parseAccountConnectDeepLink(trimmed);
    if (accountConnect) {
        return {
            kind: 'account_connect',
            publicKeyB64Url: accountConnect.publicKeyB64Url,
        };
    }

    if (isLikelyRelayUrlCandidate(trimmed)) {
        const serverUrl = normalizeServerUrl(trimmed);
        if (serverUrl) {
            return {
                kind: 'relay_url',
                serverUrl,
            };
        }
    }

    return { kind: 'unknown' };
}
