import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { teamSetupPath } from '@/components/settings/teams/teamsRoutes';
import { Avatar } from '@/components/ui/avatar/Avatar';
import type { SetupBlockItem } from '@/components/ui/setupBlocks/SetupBlockGrid';
import { SetupBlockTile } from '@/components/ui/setupBlocks/SetupBlockTile';
import { t } from '@/text';

import { useTeamSetupOffers, type TeamSetupOffer } from './useTeamSetupOffers';

/** The Team mark stands where the other blocks draw their 20-point icon. */
const TEAM_MARK_SIZE = 20;
const NO_ITEMS: readonly SetupBlockItem[] = Object.freeze([]);

/**
 * "Set up for {team}" in Home's Get set up (lab team-setup L4): one block for the latest Team joined
 * on each Home (the offer owner's choice) whose setup the person has not hidden. Set up opens the Team's setup page; the ✕ hides this Team's
 * block through the same Account layout as every other block. Home knows membership only, so the
 * sentence names no counts.
 */
export function useTeamSetupItems(
  input: Readonly<{ layout: 'card' | 'row' }>,
): readonly SetupBlockItem[] {
  const { offers, dismiss } = useTeamSetupOffers();
  const router = useRouter();
  const { layout } = input;
  return React.useMemo(
    () =>
      offers.length === 0
        ? NO_ITEMS
        : offers.map((offer): SetupBlockItem => ({
            id: offer.stepId,
            renderTile: () => (
              <TeamSetupTile
                offer={offer}
                layout={layout}
                onSetUp={() =>
                  router.push(teamSetupPath(offer.address) as never)
                }
                onDismiss={() => {
                  void dismiss(offer.address);
                }}
              />
            ),
          })),
    [dismiss, layout, offers, router],
  );
}

export function TeamSetupTile(
  props: Readonly<{
    offer: TeamSetupOffer;
    layout: 'card' | 'row';
    onSetUp: () => void;
    onDismiss: () => void;
  }>,
) {
  const { offer } = props;
  const title = t('homeSetup.teamSetupTitle', { team: offer.teamName });
  const testID = `hub-setup.team:${offer.address.serverId}:${offer.address.teamId}`;
  return (
    <SetupBlockTile
      testID={testID}
      layout={props.layout}
      glyph={
        <Avatar
          id={offer.address.teamId}
          monogram={offer.teamName}
          square
          size={TEAM_MARK_SIZE}
          imageUrl={offer.logo?.url ?? null}
          thumbhash={offer.logo?.thumbhash ?? null}
        />
      }
      title={title}
      subtitle={t('homeSetup.teamSetupSubtitle')}
      action={{
        label: t('homeSetup.teamSetupAction'),
        testID: `${testID}.action`,
        onPress: props.onSetUp,
      }}
      dismiss={{
        label: t('homeSetup.dismiss', { title }),
        tooltip: t('homeSetup.dismissTooltip'),
        onPress: props.onDismiss,
      }}
    />
  );
}
