import * as React from 'react';
import { resolveMachineKindGlyph } from '@/components/machines/machineKindGlyph';
import { StyleSheet as RNStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { MACHINES_ADD_ROUTE } from '@/components/settings/machines/collection/machineCollectionModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import {
  useWidgetFrameBodyCaption,
  useWidgetFrameBodyMeta,
} from '@/components/widgets/frame/widgetFrameBodyCaption';
import {
  workStatusGlyphColor,
  workStatusWordStyle,
} from '@/components/work/status/workStatusTreatment';
import { Typography } from '@/constants/Typography';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';

import {
  fitYourHomeLegend,
  LEGEND_GAP_PX,
  LEGEND_ROW_COMPACT_PX,
  LEGEND_ROW_PX,
  resolveYourHomeHeaderFact,
  type YourHomeHeaderFact,
  type YourHomeMachine,
  resolveYourHomeLayout,
  type YourHomeLayout,
  type YourHomeModel,
} from './yourHomeModel';
import {
  layoutHomeOrbitScene,
  type HomeOrbitBody,
  type HomeOrbitDotTone,
  type HomeOrbitOptions,
} from '@/components/atmosphere/orbit/homeOrbitScene';
import { HomeOrbitMap } from '@/components/atmosphere/orbit/HomeOrbitMap';
import { useYourHomeModel } from './useYourHomeModel';
import { StatusDot } from '@/components/ui/status/StatusDot';

/**
 * The "Your Home" widget's body (atmosphere lab `at-widget.js`): the planet is the Home, its machines
 * are moons on flat dotted orbits, their sessions ride each orbit as dots, amber means needs you, an
 * offline machine dims. Static art: nothing animates, at rest or under reduced motion. The art is
 * decorative; the machines' names and counts are the readable content.
 *
 * Off by its atmosphere moment, the body draws nothing (Home and widget areas also leave the frame out).
 */
export function YourHomeWidgetBody(props: Readonly<{ testID: string }>) {
  const moment = useAtmosphereMoment('yourHome');
  if (!moment.on) return null;
  return <YourHomeWidget testID={props.testID} />;
}

function YourHomeWidget(props: Readonly<{ testID: string }>) {
  const presentation = useWidgetPresentation();
  const model = useYourHomeModel();
  const homeName = useActiveHomeName();
  // Full width names the Home beside the title; a half-width card keeps the title and its fact (lab).
  const fullWidth = presentation
    ? presentation.footprint.columnSpan === presentation.footprint.columns
    : false;
  useWidgetFrameBodyCaption(fullWidth ? homeName : '');
  const fact = resolveYourHomeHeaderFact(model);
  const factKind = fact?.kind;
  const factCount = fact?.count;
  const meta = React.useMemo(
    () =>
      factKind && factCount !== undefined ? (
        <HeaderFact
          fact={{ kind: factKind, count: factCount }}
          testID={`${props.testID}.fact`}
        />
      ) : null,
    [factCount, factKind, props.testID],
  );
  useWidgetFrameBodyMeta(meta);
  const geometry = presentation?.geometry;
  if (!geometry) return <View testID={props.testID} />;
  const size = resolveYourHomeLayout(presentation?.size, geometry.width);
  return (
    <View
      testID={props.testID}
      style={{ width: geometry.width, height: geometry.height }}
    >
      <YourHomeComposition
        size={size}
        width={geometry.width}
        height={geometry.height}
        model={model}
        testID={props.testID}
      />
    </View>
  );
}

function useActiveHomeName(): string | null {
  const active = useActiveServerSnapshot();
  useServerProfilesGeneration();
  return resolveHomeDisplayName(getServerProfileById(active.serverId));
}

/**
 * The lab's composition per size (`yourHome()`), in the body box the frame measured. Memoized: a machine
 * heartbeat re-renders the widget, and the retained model keeps the map as it is.
 */
