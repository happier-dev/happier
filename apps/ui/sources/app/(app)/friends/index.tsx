import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { FriendsView } from '@/components/navigation/shell/FriendsView';
import { useHeaderHeight, useIsTablet } from '@/utils/platform/responsive';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useRequireFriendsEnabled } from '@/hooks/friends/useRequireFriendsEnabled';
import { Text } from '@/components/ui/text/Text';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  header: {
    backgroundColor: theme.colors.chrome.header.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.default,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 17,
    color: theme.colors.chrome.header.foreground,
    ...Typography.default('semiBold'),
  },
}));

export default function FriendsPage() {
  const enabled = useRequireFriendsEnabled();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();
  const headerHeight = useHeaderHeight();

  if (!enabled) return null;

  if (isTablet) {
    return <FriendsView />;
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <View style={[styles.headerContent, { height: headerHeight }]}>
          <Text style={styles.headerTitle}>{t('tabs.friends')}</Text>
        </View>
      </View>
      <FriendsView />
    </View>
  );
}
