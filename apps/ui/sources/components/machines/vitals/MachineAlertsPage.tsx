import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineResourcesPolicyPatchV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineVitalsAlertsPolicyV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAlertsV1';

import {
  PolicyValueSelect,
  type PolicyValueChoice,
} from '@/components/machines/policy/PolicyValueSelect';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import type { MachineResourceKey } from '@/sync/domains/machines/resources/machineRpc';
import { useMachineDaemonReadIdentities } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useMachineOfflineAlert } from '@/sync/domains/machines/resources/useMachineOfflineAlert';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { t } from '@/text';
import { openFollowNotificationSettings } from '@/components/sessions/follow/openFollowNotificationSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import {
  ALERT_SUSTAIN_PRESET_MINUTES,
  CPU_THRESHOLD_PRESETS,
  DISK_BYTES_PRESETS,
  DISK_FRACTION_PRESETS,
  describeAlertRule,
  describeMachineAlertsRow,
  formatAlertSustain,
  formatCpuThreshold,
  formatDiskThreshold,
  parseCustomCpuPercent,
  parseCustomDiskThreshold,
  parseCustomSustainMinutes,
  type MachineDiskThreshold,
} from './machineAlertsPresentation';

type AlertsPatch = NonNullable<MachineResourcesPolicyPatchV1['alerts']>;
type RuleId = 'memory' | 'disk' | 'cpu';

/**
 * A machine's alerts (lab `rv` AL / ALp): one row per rule, all off until turned on. Each row says exactly
 * when it would fire; turning it on opens its rule in place — the threshold and how long it must hold,
 * as selects in a sentence whose lists end with Custom… (R43). Every change is the minimal patch to the
 * machine's one resources policy through `machines.resources.policy.set`; a save that does not land
 * returns the control to the machine's truth and says so on its row. Recipients and an offline machine
 * read the rules without changing them, with the reason.
 */
