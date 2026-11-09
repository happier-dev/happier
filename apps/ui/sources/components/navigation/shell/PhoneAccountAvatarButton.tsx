import * as React from 'react';
import {
  HappierPressable,
  HAPPIER_ICON_BUTTON_SIZE,
} from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  ConnectionStatusControl,
  type ConnectionStatusTriggerState,
} from '@/components/navigation/ConnectionStatusControl';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** The person's face, a breath smaller than the glyph squares beside it so the row keeps one height. */
const AVATAR_SIZE_PX = HAPPIER_ICON_BUTTON_SIZE - 6;
/** The row's last control: half the 2 px gap to the glyph before it, the header's free edge after it. */
const HIT_REACH = { left: 1, right: 8 } as const;

const styles = StyleSheet.create(() => ({
  frame: {
    width: HAPPIER_ICON_BUTTON_SIZE,
    height: HAPPIER_ICON_BUTTON_SIZE,
    borderRadius: HAPPIER_ICON_BUTTON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

const AvatarTrigger = React.memo(function AvatarTrigger(
  props: Readonly<{ state: ConnectionStatusTriggerState }>,
) {
  const { theme } = useUnistyles();
  const profileId = useProfile((profile) => profile.id);
  const imageUrl = useProfile((profile) => getAvatarUrl(profile));
  const thumbhash = useProfile((profile) => profile.avatar?.thumbhash);
  const { state } = props;
  return (
    <HappierPressable
      testID="main-header-account-avatar"
      accessibilityRole="button"
      accessibilityLabel={`${t('settings.account')}, ${state.accessibilityLabel}`}
      expanded={state.open}
      hasPopup="dialog"
      hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
      hitReach={HIT_REACH}
      onPress={state.activate}
      style={(pressState) => [
        styles.frame,
        focusRingStyle({
          focused: pressState.focused,
          color: theme.colors.border.focus,
        }),
      ]}
    >
      <Avatar
        id={profileId}
        size={AVATAR_SIZE_PX}
        imageUrl={imageUrl}
        thumbhash={thumbhash}
      />
    </HappierPressable>
  );
});

const renderAvatarTrigger = (state: ConnectionStatusTriggerState) => (
  <AvatarTrigger state={state} />
);

/**
 * The person's avatar at the end of a phone tab's head opens the account/Home popover below it, the same
 * popover the wide rail's avatar opens (owner R3, 2026-11-09). Settings is that popover's first row.
 */
export const PhoneAccountAvatarButton = React.memo(
  function PhoneAccountAvatarButton() {
    return (
      <ConnectionStatusControl
        variant="header"
        renderTrigger={renderAvatarTrigger}
      />
    );
  },
);
