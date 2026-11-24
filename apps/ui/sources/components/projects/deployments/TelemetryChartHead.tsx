import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { HappierSeries } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';

/** The narrowest a collector trend reads beside its sibling; below it the two stack (a details pane, a phone). */
export const TELEMETRY_CHART_MIN_WIDTH_PX = 280;

/** The newest measured point of a series, in its own units; null while the window has none. */
export function latestTelemetryPoint(series: HappierSeries, format: (value: number) => string): string | null {
  for (let index = series.points.length - 1; index >= 0; index -= 1) {
    const y = series.points[index]!.y;
    if (typeof y === 'number') return format(y);
  }
  return null;
}

/** A collector trend's name and newest value on one line, its context under it (lab p7Flows detail and metrics). */
export function TelemetryChartHead(props: Readonly<{ title: string; latest: string | null; detail: string | null }>) {
  return (
    <View style={styles.head}>
      <View style={styles.headLine}>
        <Text variant="label" numberOfLines={1} style={styles.headTitle}>{props.title}</Text>
        <Text variant="label" emphasis="semiBold" style={styles.headValue}>{props.latest ?? '—'}</Text>
      </View>
      {props.detail ? <Text variant="meta" style={styles.caption}>{props.detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  caption: { color: theme.colors.text.secondary },
  head: { gap: theme.space.s2 },
  headLine: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.s12 },
  headTitle: { flexShrink: 1, color: theme.colors.text.secondary },
  headValue: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
}));
