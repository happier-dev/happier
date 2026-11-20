import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HAPPIER_BALANCED_TEXT_WRAP } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { useStepFocal } from '@/components/ui/motion/stepMotion/useStepFocal';

import { STEP_ROW_BUTTON_PX, StepRowBackButton, useStepRowBack } from './stepBack';

export type UnauthenticatedStepProps = Readonly<{
  /** The step's page heading. Omit when the body owns its own heading (a form with sub-views). */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** One quiet line above the heading naming what the step acts on (the Home being signed in to). */
  context?: React.ReactNode;
  children?: React.ReactNode;
  /** Actions under the body: the primary button, a quiet escape. */
  footer?: React.ReactNode;
  testID?: string;
}>;

/**
 * The column of one signed-out step inside the workflow pane: heading, purpose, body, then its
 * actions. Every pre-auth step — the welcome wizard's own steps and the standalone recovery,
 * terminal and Team routes — composes through this so a step changes what sits in the pane and
 * never where it starts or how its heading reads.
 */
/**
 * A signed-out step's heading block: the one look of a step's title and purpose. A step body that
 * titles itself (its heading changes with its own sub-views) draws its heading through this too.
 */
export function UnauthenticatedStepHeading(props: Readonly<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  context?: React.ReactNode;
  testID?: string;
}>) {
  useUnistyles();
  const styles = stylesheet;
  const headingRef = useStepFocal('heading');
  return (
    <View style={styles.header}>
      {props.context ? <View style={styles.context}>{props.context}</View> : null}
      <Text ref={headingRef} testID={props.testID} accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
      {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

export function UnauthenticatedStep(props: UnauthenticatedStepProps) {
  useUnistyles();
  const styles = stylesheet;
  const hasHeader = props.title != null && props.title !== '';
  const body = props.children == null ? null : <View style={styles.body}>{props.children}</View>;

  return (
    <View testID={props.testID} style={styles.root}>
      <View style={styles.content}>
        {hasHeader ? (
          <UnauthenticatedStepHeading
            title={props.title}
            subtitle={props.subtitle}
            context={props.context}
            testID={props.testID ? `${props.testID}-title` : undefined}
          />
        ) : null}
        {body}
      </View>
      {props.footer ? <UnauthenticatedStepFooter>{props.footer}</UnauthenticatedStepFooter> : null}
    </View>
  );
}

/**
 * A step's actions, centred on the column (direction A). On a computer the step's Back stands to the left of its
 * Continue and an equal space balances it on the right, so Continue stays on the column's axis.
 */
function UnauthenticatedStepFooter(props: Readonly<{ children: React.ReactNode }>) {
  useUnistyles();
  const styles = stylesheet;
  const back = useStepRowBack();
  return (
    <View style={styles.footer}>
      {back ? <StepRowBackButton onPress={back} /> : null}
      <View style={styles.footerActions}>{props.children}</View>
      {back ? <View style={styles.footerBalance} /> : null}
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
  // The description sits directly under the title, as on every page (PageHeader): the title's own line
  // box is the air between them, so the two read as one block (owner review 11-16).
  header: {
    width: '100%',
    alignItems: 'center',
  },
  context: {
    marginBottom: theme.space.s8,
  },
  title: {
    ...Typography.variant('display'),
    color: theme.colors.text.primary,
    textAlign: 'center',
    ...HAPPIER_BALANCED_TEXT_WRAP,
  },
  // Two short balanced lines under the title (lab direction A).
  subtitle: {
    ...Typography.variant('reading'),
    color: theme.colors.text.secondary,
    textAlign: 'center',
    maxWidth: 440,
    marginTop: theme.space.s6,
    ...HAPPIER_BALANCED_TEXT_WRAP,
  },
  body: {
    width: '100%',
    gap: theme.space.s24,
  },
  footer: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    gap: theme.space.s12,
  },
  footerActions: {
    alignItems: 'center',
    gap: theme.space.s12,
  },
  footerBalance: {
    width: STEP_ROW_BUTTON_PX,
  },
}));
