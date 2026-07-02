import { createHash } from 'node:crypto';

export type ClaudeUsageSubjectKind = 'account' | 'subscription' | 'organization';

export type ClaudeUsageSubjectRef =
    | Readonly<{
        providerId: 'claude';
        kind: 'providerSubject';
        accountSubjectId: string;
        subjectKind: ClaudeUsageSubjectKind;
        proof:
            | 'provider_account_id'
            | 'subscription_id'
            | 'organization_id'
            | 'oauth_account_id'
            | 'oauth_account_uuid';
    }>
    | Readonly<{
        providerId: 'claude';
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
): ClaudeUsageSubjectRef {
    return {
        providerId: 'claude',
        kind: 'providerSubject',
        accountSubjectId,
        subjectKind,
        proof,
    };
}

function hashProvisionalSubject(discriminator: string): string {
    return createHash('sha256')
        .update(`claude:${discriminator}`)
        .digest('hex')
        .slice(0, 24);
}

export function resolveClaudeUsageSubjectRef(input: ResolveClaudeUsageSubjectRefInput): ClaudeUsageSubjectRef {
    const subscriptionId = readNonEmptyString(input.subscriptionId);
    if (subscriptionId) return stableSubject(subscriptionId, 'subscription', 'subscription_id');

    const organizationId = readNonEmptyString(input.organizationId);
    if (organizationId) return stableSubject(organizationId, 'organization', 'organization_id');

    const providerAccountId = readNonEmptyString(input.providerAccountId);
    if (providerAccountId) return stableSubject(providerAccountId, 'account', 'provider_account_id');

    const oauthAccountId = readNonEmptyString(input.oauthAccountId);
    if (oauthAccountId) return stableSubject(oauthAccountId, 'account', 'oauth_account_id');

    const oauthAccountUuid = readNonEmptyString(input.oauthAccountUuid);
    if (oauthAccountUuid) return stableSubject(oauthAccountUuid, 'account', 'oauth_account_uuid');

    const discriminator = readNonEmptyString(input.provisionalDiscriminator);
    if (!discriminator) {
        throw new Error('Claude provisional subject discriminator is required when stable provider subject evidence is unavailable');
    }
    return {
        providerId: 'claude',
        kind: 'provisionalLocalSubject',
        accountSubjectId: `provisional:${hashProvisionalSubject(discriminator)}`,
        reason: 'missing_stable_provider_subject',
    };
}
