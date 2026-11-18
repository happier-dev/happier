import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The Reviews in-content label (Reviews lab round 8, `.rv-label`): the label role, semi-bold, in primary
 * ink. One style for the start sheet (What to review, step headers, Focus, Then, Advanced), the Review
 * page (round, Submit your review) and the opened finding's sections.
 */
export function ReviewLabel(
  props: Readonly<{
    children: string;
    /** `header` when the label opens a page section (not inside a toggle that already names itself). */
    role?: 'header';
    testID?: string;
    numberOfLines?: number;
  }>,
) {
  return (
    <Text
      accessibilityRole={props.role}
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
