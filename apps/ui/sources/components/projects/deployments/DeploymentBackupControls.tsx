import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StatusDot } from '@/components/ui/status/StatusDot';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupInventoryResultV1, DeploymentBackupVerifyInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { createDeploymentActions } from './deploymentActions';
import { deploymentDataTargetOperands } from './deploymentRestore';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import type { DeploymentBackupTestResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import {
  SCHEMA_FIELD_INPUT_STYLE,
  SchemaFieldRow,
  SchemaFieldValueSlot,
} from '@/components/settings/schemaFields/SchemaFieldRow';
import { SchemaFieldControl } from '@/components/settings/schemaFields/SchemaFieldControl';

const noop = () => {};
type Snapshot = DeploymentBackupInventoryResultV1['snapshots'][number];

/** Explicit finite Actions only. The saved configuration and capture receipts remain authoritative. */
export function DeploymentBackupControls(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  lifetime: ServerAccountScopeLifetime;
  review: DeploymentReviewHandle;
  machineName: (machineId: string) => string;
  testID: string;
}>) {
  const actions = React.useMemo(() => createDeploymentActions(props.lifetime, props.detail.environment.projectSourceId),
    [props.lifetime, props.detail.environment.projectSourceId]);
  const change = useDeploymentChangePress(props.review, noop);
  const [snapshots, setSnapshots] = React.useState<readonly Snapshot[] | null>(null);
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const target = deploymentDataTargetOperands(props.detail);
  const deploymentId = props.detail.runtimeTargetLink?.activeDeploymentId;
  if (!target || !deploymentId) return (
    <Item title={t('projects.deployments.backupNeedsDeployment')} mode="info" />
  );
  const input = { ...target, deploymentId, configRevision: props.configuration.configRevision };
  const run = () => change.press(async () => {
    setResult(null);
    const capture = await actions.runBackup(input);
    // The response is the capture receipt; do not re-read our own write as an inventory refresh.
    setSnapshots(capture.manifests.map(manifest => ({ snapshot: manifest.snapshot,
      totalBytesProcessed: manifest.totalBytesProcessed, source: { sourceId: manifest.sourceId, kind: manifest.kind },
      verification: { kind: 'verified', backupOperationId: capture.operationId, configRevision: manifest.configRevision } })));
    setResult(t('projects.deployments.backupCompleted', { count: capture.manifests.length }));
    return { ok: true };
  });
  const inspect = async () => {
    if (open) { setOpen(false); return; }
    if (snapshots !== null) { setOpen(true); return; }
    await change.press(async () => {
      const inventory = await actions.backupInventory(input);
      setSnapshots(inventory.snapshots);
      setOpen(true);
      return { ok: true };
    });
  };
  const verify = (snapshot: Snapshot, level: DeploymentBackupVerifyInputV1['level']) => change.press(async () => {
    if (snapshot.verification.kind !== 'verified') return { ok: false, error: snapshot.verification.reason };
    setResult(null);
    const checked = await actions.verifyBackup({ ...input, backupOperationId: snapshot.verification.backupOperationId,
      snapshotId: snapshot.snapshot.snapshotId, level });
    setResult(t('projects.deployments.backupVerified', { level: checked.level === 'repositoryCheck'
      ? t('projects.deployments.backupRepositoryCheck') : t('projects.deployments.backupManifestReadBack'),
      time: formatAsOfTime(Date.parse(snapshot.snapshot.time)) }));
    return { ok: true };
  });
  return (
    <>
      <Item title={t('projects.deployments.backupRun')} mode="info" rightElement={
        <SectionActionButton testID={`${props.testID}.run`} title={t('projects.deployments.backupRun')}
          disabled={change.running} onPress={run} />
      } />
      <Item title={t('projects.deployments.backupVerify')} subtitle={t('projects.deployments.backupVerifyDescription')}
        mode="info" rightElement={
          <SectionActionButton testID={`${props.testID}.verify`} title={t('projects.deployments.backupVerify')}
            disabled={change.running} onPress={inspect} />
        } />
      {change.running ? <Item title={t('projects.deployments.loading')} mode="info" /> : null}
      {result ? <Item testID={`${props.testID}.result`} title={result} mode="info" /> : null}
      {change.outcome ? <DeployOutcomeBanner outcome={change.outcome}
        pending={change.outcome.kind === 'approval' && props.review.pendingId === change.outcome.artifactId}
        machine={props.machineName(target.machineId)} onOpenReview={props.review.open} copy="setting" /> : null}
      {open && snapshots?.length === 0 ? <Item title={t('projects.deployments.backupNoSnapshots')} mode="info" /> : null}
      {open ? snapshots?.map(snapshot => (
        <Item key={snapshot.snapshot.snapshotId} testID={`${props.testID}.snapshot.${snapshot.snapshot.snapshotId}`}
          title={formatAsOfTime(Date.parse(snapshot.snapshot.time))}
          subtitle={snapshot.verification.kind === 'unknown'
            ? t('projects.deployments.backupCaptureUnavailable') : snapshot.source?.sourceId}
          mode="info" bottomElement={snapshot.verification.kind === 'verified' ? (
            <View style={styles.checks}>
              <SectionActionButton testID={`${props.testID}.snapshot.${snapshot.snapshot.snapshotId}.manifestReadBack`}
                title={t('projects.deployments.backupManifestReadBack')} disabled={change.running}
                onPress={() => verify(snapshot, 'manifestReadBack')} />
              <SectionActionButton testID={`${props.testID}.snapshot.${snapshot.snapshot.snapshotId}.repositoryCheck`}
                title={t('projects.deployments.backupRepositoryCheck')} disabled={change.running}
                onPress={() => verify(snapshot, 'repositoryCheck')} />
            </View>
          ) : undefined} />
      )) : null}
    </>
  );
}

