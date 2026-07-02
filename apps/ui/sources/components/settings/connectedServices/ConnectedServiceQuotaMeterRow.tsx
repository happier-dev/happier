import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';
import { t } from '@/text';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function formatResetCountdown(nowMs: number, resetsAtMs: number | null): string | null {
  if (!resetsAtMs) return null;
  const delta = resetsAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return t('connectedServices.quota.duration.now');

  const totalMinutes = Math.floor(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;

  if (days > 0) return t('connectedServices.quota.duration.daysHours', { days, hours });
  if (hours > 0) return minutes > 0
    ? t('connectedServices.quota.duration.hoursMinutes', { hours, minutes })
    : t('connectedServices.quota.duration.hours', { hours });
  return t('connectedServices.quota.duration.minutes', { minutes });
}

const stylesheet = StyleSheet.create((theme) => ({
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  barOuter: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.colors.surface.pressedOverlay,
    overflow: 'hidden',
  },
  barInner: {
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.colors.state.success.foreground,
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

  const utilization = deriveQuotaUtilizationPct(props.meter);
  const remaining = typeof props.meter.remainingPct === 'number' && Number.isFinite(props.meter.remainingPct)
    ? clampQuotaPct(props.meter.remainingPct)
    : utilization === null ? null : clampQuotaPct(100 - utilization);
  const remainingText = remaining === null ? '—' : `${Math.round(remaining)}%`;
  const resetText = formatResetCountdown(props.nowMs, props.meter.resetAtMs ?? props.meter.resetsAt);
  const right = remaining === null
    ? remainingText
    : resetText
      ? t('connectedServices.quota.remainingWithReset', { percent: remainingText, reset: resetText })
      : t('connectedServices.quota.remaining', { percent: remainingText });

  const usageText =
    typeof props.meter.used === 'number' && typeof props.meter.limit === 'number'
      ? t('connectedServices.quota.usageCount', { used: props.meter.used, limit: props.meter.limit })
      : null;

  const subtitle = (
    <View>
      <View style={styles.subtitleRow}>
        <View style={styles.barOuter}>
          <View style={[styles.barInner, { width: `${remaining ?? 0}%` }]} />
        </View>
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
          <Ionicons name={pinIcon as IoniconName} size={18} color={props.pinned ? theme.colors.text.primary : theme.colors.text.secondary} />
        </Pressable>
      )}
    />
  );
});
