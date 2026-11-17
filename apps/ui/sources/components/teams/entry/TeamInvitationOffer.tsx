import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import {
  TeamEntryIdentity,
  type TeamEntryLogo,
} from '@/components/teams/entry/TeamEntryIdentity';
import {
  TeamInvitationFactsLine,
  TeamInvitationPreviewDetails,
} from '@/components/teams/join/TeamInvitationPreviewDetails';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { TeamInvitationPreviewState } from '@/hooks/teams/useTeamInvitationPreview';
import { t } from '@/text';

/**
 * An invitation the Home says is still open, read as the offer itself: who invited them to which
 * Team, one facts line, what the role means, then who they are and the way to join. The entry
 * surface owns loading the preview and admission; this view only draws an already-read offer.
 */
export const TeamInvitationOffer = React.memo(function TeamInvitationOffer(
  props: Readonly<{
    testID: string;
    teamId: string;
    teamName: string;
    logo: TeamEntryLogo;
    previewState: Extract<TeamInvitationPreviewState, { kind: 'ready' }>;
    homeLabel: string;
    /** Extra lines under the facts line inside the identity header (the sign-in service origin). */
    headerNotice?: React.ReactNode;
    /** An admission answer (failure, approval, terminal) replaces the offer's body when present. */
    status?: React.ReactNode;
    /** Whether a person is signed in here; `accountLabel` names that Account when it is known. */
    signedIn: boolean;
    accountLabel: string | null;
    /** The entry's own status sentence, read under the offer while nobody is signed in. */
    statusLine: string | null;
    onRetryPreview: () => void;
    actions: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const preview = props.previewState.preview;
  // Who they are and where the invitation went: the signed-in Account, or the invited address and status.
  const identityLine =
    (props.signedIn && props.accountLabel
      ? [
          t('teams.entry.signedInTo', { account: props.accountLabel }),
          preview.recipientEmailMask !== null
            ? t('teams.join.sentToInline', { email: preview.recipientEmailMask })
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ')
      : [
          preview.recipientEmailMask !== null
            ? t('teams.join.sentTo', { email: preview.recipientEmailMask })
            : null,
          props.statusLine,
        ]
          .filter((part): part is string => part !== null)
          .join(' ')) || null;
  return (
    <View testID={props.testID} style={styles.content}>
      <TeamEntryIdentity
        testIDPrefix="team-auth-entry"
        teamId={props.teamId}
        teamName={props.teamName}
        logo={props.logo}
        heading={
          preview.inviterLabel !== null
            ? t('teams.join.invitedYouTo', {
                name: preview.inviterLabel,
                team: props.teamName,
              })
            : t('teams.join.invitedToTeam', { team: props.teamName })
        }
        inviterLabel={preview.inviterLabel ?? null}
      >
        <View style={styles.offerFacts}>
          <TeamInvitationFactsLine
            preview={preview}
            homeLabel={props.homeLabel}
          />
        </View>
        {props.headerNotice}
      </TeamEntryIdentity>
      {props.status ?? (
        <>
          <TeamInvitationPreviewDetails
            state={props.previewState}
            onRetry={props.onRetryPreview}
          />
          <View testID="team-auth-entry-offer-foot" style={styles.offerFoot}>
            {identityLine ? (
              <View style={styles.offerIdentity}>
                <Icon
                  name="person"
                  size={15}
                  color={theme.colors.text.secondary}
                />
                <Text
                  testID={
                    props.signedIn
                      ? 'team-auth-entry-account-label'
                      : 'team-auth-entry-status'
                  }
                  accessibilityRole="text"
                  variant="label"
                  style={styles.offerIdentityText}
                >
                  {identityLine}
                </Text>
              </View>
            ) : null}
            {props.actions}
          </View>
        </>
      )}
    </View>
  );
});

/**
 * The signed-in invitee's way in: one Join, and, when the Home offers a switch, a way to use
 * another Account. Rendered inside the entry surface's `WelcomeActionList`, which owns admission.
 */
export function TeamInvitationJoinActions(
  props: Readonly<{
    joinTitle: string;
    joinSubtitle?: string;
    onJoin: () => void;
    /** Under a read offer the switch is a quiet link; while the offer is still unread it is a card. */
    offered: boolean;
    onUseAnotherAccount?: () => void;
  }>,
) {
  return (
    <>
      <WelcomeActionCard
        testID="team-auth-entry-join"
        primary
        title={props.joinTitle}
        subtitle={props.joinSubtitle}
        onPress={props.onJoin}
      />
      {props.onUseAnotherAccount ? (
        <WelcomeActionCard
          testID="team-auth-entry-use-another-account"
          primary={false}
          presentation={props.offered ? 'link' : undefined}
          title={t('teams.join.useAnotherAccount')}
          subtitle={
            props.offered
              ? t('teams.join.useAnotherAccountKeeps')
              : t('teams.join.useAnotherAccountHint')
          }
          onPress={props.onUseAnotherAccount}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    width: '100%',
    gap: 22,
  },
  offerFacts: {
    marginTop: theme.space.s10,
  },
  offerFoot: {
    marginTop: theme.space.s10,
    paddingTop: theme.space.s20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
    gap: theme.space.s16,
  },
  offerIdentity: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
  },
  offerIdentityText: {
    flex: 1,
    color: theme.colors.text.secondary,
  },
}));