type Retention = DeploymentBackupConfigurationV1['retention'];
type ActionsFactory = ReturnType<typeof createDeploymentActions>;

/** The exact capture target the finite backup Actions address, or null before anything runs on a Machine. */
function useBackupTarget(detail: DeploymentEnvironmentReadDetailV1, configuration: DeploymentBackupConfigurationV1) {
  const target = deploymentDataTargetOperands(detail);
  const deploymentId = detail.runtimeTargetLink?.activeDeploymentId;
  return target && deploymentId ? { ...target, deploymentId, configRevision: configuration.configRevision } : null;
}

/** Names the saved destination the way a person set it up: bucket and prefix, then where it is. */
function destinationTitle(configuration: DeploymentBackupConfigurationV1): string {
  const text = (key: string) => {
    const value = configuration.config[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return [text('bucket'), text('prefix')].filter((part): part is string => part !== null).join(' · ')
    || configuration.destinationRef.localId;
}

function destinationPlace(configuration: DeploymentBackupConfigurationV1): string {
  const region = configuration.config.region;
  return typeof region === 'string' && region.length > 0
    ? t('projects.deployments.settingsSections.destinationS3', { region })
    : t('projects.deployments.settingsSections.destinationS3NoRegion');
}

function testOutcome(result: DeploymentBackupTestResultV1): Readonly<{ ok: boolean; line: string }> {
  if (result.kind === 'reachable') return { ok: true, line: t('projects.deployments.settingsSections.destinationReachable') };
  switch (result.reason) {
    case 'repository_missing': return { ok: false, line: t('projects.deployments.settingsSections.destinationRepositoryMissing') };
    case 'native_failed': return { ok: false, line: t('projects.deployments.settingsSections.destinationNativeFailed') };
    case 'repository_locked': return { ok: false, line: t('projects.deployments.settingsSections.destinationLocked') };
    case 'repository_password_incorrect': return { ok: false, line: t('projects.deployments.settingsSections.destinationPasswordIncorrect') };
    default: return { ok: false, line: t('projects.deployments.settingsSections.destinationRetry') };
  }
}

/**
 * Settings › Backups destination (lab `d7d/destfail`): the saved bucket and prefix, and Test, a read-only probe of that
 * repository through `deployments.backups.test`. One line says the result; a failure names what to check.
 */
export function DeploymentBackupDestinationRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  /** Absent where this viewer cannot run backup Actions. */
  actions: ActionsFactory | null;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const target = useBackupTarget(props.detail, props.configuration);
  const [tested, setTested] = React.useState<Readonly<{ ok: boolean; line: string }> | null>(null);
  const [running, setRunning] = React.useState(false);
  const { actions } = props;
  const test = async () => {
    if (!actions || !target || running) return;
    setRunning(true);
    try { setTested(testOutcome(await actions.testBackupDestination(target))); }
    catch { setTested({ ok: false, line: t('projects.deployments.settingsSections.destinationRetry') }); }
    finally { setRunning(false); }
  };
  return (
    <Item
      testID={`${props.testID}.destination`}
      title={destinationTitle(props.configuration)}
      subtitle={tested ? `${destinationPlace(props.configuration)} · ${tested.line}` : destinationPlace(props.configuration)}
      subtitleLeading={tested && !tested.ok
        ? <StatusDot size={6} color={theme.colors.state.danger.foreground} /> : undefined}
      mode="info"
      rightElement={actions && target ? (
        <SectionActionButton testID={`${props.testID}.destination.test`}
          title={t('projects.deployments.settingsSections.destinationTest')} disabled={running} onPress={test} />
      ) : undefined}
    />
  );
}

const KEEP_FIELDS = ['last', 'daily', 'weekly', 'monthly'] as const;
type KeepField = typeof KEEP_FIELDS[number];
const KEEP_LABEL: Readonly<Record<KeepField, 'keepLast' | 'keepDaily' | 'keepWeekly' | 'keepMonthly'>> = {
  last: 'keepLast', daily: 'keepDaily', weekly: 'keepWeekly', monthly: 'keepMonthly',
};

function draftFrom(retention: Retention): Record<KeepField, string> {
  const count = (field: KeepField) => retention.kind === 'keep' && retention[field] !== undefined ? String(retention[field]) : '';
  return { last: count('last'), daily: count('daily'), weekly: count('weekly'), monthly: count('monthly') };
}

/** Empty everywhere keeps every backup; any other entry must be a whole number above zero. */
export function retentionFromDraft(draft: Readonly<Record<KeepField, string>>): Retention | null {
  const counts: Partial<Record<KeepField, number>> = {};
  for (const field of KEEP_FIELDS) {
    const text = draft[field].trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1) return null;
    counts[field] = value;
  }
  return Object.keys(counts).length === 0 ? { kind: 'keepEverything' } : { kind: 'keep', ...counts };
}

