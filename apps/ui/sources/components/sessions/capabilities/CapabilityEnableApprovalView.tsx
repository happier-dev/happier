import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { ApprovalDecisionBar } from '@/components/approvals/ApprovalDecisionBar';
import { CapabilityFacts, type CapabilityCost } from '@/components/capabilities/facts/CapabilityFacts';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { CapabilityEnableApprovalSnapshot } from './capabilityEnableApproval';

/** What the body says, decided from the request, the shared decision and the durable approval status. */
export type CapabilityEnableApprovalViewModel = Readonly<{
  title: string;
  reason: string | null;
  /** "Linear is off in happier." */
  offLine: string | null;
  /** "Always in happier turns it on for every session in happier, on every machine." */
  alwaysLine: string | null;
  cost: CapabilityCost | null;
  timing: string | null;
  connected: boolean;
  allowLabel: string;
  alwaysLabel: string | null;
  /** A blocking status whose fix replaces the primary decision ("Sign in to Linear"). */
  blocking: Readonly<{ label: string; onPress: () => void }> | null;
  settled: CapabilityEnableApprovalSettled | null;
  decisionError: string | null;
  deciding: boolean;
}>;
export type CapabilityEnableApprovalSettled = Readonly<{
  /** `save_failed`: the session part held, the wider write did not (rose meta, one retry). */
  tone: 'allowed' | 'declined' | 'save_failed';
  text: string;
  meta: string | null;
  action: Readonly<{
    label: string;
    run: () => unknown;
    testID: string;
  }> | null;
}>;

export function describeCapabilityEnableSettled(
  input: Readonly<{
    approvalStatus: ApprovalRequest['status'];
    snapshot: CapabilityEnableApprovalSnapshot | null;
    itemTitle: string;
    agentName: string;
    placeName: string | null;
    timing: string | null;
    undoSession: () => unknown;
    undoAlways: () => unknown;
    retryAlways: () => unknown;
  }>,
): CapabilityEnableApprovalSettled | null {
  const status = input.snapshot?.status ?? 'idle';
  const allowed = t('capabilities.session.ask.allowedSession', {
    item: input.itemTitle,
  });
  switch (status) {
    case 'always_saved':
      return {
        tone: 'allowed',
        text: t('capabilities.session.ask.alwaysOn', {
          item: input.itemTitle,
          place: input.placeName ?? '',
        }),
        meta: t('capabilities.session.ask.alwaysOnMeta'),
        action: {
          label: t('capabilities.session.ask.undo'),
          run: input.undoAlways,
          testID: 'capability-enable-undo-always',
        },
      };
    case 'saving_always':
      return {
        tone: 'allowed',
        text: allowed,
        meta: t('capabilities.session.ask.saving'),
        action: null,
      };
    case 'always_failed':
      return {
        tone: 'save_failed',
        text: allowed,
        meta: t('capabilities.session.ask.alwaysFailed'),
        action: {
          label: t('capabilities.session.ask.tryAgain'),
          run: input.retryAlways,
          testID: 'capability-enable-retry-always',
        },
      };
    case 'session_allowed':
      return {
        tone: 'allowed',
        text: allowed,
        meta: input.timing,
        action: {
          label: t('capabilities.session.ask.undo'),
          run: input.undoSession,
          testID: 'capability-enable-undo-session',
        },
      };
    case 'rejected':
      return {
        tone: 'declined',
        text: t('capabilities.session.ask.notNow'),
        meta: t('capabilities.session.ask.declinedMeta', {
          agent: input.agentName,
          item: input.itemTitle,
        }),
        action: null,
      };
    case 'deciding':
      // The durable status may flip before our own decision returns; never call that "another device".
      return null;
    default:
      break;
  }
  // Decided on another device or by an earlier view of this request: the durable answer, without local Undo.
  if (input.approvalStatus === 'open') return null;
  if (input.approvalStatus === 'canceled') {
    // Only the request's own outcome: whether the item is on now is not this historical card's to say.
    return {
      tone: 'declined',
      text: t('approvals.status.canceled'),
      meta: input.itemTitle,
      action: null,
    };
  }
  if (input.approvalStatus === 'rejected') {
    return {
      tone: 'declined',
      text: t('capabilities.session.ask.notNow'),
      meta: t('capabilities.session.ask.answeredElsewhere'),
      action: null,
    };
  }
  if (input.approvalStatus === 'failed') {
    return {
      tone: 'declined',
      text: t('capabilities.session.ask.decisionFailed', {
        item: input.itemTitle,
      }),
      meta: null,
      action: null,
    };
  }
  return {
    tone: 'allowed',
    text: allowed,
    meta: t('capabilities.session.ask.answeredElsewhere'),
    action: null,
  };
}

