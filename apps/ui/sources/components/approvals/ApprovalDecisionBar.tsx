import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HappierDecisionBar,
  type HappierDecisionAction,
  type HappierDecisionBarProps,
  type HappierDecisionButtonProps,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

type ApprovalDecisionAction = Omit<HappierDecisionAction, 'label'> & Readonly<{ label?: string }>;

export type ApprovalDecisionBarProps = Omit<HappierDecisionBarProps, 'Button' | 'approve' | 'reject' | 'dismiss'> & Readonly<{
  /** The approved Action declares it cannot be undone: the approval reads as destructive and says so once. */
  irreversible?: boolean;
  /** Where the surface has no room under the buttons (an Inbox row), it carries the sentence itself. */
  hideIrreversibleNote?: boolean;
  /**
   * A row in a long list of requests (the Inbox): the one-shot answer is a bordered button and Deny is plain text, so a
   * page of requests doesn't shout with a filled button on every row (lab P4). A single request keeps the filled primary.
   */
  quiet?: boolean;
  approve?: ApprovalDecisionAction;
  reject?: ApprovalDecisionAction;
  dismiss?: ApprovalDecisionAction;
}>;

/** Host button/font/focus boundary only; the shared bar owns all decision presentation. */
function ApprovalDecisionButton(props: Omit<HappierDecisionButtonProps, 'emphasis'> & Readonly<{ emphasis: HappierDecisionButtonProps['emphasis'] | 'destructive' | 'quietDestructive' }>) {
  return <RoundButtonSizeScope size={props.size} presentation="uniform">
    <RoundButton size={props.size} title={props.label} accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint} titleNumberOfLines="complete"
      display={props.emphasis === 'destructive' || props.emphasis === 'quietDestructive' ? props.emphasis : props.emphasis === 'primary' ? 'default' : props.emphasis === 'plain' ? 'inverted' : 'secondary'}
      disabled={props.disabled} loading={props.busy} testID={props.testID} controlRef={props.controlRef}
      onPress={props.onPress} />
  </RoundButtonSizeScope>;
}

/** The same host button with the destructive treatment, for an approval the Action declares irreversible. */
function IrreversibleApprovalDecisionButton(props: HappierDecisionButtonProps) {
  return <ApprovalDecisionButton {...props} emphasis={props.emphasis === 'primary' ? 'destructive' : props.emphasis} />;
}

/** A row's answer: the same host button, one step quieter (bordered Allow, plain Deny). */
function QuietApprovalDecisionButton(props: HappierDecisionButtonProps) {
  return <ApprovalDecisionButton {...props} emphasis={props.emphasis === 'primary' ? 'secondary' : props.emphasis === 'secondary' ? 'plain' : props.emphasis} />;
}

/**
 * A row's answer to an irreversible request: the approval keeps its danger ink without an outline, so a
 * list of such requests doesn't read as a column of alarms and nothing on the row invites the press.
 * Its line says what the verb means; the request's own page keeps the full destructive button.
 */
function QuietIrreversibleApprovalDecisionButton(props: HappierDecisionButtonProps) {
  return <ApprovalDecisionButton {...props} emphasis={props.emphasis === 'primary' ? 'quietDestructive' : props.emphasis === 'secondary' ? 'plain' : props.emphasis} />;
}

/** Localized host defaults; request-specific consequence labels remain with their existing owners. */
export function ApprovalDecisionBar({ approve, reject, dismiss, irreversible, hideIrreversibleNote, quiet, ...props }: ApprovalDecisionBarProps) {
  const bar = <HappierDecisionBar {...props} Button={quiet
      ? (irreversible ? QuietIrreversibleApprovalDecisionButton : QuietApprovalDecisionButton)
      : (irreversible ? IrreversibleApprovalDecisionButton : ApprovalDecisionButton)}
    approve={approve ? { ...approve, label: approve.label ?? t('approvals.approve') } : undefined}
    reject={reject ? { ...reject, label: reject.label ?? t('approvals.reject') } : undefined}
    dismiss={dismiss ? { ...dismiss, label: dismiss.label ?? t('approvals.dismiss') } : undefined} />;
  if (!irreversible || !approve || hideIrreversibleNote) return bar;
  return <View style={styles.withNote}>
    <Text variant="meta" style={styles.note} testID="approvals.irreversible-note">{t('approvals.irreversibleNote')}</Text>
    {bar}
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  withNote: { gap: theme.space.s8 },
  note: { color: theme.colors.text.secondary },
}));