export function MachineAlertsPage(
  props: Readonly<{ serverId: string; machine: Machine; machineName: string }>,
) {
  const router = useRouter();
  const policy = useMachineResourcesPolicy({
    serverId: props.serverId,
    machineId: props.machine.id,
  });
  const alerts =
    policy.status === 'ready' ? (policy.policy?.alerts ?? null) : null;
  const [pending, setPending] = React.useState<Readonly<{
    rule: RuleId;
    alerts: MachineVitalsAlertsPolicyV1;
  }> | null>(null);
  const [failed, setFailed] = React.useState<ReadonlySet<RuleId>>(() => new Set());
  const pendingNow = React.useRef<MachineVitalsAlertsPolicyV1 | null>(null);
  const saving = React.useRef(0);
  const shown = pending?.alerts ?? alerts;
  const { set } = policy;
  const save = React.useCallback(
    (rule: RuleId, patch: AlertsPatch) => {
      const base = pendingNow.current ?? alerts;
      if (!base) return;
      // The row shows the choice at once; the machine's answer decides what stays.
      pendingNow.current = mergeAlerts(base, patch);
      saving.current += 1;
      setPending({ rule, alerts: pendingNow.current });
      setFailed(previous => { const next = new Set(previous); next.delete(rule); return next; });
      fireAndForget(
        (async () => {
          const result = await set({ alerts: patch });
          saving.current -= 1;
          if (saving.current === 0) {
            pendingNow.current = null;
            setPending(null);
          }
          setFailed(previous => { const next = new Set(previous); if (result.saved) next.delete(rule); else next.add(rule); return next; });
        })(),
        { tag: 'MachineAlertsPage.save' },
      );
    },
    [set, alerts],
  );

  const daemonState: unknown = props.machine.daemonState;
  const readTarget = useMachineDaemonReadIdentities([{ serverId: props.serverId, machineId: props.machine.id }])[0]!;
  // The largest volume this app session has read bounds a custom amount (no read is issued for it).
  const largestVolumeBytes = React.useCallback(
    () => readTarget.accountMatches ? readLargestRetainedVolumeBytes(readTarget.key) : null,
    [readTarget.accountMatches, readTarget.key],
  );
  const published = readMachinePublishedResources(daemonState);
  const readOnlyNote =
    policy.readOnlyReason === 'unknown' ? t('common.unavailable') : policy.readOnlyReason === 'offline'
      ? t('machineVitals.alerts.readOnly.offline', {
          machine: props.machineName,
        })
      : policy.readOnlyReason === 'not_custodian'
        ? t('machineVitals.alerts.readOnly.notCustodian', {
            machine: props.machineName,
          })
        : policy.readOnlyReason === 'older_happier' || !published
          ? t('machineVitals.alerts.readOnly.olderHappier', {
              machine: props.machineName,
            })
          : null;
  const editable = policy.editable;

  return (
    <>
      <ItemGroup
        description={
          readOnlyNote ??
          `${describeMachineAlertsRow({ machineName: props.machineName, alerts: shown, readOnlyReason: null })} ${t('machineVitals.alerts.intro', { machine: props.machineName })}`
        }
      >
        {shown ? (
          <>
            <AlertRuleRow
              rule="memory"
              title={t('machineVitals.alerts.memory.title')}
              alerts={shown}
              editable={editable}
              failed={failed.has('memory')}
              onToggle={(enabled) => save('memory', { memory: { enabled } })}
              sentence={
                <>
                  <SentenceText>
                    {t('machineVitals.alerts.memory.sentenceLead')}
                  </SentenceText>
                  <PolicyValueSelect
                    testID="machine-alerts-memory-level"
                    label={t('machineVitals.alerts.memory.levelLabel')}
                    value={t(
                      shown.memory.level === 'critical'
                        ? 'machineVitals.memory.levels.critical'
                        : 'machineVitals.memory.levels.elevated',
                    )}
                    choices={[
                      {
                        id: 'elevated',
                        title: t('machineVitals.memory.levels.elevated'),
                      },
                      {
                        id: 'critical',
                        title: t('machineVitals.memory.levels.critical'),
                      },
                    ]}
                    selectedId={shown.memory.level}
                    onSelect={(level) =>
                      save('memory', {
                        memory: {
                          level: level === 'elevated' ? 'elevated' : 'critical',
                        },
                      })
                    }
                    disabled={!editable}
                    invalid={failed.has('memory')}
                  />
                  <SentenceText>{t('machineVitals.alerts.for')}</SentenceText>
                  <SustainSelect
                    testID="machine-alerts-memory-sustain"
                    sustainMs={shown.memory.sustainMs}
                    disabled={!editable}
                    invalid={failed.has('memory')}
                    onChange={(sustainMs) =>
                      save('memory', { memory: { sustainMs } })
                    }
                  />
                </>
              }
            />
            <AlertRuleRow
              rule="disk"
              title={t('machineVitals.alerts.disk.title')}
              alerts={shown}
              editable={editable}
              failed={failed.has('disk')}
              onToggle={(enabled) => save('disk', { disk: { enabled } })}
              sentence={
                <>
                  <SentenceText>
                    {t('machineVitals.alerts.disk.sentenceLead')}
                  </SentenceText>
                  <DiskThresholdSelect
                    threshold={shown.disk.threshold}
                    disabled={!editable}
                    invalid={failed.has('disk')}
                    largestVolumeBytes={largestVolumeBytes}
                    onChange={(threshold) =>
                      save('disk', { disk: { threshold } })
                    }
                  />
                  <SentenceText>
                    {t('machineVitals.alerts.disk.sentenceTail')}
                  </SentenceText>
                </>
              }
            />
            <AlertRuleRow
              rule="cpu"
              title={t('machineVitals.alerts.cpu.title')}
              alerts={shown}
              editable={editable}
              failed={failed.has('cpu')}
              onToggle={(enabled) => save('cpu', { cpu: { enabled } })}
              sentence={
                <>
                  <SentenceText>
                    {t('machineVitals.alerts.cpu.sentenceLead')}
                  </SentenceText>
                  <CpuThresholdSelect
                    abovePct={shown.cpu.abovePct}
                    disabled={!editable}
                    invalid={failed.has('cpu')}
                    onChange={(abovePct) => save('cpu', { cpu: { abovePct } })}
                  />
                  <SentenceText>{t('machineVitals.alerts.for')}</SentenceText>
                  <SustainSelect
                    testID="machine-alerts-cpu-sustain"
                    sustainMs={shown.cpu.sustainMs}
                    disabled={!editable}
                    invalid={failed.has('cpu')}
                    onChange={(sustainMs) =>
                      save('cpu', { cpu: { sustainMs } })
                    }
                  />
                </>
              }
            />
          </>
        ) : (
          <Item title={t('machineVitals.alerts.row.unreadable')} mode="info" />
        )}
        <MachineOfflineAlertRow serverId={props.serverId} machine={props.machine} machineName={props.machineName} />
        <Item
          testID="machine-alerts-where"
          icon={<Icon name="bell" />}
          title={t('machineVitals.alerts.where.title')}
          subtitle={t('machineVitals.alerts.where.subtitle')}
          showChevron
          onPress={() => void openFollowNotificationSettings({ serverId: props.serverId, navigate: () => router.push('/settings/notifications' as never) })}
        />
      </ItemGroup>
    </>
  );
}

