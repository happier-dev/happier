import type { TeamSectionContext } from '../teamSectionContext';

/** Who may change what new members get: the Team's settings managers, while the Team accepts changes. */
export function mayAuthorNewMembersSetup(context: Pick<TeamSectionContext, 'canMutate' | 'team'>): boolean {
  return context.canMutate && context.team.capabilities.manageSettings === true;
}
