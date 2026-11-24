import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
  presentTeamSignInRequired,
  teamAcceptedSignInNames,
} from './teamSignInRequirement';

describe('teamAcceptedSignInNames', () => {
  it('names each sign-in as it reads in a sentence, never by its settings title', () => {
    expect(
      teamAcceptedSignInNames([
        { kind: 'home_method', methodId: 'key_challenge' },
      ]),
    ).toBe(t('teams.errors.signInMethodRecoveryKey'));
    expect(
      teamAcceptedSignInNames([
        { kind: 'home_method', methodId: 'key_challenge' },
      ]),
    ).not.toBe(t('settingsAccount.secretKey'));
    expect(
      teamAcceptedSignInNames([
        { kind: 'home_method', methodId: 'key_challenge' },
        { kind: 'home_method', methodId: 'email_password' },
      ]),
    ).toBe(
      `${t('teams.errors.signInMethodRecoveryKey')}${t('teams.errors.signInMethodsOr')}${t('teams.errors.signInMethodEmailPassword')}`,
    );
  });
});

describe('presentTeamSignInRequired', () => {
  it('leads to the Team sign-in and carries the page it was opened from', () => {
    const navigate = vi.fn();
    const reason = presentTeamSignInRequired({
      code: 'session_access_authentication_required',
      teamId: 'team-1',
      serverId: 'profile-acme',
      accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
      navigate,
      origin: () => '/session/s-1?right=people',
    });
    reason.action.onPress();
    const href = String(navigate.mock.calls[0]?.[0]);
    expect(href.startsWith('/teams/team-1/sign-in?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('returnTo')).toBe(
      '/session/s-1?right=people',
    );
  });
});
