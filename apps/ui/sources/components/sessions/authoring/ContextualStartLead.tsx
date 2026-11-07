import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * What a contextual Start is, at the top of the Start pane or phone sheet (lab flRun `review`, flWork
 * `start`): the marks of who or what will run, one title and the sentence that finishes it. The Run
 * form and the Workflow Start share it so both Starts open on the same edge, type and rhythm.
 */
export function ContextualStartLead(
  props: Readonly<{
    title: string;
    description?: string | null;
    marks?: React.ReactNode;
    testID?: string;
    /** Facts that belong to this start (a comparison's scope, where it runs), under the description. */
    children?: React.ReactNode;
  }>,
) {
  return (
    <View testID={props.testID} style={styles.lead}>
      {props.marks ? <View style={styles.marks}>{props.marks}</View> : null}
      <Text accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
      {props.description ? (
        <Text style={styles.description}>{props.description}</Text>
      ) : null}
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  lead: {
    gap: theme.space.s6,
  },
  marks: {
    flexDirection: 'row',
    gap: theme.space.s6,
  },
  title: {
    color: theme.colors.text.primary,
    ...Typography.variant('title'),
  },
  description: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
}));
