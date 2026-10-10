import * as React from 'react';

import type { TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

import { useTeamMembersRoster } from './useTeamMembersRoster';

/**
 * The people who can change a Team's members, sign-in and settings — its owners and admins — by
 * name, for the one line that tells a viewer without those rights whom to ask.
 *
 * The names come from the Team's own roster, read through the roster owner with its owners-and-admins
 * filter, and only for a viewer the Home lets read the roster. A viewer who cannot read it gets an
 * empty list, and the line says "an owner or admin" without naming anyone. The viewer is never
 * listed: nobody is told to ask themselves.
 */
export function useTeamManagerNames(
  context: Pick<TeamSectionContext, 'scope' | 'address' | 'team'>,
  enabled: boolean,
): readonly string[] {
  const roster = useTeamMembersRoster({
    scope: context.scope,
    address: context.address,
    filter: 'owners_admins',
    enabled: enabled && context.team.capabilities.viewRoster,
  });
  const viewerAccountId = context.scope.accountId;
  return React.useMemo(
    () =>
      roster.rows
        .filter(
          (membership) =>
            membership.status === 'active' &&
            membership.accountId !== viewerAccountId,
        )
        .map((membership) =>
          resolveAccountDisplayName({
            profile: membership.account,
            accountId: membership.accountId,
            viewerAccountId,
          }),
        )
        .filter((person) => person.named)
        .map((person) => person.name),
    [roster.rows, viewerAccountId],
  );
}
