import { normalizeConnectedServiceCredentialHealthStatus } from '@happier-dev/protocol/connect/connected-service-schemas';

type AccountsProjection = Readonly<{
    connectedAccountsV4?: ReadonlyArray<Readonly<{ status?: unknown }>> | null;
    connectedServicesV2?: ReadonlyArray<Readonly<{ profiles?: ReadonlyArray<Readonly<{ status?: unknown }>> | null }>> | null;
}>;

function needsSignIn(status: unknown): boolean {
    return normalizeConnectedServiceCredentialHealthStatus(status) === 'needs_reauth';
}

/**
 * How many connected accounts need a new sign-in — the one "needs you" of connected services (the
 * Usage rail badge, lab G2). Low limits are never counted: they are not something the person must fix.
 * The account list is read when present; the released profile projection only stands in for it.
 */
export function countConnectedAccountsNeedingSignIn(profile: AccountsProjection): number {
    const accounts = profile.connectedAccountsV4 ?? [];
    if (accounts.length > 0) return accounts.filter((account) => needsSignIn(account.status)).length;
    return (profile.connectedServicesV2 ?? [])
        .flatMap((service) => service.profiles ?? [])
        .filter((entry) => needsSignIn(entry.status))
        .length;
}
