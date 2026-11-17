import * as React from 'react';
import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams';

import { getCurrentAuth } from '@/auth/context/currentAuth';
import { AccountNameField } from '@/components/account/AccountNameField';
import { useSyncedAccountName } from '@/components/account/useSyncedAccountName';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { setAccountName } from '@/sync/api/account/apiAccountName';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { HappyError } from '@/utils/errors/errors';

import {
  resolveTeamJoinPresentation,
  shouldOfferTeamJoinName,
} from './teamJoinOutcome';

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
    /** What the Team already shares, between the name and the way on (plan D, L1 Joined). */
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

  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="success"
      title={resolveTeamJoinPresentation(props.result, props.teamName).title}
      body={
        asksName ? (
          <>
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
          {props.summary}
          </>
        ) : props.summary
      }
      action={{
        label: props.setupContinuation?.label ?? t('teams.join.openTeam', { team: props.teamName }),
        onPress: openTeam,
        busy: opening,
      }}
      accessibilitySemantics="status"
    />
  );
}
