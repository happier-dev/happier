import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { presentDiscussionAccessPrincipal } from './DiscussionInviteSheet';

describe('DiscussionInviteSheet Account presentation', () => {
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

    expect(principal).toMatchObject({ displayName: t('message.accountActorFormerMember'), avatar: { id: 'former' } });
    expect(principal.secondaryLabel).toBeUndefined();
    expect(principal.avatar?.imageUrl).toBeUndefined();
    expect(JSON.stringify(principal)).not.toContain('Retained');
    expect(JSON.stringify(principal)).not.toContain('retained');
  });
});