function mergeAlerts(
  alerts: MachineVitalsAlertsPolicyV1,
  patch: AlertsPatch,
): MachineVitalsAlertsPolicyV1 {
  return {
    memory: { ...alerts.memory, ...patch.memory },
    cpu: { ...alerts.cpu, ...patch.cpu },
    disk: { ...alerts.disk, ...patch.disk },
  };
}

const AlertRuleRow = React.memo(function AlertRuleRow(
  props: Readonly<{
    rule: RuleId;
    title: string;
    alerts: MachineVitalsAlertsPolicyV1;
    editable: boolean;
    failed: boolean;
    onToggle: (enabled: boolean) => void;
    sentence: React.ReactNode;
    showDivider?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const enabled = props.alerts[props.rule].enabled;
  const subtitle = props.failed
    ? t('machineVitals.alerts.saveFailed')
    : enabled
      ? t(
          props.rule === 'disk'
            ? 'machineVitals.alerts.disk.onDescription'
            : 'machineVitals.alerts.onDescription',
        )
      : describeAlertRule(props.rule, props.alerts);
  return (
    <Item
      testID={`machine-alerts-${props.rule}`}
      title={props.title}
      subtitle={subtitle}
      subtitleStyle={
        props.failed
          ? { color: theme.colors.state.danger.textForeground }
          : undefined
      }
      mode="info"
      showDivider={props.showDivider}
      rightElement={
        <Switch
          testID={`machine-alerts-${props.rule}-switch`}
          value={enabled}
          disabled={!props.editable}
          accessibilityLabel={props.title}
          onValueChange={props.onToggle}
        />
      }
      // The rule reads as the row's own sentence: it starts on the title's edge.
      bottomElementInset="text"
      bottomElement={
        enabled ? (
          <View
            style={styles.sentence}
            testID={`machine-alerts-${props.rule}-rule`}
          >
            {props.sentence}
          </View>
        ) : undefined
      }
    />
  );
});

function SentenceText(props: Readonly<{ children: string }>) {
  return <Text style={styles.sentenceText}>{props.children}</Text>;
}

function SustainSelect(
  props: Readonly<{
    testID: string;
    sustainMs: number;
    disabled: boolean;
    invalid: boolean;
    onChange: (sustainMs: number) => void;
  }>,
) {
  const choices = React.useMemo(
    (): readonly PolicyValueChoice[] =>
      ALERT_SUSTAIN_PRESET_MINUTES.map((minutes) => ({
        id: String(minutes),
        title: formatAlertSustain(minutes * 60_000),
      })),
    [],
  );
  const minutes = Math.round(props.sustainMs / 60_000);
  const { onChange } = props;
  const custom = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const raw = await Modal.prompt(
          t('machineVitals.alerts.customSustain.title'),
          t('machineVitals.alerts.customSustain.body'),
          {
            defaultValue: `${minutes} min`,
            confirmText: t('common.save'),
          },
        );
        if (raw === null) return;
        const value = parseCustomSustainMinutes(raw);
        if (value === null) {
          Modal.alert(
            t('machineVitals.alerts.customSustain.title'),
            t('machineVitals.alerts.customSustain.invalid'),
          );
          return;
        }
        onChange(value * 60_000);
      })(),
      { tag: 'MachineAlertsPage.customSustain' },
    );
  }, [minutes, onChange]);
  return (
    <PolicyValueSelect
      testID={props.testID}
      label={t('machineVitals.alerts.sustainLabel')}
      value={formatAlertSustain(props.sustainMs)}
      choices={choices}
      selectedId={
        (ALERT_SUSTAIN_PRESET_MINUTES as readonly number[]).includes(minutes)
          ? String(minutes)
          : null
      }
      onSelect={(id) => onChange(Number(id) * 60_000)}
      onCustom={custom}
      disabled={props.disabled}
      invalid={props.invalid}
    />
  );
}

