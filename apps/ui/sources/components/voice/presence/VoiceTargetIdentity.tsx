import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSession } from '@/sync/domains/state/storage';
import {
  getSessionAvatarId,
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
  if (!address || !session) return null;
  return getSessionName(session, address.serverId);
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
  if (!session) return null;
  const pill = props.size === 'pill';
  const name = getSessionName(session, props.address.serverId);
  if (props.avatarOnly) {
    return (
      <Avatar
        id={getSessionAvatarId(session, props.address.serverId)}
        size={pill ? 16 : 18}
        hasUnreadMessages={false}
      />
    );
  }
  return (
    <View
      testID={props.testID ?? 'voice-target-identity'}
      style={styles.row}
      accessibilityLabel={name}
    >
      <Avatar
        id={getSessionAvatarId(session, props.address.serverId)}
        size={pill ? 16 : 18}
        hasUnreadMessages={false}
      />
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
    gap: 5,
    minWidth: 0,
    flexShrink: 1,
  },
  namePill: {
    ...Typography.default('semiBold'),
    fontSize: 12.5,
    lineHeight: 16,
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  nameHero: {
    ...Typography.default('semiBold'),
    fontSize: 13,
    lineHeight: 17,
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
}));
