import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams';

import { TeamEntryIdentity } from '@/components/teams/entry/TeamEntryIdentity';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { TeamJoinedCard, type TeamSetupContinuation } from './TeamJoinedCard';
import { resolveTeamJoinPresentation } from './teamJoinOutcome';

type TeamAdmissionSuccess = Extract<TeamInvitationAcceptResultV1, { outcome: 'joined' | 'already_member' }>;

/**
 * The Joined page body: the invitation page continued, not a card. The Team lockup and "You've joined
 * {team}" head it; the name colleagues see, what the Team already shares and the way on follow.
 */
export const TeamJoinedContent = React.memo(function TeamJoinedContent(props: Readonly<{
  result: TeamAdmissionSuccess;
  teamName: string;
  accountScope: ServerAccountScope | null;
  onOpenTeam: () => Promise<void> | void;
  setupContinuation?: TeamSetupContinuation;
  summary?: React.ReactNode;
}>) {
  return (
    <View style={styles.joined}>
      <TeamEntryIdentity
        testIDPrefix="team-join-joined"
        teamId={props.result.teamId}
        teamName={props.teamName}
        logo={null}
        heading={resolveTeamJoinPresentation(props.result, props.teamName).title}
      />
      <TeamJoinedCard
        testID="team-auth-entry-admission-complete"
        result={props.result}
        teamName={props.teamName}
        accountScope={props.accountScope}
        onOpenTeam={props.onOpenTeam}
        {...(props.setupContinuation ? { setupContinuation: props.setupContinuation } : {})}
        summary={props.summary}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The same column rhythm as the Team entry page this state continues.
  joined: {
    width: '100%',
    gap: theme.space.s20,
  },
}));
