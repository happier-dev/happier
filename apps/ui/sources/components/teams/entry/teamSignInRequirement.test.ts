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
  it('opens Team sign-in when the origin is refused and carries no return', () => {
    const navigate = vi.fn();
    presentTeamSignInRequired({
      code: 'session_access_authentication_required',
      teamId: 'team-1',
      serverId: 'profile-acme',
      accepted: [],
      origin: { pathname: '//elsewhere.example.test/session/s-1', search: '' },
      navigate,
    }).action.onPress();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/teams/team-1/sign-in?serverId=profile-acme');
  });

  it('leads to the Team sign-in and carries the page it was opened from, without its unrelated query', () => {
    const navigate = vi.fn();
    // The web window's address when Sign in is pressed: the Session page with its pane, plus a parameter it does not need.
    vi.stubGlobal('window', { location: { pathname: '/session/s-1', search: '?serverId=srv_a&right=collaboration&token=secret' } });
    try {
      const reason = presentTeamSignInRequired({
        code: 'session_access_authentication_required',
        teamId: 'team-1',
        serverId: 'profile-acme',
        accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        navigate,
      });
      reason.action.onPress();
    } finally {
      vi.unstubAllGlobals();
    }
    const href = String(navigate.mock.calls[0]?.[0]);
    expect(href.startsWith('/teams/team-1/sign-in?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('returnTo')).toBe('/session/s-1?serverId=srv_a&right=collaboration');
    expect(href).not.toContain('secret');
  });
});
