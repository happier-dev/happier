import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionAvatar } from '@/components/sessions/bots/face/SessionAvatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { t } from '@/text';
import {
  getSessionName,
} from '@/utils/sessions/sessionUtils';

/**
 * The bound target's display name, read from that one Session row (never the visible Session).
 * Null in global mode, or while the target's row is not on this device.
 */
export function useVoiceTargetName(
  address: SessionAddress | null | undefined,
): string | null {
  const session = useSession(
    address?.sessionId ?? '',
    address?.serverId ?? null,
  );
  const isSessionVisible = useSessionRecordingVisibility();
  if (!address || !session) return null;
  if (!isSessionVisible(address)) return t('message.provenanceSession');
  return getSessionName(session, address.serverId);
}

/**
 * Whether the bound target is the Session on screen: there the page already says which Session it is,
 * so presence drops "Talking to …" and shows the call's own state instead.
 */
export function useVoiceTargetOnScreen(address: SessionAddress | null | undefined): boolean {
  const focused = useFocusedSessionAddress();
  return Boolean(address) && areSessionAddressesEqual(address, focused);
}

/**
 * "Who you are talking to" in Voice presence (lab `b-voice A/O`): the target Session's own seeded
 * avatar and its name. It rides the status line of the existing containers; there is no Bot pill.
 */
export const VoiceTargetIdentity = React.memo(function VoiceTargetIdentity(
  props: Readonly<{
    address: SessionAddress;
    size: 'pill' | 'hero';
    /** Only the avatar: a frame's leading mark beside a title that already names the target. */
    avatarOnly?: boolean;
    testID?: string;
  }>,
): React.ReactElement | null {
  const session = useSession(props.address.sessionId, props.address.serverId);
  const isSessionVisible = useSessionRecordingVisibility();
  if (!session) return null;
  const identityVisible = isSessionVisible(props.address);
  const pill = props.size === 'pill';
  const name = identityVisible ? getSessionName(session, props.address.serverId) : t('message.provenanceSession');
  if (props.avatarOnly) {
    return identityVisible ? (
      <SessionAvatar session={session} serverId={props.address.serverId} size={pill ? 16 : 18} />
    ) : null;
  }
  return (
    <View
      testID={props.testID ?? 'voice-target-identity'}
      style={styles.row}
      accessibilityLabel={name}
    >
      {identityVisible ? <SessionAvatar session={session} serverId={props.address.serverId} size={pill ? 16 : 18} /> : null}
      <Text numberOfLines={1} style={pill ? styles.namePill : styles.nameHero}>
        {name}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
    flexShrink: 1,
  },
  namePill: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  nameHero: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
}));