/**
 * Settings › Backups keep counts (lab `database/keep`) and Remove old backups now. Change edits the counts in place and
 * Save writes them once through `deployments.environments.update` (patch.backupRetention); Remove runs
 * `deployments.backups.prune` with the saved counts. Both are the Actions an agent calls.
 */
export function DeploymentBackupRetentionRows(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  label: string;
  /** Saves new counts; absent where this viewer cannot change settings. */
  onSave: ((retention: Retention) => Promise<boolean>) | null;
  actions: ActionsFactory | null;
  review: DeploymentReviewHandle | null;
  machineName: (machineId: string) => string;
  testID: string;
}>) {
  const { configuration, onSave, actions } = props;
  const [draft, setDraft] = React.useState<Record<KeepField, string> | null>(null);
  const [saving, setSaving] = React.useState(false);
  const target = useBackupTarget(props.detail, configuration);
  const prune = useDeploymentChangePress(props.review, noop);
  const [pruned, setPruned] = React.useState<string | null>(null);
  const next = draft ? retentionFromDraft(draft) : null;
  const save = async () => {
    if (!onSave || !next || saving) return;
    setSaving(true);
    const settled = await onSave(next);
    setSaving(false);
    if (settled) setDraft(null);
  };
  const removeOld = () => prune.press(async () => {
    if (!actions || !target || configuration.retention.kind !== 'keep') return { ok: true };
    setPruned(null);
    const result = await actions.pruneBackups({ ...target, retention: configuration.retention });
    setPruned(result.forgottenSnapshotIds.length > 0
      ? t('projects.deployments.settingsSections.pruned', { count: result.forgottenSnapshotIds.length })
      : t('projects.deployments.settingsSections.prunedNothing'));
    return { ok: true };
  });
  return (
    <>
      <Item
        testID={`${props.testID}.retention`}
        title={t('projects.deployments.settingsSections.keepTitle')}
        subtitle={!draft ? props.label : next
          ? t('projects.deployments.settingsSections.keepDescription')
          : t('projects.deployments.settingsSections.keepInvalid')}
        mode="info"
        rightElement={!onSave ? undefined : draft ? (
          <View style={styles.checks}>
            <SectionActionButton testID={`${props.testID}.retention.cancel`}
              title={t('projects.deployments.settingsSections.keepCancel')} disabled={saving} onPress={() => setDraft(null)} />
            <SectionActionButton testID={`${props.testID}.retention.save`}
              title={t('projects.deployments.settingsSections.keepSave')} disabled={saving || !next} onPress={save} />
          </View>
        ) : (
          <SectionActionButton testID={`${props.testID}.retention.change`}
            title={t('projects.deployments.settingsSections.keepChange')}
            onPress={() => setDraft(draftFrom(configuration.retention))} />
        )}
      />
      {draft ? KEEP_FIELDS.map((field) => (
        <SchemaFieldRow
          key={field}
          testID={`${props.testID}.retention.${field}`}
          title={t(`projects.deployments.settingsSections.${KEEP_LABEL[field]}`)}
          layout="adaptive"
          disabled={saving}
          control={
            <SchemaFieldValueSlot kind="number">
              <SchemaFieldControl
                control="text"
                inputProps={{
                  testID: `${props.testID}.retention.${field}.input`,
                  accessibilityLabel: t(`projects.deployments.settingsSections.${KEEP_LABEL[field]}`),
                  value: draft[field],
                  placeholder: '0',
                  keyboardType: 'number-pad',
                  editable: !saving,
                  onChangeText: (text: string) => setDraft((current) => current ? { ...current, [field]: text } : current),
                  style: SCHEMA_FIELD_INPUT_STYLE,
                }}
              />
            </SchemaFieldValueSlot>
          }
        />
      )) : null}
      {actions && target && configuration.retention.kind === 'keep' && !draft ? (
        <Item
          testID={`${props.testID}.prune`}
          title={t('projects.deployments.settingsSections.pruneTitle')}
          subtitle={pruned ?? t('projects.deployments.settingsSections.pruneDescription')}
          mode="info"
          rightElement={
            <SectionActionButton testID={`${props.testID}.prune.run`}
              title={t('projects.deployments.settingsSections.pruneAction')} disabled={prune.running} onPress={removeOld} />
          }
        />
      ) : null}
      {prune.outcome && props.review && target ? <DeployOutcomeBanner outcome={prune.outcome}
        pending={prune.outcome.kind === 'approval' && props.review.pendingId === prune.outcome.artifactId}
        machine={props.machineName(target.machineId)} onOpenReview={props.review.open} copy="setting" /> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
}));
