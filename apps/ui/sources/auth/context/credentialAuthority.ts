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
