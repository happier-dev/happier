import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';
import { t } from '@/text';

/** The launch mark's size: the app icon's presence, not a page title's. */
const LAUNCH_MARK_SIZE = 44;

/**
 * The app's own startup state, before the shell knows which page it will open: the Happier mark centred on the
 * window's canvas with the person's chosen spinner as a quiet progress cue (the web counterpart of the native
 * splash). A list's skeleton promises rows; at startup there is no list yet, so it would promise a structure
 * that may never come (owner 2026-11-11). Lists keep their own skeletons once the shell is up.
 */
export const AppLaunchState = React.memo(function AppLaunchState(
  props: Readonly<{ testID: string }>,
) {
  return (
    <View
      testID={props.testID}
      style={styles.root}
      accessibilityRole="progressbar"
      accessibilityLabel={t('common.loading')}
    >
      <View testID={`${props.testID}-mark`} style={styles.mark}>
        <HeaderLogo size={LAUNCH_MARK_SIZE} inset={0} />
      </View>
      <ActivitySpinner size="small" />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s24,
  },
  mark: { alignItems: 'center', justifyContent: 'center' },
}));
