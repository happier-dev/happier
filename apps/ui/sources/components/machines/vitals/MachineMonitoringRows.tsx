import * as React from 'react';
import type { MachineMonitoringPolicyV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import {
  GuardChoiceRow,
  GuardSelectRow,
} from '@/components/machines/guard/guardRows';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type MonitoringMode = MachineMonitoringPolicyV1['mode'];
type MonitoringRow = 'mode' | 'interval';

const INTERVAL_PRESETS_MS = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
] as const;

/**
 * The machine's monitoring preference beside its Alerts row: how it reads its vitals (Off · While viewing ·
 * Always) and, while it reads, how often. Saved through the one resources-policy Action; a save in flight
 * shows its value at once, and one that does not land says so on its row.
 */
export const MachineMonitoringRows = React.memo(function MachineMonitoringRows(
  props: Readonly<{ serverId: string; machineId: string }>,
) {
  const policy = useMachineResourcesPolicy({
    serverId: props.serverId,
    machineId: props.machineId,
  });
  const saved =
    policy.status === 'ready' ? (policy.policy?.monitoring ?? null) : null;
  const [pending, setPending] =
    React.useState<Partial<MachineMonitoringPolicyV1> | null>(null);
  const [failed, setFailed] = React.useState<MonitoringRow | null>(null);
  // Saves made while an earlier one is in flight compose on it; the machine's answer decides once the last lands.
  const saving = React.useRef(0);
  const { set } = policy;
  const save = React.useCallback(
    (row: MonitoringRow, patch: Partial<MachineMonitoringPolicyV1>) => {
      setPending((previous) => ({ ...previous, ...patch }));
      setFailed(null);
      saving.current += 1;
      fireAndForget(
        (async () => {
          const result = await set({ monitoring: patch });
          saving.current -= 1;
          if (saving.current === 0) setPending(null);
          if (!result.saved) setFailed(row);
        })(),
        { tag: 'MachineMonitoringRows.save' },
      );
    },
    [set],
  );
  if (!saved) return null;
  const shown = { ...saved, ...pending };
  const failure = t('machineVitals.alerts.saveFailed');
  const modes: ReadonlyArray<
    Readonly<{ id: MonitoringMode; label: string; description: string }>
  > = [
    {
      id: 'off',
      label: t('machineVitals.monitoring.modes.off'),
      description: t('machineVitals.monitoring.descriptions.off'),
    },
    {
      id: 'while_viewing',
      label: t('machineVitals.monitoring.modes.whileViewing'),
      description: t('machineVitals.monitoring.descriptions.whileViewing'),
    },
    {
      id: 'always',
      label: t('machineVitals.monitoring.modes.always'),
      description: t('machineVitals.monitoring.descriptions.always'),
    },
  ];
  const seconds = (ms: number) =>
    t('machineVitals.monitoring.seconds', { count: Math.round(ms / 100) / 10 });
  return (
    <ItemGroup>
      <GuardChoiceRow
        testID="machine-monitoring-mode"
        title={t('machineVitals.monitoring.title')}
        options={modes}
        value={shown.mode}
        editable={policy.editable}
        failed={failed === 'mode' ? failure : null}
        onChange={(mode) => save('mode', { mode })}
      />
      {shown.mode === 'off' ? null : (
        <GuardSelectRow<number>
          testID="machine-monitoring-interval"
          title={t('machineVitals.monitoring.interval')}
          subtitle={t('machineVitals.monitoring.intervalDescription')}
          label={t('machineVitals.monitoring.interval')}
          value={shown.intervalMs}
          format={seconds}
          presets={INTERVAL_PRESETS_MS}
          editable={policy.editable}
          failed={failed === 'interval' ? failure : null}
          onChange={(intervalMs) => save('interval', { intervalMs })}
        />
      )}
    </ItemGroup>
  );
});

/**
 * The Overview while monitoring is Off: one calm card that says so — never zeros, a skeleton or "unavailable" —
 * and, for whoever may change it, the way back on. What was read before stays below it, as of its time.
 */
export const MachineMonitoringOffCard = React.memo(function MachineMonitoringOffCard(
  props: Readonly<{ serverId: string; machineId: string; machineName: string; held: boolean }>,
) {
  const policy = useMachineResourcesPolicy({ serverId: props.serverId, machineId: props.machineId });
  const [failed, setFailed] = React.useState(false);
  const { set } = policy;
  // The returned promise keeps the action pending until the machine answers (the shared state owner's rule).
  const turnOn = React.useCallback(async () => {
    setFailed(false);
    const result = await set({ monitoring: { mode: 'always' } });
    if (!result.saved) setFailed(true);
  }, [set]);
  const reason = failed ? t('machineVitals.alerts.saveFailed')
    : props.held ? t('machineVitals.monitoring.offReasonHeld') : t('machineVitals.monitoring.offReason');
  return (
    <ItemGroup header="none">
      <SurfaceStateCard
        testID="machine-vitals-monitoring-off"
        size="details"
        kind="empty"
        title={t('machineVitals.monitoring.offTitle', { machine: props.machineName })}
        reason={policy.editable ? reason : `${reason} ${t('machineVitals.monitoring.offByOwner')}`}
        icon={<Icon name="pause-circle" />}
        {...(policy.editable ? { action: { label: t('machineVitals.monitoring.turnOn'), testID: 'machine-vitals-monitoring-on', onPress: turnOn } } : {})}
      />
    </ItemGroup>
  );
});
