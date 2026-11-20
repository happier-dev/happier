import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierDivider, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { AccountNameField } from '@/components/account/AccountNameField';
import { useSyncedAccountName } from '@/components/account/useSyncedAccountName';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { WelcomeActionList } from '@/components/onboarding/preAuth/WelcomeActionList';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { setAccountName } from '@/sync/api/account/apiAccountName';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { HappyError } from '@/utils/errors/errors';

import { TeamJoinedSummaryForTeam } from './TeamJoinedSummary';
import { shouldOfferTeamJoinName } from './teamJoinOutcome';

type TeamAdmissionSuccess = Extract<
  TeamInvitationAcceptResultV1,
  { outcome: 'joined' | 'already_member' }
>;

export type TeamSetupContinuation = Readonly<{
  label: string;
  onContinue: () => Promise<void> | void;
}>;

/**
 * The one "you're in" card after accepting a Team invitation.
 *
 * A fresh join by an Account with no name of its own also asks how colleagues
 * should see it; leaving the field empty simply opens the Team. The ask is
 * decided once, when the profile is first known, so a name that syncs in while
 * the card is open never makes the field vanish under the person typing.
 */
export function TeamJoinedCard(
  props: Readonly<{
    testID: string;
    result: TeamAdmissionSuccess;
    teamName: string;
    /** The Account that was admitted, on the Home that admitted it. */
    accountScope: ServerAccountScope | null;
    onOpenTeam: () => Promise<void> | void;
    setupContinuation?: TeamSetupContinuation;
    /** Static summary for the design specimen. Live admissions bind their Team here. */
    summary?: React.ReactNode;
  }>,
): React.ReactElement {
  const isFocused = useIsFocused();
  const focused = React.useRef(isFocused);
  focused.current = isFocused;
  React.useEffect(() => {
    focused.current = isFocused;
    return () => { focused.current = false; };
  }, [isFocused]);
  const accountExecution = useMountedActionExecution(props.accountScope);
  const syncedName = useSyncedAccountName(props.accountScope);
  const offer = shouldOfferTeamJoinName({
    outcome: props.result.outcome,
    profile: syncedName,
  });
  const [asksName, setAsksName] = React.useState<boolean | null>(() =>
    syncedName ? offer : null,
  );
  React.useEffect(() => {
    if (asksName === null && syncedName) setAsksName(offer);
  }, [asksName, offer, syncedName]);

  const [name, setName] = React.useState('');
  const [nameError, setNameError] = React.useState<string | null>(null);
  const autoFocus = useDeviceType() !== 'phone';

  // How the admitted Account is named, remembered while its profile is the one in sync so a
  // refusal after an Account change can say which Account to go back to.
  const admittedLabel = React.useRef<string | null>(null);
  if (syncedName?.label) admittedLabel.current = syncedName.label;

  const continuationDestination = React.useRef<'team' | 'setup'>(props.setupContinuation ? 'setup' : 'team');
  const [opening, finishJoined] = useHappyAction(async (destination: 'team' | 'setup') => {
    continuationDestination.current = destination;
    const setup = destination === 'setup' ? props.setupContinuation : undefined;
    if ((setup || (asksName && name.trim()))
      && !areServerAccountScopesEqual(getActiveServerAccountScope(), props.accountScope)) {
      const message = admittedLabel.current
        ? t('teams.join.nameAccountSwitched', { account: admittedLabel.current })
        : t('teams.join.nameAccountSwitchedUnnamed');
      if (!asksName) throw new HappyError(message, false);
      setNameError(message);
      return;
    }
    if (asksName && name.trim()) {
      setNameError(null);
      try {
        const credentials = getCurrentAuth()?.credentials;
        if (!credentials) throw new Error('Account is unavailable');
        await setAccountName(credentials, name, accountExecution);
      } catch {
        setNameError(t('settingsAccount.nameSaveFailed'));
        return;
      }
    }
    // Native confirmation and name saving finish here before the explicit continuation.
    if (focused.current) await (setup?.onContinue ?? props.onOpenTeam)();
  });
  const openTeam = React.useCallback(() => {
    finishJoined(props.setupContinuation ? 'setup' : 'team');
  }, [finishJoined, props.setupContinuation]);

  // The page heading already says "You've joined <Team>" (TeamEntryIdentity), so this body is
  // what comes next: the name colleagues see, then one way on. No card: the joined state reads
  // as the same page the invitation was, continued.
  const admission = React.useMemo(() => ({
    pendingActionId: opening
      ? (continuationDestination.current === 'setup' || !props.setupContinuation ? OPEN_TEAM_ACTION_ID : OPEN_TEAM_LATER_ACTION_ID)
      : null,
    run: async (_actionId: string, action: () => Promise<void> | void) => { await action(); },
  }), [opening, props.setupContinuation]);
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={styles.body}>
      {props.summary ?? (props.setupContinuation && props.accountScope ? (
        <TeamJoinedSummaryForTeam
          testID="team-join-joined-summary"
          scope={props.accountScope}
          teamId={props.result.teamId}
        />
      ) : null)}
      {asksName ? (
        <AccountNameField
          testID={`${props.testID}-name-field`}
          value={name}
          onChangeText={(next) => {
            setNameError(null);
            setName(next);
          }}
          supportingText={t('teams.join.nameStepReason')}
          error={nameError}
          autoFocus={autoFocus}
          editable={!opening}
          returnKeyType="go"
          onSubmitEditing={openTeam}
        />
      ) : null}
      {props.setupContinuation ? (
        // What the Team gives ends here; the way on starts below the hairline (lab L1 Joined).
        <HappierDivider color={theme.colors.border.default} decorative testID={`${props.testID}-divider`} />
      ) : null}
      <WelcomeActionList admission={admission}>
        <WelcomeActionCard
          testID={`${props.testID}-action`}
          actionId={OPEN_TEAM_ACTION_ID}
          primary
          title={props.setupContinuation?.label ?? t('teams.join.openTeam', { team: props.teamName })}
          iconName={props.setupContinuation ? 'caret-right' : undefined}
          onPress={openTeam}
        />
      </WelcomeActionList>
      {props.setupContinuation ? (
        // Setup is offered, never required: the Team itself is one quiet press away, and Home keeps the offer.
        <View style={styles.later}>
          <TextLinkButton
            testID={`${props.testID}-open-team`}
            tone="strong"
            label={t('teams.join.openTeam', { team: props.teamName })}
            disabled={opening}
            onPress={() => finishJoined('team')}
          />
          <Text style={[styles.laterNote, { color: theme.colors.text.secondary }]}>
            {` · ${t('teams.join.setUpLaterFromHome')}`}
          </Text>
        </View>
      ) : null}

    </View>
  );
}

const OPEN_TEAM_ACTION_ID = 'team-joined-open';
const OPEN_TEAM_LATER_ACTION_ID = 'team-joined-open-later';

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s20,
  },
  later: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // The note reads at the link's own step, so the two halves of the line share one baseline.
  laterNote: {
    ...happierPageTextMetrics('rowDescription'),
  },
}));
