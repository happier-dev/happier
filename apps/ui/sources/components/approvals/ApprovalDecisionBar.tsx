import * as React from 'react';
import {
  HappierDecisionBar,
  type HappierDecisionAction,
  type HappierDecisionBarProps,
  type HappierDecisionButtonProps,
} from '@happier-dev/plugin-ui/presentation';

import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

type ApprovalDecisionAction = Omit<HappierDecisionAction, 'label'> & Readonly<{ label?: string }>;

export type ApprovalDecisionBarProps = Omit<HappierDecisionBarProps, 'Button' | 'approve' | 'reject' | 'dismiss'> & Readonly<{
  approve?: ApprovalDecisionAction;
  reject?: ApprovalDecisionAction;
  dismiss?: ApprovalDecisionAction;
}>;

/** Host button/font/focus boundary only; the shared bar owns all decision presentation. */
function ApprovalDecisionButton(props: HappierDecisionButtonProps) {
  return <RoundButtonSizeScope size={props.size} presentation="uniform">
    <RoundButton size={props.size} title={props.label} accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint} titleNumberOfLines="complete"
      display={props.emphasis === 'primary' ? 'default' : props.emphasis === 'plain' ? 'inverted' : 'secondary'}
      disabled={props.disabled} loading={props.busy} testID={props.testID} controlRef={props.controlRef}
      onPress={props.onPress} />
  </RoundButtonSizeScope>;
}

/** Localized host defaults; request-specific consequence labels remain with their existing owners. */
export function ApprovalDecisionBar({ approve, reject, dismiss, ...props }: ApprovalDecisionBarProps) {
  return <HappierDecisionBar {...props} Button={ApprovalDecisionButton}
    approve={approve ? { ...approve, label: approve.label ?? t('approvals.approve') } : undefined}
    reject={reject ? { ...reject, label: reject.label ?? t('approvals.reject') } : undefined}
    dismiss={dismiss ? { ...dismiss, label: dismiss.label ?? t('approvals.dismiss') } : undefined} />;
}
