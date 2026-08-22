import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { findMissingClaudeCodeCredentialScopes } from './scopes.js';

export type ClaudeCodeCredentialHealthStatus =
    | 'ok'
    | 'missing_access_token'
    | 'missing_refresh_token'
    | 'missing_required_scope'
    | 'unsupported_credential_kind'
    | 'unsupported_service';

export type ClaudeCodeCredentialHealth = Readonly<{
    status: ClaudeCodeCredentialHealthStatus;
    missingScopes: readonly string[];
}>;

function isNonBlank(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

export function classifyClaudeCodeCredentialHealth(
    record: OauthCredentialRecord | TokenCredentialRecord,
): ClaudeCodeCredentialHealth {
    if (record.serviceId !== 'claude-subscription') {
        return { status: 'unsupported_service', missingScopes: [] };
    }
    if (record.kind === 'token') {
        return isNonBlank(record.token.token)
            ? { status: 'ok', missingScopes: [] }
            : { status: 'missing_access_token', missingScopes: [] };
    }
    if (record.kind !== 'oauth') {
        return { status: 'unsupported_credential_kind', missingScopes: [] };
    }
    if (!isNonBlank(record.oauth.accessToken)) {
        return { status: 'missing_access_token', missingScopes: [] };
    }
    if (!isNonBlank(record.oauth.refreshToken)) {
        return { status: 'missing_refresh_token', missingScopes: [] };
    }
    const missingScopes = findMissingClaudeCodeCredentialScopes(record.oauth.scope);
    if (missingScopes.length > 0) {
        return { status: 'missing_required_scope', missingScopes };
    }
    return { status: 'ok', missingScopes: [] };
}
