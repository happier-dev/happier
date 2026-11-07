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
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { Switch } from '@/components/ui/forms/Switch';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { PluginUiBackupDestinationProjection } from '@/sync/domains/plugins/ui/projection';

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

/** Empty or 0 everywhere keeps every backup; any other entry must be a whole number. */
export function retentionFromDraft(draft: Readonly<Record<KeepField, string>>): Retention | null {
  const counts: Partial<Record<KeepField, number>> = {};
  for (const field of KEEP_FIELDS) {
    const text = draft[field].trim();
    if (text === '') continue;
    if (!/^\d+$/.test(text)) return null;
    const value = Number(text);
    if (!Number.isSafeInteger(value)) return null;
    // 0 means this rule keeps nothing extra, the same as leaving it empty (lab `database/keep`).
    if (value > 0) counts[field] = value;
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
        <FieldValueItem
          key={field}
          testID={`${props.testID}.retention.${field}`}
          fieldTestID={`${props.testID}.retention.${field}.input`}
          title={t(`projects.deployments.settingsSections.${KEEP_LABEL[field]}`)}
          kind="integer"
          allowEmpty
          placeholder="0"
          value={draft[field]}
          stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }}
          compactStepper
          disabled={saving}
          onDraftChange={(text) => setDraft((current) => current ? { ...current, [field]: text } : current)}
          onCommit={(text) => {
            setDraft((current) => current ? { ...current, [field]: text } : current);
            return text;
          }}
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

type CredentialRole = DeploymentBackupConfigurationV1['credentialBindings'][number]['role'];
const CREDENTIAL_LABEL: Readonly<Record<string, 'credentialAccessKeyId' | 'credentialSecretAccessKey'
  | 'credentialRepositoryPassword' | 'credentialSessionToken'>> = {
  accessKeyId: 'credentialAccessKeyId', secretAccessKey: 'credentialSecretAccessKey',
  repositoryPassword: 'credentialRepositoryPassword', sessionToken: 'credentialSessionToken',
};
/** Friendlier names for common destination fields; any other field the descriptor declares shows its own key. */
const CONFIG_LABEL: Readonly<Record<string, 'setupEndpoint' | 'setupBucket' | 'setupPrefix' | 'setupRegion'>> = {
  endpoint: 'setupEndpoint', bucket: 'setupBucket', prefix: 'setupPrefix', region: 'setupRegion',
};
type DestinationEntry = PluginUiBackupDestinationProjection;
type ConfigField = Readonly<{ key: string; required: boolean; minLength: number }>;

/** The text fields a destination's own configuration schema declares, in its order. */
function destinationConfigFields(entry: DestinationEntry): readonly ConfigField[] {
  const schema = entry.definition.configSchema as Readonly<{ properties?: Record<string, unknown>; required?: unknown }>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
    const declared = property as Readonly<{ type?: unknown; minLength?: unknown }> | null;
    return declared?.type === 'string' ? [{ key, required: required.includes(key),
      minLength: typeof declared.minLength === 'number' ? declared.minLength : 0 }] : [];
  });
}

/**
 * Settings › Backups before anything is set up (JOURNEY-OPUS-85 F1): an S3-transport destination the backup-destinations
 * family publishes (its identity, configuration fields and credential roles come from that descriptor), the database
 * service to dump and the keep counts, saved once as `environments.update` patch.backup (T2-DATA's configuration owner).
 * Credentials and the nightly schedule follow on the saved setup, through their own Actions.
 */
