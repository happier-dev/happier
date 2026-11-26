import { normalizeAuthMethodId } from '@happier-dev/protocol/auth/providers';

import {
  checkAccountRetainsLoginRouteForDecisions,
  readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx,
  resolveEffectiveAccountLoginMethodsForDecisions,
} from '@/app/auth/methods/effectiveAccountLoginMethods';
import { resolveEffectiveHomeAuthMethodsInTx } from '@/app/auth/methods/effectiveHomeAuthMethods';
import { findIdentityProviderBlockers } from '@/app/auth/providers/accountIdentityLifecycle';
import type { Tx } from '@/storage/inTx';

import { readTeamsUsingHomeIdentityMethodsInTx } from './teamIdentityConnectionProjection';

export type IdentityProviderLoginImpact = Readonly<{
  linkedAccounts: number;
  accountsRequiringAlternateLogin: number;
  /** Linked Accounts exist but the current Home authentication decision cannot be read. */
  homeAuthenticationUnavailable: boolean;
}>;

/**
 * Accounts linked to one identity provider, and how many of them currently log
 * in and would have no other route without it. Removing a provider and taking
 * it out of service withdraw the same route, so both decide through here.
 */
export async function readIdentityProviderLoginImpactInTx(
  tx: Tx,
  input: Readonly<{ env: NodeJS.ProcessEnv; providerInstanceId: string }>,
): Promise<IdentityProviderLoginImpact> {
  const identityRows = await findIdentityProviderBlockers(
    tx,
    input.providerInstanceId,
  );
  const accountIds = [...new Set(identityRows.map((row) => row.accountId))];
  if (accountIds.length === 0) {
    return {
      linkedAccounts: 0,
      accountsRequiringAlternateLogin: 0,
      homeAuthenticationUnavailable: false,
    };
  }
  const effectiveHome = await resolveEffectiveHomeAuthMethodsInTx(tx, {
    env: input.env,
  });
  if (effectiveHome.status !== 'ready') {
    return {
      linkedAccounts: accountIds.length,
      accountsRequiringAlternateLogin: 0,
      homeAuthenticationUnavailable: true,
    };
  }
  const [currentFactsByAccountId, remainingFactsByAccountId] =
    await Promise.all([
      readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(tx, {
        accountIds,
        env: input.env,
        excludedProviderId: null,
        identityEligibility: 'current',
      }),
      readAccountLoginViabilityFactsByAccountIdAfterProviderRemovalInTx(tx, {
        accountIds,
        env: input.env,
        excludedProviderId: input.providerInstanceId,
        identityEligibility: 'current',
      }),
    ]);
  let accountsRequiringAlternateLogin = 0;
  for (const accountId of accountIds) {
    const currentFacts = currentFactsByAccountId.get(accountId);
    const remainingFacts = remainingFactsByAccountId.get(accountId);
    if (!currentFacts || !remainingFacts) continue;
    if (
      resolveEffectiveAccountLoginMethodsForDecisions(
        effectiveHome.decisions,
        currentFacts,
      ).viable &&
      !checkAccountRetainsLoginRouteForDecisions(
        effectiveHome.decisions,
        remainingFacts,
      ).ok
    ) {
      accountsRequiringAlternateLogin += 1;
    }
  }
  return {
    linkedAccounts: accountIds.length,
    accountsRequiringAlternateLogin,
    homeAuthenticationUnavailable: false,
  };
}

export type HomeIdentityMethodWithdrawalBlocker =
  | 'team_authentication_policy_in_use'
  | 'account_would_lose_login'
  | 'home_authentication_policy_unavailable';

/**
 * The one refusal for taking a Home identity method out of service: disabling
 * or removing its Home provider, or disabling its Home connection. A Team
 * authentication policy that accepts the method, or an Account whose last
 * current login route it is, keeps it in service.
 */
export async function readHomeIdentityMethodWithdrawalBlockerInTx(
  tx: Tx,
  input: Readonly<{ env: NodeJS.ProcessEnv; providerInstanceId: string }>,
): Promise<HomeIdentityMethodWithdrawalBlocker | null> {
  const methodId = normalizeAuthMethodId(input.providerInstanceId);
  const teams = await readTeamsUsingHomeIdentityMethodsInTx(tx, [methodId]);
  if ((teams.get(methodId)?.length ?? 0) > 0)
    return 'team_authentication_policy_in_use';
  const impact = await readIdentityProviderLoginImpactInTx(tx, input);
  if (impact.homeAuthenticationUnavailable)
    return 'home_authentication_policy_unavailable';
  return impact.accountsRequiringAlternateLogin > 0
    ? 'account_would_lose_login'
    : null;
}
