import { computeSha256HexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';

export const CLAUDE_ACCOUNT_USAGE_PROVIDER_ID = 'claude';

export type ClaudeUsageSubjectKind = 'account' | 'subscription' | 'organization';

export type ClaudeUsageSubjectRef =
    | Readonly<{
        providerId: typeof CLAUDE_ACCOUNT_USAGE_PROVIDER_ID;
        kind: 'providerSubject';
        accountSubjectId: string;
        subjectKind: ClaudeUsageSubjectKind;
        providerOrganizationId?: string;
        proof:
            | 'provider_account_id'
            | 'subscription_id'
            | 'organization_id'
            | 'oauth_account_id'
            | 'oauth_account_uuid';
    }>
    | Readonly<{
        providerId: typeof CLAUDE_ACCOUNT_USAGE_PROVIDER_ID;
        kind: 'provisionalLocalSubject';
        accountSubjectId: string;
        reason: 'missing_stable_provider_subject';
    }>;

export type ResolveClaudeUsageSubjectRefInput = Readonly<{
    providerAccountId?: string | null;
    subscriptionId?: string | null;
    organizationId?: string | null;
    oauthAccountId?: string | null;
    oauthAccountUuid?: string | null;
    provisionalDiscriminator?: string | null;
    accountLabel?: string | null;
}>;

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stableSubject(
    accountSubjectId: string,
    subjectKind: ClaudeUsageSubjectKind,
    proof: Extract<ClaudeUsageSubjectRef, { kind: 'providerSubject' }>['proof'],
    providerOrganizationId?: string,
): ClaudeUsageSubjectRef {
    return {
        providerId: CLAUDE_ACCOUNT_USAGE_PROVIDER_ID,
        kind: 'providerSubject',
        accountSubjectId,
        subjectKind,
        proof,
        ...(providerOrganizationId ? { providerOrganizationId } : {}),
    };
}

function hashProvisionalSubject(discriminator: string): string {
    return computeSha256HexDigest(`claude:${discriminator}`).slice(0, 24);
}

export function resolveClaudeUsageSubjectRef(input: ResolveClaudeUsageSubjectRefInput): ClaudeUsageSubjectRef {
    const subscriptionId = readNonEmptyString(input.subscriptionId);
    if (subscriptionId) return stableSubject(subscriptionId, 'subscription', 'subscription_id');

    const organizationId = readNonEmptyString(input.organizationId);
    const providerAccountId = readNonEmptyString(input.providerAccountId);
    const oauthAccountId = readNonEmptyString(input.oauthAccountId);
    const oauthAccountUuid = readNonEmptyString(input.oauthAccountUuid);
    const userId = providerAccountId ?? oauthAccountId ?? oauthAccountUuid;
    if (userId && organizationId) {
        return stableSubject(userId, 'account', providerAccountId ? 'provider_account_id'
            : oauthAccountId ? 'oauth_account_id' : 'oauth_account_uuid', organizationId);
    }

    const discriminator = readNonEmptyString(input.provisionalDiscriminator);
    if (!discriminator) {
        throw new Error('Claude provisional subject discriminator is required when stable provider subject evidence is unavailable');
    }
    return {
        providerId: CLAUDE_ACCOUNT_USAGE_PROVIDER_ID,
        kind: 'provisionalLocalSubject',
        accountSubjectId: `provisional:${hashProvisionalSubject(discriminator)}`,
        reason: 'missing_stable_provider_subject',
    };
}
