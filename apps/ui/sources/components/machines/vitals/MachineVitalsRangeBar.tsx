import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import type { MachineVitalsRange } from '@/sync/domains/machines/resources/machineRpc';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { MACHINE_VITALS_RANGE_UI_KEY, machineVitalsRangeState } from '@/sync/domains/state/navigationUiState';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import type { MachinePageTabBarAccessoryProps } from '@/components/machines/page/machinePageTabQuery';
import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import { MachineFreshnessChip, type MachineFreshness } from '@/components/machines/page/MachineFreshnessChip';
import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import { EMPTY_MACHINE_RESOURCE_STATE, isMachineResourceStateStale, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useMachineResourceRefreshing } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useMachineMonitoringMode } from '@/sync/domains/machines/resources/useMachineMonitoringMode';

import { MACHINE_VITALS_RANGES, selectMachineVitalsOverviewView, type MachineVitalsOverviewView } from './machineVitalsPresentation';

const RANGE_KEYS = {
  '1h': 'machineVitals.range.hour',
  '24h': 'machineVitals.range.day',
  '7d': 'machineVitals.range.week',
} as const satisfies Record<MachineVitalsRange, string>;

/** The history range a machine's Overview charts, remembered on this device (view state, not a setting of the machine). */
export function useMachineVitalsRange(): readonly [
  MachineVitalsRange,
  (next: MachineVitalsRange) => void,
] {
  const range = usePersistentUiStateValue(machineVitalsRangeState, MACHINE_VITALS_RANGE_UI_KEY) ?? '1h';
  const setRange = React.useCallback((next: MachineVitalsRange) => {
    machineVitalsRangeState.set(MACHINE_VITALS_RANGE_UI_KEY, next);
  }, []);
  return [range, setRange] as const;
}

/**
 * The Overview's freshness and range (lab `rv` O, OS 2–3): "Live" while samples arrive, "As of 10:42 ·
 * Retry" when the machine stopped answering, "As of yesterday 23:14" offline; then 1 h · 24 h · 7 d.
 * Freshness speaks in one chip; values never dim for it.
 */
export const MachineVitalsRangeBar = React.memo(function MachineVitalsRangeBar(
  props: Readonly<{
    freshness: MachineFreshness;
    showRange: boolean;
    /** At the end of the page's tab bar (lab `rv` O) the bar sits on the tab row, without the body's gap below. */
    placement?: 'body' | 'bar';
  }>,
) {
  const language = usePreferredLanguage();
  const [range, setRange] = useMachineVitalsRange();
  const tabs = React.useMemo(
    () => MACHINE_VITALS_RANGES.map((id) => ({ id, label: t(RANGE_KEYS[id]) })),
    [language],
  );
  return (
    <View style={[styles.bar, props.placement === 'bar' ? styles.inBar : null]} testID="machine-vitals-range-bar">
      <MachineFreshnessChip freshness={props.freshness} />
      {props.showRange ? (
        <View style={styles.range}>
          <SegmentedTabBar<MachineVitalsRange>
            role="radiogroup"
            compact
            segmentSizing="content"
            tabs={tabs}
            activeTabId={range}
            onSelectTab={setRange}
            accessibilityLabel={t('machineVitals.range.label')}
            testIDPrefix="machine-vitals-range"
          />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 32,
    marginBottom: 8,
  },
  inBar: {
    marginBottom: 0,
  },
  range: {
    marginLeft: 'auto',
  },
});

/** The chip for an Overview state: nothing while the first sample loads, Live, As of · Retry, or As of offline. */
export function resolveVitalsFreshnessChip(view: MachineVitalsOverviewView, onRetry: () => void, refreshing = false): MachineFreshness {
    // Off with an earlier reading: "As of 10:42", nothing to retry — nothing is reading.
    if (view.kind === 'monitoring_off') return view.sample ? { kind: 'offline', at: view.sample.sampledAt } : { kind: 'none' };
    if (view.kind !== 'ready') return { kind: 'none' };
    if (view.freshness === 'offline') return { kind: 'offline', at: view.sample.sampledAt };
    if (refreshing) return { kind: 'checking', at: view.sample.sampledAt };
    if (view.freshness === 'live') return { kind: 'live' };
    return { kind: 'stale', at: view.sample.sampledAt, onRetry };
}

/**
 * The Overview's freshness and range at the end of the machine page's tab bar on wide layouts (lab `rv`
 * O). It reads what the Overview body already holds — no read or demand of its own — so it shows exactly
 * the state the tiles below it show.
 */
export const MachineVitalsBarAccessory = React.memo(function MachineVitalsBarAccessory(props: MachinePageTabBarAccessoryProps) {
    const { target } = useMachinePageState();
    const daemonState: unknown = target.machine?.daemonState;
    const published = React.useMemo(() => readMachinePublishedResources(daemonState), [daemonState]);
    const [range] = useMachineVitalsRange();
    const readTarget = useMachineDaemonReadTarget(props);
    const key = React.useMemo(() => ({ ...readTarget.key, view: 'overview' as const }), [readTarget.key]);
    const refreshingInputs = React.useMemo(() => [key], [key]);
    const refreshing = useMachineResourceRefreshing(refreshingInputs, 'overview');
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => readTarget.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, readTarget.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const monitoring = useMachineMonitoringMode(props);
    const view = selectMachineVitalsOverviewView({ online: props.online, published, monitoring,
        state: { ...state, stale: isMachineResourceStateStale(state, Date.now()) } });
    const retry = React.useCallback(() => {
        if (!readTarget.enabled) return;
        machineResourceStore.retry(key);
        machineResourceStore.retryHistory({ ...readTarget.key, range });
    }, [key, readTarget.enabled, readTarget.key, range]);
    if (view.kind !== 'loading' && view.kind !== 'ready' && !(view.kind === 'monitoring_off' && view.sample)) return null;
    return <MachineVitalsRangeBar freshness={props.online === null ? { kind: 'none' } : resolveVitalsFreshnessChip(view, retry, refreshing)} showRange={view.kind === 'ready'} placement="bar" />;
});
