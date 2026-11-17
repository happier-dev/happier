import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CapacityBar } from '@happier-dev/plugin-ui/presentation';

import {
  resolveMachineResourceToneColor,
  type MachineResourceTone,
} from '@/components/machines/summary/machineSummaryStripModel';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * One labelled meter inside a tile (a volume, swap): the name at the left, "412 GB free of 994" at the
 * right in one tabular run, then the shared capacity bar filling by what is used (R9). Calm fills are ink;
 * only the metric that needs you takes its tone. An optional quieter segment (macOS purgeable space) is
 * drawn hatched inside the used part and never changes the figure.
 */
export const VitalsMeterRow = React.memo(function VitalsMeterRow(
  props: Readonly<{
    label: string;
    /** The label reads in ink (a volume's name) rather than quiet (Swap). */
    strongLabel?: boolean;
    part: string;
    /** "free" after the part, when the figure is a free amount. */
    partWord?: string;
    whole: string;
    used: number | null;
    capacity: number;
    tone: MachineResourceTone;
    /** Used bytes the OS can give back on its own (purgeable); drawn as a quiet hatched stretch. */
    reclaimable?: number;
    accessibilityLabel: string;
    note?: string | null;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const pluginTheme = usePluginUiTheme(theme);
  const toned = props.tone !== 'calm';
  const fill = toned
    ? resolveMachineResourceToneColor(props.tone, theme.colors)
    : theme.colors.text.tertiary;
  const valueColor = toned ? fill : theme.colors.text.primary;
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={props.accessibilityLabel}
      style={styles.row}
    >
      <View style={styles.head}>
        <Text
          numberOfLines={1}
          style={[styles.label, props.strongLabel ? styles.labelStrong : null]}
        >
          {props.label}
        </Text>
        <Text numberOfLines={1} style={styles.value}>
          <Text style={[styles.part, { color: valueColor }]}>{props.part}</Text>
          {props.partWord ? (
            <Text
              style={[styles.part, { color: valueColor }]}
            >{` ${props.partWord}`}</Text>
          ) : null}
          <Text style={styles.whole}>{` ${props.whole}`}</Text>
        </Text>
      </View>
      <CapacityBar
        theme={pluginTheme}
        label={props.accessibilityLabel}
        value={props.used}
        capacity={props.capacity}
        color={fill}
        trackColor={theme.colors.border.default}
        size="inline"
        showCaption={false}
        animated
        reducedMotion={reducedMotion}
        {...(props.used !== null && props.reclaimable !== undefined && props.reclaimable > 0
          ? {
              projection: 'remaining' as const,
              projected: Math.max(0, props.used - props.reclaimable),
            }
          : {})}
      />
      {props.note ? <Text style={styles.note}>{props.note}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.space.s6,
    minWidth: 0,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
    minWidth: 0,
  },
  label: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  labelStrong: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
  },
  value: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    marginLeft: 'auto',
    flexShrink: 0,
  },
  part: {
    ...Typography.default('medium'),
  },
  whole: {
    color: theme.colors.text.secondary,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