function CpuThresholdSelect(
  props: Readonly<{
    abovePct: number;
    disabled: boolean;
    invalid: boolean;
    onChange: (abovePct: number) => void;
  }>,
) {
  const choices = React.useMemo(
    (): readonly PolicyValueChoice[] =>
      CPU_THRESHOLD_PRESETS.map((pct) => ({
        id: String(pct),
        title: formatCpuThreshold(pct),
      })),
    [],
  );
  const { onChange } = props;
  const custom = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const raw = await Modal.prompt(
          t('machineVitals.alerts.customCpu.title'),
          t('machineVitals.alerts.customCpu.body'),
          {
            defaultValue: String(props.abovePct),
            inputType: 'numeric',
            confirmText: t('common.save'),
          },
        );
        if (raw === null) return;
        const value = parseCustomCpuPercent(raw);
        if (value === null) {
          Modal.alert(
            t('machineVitals.alerts.customCpu.title'),
            t('machineVitals.alerts.customCpu.invalid'),
          );
          return;
        }
        onChange(value);
      })(),
      { tag: 'MachineAlertsPage.customCpu' },
    );
  }, [onChange, props.abovePct]);
  return (
    <PolicyValueSelect
      testID="machine-alerts-cpu-threshold"
      label={t('machineVitals.alerts.cpu.thresholdLabel')}
      value={formatCpuThreshold(props.abovePct)}
      choices={choices}
      selectedId={
        (CPU_THRESHOLD_PRESETS as readonly number[]).includes(props.abovePct)
          ? String(props.abovePct)
          : null
      }
      onSelect={(id) => onChange(Number(id))}
      onCustom={custom}
      disabled={props.disabled}
      invalid={props.invalid}
    />
  );
}

function diskChoiceId(threshold: MachineDiskThreshold): string {
  return 'freeFraction' in threshold
    ? `fraction:${threshold.freeFraction}`
    : `bytes:${threshold.freeBytes}`;
}

