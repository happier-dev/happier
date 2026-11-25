import type { TeamAcceptedAuthenticationV1 } from '@happier-dev/protocol/auth/teamAuthenticationPolicy';

import { describeOAuthProvider } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { t } from '@/text';

import { readCurrentRouteAddress } from '@/components/appShell/workspace/currentRouteLocation';

import { teamSignInOrigin, teamSignInReturnPath, type TeamSignInOriginAddress } from './teamSignInHome';

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
 * The sign-in returns to the supplied surface, or to the current page for callers that use it as their origin.
 */
export function presentTeamSignInRequired(
  input: Readonly<{
    code: string;
    teamId: string;
    serverId: string;
    /** The Team's accepted sign-ins as this member reads them; empty when not known here. */
    accepted: readonly TeamAcceptedAuthenticationV1[];
    origin?: TeamSignInOriginAddress | (() => TeamSignInOriginAddress);
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
            returnTo: teamSignInOrigin(typeof input.origin === 'function' ? input.origin() : input.origin ?? readCurrentRouteAddress()),
          }),
        ),
    },
  };
}

/** Where the Home's own sign-out lives, with its consequence stated beside it. */
const HOME_SIGN_OUT_PATH = '/settings/account';

/**
 * A Home that refuses Teams to a released 0.2 sign-in: the outcome in one sentence and the one step, signing in
 * again. Signing out forgets this sign-in on the device and that path asks nothing more, so the step leads to the
 * Home's own sign-out in Account settings, where its consequence is said, and never signs out on this press.
 */
export function presentTeamSignInOutdated(
  input: Readonly<{ code: string; navigate: (href: string) => void }>,
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
      onPress: () => input.navigate(HOME_SIGN_OUT_PATH),
    },
  };
}
