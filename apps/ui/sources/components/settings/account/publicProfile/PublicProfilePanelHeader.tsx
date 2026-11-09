import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

/** The small header of the editor's anchored panels (Look, Public data): what the panel decides, in one line. */
export function PublicProfilePanelHeader(props: Readonly<{ title: string; description: string }>): React.ReactElement {
  return (
    <View style={styles.header}>
      <Text variant="heading" emphasis="semiBold" style={styles.title} accessibilityRole="header">
        {props.title}
      </Text>
      <Text variant="meta" style={styles.description}>
        {props.description}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s4,
    gap: theme.space.s2,
  },
  title: { color: theme.colors.text.primary },
  description: { color: theme.colors.text.secondary },
}));
