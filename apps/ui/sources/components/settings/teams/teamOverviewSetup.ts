import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

export type TeamSetupStepId = 'invite' | 'sign_in' | 'share';
export type TeamSetupStep = Readonly<{ id: TeamSetupStepId; current: boolean }>;

/**
 * The setup a just-created Team still needs (lab `tsOverview-E`), derived only from facts the Team
 * projection already carries — never marked done without evidence.
 *
 * A Team is "just created" while its owner is its only member and nobody has been invited: the
 * moment either changes, the Team is in use and the Overview shows its summaries instead. Inviting
 * is therefore always the current step. Choosing the Team's own accepted sign-in is offered only to
 * a viewer who can change it and only until the Team has chosen one; keeping the Home's sign-in is a
 * legitimate answer, so that step is guidance rather than a gate. Sharing a session is guidance too:
 * it happens from a session's own menu.
 */
export function resolveTeamSetupSteps(
  team: TeamSummaryV1,
): readonly TeamSetupStep[] | null {
  const counts = team.counts;
  if (
    team.archivedAt !== null ||
    !team.capabilities.manageInvitations ||
    !counts ||
    counts.waitingInvitations === null ||
    counts.members > 1 ||
    counts.waitingInvitations > 0
  )
    return null;
  const steps: TeamSetupStep[] = [{ id: 'invite', current: true }];
  if (
    team.capabilities.manageAuthentication &&
    team.policy.authenticationPolicy === null
  ) {
    steps.push({ id: 'sign_in', current: false });
  }
  steps.push({ id: 'share', current: false });
  return Object.freeze(steps);
}