/** Pure presentation of the enable request, so every state can be drawn from its model. */
export const CapabilityEnableApprovalView = React.memo(
  function CapabilityEnableApprovalView(
    props: Readonly<{
      model: CapabilityEnableApprovalViewModel;
      chrome: 'card' | 'inline';
      decisionsAvailable: boolean;
      headerAccessory?: React.ReactNode;
      onChoose?: (choice: 'session' | 'always' | 'reject') => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    // A phone stacks the decisions full width (lab xi Qp).
    const phone = isMobileLayoutWidth(useWindowDimensions().width);
    const { model } = props;
    if (model.settled) return <CapabilityEnableSettledLine settled={model.settled} />;
    const choose = props.onChoose;
    const available = props.decisionsAvailable && choose !== undefined;
    return (
      <ApprovalPromptChrome
        testID="capability-enable-approval"
        chrome={props.chrome}
        tone="attention"
        title={model.title}
        titleNumberOfLines={2}
        subtitle={model.reason}
        subtitleNumberOfLines={2}
        headerAccessory={props.headerAccessory}
        footer={
          available ? (
            <ApprovalDecisionBar
              layout={phone ? 'stacked' : 'inline'}
              size="small"
              busy={model.deciding}
              approve={
                model.blocking
                  ? {
                      label: model.blocking.label,
                      testID: 'capability-enable-fix',
                      onPress: model.blocking.onPress,
                    }
                  : {
                      label: model.allowLabel,
                      testID: 'capability-enable-session',
                      onPress: () => choose('session'),
                    }
              }
              alternative={
                model.alwaysLabel && !model.blocking
                  ? {
                      label: model.alwaysLabel,
                      testID: 'capability-enable-always',
                      onPress: () => choose('always'),
                    }
                  : undefined
              }
              reject={{
                label: t('capabilities.session.ask.notNow'),
                testID: 'capability-enable-reject',
                onPress: () => choose('reject'),
              }}
            />
          ) : undefined
        }
      >
        {model.offLine ? (
          <Text variant="body" style={styles.consequence}>
            <Text
              variant="body"
              emphasis="medium"
              style={styles.consequenceStrong}
            >
              {model.offLine}
            </Text>
            {model.alwaysLine ? ` ${model.alwaysLine}` : null}
          </Text>
        ) : null}
        {model.cost || model.timing || model.connected ? (
          <CapabilityFacts
            presentation="row"
            cost={model.cost ?? undefined}
            extra={[
              ...(model.connected
                ? [t('capabilities.session.ask.connected')]
                : []),
              ...(model.timing ? [model.timing] : []),
            ]}
          />
        ) : null}
        {model.decisionError ? (
          <View accessibilityRole="alert" style={styles.errorLine}>
            <Icon
              name="warning-circle"
              size={14}
              color={theme.colors.state.danger.foreground}
            />
            <Text variant="meta" style={styles.errorText}>
              {model.decisionError}
            </Text>
          </View>
        ) : null}
      </ApprovalPromptChrome>
    );
  },
);


/** The one settled line of an enable request (allowed, saving, saved with Undo, failed with Try again, declined). */
export function CapabilityEnableSettledLine(props: Readonly<{ settled: CapabilityEnableApprovalSettled }>) {
    const { theme } = useUnistyles();
    const settled = props.settled;
    return (
        <View testID="capability-enable-settled" style={styles.settled}>
          <Icon
            name={settled.tone === 'declined' ? 'minus-circle' : 'check-circle'}
            size={16}
            color={
              settled.tone === 'declined'
                ? theme.colors.text.tertiary
                : theme.colors.text.secondary
            }
          />
          <Text variant="body" style={styles.settledText} numberOfLines={2}>
            <Text variant="body" emphasis="medium" style={styles.settledStrong}>
              {settled.text}
            </Text>
            {settled.meta ? (
              <Text
                variant="body"
                style={settled.tone === 'save_failed' ? styles.settledMetaFailed : styles.settledMeta}
              >{` · ${settled.meta}`}</Text>
            ) : null}
          </Text>
          {settled.action ? (
            <TextLinkButton
              testID={settled.action.testID}
              label={settled.action.label}
              tone="strong"
              onPress={settled.action.run}
            />
          ) : null}
        </View>
    );
}


/**
 * The page anatomy of the request's decisions (Inbox Details): Allow for this session · Always in <place> ·
 * Not now, plus the page's own Dismiss; once decided, the card's settled line. Same controller as the card.
 */
export function CapabilityEnableDecisionBar(props: Readonly<{
    model: Pick<CapabilityEnableApprovalViewModel, 'allowLabel' | 'alwaysLabel' | 'blocking' | 'settled' | 'deciding'>;
    choose: (choice: 'session' | 'always' | 'reject') => unknown;
    disabled: boolean;
    onDismiss?: () => void;
}>) {
    const { model, choose } = props;
    if (model.settled) return <CapabilityEnableSettledLine settled={model.settled} />;
    const disabled = props.disabled || model.deciding;
    return (
        <ApprovalDecisionBar testID="approvals.actions" busy={model.deciding}
            approve={model.blocking
                ? { testID: 'approvals.approve', label: model.blocking.label, disabled: props.disabled, onPress: model.blocking.onPress }
                : { testID: 'approvals.approve', label: model.allowLabel, disabled, onPress: () => { void choose('session'); } }}
            alternative={model.alwaysLabel && !model.blocking
                ? { testID: 'approvals.always', label: model.alwaysLabel, disabled, onPress: () => { void choose('always'); } }
                : undefined}
            dismiss={props.onDismiss ? { testID: 'approvals.cancel', label: t('approvals.dismiss'), disabled,
                accessibilityHint: t('approvals.dismissHint'), onPress: props.onDismiss } : undefined}
            reject={{ testID: 'approvals.reject', label: t('capabilities.session.ask.notNow'), disabled, onPress: () => { void choose('reject'); } }} />
    );
}

const styles = StyleSheet.create((theme) => ({
  consequence: {
    color: theme.colors.text.secondary,
  },
  consequenceStrong: {
    color: theme.colors.text.primary,
  },
  errorLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  errorText: {
    color: theme.colors.state.danger.foreground,
    flexShrink: 1,
  },
  settled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
    paddingHorizontal: theme.space.s4,
  },
  settledText: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  settledStrong: {
    color: theme.colors.text.primary,
  },
  settledMetaFailed: {
    color: theme.colors.state.danger.foreground,
  },
  settledMeta: {
    color: theme.colors.text.secondary,
  },
}));