const YourHomeComposition = React.memo(function YourHomeComposition(
  props: Readonly<{
    size: YourHomeLayout;
    width: number;
    height: number;
    model: YourHomeModel;
    testID: string;
  }>,
) {
  const { size, width: sw, height: bodyH, model } = props;
  const machines = model.machines;
  if (machines.length === 0) {
    const tall = size === 'medium' || size === 'full';
    const h = tall ? bodyH - 112 : bodyH - 30;
    const k = fit(sw, h, size === 'small' || size === 'medium' ? 262 : 564, tall ? 186 : 88);
    const scene = layoutHomeOrbitScene(sw, h, orbitBodies(machines), { small: !tall, pr: (tall ? 34 : 18) * k });
    return (
      <View style={styles.fill}>
        <HomeOrbitMap scene={scene} small={!tall} accessibilityLabel={t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })} />
        <EmptyHome tall={tall} testID={props.testID} />
      </View>
    );
  }
  if (size === 'small') {
    const h = bodyH - 22;
    const scene = layoutHomeOrbitScene(sw, h, orbitBodies(machines.slice(0, SMALL_ORBITS)), { small: true, pr: 18 * fit(sw, h, 262, 96), angles: [-14, 196, 166] });
    return (
      <View style={styles.fill}>
        <HomeOrbitMap scene={scene} small accessibilityLabel={t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })} />
        <View style={styles.foot} testID={`${props.testID}.foot`}>
          <Text style={styles.footText}>
            {t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })}
          </Text>
          {model.needsYou > 0 ? (
            <NeedsYou label={t('homeIndex.sessionsNeedYou', { count: model.needsYou })} />
          ) : null}
        </View>
      </View>
    );
  }
  if (size === 'wide') {
    const w = Math.round(sw * 0.5);
    const pr = 26 * fit(w, bodyH, 282, 118);
    const scene = layoutHomeOrbitScene(w, bodyH, orbitBodies(fitYourHomeLegend(machines, bodyH, true).shown), { small: true, pr, radii: radii([1.55, 1.95, 2.3], pr), angles: [-14, 196, 166] });
    return (
      <View style={[styles.fill, styles.row]}>
        <HomeOrbitMap scene={scene} small accessibilityLabel={t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })} />
        <Legend machines={machines} compact height={bodyH} testID={props.testID} />
      </View>
    );
  }
  if (size === 'medium') {
    const h = bodyH - MEDIUM_LEGEND_PX;
    const pr = 40 * fit(sw, h, 262, 196);
    const scene = layoutHomeOrbitScene(sw, h, orbitBodies(fitYourHomeLegend(machines, MEDIUM_LEGEND_PX, true).shown), { pr, radii: radii([1.55, 1.97, 2.4], pr), angles: [-38, 214, 128] });
    return (
      <View style={styles.fill}>
        <HomeOrbitMap scene={scene} accessibilityLabel={t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })} />
        <Legend machines={machines} compact column height={MEDIUM_LEGEND_PX} testID={props.testID} />
      </View>
    );
  }
  const w = Math.round(sw * 0.54);
  const pr = 50 * fit(w, bodyH, 305, 298);
  const scene = layoutHomeOrbitScene(w, bodyH, orbitBodies(fitYourHomeLegend(machines, bodyH, false).shown), { pr, radii: radii([1.62, 2.2, 2.78], pr), angles: [-34, 212, 130] });
  return (
    <View style={[styles.fill, styles.row]}>
      <HomeOrbitMap scene={scene} accessibilityLabel={t('homeWidgets.yourHomeOnline', { online: model.online, total: machines.length })} />
      <Legend machines={machines} height={bodyH} testID={props.testID} />
    </View>
  );
});

/** A small card names no machine, so its orbit draws the lab's three bodies, one per orbit. */
const SMALL_ORBITS = 3;

/** Under the medium scene the lab keeps three compact rows. */
const MEDIUM_LEGEND_PX = 102;

/**
 * The lab's radii were drawn for its scene box at each size (A3 cells). A body shorter or narrower
 * than that box scales the planet and its orbits down with it, so the composition keeps the lab's
 * proportions instead of clipping; a larger body keeps the lab's sizes.
 */
const fit = (w: number, h: number, labW: number, labH: number) => Math.max(0, Math.min(1, w / labW, h / labH));

const radii = (
  ks: readonly number[],
  pr: number,
): HomeOrbitOptions['radii'] => ks.map((k) => k * pr);

/** Sessions ride their machine's orbit; an offline machine shows none (its last count is in the legend). */
const SESSION_TONE: Readonly<Record<YourHomeMachine['shown'][number], HomeOrbitDotTone>> = {
  need: 'attention',
  work: 'active',
  idle: 'quiet',
};
function orbitBodies(machines: readonly YourHomeMachine[]): HomeOrbitBody[] {
  return machines.filter(machine => machine.online !== null).map((machine) => ({
    key: machine.id,
    online: machine.online === true,
    dots: machine.online ? machine.shown.map((state, index) => ({ key: String(index), tone: SESSION_TONE[state] })) : [],
  }));
}

/** The machines, one row each: glyph, name (and its state line at full size), then what it holds. */
function Legend(
  props: Readonly<{
    machines: readonly YourHomeMachine[];
    compact?: boolean;
    column?: boolean;
    /** The legend's room: rows that do not fit fold into one quiet "N more" row. */
    height: number;
    testID: string;
  }>,
) {
  const { shown, more } = fitYourHomeLegend(props.machines, props.height, props.compact === true);
  return (
    <View style={[styles.legend, props.column ? styles.legendColumn : null]}>
      {shown.map((machine, index) => (
        <LegendRow
          key={machine.id}
          machine={machine}
          compact={props.compact === true}
          first={index === 0}
          testID={`${props.testID}.machine.${machine.id}`}
        />
      ))}
      {more > 0 ? (
        <View testID={`${props.testID}.more`} style={[styles.legendRow, styles.legendRowCompact, shown.length > 0 ? styles.legendRowDivided : null]}>
          <Text style={styles.legendState}>{t('homeWidgets.yourHomeMore', { count: more })}</Text>
        </View>
      ) : null}
    </View>
  );
}

