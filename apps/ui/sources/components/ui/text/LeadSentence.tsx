import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** What a page or sheet states first: a statement in ink, and the quiet clause that finishes it. */
export type LeadSentenceContent = Readonly<{
  statement: string;
  detail: string | null;
}>;

/**
 * The one lead anatomy (lab `mc-acsay`, sandbox sheets): "devbox runs sessions directly." in ink, then the quiet
 * continuation in the same paragraph, held to the reading measure. Machine sub-page heads and step sheets use it.
 */
export function LeadSentence(
  props: LeadSentenceContent &
    Readonly<{ testID?: string; style?: StyleProp<TextStyle> }>,
) {
  return (
    <Text testID={props.testID} style={[styles.lead, props.style]}>
      <Text style={styles.statement}>{props.statement}</Text>
      {props.detail ? ` ${props.detail}` : null}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  lead: {
    ...Typography.variant('heading', 'regular'),
    color: theme.colors.text.secondary,
    maxWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading,
  },
  statement: {
    ...Typography.variant('heading', 'semiBold'),
    color: theme.colors.text.primary,
  },
}));
