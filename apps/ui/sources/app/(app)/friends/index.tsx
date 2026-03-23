import * as React from 'react';
import { View, Platform, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';

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
    backgroundColor: theme.colors.header.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  backButton: {
    marginRight: 16,
  },
  headerTitle: {
    fontSize: 17,
    color: theme.colors.header.tint,
    ...Typography.default('semiBold'),
  },
}));

export default function FriendsPage() {
  const enabled = useRequireFriendsEnabled();
  const router = useRouter();
  const { theme } = useUnistyles();
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            onPress={() => router.back()}
            style={styles.backButton}
            hitSlop={15}
          >
            <Ionicons
              name={Platform.OS === 'ios' ? 'chevron-back' : 'arrow-back'}
              size={24}
              color={theme.colors.header.tint}
            />
          </Pressable>
          <Text style={styles.headerTitle}>{t('tabs.friends')}</Text>
        </View>
      </View>
      <FriendsView />
    </View>
  );
}
