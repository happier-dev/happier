import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { deriveQuotaMeterValues } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { formatResetCountdown, isResetCountdownOutdated, type ResetCountdownFormatter } from '@/sync/domains/connectedServices/formatResetCountdown';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { t } from '@/text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type IoniconName = IconName;

const RESET_COUNTDOWN_FORMATTER: ResetCountdownFormatter = {
  durationNow: () => t('connectedServices.quota.duration.now'),
  durationOutdated: () => t('connectedServices.quota.duration.outdated'),
  durationDaysHours: ({ days, hours }) => t('connectedServices.quota.duration.daysHours', { days, hours }),
  durationHoursMinutes: ({ hours, minutes }) => t('connectedServices.quota.duration.hoursMinutes', { hours, minutes }),
  durationMinutes: ({ minutes }) => t('connectedServices.quota.duration.minutes', { minutes }),
  durationHoursMinutesSeconds: ({ hours, minutes, seconds }) => t('connectedServices.quota.duration.hoursMinutesSeconds', { hours, minutes, seconds }),
  durationMinutesSeconds: ({ minutes, seconds }) => t('connectedServices.quota.duration.minutesSeconds', { minutes, seconds }),
};

const stylesheet = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  bar: {
    flex: 1,
  },
  subtitleText: {
    ...Typography.rowMeta(),
    color: theme.colors.text.secondary,
  },
  rightText: {
    minWidth: 74,
    textAlign: 'right',
    ...Typography.rowMeta(),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
  },
}));

export const ConnectedServiceQuotaMeterRow = React.memo(function ConnectedServiceQuotaMeterRow(props: Readonly<{
  meter: ConnectedServiceQuotaMeterV1;
  nowMs: number;
  pinned: boolean;
  onTogglePin: () => void;
}>) {
  const { theme } = useUnistyles();
  const styles = stylesheet;

  const { remainingPct: remaining, used, limit } = deriveQuotaMeterValues(props.meter);
  const remainingText = remaining === null ? '—' : `${Math.round(remaining)}%`;
  // An elapsed reset boundary means the snapshot predates its own reset — fall back to the plain
  // remaining label instead of composing the nonsense phrase "resets in outdated".
  const resetText = isResetCountdownOutdated(props.nowMs, props.meter.resetAtMs ?? props.meter.resetsAt)
    ? null
    : formatResetCountdown(props.nowMs, props.meter.resetAtMs ?? props.meter.resetsAt, RESET_COUNTDOWN_FORMATTER);
  const right = remaining === null
    ? remainingText
    : resetText
    ? t('connectedServices.quota.remainingWithReset', { percent: remainingText, reset: resetText })
    : t('connectedServices.quota.remaining', { percent: remainingText });
  const tone = resolveQuotaTone(remaining);

  const usageText =
    typeof used === 'number' && typeof limit === 'number'
      ? t('connectedServices.quota.usageCount', { used, limit })
      : null;

  const subtitle = (
    <View>
      <View style={styles.subtitleRow}>
        <MeterBar
          testID="connected-service-quota-meter-row:remaining-bar"
          style={styles.bar}
          tone={tone}
          // CS quota gauges are remaining-first end to end: the labels say "% left", the tone is
          // derived from remaining, and the capacity rings display remaining. The fill must match
          // that language (battery model: full green bar = plenty left) — a consumption fill next
          // to a "left" label reads inverted (user decision 2026-07-10, reverting 5ad4d06be).
          fillFraction={(remaining ?? 0) / 100}
        />
        <Text style={styles.rightText}>{right}</Text>
      </View>
      {usageText ? <Text style={styles.subtitleText}>{usageText}</Text> : null}
    </View>
  );

  const pinIcon = props.pinned ? 'bookmark' : 'bookmark-outline';

  return (
    <Item
      title={props.meter.label}
      subtitle={subtitle}
      subtitleLines={0}
      showChevron={false}
      rightElement={(
        <Pressable onPress={props.onTogglePin} hitSlop={12} style={{ paddingLeft: 8, paddingVertical: 4 }}>
          <Icon name={pinIcon as IoniconName} size={16} color={props.pinned ? theme.colors.text.primary : theme.colors.text.secondary} />
        </Pressable>
      )}
    />
  );
});
