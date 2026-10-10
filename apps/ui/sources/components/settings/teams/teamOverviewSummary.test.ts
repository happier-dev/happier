import { describe, expect, it } from 'vitest';

import {
  teamInvitationRowFixture,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';

import {
  resolveTeamOverviewAttention,
  teamOverviewGroupsSummary,
  teamOverviewInvitationsSummary,
  teamOverviewSettingsSummary,
} from './teamOverviewSummary';

const counts = {
  members: 8,
  suspendedMembers: 1,
  groups: 4,
  waitingInvitations: 2,
};

describe('Team Overview summaries', () => {
  it('says the history default beside the session default, and changes with it', () => {
    const fromJoining = teamOverviewSettingsSummary(
      teamSummaryFixture({
        policy: teamPolicyFixture({
          defaultSessionHistoryAccess: 'from_membership',
        }),
      }),
    );
    const earlier = teamOverviewSettingsSummary(
      teamSummaryFixture({
        policy: teamPolicyFixture({
          defaultSessionHistoryAccess: 'all_existing',
        }),
      }),
    );
    expect(fromJoining).not.toBe(earlier);
    expect(fromJoining.split(' · ')).toHaveLength(2);
    expect(fromJoining.split(' · ')[0]).toBe(earlier.split(' · ')[0]);
  });

  it('adds the directory that keeps Groups in step only when one is known', () => {
    const team = teamSummaryFixture({ counts });
    const plain = teamOverviewGroupsSummary(team, []);
    const managed = teamOverviewGroupsSummary(team, ['Acme directory']);
    expect(managed.startsWith(plain)).toBe(true);
    expect(managed).toContain('Acme directory');
    expect(plain).not.toContain('Acme directory');
  });

  it('leads the invitations summary with an undelivered email when there is one', () => {
    const team = teamSummaryFixture({ counts });
    const quiet = teamOverviewInvitationsSummary(team, 0);
    const trouble = teamOverviewInvitationsSummary(team, 1);
    expect(trouble.endsWith(quiet)).toBe(true);
    expect(trouble).not.toBe(quiet);
  });
});

describe('resolveTeamOverviewAttention', () => {
  const failedSource = {
    id: 'source-a',
    displayName: 'Acme directory',
    failed: true,
  };
  const healthySource = {
    id: 'source-b',
    displayName: 'Contractors',
    failed: false,
  };
  const undelivered = teamInvitationRowFixture({
    id: 'inv-undelivered',
    recipientEmailMask: 's•••@gmail.com',
    lastEmailDelivery: { status: 'failed', attemptedAt: 1 },
  });
  const delivered = teamInvitationRowFixture({
    id: 'inv-delivered',
    recipientEmailMask: 'j•••@acme.dev',
    lastEmailDelivery: { status: 'sent', attemptedAt: 1 },
  });

  it('is empty while everything is healthy', () => {
    expect(
      resolveTeamOverviewAttention({
        sources: [healthySource],
        invitations: [delivered],
        now: 2,
      }),
    ).toEqual([]);
  });

  it('lists a failed directory before an undelivered invitation, each addressed to its own record', () => {
    expect(
      resolveTeamOverviewAttention({
        sources: [healthySource, failedSource],
        invitations: [delivered, undelivered],
        now: 2,
      }),
    ).toEqual([
      { kind: 'directory_failed', sourceId: 'source-a', name: 'Acme directory' },
      {
        kind: 'invitation_undelivered',
        invitationId: 'inv-undelivered',
        recipient: 's•••@gmail.com',
      },
    ]);
  });

  it('ignores an undelivered email on an invitation that is no longer waiting', () => {
    expect(
      resolveTeamOverviewAttention({
        sources: [],
        invitations: [{ ...undelivered, state: 'revoked' }],
        now: 2,
      }),
    ).toEqual([]);
  });
});