function LegendRow(
  props: Readonly<{
    machine: YourHomeMachine;
    compact: boolean;
    first: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { machine } = props;
  const off = machine.online === false;
  const state = machine.online === null ? t('common.unknown') : off
    ? t('homeWidgets.yourHomeOffline', {
        lastSeen: formatLastSeen(machine.lastSeenAt ?? 0),
      })
    : [
        t('homeWidgets.yourHomeSessions', { count: machine.shown.length }),
        ...(machine.working > 0
          ? [t('homeWidgets.yourHomeWorking', { count: machine.working })]
          : []),
      ].join(' · ');
  const needLabel = t('homeIndex.sessionsNeedYou', { count: machine.needsYou });
  return (
    <View
      testID={props.testID}
      accessible
      accessibilityLabel={[
        machine.name,
        state,
        ...(machine.needsYou > 0 ? [needLabel] : []),
      ].join(', ')}
      style={[
        styles.legendRow,
        props.compact ? styles.legendRowCompact : null,
        props.first ? null : styles.legendRowDivided,
      ]}
    >
      <Icon
        name={resolveMachineKindGlyph({ isThisComputer: machine.isThisComputer })}
        size={ICON_SIZE.sm}
        color={theme.colors.text.secondary}
      />
      <View style={styles.legendText}>
        <Text
          style={[styles.legendName, off ? styles.dim : null]}
          numberOfLines={1}
        >
          {machine.name}
        </Text>
        {props.compact ? null : (
          <Text
            style={[styles.legendState, off ? styles.dim : null]}
            numberOfLines={1}
          >
            {state}
          </Text>
        )}
      </View>
      {machine.needsYou > 0 ? (
        <NeedsYou label={String(machine.needsYou)} />
      ) : machine.online === null ? null : off ? (
        <View style={styles.offDot} />
      ) : (
        <Text style={styles.legendCount}>{machine.shown.length}</Text>
      )}
    </View>
  );
}

/** Amber means it needs you: the attention dot and its word, in the attention treatment. */
function NeedsYou(props: Readonly<{ label: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.need}>
      <StatusDot color={workStatusGlyphColor(theme.colors, 'attention')} size={6} />
      <Text style={[workStatusWordStyle('attention'), styles.needText]}>
        {props.label}
      </Text>
    </View>
  );
}

function HeaderFact(
  props: Readonly<{ fact: YourHomeHeaderFact; testID: string }>,
) {
  return (
    <View testID={props.testID}>
      {props.fact.kind === 'needsYou' ? (
        <NeedsYou
          label={t('homeIndex.sessionsNeedYou', { count: props.fact.count })}
        />
      ) : (
        <Text style={styles.footText}>
          {t('homeWidgets.yourHomeWorking', { count: props.fact.count })}
        </Text>
      )}
    </View>
  );
}

/** An empty Home: two quiet orbits, then what to do — add the first machine. */
function EmptyHome(props: Readonly<{ tall: boolean; testID: string }>) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const add = React.useCallback(
    () => router.push(MACHINES_ADD_ROUTE as never),
    [router],
  );
  return (
    <View
      testID={`${props.testID}.empty`}
      style={props.tall ? styles.emptyFlow : styles.emptyRow}
    >
      <Text style={styles.emptyTitle}>
        {t('homeWidgets.yourHomeEmptyTitle')}
      </Text>
      {props.tall ? (
        <Text style={styles.emptyBody}>
          {t('homeWidgets.yourHomeEmptyBody')}
        </Text>
      ) : null}
      <RoundButton
        testID={`${props.testID}.addMachine`}
        size="small"
        display="secondary"
        title={t('settings.addMachine')}
        onPress={add}
        leading={
          <Icon
            name="plus"
            size={ICON_SIZE.xs}
            color={theme.colors.text.primary}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1, position: 'relative' },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  scene: { position: 'relative', flexShrink: 0, overflow: 'hidden' },
  foot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s10,
  },
  footText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  legend: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    gap: LEGEND_GAP_PX,
    paddingLeft: theme.space.s6,
  },
  // A fixed-height strip under the scene. `legend`'s `flex` shorthand sets a zero basis, which would also zero this strip's height
  // and let its rows overflow upward over the orbits, so the basis is put back to the height.
  legendColumn: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', height: MEDIUM_LEGEND_PX, paddingLeft: 0 },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: LEGEND_ROW_PX,
    paddingHorizontal: theme.space.s2,
  },
  legendRowCompact: { minHeight: LEGEND_ROW_COMPACT_PX },
  legendRowDivided: {
    borderTopWidth: RNStyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  legendText: { flex: 1, minWidth: 0 },
  legendName: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
  },
  legendState: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  legendCount: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  dim: { color: theme.colors.text.tertiary },
  offDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.text.tertiary,
    opacity: 0.6,
  },
  need: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  needText: {
    ...happierPageTextMetrics('meta'),
    fontVariant: ['tabular-nums'],
  },
  emptyFlow: { marginTop: theme.space.s6, alignItems: 'center', gap: theme.space.s2 },
  emptyRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s10,
  },
  emptyTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.primary,
  },
  emptyBody: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    color: theme.colors.text.secondary,
    marginBottom: theme.space.s8,
    textAlign: 'center',
  },
}));
