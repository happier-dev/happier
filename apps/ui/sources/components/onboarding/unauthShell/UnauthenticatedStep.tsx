import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HAPPIER_BALANCED_TEXT_WRAP } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { StepEntranceBody } from '@/components/ui/motion/stepMotion/StepEntranceBody';
import { useStepFocal } from '@/components/ui/motion/stepMotion/useStepFocal';

import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import type { IconName } from '@/components/ui/icons/Icon';

import { StepMark } from './StepMark';

import { useUnauthShellLayout } from './useUnauthShellLayout';
import { STEP_ROW_BUTTON_PX, StepBackContext, StepRowBackButton, UNAUTH_LEAVE_TEST_ID, useStepLeave, useStepRowBack } from './stepBack';

/** A dead end's way out, drawn as the page's pill: its own exit, or the shell's Back when it has none. */
export type StepLeaveAction = Readonly<{ label: string; onPress?: () => void; testID?: string }>;

export type UnauthenticatedStepProps = Readonly<{
  /** The step's page heading. Omit when the body owns its own heading (a form with sub-views). */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** The subtitle's test id, when the subtitle is the state's own sentence (a dead link, a done change). */
  subtitleTestID?: string;
  /** One quiet line above the heading naming what the step acts on (the Home being signed in to). */
  context?: React.ReactNode;
  /** A round mark over the heading naming what the step is about ({@link StepMark}). */
  mark?: React.ReactNode;
  /**
   * A terminal answer (a link that leads nowhere): the column stands lower over the planet with fewer words, and its
   * way out is the page's pill instead of the shell's Back (lab direction A, problem steps).
   */
  problem?: Readonly<{ leave?: StepLeaveAction }>;
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
  mark?: React.ReactNode;
  testID?: string;
  subtitleTestID?: string;
}>) {
  useUnistyles();
  const styles = stylesheet;
  const headingRef = useStepFocal('heading');
  return (
    <View style={styles.header}>
      {props.mark ? <View style={styles.mark}>{props.mark}</View> : null}
      {props.context ? <View style={styles.context}>{props.context}</View> : null}
      <Text ref={headingRef} testID={props.testID} accessibilityRole="header" style={styles.title}>
        {props.title}
      </Text>
      {props.subtitle ? <Text testID={props.subtitleTestID} style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

/**
 * A body that owns its heading and turns into a terminal answer in place (a scanned code that cannot be used): the
 * problem step's placement, lower over the planet, with its round mark over the heading. The same object as a routed
 * problem step ({@link UnauthenticatedStepProps.problem}), announced as a status.
 */
export function StepProblemHeading(props: Readonly<{
  iconName: IconName;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  context?: React.ReactNode;
  testID?: string;
  subtitleTestID?: string;
}>) {
  useUnistyles();
  const styles = stylesheet;
  const compact = useUnauthShellLayout() === 'compact';
  return (
    <View style={compact ? styles.rootProblemCompact : styles.rootProblem}
      accessibilityRole="text" accessibilityLiveRegion="polite" aria-live="polite" role="status">
      <UnauthenticatedStepHeading
        mark={<StepMark iconName={props.iconName} />}
        title={props.title}
        subtitle={props.subtitle}
        context={props.context}
        testID={props.testID}
        subtitleTestID={props.subtitleTestID}
      />
    </View>
  );
}

export function UnauthenticatedStep(props: UnauthenticatedStepProps) {
  useUnistyles();
  const styles = stylesheet;
  const hasHeader = props.title != null && props.title !== '';
  const body = props.children == null ? null
    : <StepEntranceBody style={styles.body} followHeading={hasHeader}>{props.children}</StepEntranceBody>;
  const leave = props.problem?.leave;
  const compact = useUnauthShellLayout() === 'compact';

  return (
    <View
      testID={props.testID}
      style={[styles.root, props.problem ? (compact ? styles.rootProblemCompact : styles.rootProblem) : null]}
    >
      <View style={styles.content}>
        {hasHeader ? (
          <UnauthenticatedStepHeading
            title={props.title}
            subtitle={props.subtitle}
            subtitleTestID={props.subtitleTestID}
            context={props.context}
            mark={props.mark}
            testID={props.testID ? `${props.testID}-title` : undefined}
          />
        ) : null}
        {body}
      </View>
      {props.footer || leave ? (
        <UnauthenticatedStepFooter leave={leave}>{props.footer}</UnauthenticatedStepFooter>
      ) : null}
    </View>
  );
}

/**
 * A step's actions, centred on the column (direction A). On a computer the step's Back stands to the left of its
 * Continue and an equal space balances it on the right, so Continue stays on the column's axis.
 */
function UnauthenticatedStepFooter(props: Readonly<{ children?: React.ReactNode; leave?: StepLeaveAction }>) {
  return props.leave
    ? <LeaveStepFooter leave={props.leave}>{props.children}</LeaveStepFooter>
    : <StepActions>{props.children}</StepActions>;
}

/**
 * A step's centred actions with Back to their left on a computer, for a body that draws its own actions (a form with
 * sub-views). `onBack` is the body's own way back, used where no signed-out shell provides one (a signed-in card);
 * inside the shell the body routes its Back through the shell (`useStepBackOverride`).
 */
export function StepActions(props: Readonly<{ children?: React.ReactNode; onBack?: () => void }>) {
  useUnistyles();
  const styles = stylesheet;
  const slot = React.useContext(StepBackContext);
  const rowBack = useStepRowBack();
  const back = rowBack ?? (slot ? null : props.onBack ?? null);
  const compact = useUnauthShellLayout() === 'compact';
  return (
    <View style={styles.footer}>
      {back ? <StepRowBackButton onPress={back} /> : null}
      <View style={[styles.footerActions, compact ? styles.footerActionsCompact : null]}>{props.children}</View>
      {back ? <View style={styles.footerBalance} /> : null}
    </View>
  );
}

/** A dead end's actions: its one action (if any), then its way out as the page's pill, in place of the shell's Back. */
function LeaveStepFooter(props: Readonly<{ children?: React.ReactNode; leave: StepLeaveAction }>) {
  useUnistyles();
  const styles = stylesheet;
  const back = useStepLeave();
  const onLeave = props.leave.onPress ?? back;
  const compact = useUnauthShellLayout() === 'compact';
  return (
    <View style={styles.footer}>
      <View style={[styles.footerActions, compact ? styles.footerActionsCompact : null]}>
        {props.children}
        {onLeave ? (
          <WelcomeActionCard
            testID={props.leave.testID ?? UNAUTH_LEAVE_TEST_ID}
            title={props.leave.label}
            presentation="pill"
            escape
            onPress={onLeave}
          />
        ) : null}
      </View>
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
  // The description sits close under the title so the two read as one block (owner review 11-16); the final lab
  // (direction A) sets that air at s10.
  header: {
    width: '100%',
    alignItems: 'center',
  },
  // A terminal answer stands lower over the planet than a working step (lab direction A, problem steps).
  rootProblem: {
    paddingTop: theme.space.s48 + theme.space.s24,
  },
  rootProblemCompact: {
    paddingTop: theme.space.s40,
  },
  mark: {
    marginBottom: theme.space.s24,
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
    marginTop: theme.space.s10,
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
  // On a phone the actions take the column's width, so a step's primary can span it (lab direction A).
  footerActionsCompact: {
    flex: 1,
  },
  footerBalance: {
    width: STEP_ROW_BUTTON_PX,
  },
}));
