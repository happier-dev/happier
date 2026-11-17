import { classifyPairingLink } from '@/auth/pairing/classifyPairingLink';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';

export type ParsedOnboardingScanPayload =
    | Readonly<{ kind: 'home_qr_invite'; rawLink: string }>
    | Readonly<{ kind: 'legacy_pairing_update_required' }>
    | Readonly<{ kind: 'account_connect'; publicKeyB64Url: string }>
    | Readonly<{ kind: 'relay_url'; serverUrl: string }>
    | Readonly<{ kind: 'team_join' | 'source_setup'; path: string }>
    | Readonly<{ kind: 'unknown' }>;

function isLikelyRelayUrlCandidate(raw: string): boolean {
    return raw.includes('://') || raw.startsWith('localhost') || raw.startsWith('[') || /[.:]/.test(raw);
}

export function parseOnboardingScanPayload(raw: string): ParsedOnboardingScanPayload {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return { kind: 'unknown' };

    const link = classifyPairingLink(trimmed);
    switch (link.kind) {
        case 'home_qr_invite':
            return { kind: 'home_qr_invite', rawLink: link.rawLink };
        case 'legacy_pairing':
            return { kind: 'legacy_pairing_update_required' };
        case 'account_connect':
            return { kind: 'account_connect', publicKeyB64Url: link.publicKeyB64Url };
        case 'team_join':
        case 'source_setup':
            return { kind: link.kind, path: link.path };
        case 'terminal_connect':
            // A terminal link is not a relay address; onboarding has no terminal step.
            return { kind: 'unknown' };
        case 'unknown':
            break;
    }

    // Not a pairing link: onboarding also accepts a bare relay address.
    if (isLikelyRelayUrlCandidate(trimmed)) {
        const serverUrl = normalizeServerUrl(trimmed);
        if (serverUrl) return { kind: 'relay_url', serverUrl };
    }

    return { kind: 'unknown' };
}
