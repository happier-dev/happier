import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { TeamMemberDefaultsSection } from '@/components/settings/teams/defaults/TeamMemberDefaultsSection';
import { memberDefaultsAccess } from '@/components/settings/teams/defaults/memberDefaults';
import type { TeamSectionContext } from '@/components/settings/teams/teamSectionContext';
import { ItemList } from '@/components/ui/lists/ItemList';
import {
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit/fixtures/teamFixtures';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * Dev-only: "Defaults for members" as a Team administrator authors it (`?state=admin`, may change Team
 * defaults) and as a member reads it (`?state=member`, the Home says who changes them), drawn by the real
 * TeamMemberDefaultsSection over testkit Team fixtures. Choices here reach no Home: the Team is a fixture.
 */
const TEAM_SCOPE = Object.freeze({ kind: 'team' as const });
const ignore = () => {};

export default function TeamDefaultsDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  const admin = params.state !== 'member';
  const scope = useActiveServerAccountScope();
  const context = React.useMemo<TeamSectionContext | null>(
    () =>
      scope
        ? {
            scope,
            address: { serverId: scope.serverId, teamId: 'team-platform' },
            homeName: 'Harbor Home',
            team: teamSummaryFixture({
              id: 'team-platform',
              name: 'Platform Engineering',
              viewerRole: admin ? 'owner' : 'member',
              capabilities: teamCapabilitiesFixture(
                admin ? { manageSettings: true } : {},
              ),
            }),
            mutationsAvailable: true,
            archived: false,
            canMutate: admin,
            approvalPending: false,
            refresh: ignore,
            requestApproval: ignore,
            settleLeave: ignore,
          }
        : null,
    [scope, admin],
  );
  if (!context) return null;
  return (
    <ItemList>
      <TeamMemberDefaultsSection
        key={String(admin)}
        testID="dev-team-defaults"
        context={context}
        scope={TEAM_SCOPE}
        access={memberDefaultsAccess(TEAM_SCOPE, context.team.capabilities)}
        writable={context.canMutate}
      />
    </ItemList>
  );
}
