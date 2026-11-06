import * as React from 'react';
import {
  HappierPressable,
  HAPPIER_ICON_BUTTON_SIZE,
} from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

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

/**
 * Settings on a phone (owner Q4, 2026-10-30): the person's avatar at the end of the main tabs' header
 * opens Settings as a pushed page, the iOS pattern, so the tab bar keeps its slots for work.
 */
export const PhoneSettingsAvatarButton = React.memo(
  function PhoneSettingsAvatarButton() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const profileId = useProfile((profile) => profile.id);
    const imageUrl = useProfile((profile) => getAvatarUrl(profile));
    const thumbhash = useProfile((profile) => profile.avatar?.thumbhash);
    const openSettings = React.useCallback(() => {
      const result = runGuardedNavigation(() => router.push('/settings'));
      if (result !== true)
        fireAndForget(result, { tag: 'PhoneSettingsAvatarButton.settings' });
    }, [router]);
    return (
      <HappierPressable
        testID="main-header-settings-avatar"
        accessibilityRole="button"
        accessibilityLabel={t('settings.title')}
        hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
        hitReach={HIT_REACH}
        onPress={openSettings}
        style={(state) => [
          styles.frame,
          focusRingStyle({
            focused: state.focused,
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
  },
);
