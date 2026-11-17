import * as React from 'react';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { teamSetupPath } from '@/components/settings/teams/teamsRoutes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { useSourceTeamSetupHint } from './useSourceTeamSetupHint';

/**
 * The way back into a Team's setup from a Source it shares (lab team-setup L4 project hint): one row
 * under "Who can see it" naming the Team, with Set up. Hiding the Home block never removes it; it is
 * absent when the Source names no Team this person belongs to.
 */
export const SourceTeamSetupRow = React.memo(function SourceTeamSetupRow(
  props: Readonly<{
    serverId: string;
    source: ProjectSourceV1 | null;
  }>,
) {
  const hint = useSourceTeamSetupHint(props.serverId, props.source);
  const router = useRouter();
  const address = hint?.address ?? null;
  const open = React.useCallback(() => {
    if (address) router.push(teamSetupPath(address) as never);
  }, [address, router]);
  if (!hint) return null;
  return (
    <Item
      testID="projects.sources.detail.teamSetup"
      title={t('homeSetup.teamSetupHint', { team: hint.teamName })}
      showChevron={false}
      onPress={open}
      rightElementOutsidePressable
      rightElement={
        <RoundButton
          testID="projects.sources.detail.teamSetup.action"
          size="small"
          display="secondary"
          title={t('homeSetup.teamSetupAction')}
          onPress={open}
        />
      }
    />
  );
});
