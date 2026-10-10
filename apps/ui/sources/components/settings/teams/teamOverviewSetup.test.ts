import { describe, expect, it } from 'vitest';

import {
  teamCapabilitiesFixture,
  teamPolicyFixture,
  teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';

import { resolveTeamSetupSteps } from './teamOverviewSetup';

const manager = teamCapabilitiesFixture({
  manageInvitations: true,
  manageAuthentication: true,
});
const newTeamCounts = {
  members: 1,
  suspendedMembers: 0,
  groups: 0,
  waitingInvitations: 0,
};

describe('resolveTeamSetupSteps', () => {
  it('turns a just-created Team into its setup steps, with Invite as the current step', () => {
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({ capabilities: manager, counts: newTeamCounts }),
      ),
    ).toEqual([
      { id: 'invite', current: true },
      { id: 'sign_in', current: false },
      { id: 'share', current: false },
    ]);
  });

  it('drops the sign-in step once the Team has chosen its own accepted sign-in', () => {
    const team = teamSummaryFixture({
      capabilities: manager,
      counts: newTeamCounts,
      policy: teamPolicyFixture({
        authenticationPolicy: {
          v: 1,
          mode: 'restricted',
          accepted: [{ kind: 'home_method', methodId: 'github' }],
        },
      }),
    });
    expect(resolveTeamSetupSteps(team)?.map((step) => step.id)).toEqual([
      'invite',
      'share',
    ]);
  });

  it('omits the sign-in step for a viewer who cannot change authentication', () => {
    const team = teamSummaryFixture({
      capabilities: teamCapabilitiesFixture({ manageInvitations: true }),
      counts: newTeamCounts,
    });
    expect(resolveTeamSetupSteps(team)?.map((step) => step.id)).toEqual([
      'invite',
      'share',
    ]);
  });

  it('leaves once anyone else has joined or been invited', () => {
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({
          capabilities: manager,
          counts: { ...newTeamCounts, members: 2 },
        }),
      ),
    ).toBeNull();
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({
          capabilities: manager,
          counts: { ...newTeamCounts, waitingInvitations: 1 },
        }),
      ),
    ).toBeNull();
  });

  it('shows nothing without evidence: unknown counts, no invite capability, or an archived Team', () => {
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({ capabilities: manager, counts: null }),
      ),
    ).toBeNull();
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({
          capabilities: teamCapabilitiesFixture({}),
          counts: { ...newTeamCounts, waitingInvitations: null },
        }),
      ),
    ).toBeNull();
    expect(
      resolveTeamSetupSteps(
        teamSummaryFixture({
          capabilities: manager,
          counts: newTeamCounts,
          archivedAt: 1,
        }),
      ),
    ).toBeNull();
  });
});