export function DeploymentBackupSetup(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  onSave: (configuration: DeploymentBackupConfigurationV1) => Promise<boolean>;
  testID: string;
}>) {
  const destinations = useAppShellPluginUiProjection((value) => value.pluginUiProjection?.backupDestinationsById);
  const destination = React.useMemo(() => Object.values(destinations ?? {})
    .find((entry) => entry.definition.resticTransport === 's3') ?? null, [destinations]);
  const configFields = React.useMemo(() => destination ? destinationConfigFields(destination) : [], [destination]);
  const [fields, setFields] = React.useState<Record<string, string> | null>(null);
  const [roles, setRoles] = React.useState<ReadonlySet<CredentialRole>>(new Set());
  const [keep, setKeep] = React.useState<Record<KeepField, string>>({ last: '', daily: '7', weekly: '4', monthly: '' });
  const [saving, setSaving] = React.useState(false);
  const id = `${props.testID}.setup`;
  const retention = retentionFromDraft(keep);
  const value = (key: string) => (fields?.[key] ?? '').trim();
  const complete = fields !== null && destination !== null && retention !== null && value('service') !== ''
    && configFields.every((field) => !field.required || value(field.key).length >= field.minLength)
    && configFields.every((field) => value(field.key) === '' || value(field.key).length >= field.minLength);
  const start = () => {
    if (!destination) return;
    setFields({ ...Object.fromEntries(configFields.map((field) => [field.key, ''])),
      service: props.detail.content.template?.data?.service ?? '' });
    setRoles(new Set(destination.definition.credentialRoles));
  };
  const save = async () => {
    if (!fields || !destination || !retention || !complete || saving) return;
    const service = value('service');
    const config = Object.fromEntries(configFields.flatMap((field) =>
      value(field.key) !== '' || field.required ? [[field.key, value(field.key)]] : []));
    setSaving(true);
    const saved = await props.onSave({
      configRevision: 1, destinationRef: { pluginId: destination.pluginId, localId: destination.definition.id },
      // The host captures the destination's current occurrence when it prepares the setup.
      occurrenceId: destination.definition.id,
      config,
      credentialBindings: destination.definition.credentialRoles.filter((role) => roles.has(role))
        .map((role) => ({ purpose: 'backupDestination' as const, configKey: 'destination' as const, role })),
      sources: [{ kind: 'dump', sourceId: service, service, consistency: 'logical' }],
      ownership: { environmentId: props.detail.environment.id, prefix: value('prefix') },
      retention,
    });
    setSaving(false);
    if (saved) setFields(null);
  };
  const setField = (key: string) => (text: string) => setFields((current) => current ? { ...current, [key]: text } : current);
  const setKeepField = (field: KeepField) => (text: string) => setKeep((current) => ({ ...current, [field]: text }));
  return (
    <>
      <Item
        testID={id}
        title={t('projects.deployments.settingsSections.setupTitle')}
        subtitle={!destination ? t('projects.deployments.settingsSections.setupNoDestination')
          : fields && !complete ? t('projects.deployments.settingsSections.setupIncomplete')
            : t('projects.deployments.settingsSections.setupBody')}
        mode="info"
        rightElement={!destination ? undefined : fields ? (
          <View style={styles.checks}>
            <SectionActionButton testID={`${id}.cancel`} title={t('projects.deployments.settingsSections.setupCancel')}
              disabled={saving} onPress={() => setFields(null)} />
            <SectionActionButton testID={`${id}.save`} title={t('projects.deployments.settingsSections.setupSave')}
              disabled={saving || !complete} onPress={save} />
          </View>
        ) : (
          <SectionActionButton testID={`${id}.start`} title={t('projects.deployments.settingsSections.setupStart')}
            icon="plus" onPress={start} />
        )}
      />
      {fields ? [...configFields.map((field) => field.key), 'service'].map((key) => (
        <FieldValueItem
          key={key}
          testID={`${id}.${key}`}
          fieldTestID={`${id}.${key}.input`}
          title={key === 'service' ? t('projects.deployments.settingsSections.setupService')
            : CONFIG_LABEL[key] ? t(`projects.deployments.settingsSections.${CONFIG_LABEL[key]}`) : key}
          accessoryLayout="stacked"
          autoCapitalize="none"
          monospace={key !== 'service'}
          value={fields[key] ?? ''}
          allowEmpty
          disabled={saving}
          onDraftChange={setField(key)}
          onCommit={(text) => { setField(key)(text); return text; }}
        />
      )) : null}
      {fields && destination ? destination.definition.credentialRoles.map((role) => (
        <Item
          key={role}
          testID={`${id}.role.${role}`}
          title={t(`projects.deployments.settingsSections.${CREDENTIAL_LABEL[role] ?? 'credentialRepositoryPassword'}`)}
          subtitle={t('projects.deployments.settingsSections.setupRoleBody')}
          rightElement={
            <Switch value={roles.has(role)} disabled={saving} onValueChange={(on) => setRoles((current) => {
              const next = new Set(current);
              if (on) next.add(role); else next.delete(role);
              return next;
            })} />
          }
        />
      )) : null}
      {fields ? (['daily', 'weekly'] as const).map((field) => (
        <FieldValueItem
          key={field}
          testID={`${id}.keep.${field}`}
          fieldTestID={`${id}.keep.${field}.input`}
          title={t(`projects.deployments.settingsSections.${KEEP_LABEL[field]}`)}
          kind="integer"
          allowEmpty
          value={keep[field]}
          stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }}
          compactStepper
          disabled={saving}
          onDraftChange={setKeepField(field)}
          onCommit={(text) => { setKeepField(field)(text); return text; }}
        />
      )) : null}
    </>
  );
}

