import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierStatusCapsule } from '@happier-dev/plugin-ui/presentation';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import {
  CORE_CAPSULE_HOST,
  useCoreCapsuleColors,
} from '@/components/ui/status/capsuleHost';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useFloatingChromeClearance, usePageBottomSeat } from '@/components/ui/layout/useFloatingChromeClearance';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import {
  useSessionStatus,
} from '@/utils/sessions/sessionUtils';
import type { SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

import { usePhoneAskSheet } from './phoneAskSheetState';

export type PhoneWorkingCapsuleKind = 'working' | 'queued' | 'needsYou';

/** How the canonical Session status reads in the capsule; anything else means the turn has settled. */
export function resolvePhoneWorkingCapsuleKind(
  state: SessionAwarenessPresentationStateV1,
): PhoneWorkingCapsuleKind | null {
  if (state === 'thinking' || state === 'resuming') return 'working';
  // The message waits with no turn running (an inactive Session): it is queued, not being worked on.
  if (state === 'pending_input' || state === 'waiting_for_startup_lock') return 'queued';
  if (state === 'permission_required' || state === 'action_required')
    return 'needsYou';
  return null;
}

/**
 * After Send from the phone Ask sheet (lab ask Ap2): one capsule over the File page says the agent is on it,
 * "{agent} is working · View", "Queued input · View" while the message waits for the Session to run, or
 * amber "Needs you" when the Session waits on the person. View opens the
 * Session. It reads the Session's canonical status and leaves once that status settles.
 */
export function PhoneWorkingCapsule(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    onView: () => void;
  }>,
): React.ReactElement | null {
  const sheet = usePhoneAskSheet();
  const working = sheet?.phase === 'working';
  const session = useSession(working ? props.sessionId : '', props.serverId);
  const status = useSessionStatus(session);
  const kind = status ? resolvePhoneWorkingCapsuleKind(status.state) : null;

  // The capsule follows one turn: once the Session has been seen working, a settled status ends it.
  const seenRef = React.useRef(false);
  React.useEffect(() => {
    if (!working) {
      seenRef.current = false;
      return;
    }
    if (kind) seenRef.current = true;
    else if (seenRef.current) sheet?.finish();
  }, [kind, sheet, working]);

  if (!working || !kind || !session) return null;
  const agentId = readSessionPresentationAgentId(session);
  return (
    <PhoneWorkingCapsuleView
      kind={kind}
      agent={
        agentId
          ? resolveAgentCatalogTitle(agentId)
          : t('newSession.wizardSection.agent')
      }
      onView={() => {
        sheet?.finish();
        props.onView();
      }}
    />
  );
}

/** The capsule itself, floating above the page's bottom edge, its floating tab bar and any bottom bar the page keeps. */
export function PhoneWorkingCapsuleView(
  props: Readonly<{
    kind: PhoneWorkingCapsuleKind;
    agent: string;
    onView: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const colors = useCoreCapsuleColors();
  const insets = useChromeSafeAreaInsets();
  // Like the page's other bottom bars: above the floating tab bar when one covers the page.
  const chromeClearance = useFloatingChromeClearance();
  // A bar the page keeps at its bottom (the Edit key row, the review bar, a selection's bar) holds that edge: the capsule rides above it.
  const bottom = usePageBottomSeat(chromeClearance > 0 ? chromeClearance : insets.bottom + theme.space.s16);
  const needsYou = props.kind === 'needsYou';
  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { bottom }]}
    >
      <HappierStatusCapsule
        placement="inline"
        busy={props.kind === 'working'}
        text={
          needsYou
            ? t('files.track.needsYou')
            : props.kind === 'queued'
              ? t('status.queuedInput')
              : t('files.track.agentWorking', { agent: props.agent })
        }
        action={{ label: t('files.track.view'), onPress: props.onView }}
        colors={
          needsYou
            ? { ...colors, text: theme.colors.state.attention.textForeground }
            : colors
        }
        host={CORE_CAPSULE_HOST}
        testID="phone-ask-working-capsule"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 3,
  },
});
