import type { TeamAcceptedAuthenticationV1 } from '@happier-dev/protocol/auth/teamAuthenticationPolicy';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { describeOAuthProvider } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';

import { readCurrentRouteAddress } from '@/components/appShell/workspace/currentRouteLocation';

import { teamSignInOrigin, teamSignInReturnPath } from './teamSignInHome';

/**
 * The sign-ins a Team accepts, each named as it reads inside a sentence ("your Recovery key", "your email and
 * password"), never by its settings title, and joined as one natural list.
 */
export function teamAcceptedSignInNames(
  accepted: readonly TeamAcceptedAuthenticationV1[],
): string {
  const names = accepted.map((reference) => {
    if (reference.kind === 'team_connection')
      return t('teams.errors.signInMethodTeamConnection');
    switch (reference.methodId.toLowerCase()) {
      case 'key_challenge':
        return t('teams.errors.signInMethodRecoveryKey');
      case 'email_password':
        return t('teams.errors.signInMethodEmailPassword');
      case 'mtls':
        return t('teams.errors.signInMethodCertificate');
      default:
        return t('teams.errors.signInMethodProvider', {
          provider: describeOAuthProvider(reference.methodId).providerName,
        });
    }
  });
  return [...new Set(names)].join(t('teams.errors.signInMethodsOr'));
}

/**
 * A Team refused because the current sign-in does not meet its rule: which sign-in it needs and the one
 * step that meets it, the Team's own sign-in. Asking again could only be refused again, so it is not retryable.
 * The sign-in returns to the page it was opened from (read when pressed), so the same Share or Start can follow.
 */
export function presentTeamSignInRequired(
  input: Readonly<{
    code: string;
    teamId: string;
    serverId: string;
    /** The Team's accepted sign-ins as this member reads them; empty when not known here. */
    accepted: readonly TeamAcceptedAuthenticationV1[];
    navigate: (href: string) => void;
  }>,
): Readonly<{
  code: string;
  message: string;
  retryable: false;
  action: Readonly<{ label: string; onPress: () => void }>;
}> {
  const methods = teamAcceptedSignInNames(input.accepted);
  return {
    code: input.code,
    message: methods
      ? t('teams.errors.signInRequired', { methods })
      : t('session.access.authenticationRequired'),
    retryable: false,
    action: {
      label: t('teams.errors.signInRequiredAction'),
      onPress: () =>
        input.navigate(
          teamSignInReturnPath({
            teamId: input.teamId,
            serverId: input.serverId,
            // Read when pressed: the page and only the parameters that reopen it.
            returnTo: teamSignInOrigin(readCurrentRouteAddress()),
          }),
        ),
    },
  };
}

/**
 * A Home that refuses Teams to a released 0.2 sign-in: the outcome in one sentence and the one step, signing in
 * again. The step is the Home's own sign-out, through its confirmation (signing out forgets this sign-in on the
 * device, so it is never one press), after which the person signs in again as on any signed-out Home.
 */
export function presentTeamSignInOutdated(
  input: Readonly<{ code: string; serverId: string }>,
): Readonly<{
  code: string;
  message: string;
  retryable: false;
  action: Readonly<{ label: string; onPress: () => void }>;
}> {
  return {
    code: input.code,
    message: t('teams.errors.signInOutdated'),
    retryable: false,
    action: {
      label: t('teams.errors.signInAgainAction'),
      onPress: () => { void signOutToSignInAgain(input.serverId); },
    },
  };
}

async function signOutToSignInAgain(serverId: string): Promise<void> {
  // The Account signed in on that Home when pressed; nothing is signed out for an Account no longer there.
  const scope = readCurrentServerCredentialAccountScopeLifetime(serverId)?.scope;
  if (!scope) return;
  const result = await createFrontDoorActionExecute()(
    'account.signOut',
    { serverId: scope.serverId, accountId: scope.accountId },
    { surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId },
  );
  if (result.ok || isActionApprovalDeclinedErrorCode(result.errorCode)) return;
  alertActionFailure({
    reason: resolveActionExecutionFailureMessage(result, t('errors.operationFailed')),
    code: result.errorCode,
    requestId: result.requestId,
  });
}
