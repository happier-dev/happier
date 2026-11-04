import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  StepTransitionFrame,
  type StepTransitionDirection,
} from '@/components/ui/motion/StepTransitionFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type UnauthenticatedStepProps = Readonly<{
  /** The step's page heading. Omit when the body owns its own heading (a form with sub-views). */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** One quiet line above the heading naming what the step acts on (the Home being signed in to). */
  context?: React.ReactNode;
  children?: React.ReactNode;
  /** Actions under the body: the primary button, a quiet escape. */
  footer?: React.ReactNode;
  /** Animates only the body when the step changes inside a host that keeps the heading mounted. */
  bodyTransitionKey?: string | number;
  bodyTransitionDirection?: StepTransitionDirection;
  testID?: string;
}>;

/**
 * The column of one signed-out step inside the workflow pane: heading, purpose, body, then its
 * actions. Every pre-auth step — the welcome wizard's own steps and the standalone recovery,
 * terminal and Team routes — composes through this so a step changes what sits in the pane and
 * never where it starts or how its heading reads.
 */
export function UnauthenticatedStep(props: UnauthenticatedStepProps) {
  useUnistyles();
  const styles = stylesheet;
  const hasHeader = props.title != null && props.title !== '';
  const body = props.children == null ? null : <View style={styles.body}>{props.children}</View>;

  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.content}>
        {hasHeader ? (
          <View style={styles.header}>
            {props.context ? <View style={styles.context}>{props.context}</View> : null}
            <Text
              testID={props.testID ? `${props.testID}-title` : undefined}
              accessibilityRole="header"
              style={styles.title}
            >
              {props.title}
            </Text>
            {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
          </View>
        ) : null}
        {body && props.bodyTransitionKey != null ? (
          <StepTransitionFrame
            transitionKey={props.bodyTransitionKey}
            direction={props.bodyTransitionDirection ?? 'forward'}
            testID={props.testID ? `${props.testID}-body-transition` : undefined}
          >
            {body}
          </StepTransitionFrame>
        ) : (
          body
        )}
      </View>
      {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    justifyContent: 'flex-start',
    gap: theme.space.s24,
  },
  // The heading block and the body are two groups: a body's first field label must not read as
  // a third line of the heading, so they sit a section apart while the heading's lines stay close.
  content: {
    width: '100%',
    gap: theme.space.s24,
  },
  header: {
    width: '100%',
    gap: theme.space.s10,
  },
  context: {
    marginBottom: theme.space.s2,
  },
  title: {
    ...Typography.variant('display'),
    color: theme.colors.text.primary,
  },
  subtitle: {
    ...Typography.default(),
    fontSize: 16,
    lineHeight: 24,
    color: theme.colors.text.secondary,
  },
  body: {
    width: '100%',
    gap: theme.space.s24,
  },
  footer: {
    width: '100%',
    alignItems: 'flex-start',
    gap: 14,
  },
}));
