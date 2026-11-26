import { parseAccountApiTokenBearerV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { parseTokenPayload } from '@/utils/auth/parseToken';

export type CredentialAuthorityKind = 'account' | 'terminal' | 'api_token' | 'none';

/** Installed credentials still authenticate at the Home; this projection never verifies a bearer. */
export function readCredentialAuthorityKind(token: string | null | undefined): CredentialAuthorityKind {
    if (!token) return 'none';
    if (parseAccountApiTokenBearerV1(token)) return 'api_token';
    try {
        const kind = readAuthTokenProvenance(parseTokenPayload(token), { allowLegacyHome: true })?.provenance.kind;
        return kind === 'account' || kind === 'terminal' ? kind : 'none';
    } catch {
        return 'none';
    }
}

/**
 * A released 0.2 pre-marker Account bearer. Homes still admit it on ordinary routes but
 * refuse it on route families that require signed provenance (Teams).
 */
export function isLegacyHomeAccountToken(token: string): boolean {
    if (parseAccountApiTokenBearerV1(token)) return false;
    try {
        const read = readAuthTokenProvenance(parseTokenPayload(token), { allowLegacyHome: true });
        return read?.legacy === true && read.provenance.kind === 'account';
    } catch {
        return false;
    }
}
