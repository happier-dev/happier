import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { presentHomeInvitePeople } from '@/components/settings/home/governance/HomeInvitePeopleDialog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { teamMemberAddPath } from '../teamsRoutes';

/**
 * The roster's "+" (DR-06, lab `tsMembers-M`), the same on the Members page and on the Members rail
 * beside an open person. Two ways to add someone exist — an Account already on this Home, or an
 * invitation for anyone else — and they are named by what the owner knows rather than guessed: with
 * both available the action opens a menu; with one, it goes straight there. Inviting opens the one
 * Invite people dialog with this Team chosen. Renders nothing for a viewer who can do neither.
 */
export const TeamMemberAddAction = React.memo(function TeamMemberAddAction(
  props: Readonly<{
    context: Pick<TeamSectionContext, 'address' | 'homeName' | 'team' | 'canMutate'>;
    /** `section`: the labelled action of a page section. `rail`: the plain "+" of a collection rail. */
    presentation: 'section' | 'rail';
  }>,
) {
  const router = useRouter();
  const { context } = props;
  const canAdd = context.team.capabilities.manageMembers && context.canMutate;
  const canInvite = context.team.capabilities.manageInvitations && context.canMutate;
  const [open, setOpen] = React.useState(false);
  const addExisting = React.useCallback(
    () => router.push(teamMemberAddPath(context.address)),
    [context.address, router],
  );
  const invite = React.useCallback(
    () =>
      presentHomeInvitePeople({
        serverId: context.address.serverId,
        teamId: context.address.teamId,
      }),
    [context.address.serverId, context.address.teamId],
  );
  if (!canAdd && !canInvite) return null;
  const menu = canAdd && canInvite;
  const button = (onPress: () => void) =>
    props.presentation === 'rail' ? (
      <IconButton
        testID="team-members-add"
        iconName="plus"
        accessibilityLabel={t('teams.members.add')}
        tooltip={t('teams.members.add')}
        variant="plain"
        onPress={onPress}
      />
    ) : (
      <SectionActionButton
        testID="team-members-add"
        icon="plus"
        title={t('teams.members.add')}
        expanded={menu ? open : undefined}
        onPress={onPress}
      />
    );
  if (!menu) return button(canAdd ? addExisting : invite);
  return (
    <DropdownMenu
      testID="team-members-add-menu"
      open={open}
      onOpenChange={setOpen}
      items={[
        {
          id: 'existing',
          testID: 'team-members-add-menu:existing',
          title: t('teams.members.addMenu.existing'),
          subtitle: t('teams.members.addMenu.existingBody', {
            home: context.homeName,
          }),
          icon: <Icon name="users" />,
        },
        {
          id: 'invite',
          testID: 'team-members-add-menu:invite',
          title: t('teams.members.addMenu.invite'),
          subtitle: t('teams.members.addMenu.inviteBody', {
            team: context.team.name,
          }),
          icon: <Icon name="user-plus" />,
        },
      ]}
      onSelect={(id) => {
        setOpen(false);
        if (id === 'existing') addExisting();
        else if (id === 'invite') invite();
      }}
      placement="bottom"
      popoverAnchorAlign={props.presentation === 'rail' ? 'start' : 'end'}
      matchTriggerWidth={false}
      maxWidthCap={320}
      showCategoryTitles={false}
      popoverPortalWebTarget="body"
      trigger={({ toggle }) => button(toggle)}
    />
  );
});
