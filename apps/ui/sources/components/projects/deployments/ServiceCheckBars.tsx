import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Heatmap } from '@happier-dev/plugin-ui/presentation';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { parseThemeColor } from '@/theme/parseThemeColor';

import type { ServiceCheckDay } from './serviceCheckPresentation';

const ROWS = [{ id: 'checks', label: '' }] as const;
/** The quiet success ink of a passing bar (lab mon.css `.mb i`); slow and down speak in the full state inks. */
const PASSING_ALPHA = 0.62;
/** Reserved slots while results load: ink at a breath (lab `.mb.sk`). */
const LOADING_ALPHA = 0.07;
/** A check whose Machine stopped checking keeps its last bars, dimmed (lab `.mb.stale`). */
const STALE_OPACITY = 0.45;

export type ServiceCheckBarCell = Readonly<{
  key: string;
  tone: ServiceCheckDay['tone'];
  label: string;
  valueLabel?: string;
}>;
export type ServiceCheckBarSize = 'inline' | 'tile' | 'full';

/**
 * The one presentation of a Check's history as bars (MONITOR-LAB-1115 Q1): recent results on rows, cards and the Check
 * page, and the 30 daily bars on the Check page. Healthy bars are a quiet success tint; amber and rose mark slow and
 * down; an empty slot has no sample. Every bar comes from the Check presentation owner (serviceCheckRecentBars,
 * serviceCheckHistoryStrip); nothing here decides a state.
 */
export const ServiceCheckBars = React.memo(function ServiceCheckBars(
  props: Readonly<{
    cells: readonly ServiceCheckBarCell[] | 'loading';
    /** Loading reserves this many slots, so nothing moves when results arrive. */
    slots: number;
    size: ServiceCheckBarSize;
    label: string;
    partialLead?: boolean;
    stale?: boolean;
    /** Rows and cards read their bars through the row's own label; the Check page lets each bar be read. */
    decorative?: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const inks = React.useMemo(
    () => ({
      up:
        parseThemeColor(theme.colors.state.success.foreground)
          ?.alpha(PASSING_ALPHA)
          .rgb()
          .string() ?? theme.colors.state.success.foreground,
      degraded: theme.colors.state.warning.foreground,
      down: theme.colors.state.danger.foreground,
      loading:
        parseThemeColor(theme.colors.text.primary)
          ?.alpha(LOADING_ALPHA)
          .rgb()
          .string() ?? theme.colors.surface.inset,
      lead: theme.colors.text.tertiary,
    }),
    [theme],
  );
  const { cells: input, slots } = props;
  const columns = React.useMemo(
    () =>
      input === 'loading'
        ? Array.from({ length: slots }, (_, index) => ({
            id: String(index),
            label: '',
          }))
        : input.map((cell) => ({ id: cell.key, label: '' })),
    [input, slots],
  );
  const cells = React.useMemo(
    () =>
      input === 'loading'
        ? columns.map((column) => ({
            id: column.id,
            row: 'checks',
            column: column.id,
            label: '',
            value: 1,
            color: inks.loading,
          }))
        : input.map((cell) => {
            const ink =
              cell.tone === 'up' ||
              cell.tone === 'down' ||
              cell.tone === 'degraded'
                ? inks[cell.tone]
                : null;
            return {
              id: cell.key,
              row: 'checks',
              column: cell.key,
              label: cell.label,
              value: ink ? 1 : null,
              ...(cell.valueLabel ? { valueLabel: cell.valueLabel } : {}),
              ...(ink ? { color: ink } : {}),
            };
          }),
    [columns, inks, input],
  );
  const inline = props.size === 'inline';
  return (
    <View
      testID={props.testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        flexShrink: 0,
        ...(inline ? null : { alignSelf: 'stretch' }),
        opacity: props.stale ? STALE_OPACITY : 1,
      }}
    >
      {props.partialLead ? (
        <PartialLead size={props.size} color={inks.lead} gap={theme.space.s2} />
      ) : null}
      <View style={inline ? null : { flex: 1, minWidth: 0 }}>
        <Heatmap
          theme={pluginTheme}
          label={props.label}
          layout="bars"
          size={props.size}
          rows={ROWS}
          columns={columns}
          cells={cells}
          decorative={props.decorative ?? inline}
          showReadout={false}
          {...(props.testID ? { testID: `${props.testID}.bars` } : {})}
        />
      </View>
    </View>
  );
});

/** "Older checks were not kept": a dotted run at the bars' foot where trimmed results would have stood (lab `.mb i.bp`). */
function PartialLead(
  props: Readonly<{ size: ServiceCheckBarSize; color: string; gap: number }>,
) {
  const dots = props.size === 'inline' ? 3 : 6;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', gap: props.gap, alignSelf: 'flex-end' }}
    >
      {Array.from({ length: dots }, (_, index) => (
        <View
          key={index}
          style={{ width: 2, height: 1, backgroundColor: props.color }}
        />
      ))}
    </View>
  );
}
