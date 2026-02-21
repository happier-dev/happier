import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.surfaceHigh,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  text: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
}));

export const ConnectedServiceQuotaBadgesView = React.memo(function ConnectedServiceQuotaBadgesView(props: Readonly<{
  badges: ReadonlyArray<{ meterId: string; text: string }>;
}>) {
  const { theme } = useUnistyles();
  const styles = stylesheet;

  if (!props.badges || props.badges.length === 0) return null;

  return (
    <View style={styles.container}>
      {props.badges.map((badge) => (
        <View key={badge.meterId} style={styles.badge}>
          <Text style={styles.text}>{badge.text}</Text>
        </View>
      ))}
    </View>
  );
});

