import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { presentDiscussionAccessPrincipal } from './DiscussionInviteSheet';

describe('DiscussionInviteSheet Account presentation', () => {
  it('uses the same Account face in the access roster as in the Discussion byline', () => {
    const scope = { serverId: 'discussion-home', accountId: 'viewer' };
    const actor = { v: 1, accountId: 'viewer', accessibility: 'current', profile: null } as const;
    const principal = presentDiscussionAccessPrincipal({
      ref: { kind: 'account', accountId: actor.accountId },
      actor,
      scope,
      viewerProfile: null,
    });

    expect(principal.avatar?.id).toBe(resolveAccountActorPresentation({ ...actor, serverId: scope.serverId }, scope).avatar.id);
    expect(presentDiscussionAccessPrincipal({ ref: principal.ref, scope, viewerProfile: null }).avatar?.id)
      .toBe(principal.avatar?.id);
  });

  it('uses an explicit former relationship instead of retained grant display identity', () => {
    const principal = presentDiscussionAccessPrincipal({
      ref: { kind: 'account', accountId: 'former' },
      display: { name: 'Retained Person', username: 'retained' },
      actor: { v: 1, accountId: 'former', accessibility: 'former', profile: {
        name: 'Retained Person', firstName: 'Retained', lastName: 'Person', username: 'retained',
        avatarUrl: 'https://discussion-invite.test/retained.png',
      } },
      scope: { serverId: 'home', accountId: 'viewer' },
      viewerProfile: null,
    });

    expect(principal).toMatchObject({ displayName: t('message.accountActorFormerMember'), avatar: { id: 'former-member' } });
    expect(principal.secondaryLabel).toBeUndefined();
    expect(principal.avatar?.imageUrl).toBeUndefined();
    expect(JSON.stringify(principal)).not.toContain('Retained');
    expect(JSON.stringify(principal)).not.toContain('retained');
  });
});