/**
 * The credential roles a saved destination names, each bound to a Saved Secret through the existing
 * `deployments.bindings.set` backupDestination path. Values never enter the backup configuration.
 */
export function DeploymentBackupCredentialRows(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  lifetime: ServerAccountScopeLifetime | null;
  actions: ActionsFactory | null;
  review: DeploymentReviewHandle | null;
  onChanged: () => void;
  machineName: (machineId: string) => string;
  testID: string;
}>) {
  const change = useDeploymentChangePress(props.review, props.onChanged);
  const { actions, lifetime } = props;
  const bound = (role: CredentialRole) => props.detail.content.bindings.some((binding) =>
    binding.purpose === 'backupDestination' && binding.configKey === 'destination' && binding.role === role);
  const choose = async (role: CredentialRole) => {
    if (!actions || !lifetime) return;
    const controller = new AbortController();
    const selection = await presentSavedSecretReferencePicker({ accountLifetime: lifetime, signal: controller.signal,
      isCurrent: () => lifetime.isCurrent() });
    if (!selection) return;
    await change.press(() => actions.setBindings({ environmentId: props.detail.environment.id,
      expectedRevision: props.detail.environment.revision, remove: [],
      set: [{ purpose: 'backupDestination', configKey: 'destination', role,
        source: { kind: 'secret', ref: selection.ref, resourceRevision: selection.resourceRevision } }] }));
  };
  return (
    <>
      {props.configuration.credentialBindings.map(({ role }) => (
        <Item
          key={role}
          testID={`${props.testID}.credential.${role}`}
          title={t(`projects.deployments.settingsSections.${CREDENTIAL_LABEL[role] ?? 'credentialRepositoryPassword'}`)}
          subtitle={bound(role)
            ? t('projects.deployments.settingsSections.credentialSet')
            : t('projects.deployments.settingsSections.credentialMissing')}
          mode="info"
          rightElement={actions && lifetime ? (
            <SectionActionButton testID={`${props.testID}.credential.${role}.choose`}
              title={t('projects.deployments.settingsSections.credentialChoose')}
              disabled={change.running} onPress={() => { void choose(role); }} />
          ) : undefined}
        />
      ))}
      {change.outcome && props.review ? <DeployOutcomeBanner outcome={change.outcome}
        pending={change.outcome.kind === 'approval' && props.review.pendingId === change.outcome.artifactId}
        machine={props.machineName(props.detail.environment.controllerMachineId)} onOpenReview={props.review.open}
        copy="setting" /> : null}
    </>
  );
}

/**
 * The nightly schedule: the built-in Nightly backups Workflow for this exact capture target, read and added through the
 * trigger owner (`workflow.trigger.list` deploymentBackup, `workflow.trigger.add`).
 */
export function DeploymentBackupScheduleRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  actions: ActionsFactory | null;
  testID: string;
}>) {
  const target = useBackupTarget(props.detail, props.configuration);
  const { actions } = props;
  const [scheduled, setScheduled] = React.useState<boolean | null>(null);
  const [adding, setAdding] = React.useState(false);
  const targetKey = target ? JSON.stringify(target) : null;
  React.useEffect(() => {
    if (!actions || !target) return;
    let live = true;
    const { expectedRevision: _expectedRevision, ...identity } = target;
    actions.backupScheduleSets(identity).then((count) => { if (live) setScheduled(count > 0); }, () => {});
    return () => { live = false; };
    // The target key carries every identity field the read uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, targetKey]);
  const turnOn = async () => {
    if (!actions || !target || adding) return;
    setAdding(true);
    try {
      await actions.addBackupSchedule({ target, retention: props.configuration.retention,
        controllerMachineId: props.detail.environment.controllerMachineId });
      setScheduled(true);
    } catch { /* The trigger owner's refusal leaves the row as it was; pressing again retries. */ }
    setAdding(false);
  };
  return (
    <Item
      testID={`${props.testID}.schedule`}
      title={t('projects.deployments.settingsSections.scheduleTitle')}
      subtitle={scheduled
        ? t('projects.deployments.settingsSections.scheduleOn')
        : t('projects.deployments.settingsSections.scheduleOff')}
      mode="info"
      rightElement={actions && target && scheduled === false ? (
        <SectionActionButton testID={`${props.testID}.schedule.on`}
          title={t('projects.deployments.settingsSections.scheduleTurnOn')} disabled={adding} onPress={turnOn} />
      ) : undefined}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
}));
