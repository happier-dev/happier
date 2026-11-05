import { listConnectedAccountsNeedingSignIn } from './connectedAccountsNeedingSignIn';

/**
 * How many connected accounts need a new sign-in — the one "needs you" of connected services (the
 * Usage rail badge, lab G2). Low limits are never counted: they are not something the person must fix.
 * The negotiated list owns transport selection, displayable health and actionable service identity.
 */
export function countConnectedAccountsNeedingSignIn(params: Parameters<typeof listConnectedAccountsNeedingSignIn>[0]): number {
    return listConnectedAccountsNeedingSignIn(params).length;
}
