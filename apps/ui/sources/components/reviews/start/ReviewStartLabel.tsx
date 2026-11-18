import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The start sheet's one in-content label (Reviews lab round 8, `.rv-label`): the label role, semi-bold, in
 * primary ink, for What to review, every step header, Focus, Then and Advanced alike.
 */
export function ReviewStartLabel(
  props: Readonly<{
    children: string;
    testID?: string;
    numberOfLines?: number;
  }>,
) {
  return (
    <Text
      style={styles.label}
      testID={props.testID}
      numberOfLines={props.numberOfLines}
    >
      {props.children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
}));
