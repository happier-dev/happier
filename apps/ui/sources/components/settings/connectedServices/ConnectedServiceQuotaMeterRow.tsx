import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { clampQuotaPct, deriveQuotaUtilizationPct } from '@/sync/domains/connectedServices/deriveQuotaUtilizationPct';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function formatResetCountdown(nowMs: number, resetsAtMs: number | null): string | null {
  if (!resetsAtMs) return null;
  const delta = resetsAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return 'now';

  const totalMinutes = Math.floor(delta / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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
    backgroundColor: theme.colors.surfacePressedOverlay,
    overflow: 'hidden',
  },
  barInner: {
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.colors.success,
  },
  subtitleText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textSecondary,
  },
  rightText: {
    minWidth: 74,
    textAlign: 'right',
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textSecondary,
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
  const remaining = utilization === null ? null : clampQuotaPct(100 - utilization);
  const remainingText = remaining === null ? '—' : `${Math.round(remaining)}%`;
  const resetText = formatResetCountdown(props.nowMs, props.meter.resetsAt);
  const right = resetText ? `${remainingText}  ${resetText}` : remainingText;

  const usageText =
    typeof props.meter.used === 'number' && typeof props.meter.limit === 'number'
      ? `${props.meter.used}/${props.meter.limit}`
      : null;

  const subtitle = (
    <View>
      <View style={styles.subtitleRow}>
        <View style={styles.barOuter}>
          <View style={[styles.barInner, { width: `${utilization ?? 0}%` }]} />
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
          <Ionicons name={pinIcon as IoniconName} size={18} color={props.pinned ? theme.colors.text : theme.colors.textSecondary} />
        </Pressable>
      )}
    />
  );
});
