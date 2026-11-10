import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Send/Run's inline review: whose credentials this start uses (a Team's shared account), in the Action's own
 * words. Pressing Send is the confirmation, so the line sits quietly with the launch notices, above the
 * composer, and only while a Team or account source is selected.
 */
export function NewSessionCreationReviewLine(
  props: Readonly<{ summary: string | null | undefined }>,
): React.ReactElement | null {
  if (!props.summary) return null;
  return (
    <View style={styles.slot} testID="new-session-creation-review">
      <Text style={styles.line}>{props.summary}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    marginBottom: theme.space.s8,
  },
  line: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
