import type { SystemTaskSpec } from '@happier-dev/protocol';

import { areServerProfileIdentifiersEquivalent, resolveSavedServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export type ThisComputerSetupScope = Readonly<{
    expectedRelayUrl: string;
    serverId?: string;
    expectedAccountId?: string;
}>;

export function readThisComputerSetupScope(spec: SystemTaskSpec | null): ThisComputerSetupScope | null {
    if (!spec || (spec.kind !== 'setup.thisComputer.v1' && spec.kind !== 'setup.repairThisComputer.v1')) return null;
    const params = spec.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
    const relayUrl = 'activeRelayUrl' in params && typeof params.activeRelayUrl === 'string' ? params.activeRelayUrl : '';
    if (!relayUrl) return null;
    const identity = 'activeServerIdentityId' in params && typeof params.activeServerIdentityId === 'string' ? params.activeServerIdentityId : null;
    const profile = identity ? null : resolveSavedServerProfileByUrl(relayUrl, { includeCanonicalServerUrl: true });
    const serverId = identity ?? (profile?.kind === 'resolved' ? profile.profile.id : null);
    const accountId = 'activeAccountId' in params && typeof params.activeAccountId === 'string' ? params.activeAccountId : null;
    return { expectedRelayUrl: relayUrl, ...(serverId ? { serverId } : {}), ...(accountId ? { expectedAccountId: accountId } : {}) };
}

/** The same Home/account rule serves setup admission and every setup observer. */
export function matchesThisComputerSetupScope(spec: SystemTaskSpec | null, scope: ThisComputerSetupScope): boolean {
    const actual = readThisComputerSetupScope(spec);
    if (!actual) return false;
    const params = spec?.params;
    const identity = params && typeof params === 'object' && !Array.isArray(params)
        && 'activeServerIdentityId' in params && typeof params.activeServerIdentityId === 'string' ? params.activeServerIdentityId : null;
    const profile = identity ? null : resolveSavedServerProfileByUrl(actual.expectedRelayUrl, { includeCanonicalServerUrl: true });
    const matchesHome = identity
        ? identity === scope.serverId || areServerProfileIdentifiersEquivalent(identity, scope.serverId)
        : scope.serverId
            ? profile?.kind === 'resolved' && areServerProfileIdentifiersEquivalent(profile.profile.id, scope.serverId)
            : profile?.kind !== 'ambiguous';
    return createServerUrlComparableKey(actual.expectedRelayUrl) === createServerUrlComparableKey(scope.expectedRelayUrl)
        && matchesHome && (actual.expectedAccountId ?? null) === (scope.expectedAccountId ?? null);
}
