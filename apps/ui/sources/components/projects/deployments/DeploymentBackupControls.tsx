import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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

const styles = StyleSheet.create((theme) => ({
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
}));