/** The disk alert's line as a select (presets + Custom…); also used where Storage surfaces this alert. */
export function DiskThresholdSelect(
  props: Readonly<{
    threshold: MachineDiskThreshold;
    largestVolumeBytes: () => number | null;
    disabled: boolean;
    invalid: boolean;
    onChange: (threshold: MachineDiskThreshold) => void;
  }>,
) {
  const presets = React.useMemo(
    (): readonly MachineDiskThreshold[] => [
      ...DISK_FRACTION_PRESETS.map((freeFraction) => ({ freeFraction })),
      ...DISK_BYTES_PRESETS.map((freeBytes) => ({ freeBytes })),
    ],
    [],
  );
  const choices = React.useMemo(
    () =>
      presets.map((threshold) => ({
        id: diskChoiceId(threshold),
        title: formatDiskThreshold(threshold),
      })),
    [presets],
  );
  const current = diskChoiceId(props.threshold);
  const { onChange, largestVolumeBytes } = props;
  const custom = React.useCallback(() => {
    fireAndForget(
      (async () => {
        const raw = await Modal.prompt(
          t('machineVitals.alerts.customDisk.title'),
          t('machineVitals.alerts.customDisk.body'),
          {
            defaultValue: formatDiskThreshold(props.threshold),
            confirmText: t('common.save'),
          },
        );
        if (raw === null) return;
        const value = parseCustomDiskThreshold(raw, largestVolumeBytes());
        if (value === null) {
          Modal.alert(
            t('machineVitals.alerts.customDisk.title'),
            t('machineVitals.alerts.customDisk.invalid'),
          );
          return;
        }
        onChange(value);
      })(),
      { tag: 'MachineAlertsPage.customDisk' },
    );
  }, [largestVolumeBytes, onChange, props.threshold]);
  return (
    <PolicyValueSelect
      testID="machine-alerts-disk-threshold"
      label={t('machineVitals.alerts.disk.thresholdLabel')}
      value={formatDiskThreshold(props.threshold)}
      choices={choices}
      selectedId={
        choices.some((choice) => choice.id === current) ? current : null
      }
      onSelect={(id) => {
        const chosen = presets.find(
          (threshold) => diskChoiceId(threshold) === id,
        );
        if (chosen) onChange(chosen);
      }}
      onCustom={custom}
      disabled={props.disabled}
      invalid={props.invalid}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  sentence: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s6,
    paddingTop: theme.space.s8,
  },
  sentenceText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));

function readLargestRetainedVolumeBytes(key: MachineResourceKey): number | null {
  let largest: number | null = null;
  for (const view of ['overview', 'summary'] as const) {
    const disk = machineResourceStore.getState({ ...key, view }).snapshot?.sample?.disk;
    if (!disk?.reported) continue;
    for (const volume of disk.volumes) largest = Math.max(largest ?? 0, volume.totalBytes);
  }
  return largest;
}

/**
 * "Machine offline" (VIT-14): the one rule the machine cannot raise itself, so it is an Account setting the
 * server reads; it stays editable while the machine is away, which is exactly when it matters.
 */
export function MachineOfflineAlertRow(props: Readonly<{ serverId: string; machine: Pick<Machine, 'id' | 'isShared'>; machineName: string }>) {
  const { theme } = useUnistyles();
  const offline = useMachineOfflineAlert({ serverId: props.serverId, machineId: props.machine.id });
  // Offline alerts reach the machine's custodian only (plan 20 §4.7, D1): a recipient's choice could not enroll
  // the owner's notifications, so the row says who gets them instead of offering a switch that would not deliver.
  // Only a machine projected as shared with this viewer (`isShared === true`) is someone else's; unknown is ours.
  if (props.machine.isShared === true) {
    return (
      <Item
        testID="machine-alerts-offline"
        title={t('machineVitals.alerts.offline.title')}
        subtitle={t('machineVitals.alerts.offline.ownerOnly', { machine: props.machineName })}
        mode="info"
      />
    );
  }
  if (offline.status !== 'ready') return (
    <Item testID="machine-alerts-offline" title={t('machineVitals.alerts.offline.title')}
      subtitle={t('machineVitals.alerts.row.unreadable')} detail={t('common.unavailable')} mode="info" />
  );
  const toggle = (next: boolean) => {
    fireAndForget(offline.set(next), { tag: 'MachineAlertsPage.offline' });
  };
  return (
    <Item
      testID="machine-alerts-offline"
      title={t('machineVitals.alerts.offline.title')}
      subtitle={offline.failed ? t('machineVitals.alerts.saveFailed') : t('machineVitals.alerts.offline.rule', { machine: props.machineName })}
      subtitleStyle={offline.failed ? { color: theme.colors.state.danger.textForeground } : undefined}
      mode="info"
      rightElement={(
        <Switch testID="machine-alerts-offline-switch" value={offline.enabled === true}
          accessibilityLabel={t('machineVitals.alerts.offline.title')} onValueChange={toggle} />
      )}
    />
  );
}

