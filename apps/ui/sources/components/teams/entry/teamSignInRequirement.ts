import type { TeamAcceptedAuthenticationV1 } from '@happier-dev/protocol/auth/teamAuthenticationPolicy';

import { describeOAuthProvider } from '@/components/account/auth/homeAuthenticationActionPresentation';
import { t } from '@/text';

import { teamSignInReturnPath } from './teamSignInHome';

/** The sign-ins a Team accepts, named as the sign-in screen and Account settings name them. */
export function teamAcceptedSignInNames(
  accepted: readonly TeamAcceptedAuthenticationV1[],
): string {
  const names = accepted.map((reference) => {
    if (reference.kind === 'team_connection')
      return t('teams.errors.signInMethodTeamConnection');
    switch (reference.methodId.toLowerCase()) {
      case 'key_challenge':
        return t('settingsAccount.secretKey');
      case 'email_password':
        return t('teams.errors.signInMethodEmailPassword');
      case 'mtls':
        return t('teams.errors.signInMethodCertificate');
      default:
        return describeOAuthProvider(reference.methodId).providerName;
    }
  });
  return [...new Set(names)].join(t('teams.errors.signInMethodsOr'));
}

/**
 * A Team refused because the current sign-in does not meet its rule: which sign-in it needs and the one
 * step that meets it, the Team's own sign-in. Asking again could only be refused again, so it is not retryable.
 */
export function presentTeamSignInRequired(
  input: Readonly<{
    code: string;
    teamId: string;
    teamName: string;
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
      ? t('teams.errors.signInRequired', { team: input.teamName, methods })
      : t('session.access.authenticationRequired'),
    retryable: false,
    action: {
      label: t('teams.errors.signInRequiredAction'),
      onPress: () =>
        input.navigate(
          teamSignInReturnPath({
            teamId: input.teamId,
            serverId: input.serverId,
          }),
        ),
    },
  };
}
