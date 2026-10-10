import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionPendingMessages } from '@/sync/store/hooks';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import {
  resolveUsageResetStartBinding,
  type UsagePlanAccount,
  type UsageResetStartBinding,
} from './usagePlansModel';
import type { UsagePlanAccountName } from './useUsagePlans';
import { useUsagePlanAction } from './UsagePlanActions';
import { formatPlanMoment, UsagePlanSectionHead, usePlanText } from './UsagePlanParts';

type ResetOption = Readonly<{
  id: string;
  title: string;
  subtitle: string;
  reset: Extract<UsageResetStartBinding, { status: 'available' }>['reset'];
}>;

const UNAVAILABLE_KEYS = {
  no_reading: 'usage.board.plans.resetStartNoReading',
  no_reset: 'usage.board.plans.resetStartNoReset',
  no_witness: 'usage.board.plans.resetStartNoWitness',
} as const;

/**
 * "Start at a reset" for the one Session this view is about (lab `p2reset` Q): each of its queued
 * messages can be held for a known reset through the pending owner's own Action. The binding is the
 * read's source, record and latest accepted entry; with nothing to witness, the control is withheld
 * and says why instead of offering a form that cannot succeed.
 */
export function UsageResetStartSection(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    accounts: readonly UsagePlanAccount[];
    nameOf: (account: UsagePlanAccount) => UsagePlanAccountName;
    nowMs: number;
    onSettled: () => void;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const pending = useSessionPendingMessages(props.sessionId);
  const { accounts, nameOf, nowMs } = props;
  const resolved = React.useMemo(() => {
    const options: ResetOption[] = [];
    let reason: keyof typeof UNAVAILABLE_KEYS = 'no_reset';
    for (const account of accounts) {
      for (const window of account.windows) {
        if (window.resetAtMs === null) continue;
        const binding = resolveUsageResetStartBinding(account, window.meterId);
        if (binding.status === 'unavailable') {
          reason = binding.reason;
          continue;
        }
        options.push({
          id: window.key,
          title: `${nameOf(account).title} · ${window.label}`,
          subtitle: t('usage.board.plans.capacityResets', { time: formatPlanMoment(window.resetAtMs, nowMs) }),
          reset: binding.reset,
        });
      }
    }
    return { options, reason };
  }, [accounts, nameOf, nowMs]);
  // A message already held for a reset is in the waiting list; replies that are not the user's are not startable.
  const messages = pending.messages.filter(
    (message) =>
      message.localId !== null &&
      message.messageRole !== 'non_user' &&
      message.pendingRequestedAction?.kind !== 'reset_start',
  );
  if (messages.length === 0) return null;
  return (
    <View testID={props.testID} style={styles.section}>
      <UsagePlanSectionHead title={t('usage.board.plans.resetStartTitle')} meta={t('usage.board.plans.resetStartMeta')} />
      {resolved.options.length === 0 ? (
        <Text testID={`${props.testID}.unavailable`} style={[styles.quiet, text.detail]}>
          {t(UNAVAILABLE_KEYS[resolved.reason])}
        </Text>
      ) : (
        messages.map((message) => (
          <ResetStartRow
            key={message.id}
            message={message}
            options={resolved.options}
            sessionId={props.sessionId}
            serverId={props.serverId}
            onSettled={props.onSettled}
            testID={`${props.testID}.${message.localId}`}
          />
        ))
      )}
    </View>
  );
}

function ResetStartRow(
  props: Readonly<{
    message: PendingMessage;
    options: readonly ResetOption[];
    sessionId: string;
    serverId: string;
    onSettled: () => void;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const [open, setOpen] = React.useState(false);
  const action = useUsagePlanAction();
  const { options, message, sessionId, serverId, onSettled } = props;
  const items = React.useMemo(
    () => options.map((option) => ({ id: option.id, title: option.title, subtitle: option.subtitle })),
    [options],
  );
  const status =
    action.state === 'approval'
      ? t('usage.board.plans.waitingApproval')
      : action.state === 'failed'
        ? t('usage.board.plans.resetStartFailed')
        : null;
  return (
    <View testID={props.testID} style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.title, text.title]} numberOfLines={1}>
          {message.displayText ?? message.text}
        </Text>
        {status ? (
          <Text
            style={[styles.quiet, text.detail]}
            {...(action.state === 'failed' ? { accessibilityRole: 'alert' as const } : {})}
            numberOfLines={1}
          >
            {status}
          </Text>
        ) : null}
      </View>
      <DropdownMenu
        testID={`${props.testID}.pick`}
        open={open}
        onOpenChange={setOpen}
        matchTriggerWidth={false}
        items={items}
        onSelect={(id) => {
          setOpen(false);
          const option = options.find((candidate) => candidate.id === id);
          if (!option || message.localId === null) return;
          void action.run(
            'session.pending.resetStart.set',
            { sessionId, localId: message.localId, serverId, reset: option.reset },
            onSettled,
          );
        }}
        trigger={({ toggle }) => (
          <RoundButton
            size="small"
            display="secondary"
            title={t('usage.board.plans.resetStartAction')}
            testID={`${props.testID}.open`}
            loading={action.state === 'pending'}
            disabled={action.state === 'pending' || action.state === 'approval'}
            onPress={toggle}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  title: { ...Typography.default('medium'), color: theme.colors.text.primary },
  quiet: { ...Typography.default(), color: theme.colors.text.tertiary },
}));
