import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StatusDot } from '@/components/ui/status/StatusDot';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { DeploymentBackupConfigurationV1Schema,
  type DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupInventoryResultV1, DeploymentBackupVerifyInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

import { Item } from '@/components/ui/lists/Item';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { createDeploymentActions } from './deploymentActions';
import { deploymentDataTargetOperands, prepareDeploymentBackupConfigurationV1 } from '@happier-dev/deployments';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { readDeploymentActionError, useDeploymentChangePress } from './deploymentActionOutcome';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { DeployOutcomeBanner, type DeploymentReviewHandle } from './DeploymentEnvironmentDetail';
import type { DeploymentBackupTestResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import type { DeploymentBackupHistoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupHistoryV1';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { presentSavedSecretReferencePicker } from '@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { deriveActionInputHints } from '@happier-dev/protocol/actions/schemaInputHints';
import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { resolveEffectiveInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { buildSessionActionFieldOptionsResolver } from '@/components/sessions/actions/sessionActionFieldOptions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HappyError } from '@/utils/errors/errors';
import { Text } from '@/components/ui/text/Text';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { Switch } from '@/components/ui/forms/Switch';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { DeploymentBackupConfigureInputV1, DeploymentBackupConfigureResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DeploymentBackupAnotherMachineSetupV1Schema, type DeploymentBackupAnotherMachineSetupV1 } from '@happier-dev/protocol/deployments/deploymentBackupAnotherMachineV1';
import { sourceWord } from './DeploymentCreationDefaultsRows';
import { formatAutomationScheduleLabel } from '@/components/automations/list/automationListFormatting';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { WORKFLOWS_NEW_ROUTE } from '@/components/workflows/workflowsRoutes';
import { SFTP_BACKUP_DESTINATION_REF_V1 } from '@happier-dev/protocol/plugins/contributions/backupDestinations';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { MachineSetupV1Schema } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { useMachineListForServer } from '@/sync/store/hooks';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { MachineSetupRecipeInputs } from '@/components/settings/machines/managed/MachineSetupRecipeInputs';
import { readMachineSetupRecipeInputState } from '@/components/settings/machines/managed/machineSetupRecipeInputsModel';
import { deploymentActionRefusalRemedy } from './deploymentPresentation';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { deploymentBackupKeepFields as KEEP_FIELDS, deploymentBackupKeepLabels as KEEP_LABEL,
  deploymentBackupRetentionDraftFrom as draftFrom, retentionFromDraft,
  type DeploymentBackupKeepField as KeepField } from './deploymentBackupRetention';
import { useBackupPathCapacity, BackupPathCapacityReview } from './DeploymentBackupCapacity';
export { retentionFromDraft } from './deploymentBackupRetention';

const noop = () => {};
type Snapshot = DeploymentBackupInventoryResultV1['snapshots'][number];

/** Explicit finite Actions only. The saved configuration and capture receipts remain authoritative. */
export function DeploymentBackupControls(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  lifetime: ServerAccountScopeLifetime;
  review: DeploymentReviewHandle;
  onBackupCompleted: () => void;
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
    props.onBackupCompleted();
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
      {change.outcome ? <DeployOutcomeBanner controller={change.banner}
        machine={props.machineName(target.machineId)} copy="setting" /> : null}
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

type MissedSchedule = Readonly<{ triggerId: string; dueAt: number; lastRunAt: number | null }>;
/** Facts read once per presentation; the Action owners derive them (history receipts, scheduler cursor), we only show them. */
export type DeploymentBackupFacts =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; history: DeploymentBackupHistoryResultV1 | null; missed: readonly MissedSchedule[] }>
  | Readonly<{ status: 'unavailable' }>;
const LOADING_FACTS: DeploymentBackupFacts = Object.freeze({ status: 'loading' });
const NO_MISSED: readonly MissedSchedule[] = Object.freeze([]);

/**
 * Exact capture history and stable Environment schedules, read through their Action owners when the surface is presented
 * and again on `reload` (after its own Back up now). No timer, no poll.
 * Shared by Settings › Backups and the Database page.
 */
export function useDeploymentBackupFacts(
  actions: ReturnType<typeof createDeploymentActions> | null,
  input: Parameters<ReturnType<typeof createDeploymentActions>['backupHistory']>[0] | null,
  presented: boolean,
) {
  const [facts, setFacts] = React.useState<DeploymentBackupFacts>(LOADING_FACTS);
  const [generation, setGeneration] = React.useState(0);
  const key = input ? JSON.stringify(input) : null;
  React.useEffect(() => {
    if (!actions || !input || !presented) return;
    let live = true;
    void Promise.allSettled([actions.backupHistory(input), actions.missedBackupSchedules({ environmentId: input.environmentId })]).then(([history, missed]) => {
      if (!live) return;
      if (history.status === 'rejected' && missed.status === 'rejected') { setFacts({ status: 'unavailable' }); return; }
      setFacts({ status: 'ready', history: history.status === 'fulfilled' ? history.value : null,
        missed: missed.status === 'fulfilled' ? missed.value : NO_MISSED });
    });
    return () => { live = false; };
    // The serialized operands are the read's identity; the parsed object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, key, presented, generation]);
  const reload = React.useCallback(() => setGeneration((value) => value + 1), []);
  return { facts: input ? facts : null, reload };
}

/** What the facts say needs the person: an overdue unstarted run first, then a latest backup that failed. */
export function deploymentBackupAttention(facts: DeploymentBackupFacts | null) {
  const ready = facts?.status === 'ready' ? facts : null;
  const missed = ready?.missed[0] ?? null;
  const latestBackup = ready?.history?.history.entries.find((entry) => entry.action === 'backup') ?? null;
  return {
    missed,
    failed: latestBackup?.state === 'failed' ? latestBackup : null,
    lastGood: ready?.history?.lastSuccessfulBackup ?? null,
    entries: ready?.history?.history.entries ?? [],
  };
}
type ActionsFactory = ReturnType<typeof createDeploymentActions>;

/** The exact capture target the finite backup Actions address, or null before anything runs on a Machine. */
function useBackupTarget(detail: DeploymentEnvironmentReadDetailV1, configuration: DeploymentBackupConfigurationV1) {
  const target = deploymentDataTargetOperands(detail);
  const deploymentId = detail.runtimeTargetLink?.activeDeploymentId;
  return target && deploymentId ? { ...target, deploymentId, configRevision: configuration.configRevision } : null;
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
 * Settings › Backups destination and its explicit repository probe. Test writes and reads back a temporary
 * object through `deployments.backups.test`; a failure names what to check.
 */
export function DeploymentBackupDestinationRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  /** Absent where this viewer cannot run backup Actions. */
  actions: ActionsFactory | null;
  lifetime?: ServerAccountScopeLifetime;
  testID: string;
}>) {
  const { theme } = useUnistyles();
  const target = useBackupTarget(props.detail, props.configuration);
  const [tested, setTested] = React.useState<Readonly<{ ok: boolean; line: string }> | null>(null);
  const [running, setRunning] = React.useState(false);
  const projection = usePluginUiProjectionCurrentness({ serverId: props.detail.environment.serverId,
    machineId: props.detail.environment.controllerMachineId, sections: BACKUP_DESTINATION_SECTIONS });
  const localize = usePluginLocalizedTextResolver({ projection: projection.pluginUiProjection });
  const destination = projection.pluginUiProjection?.backupDestinationsById[
    buildQualifiedPluginContributionKey(props.configuration.destinationRef)];
  const pathCapacity = useBackupPathCapacity(props.detail.environment.serverId,
    destination?.definition.locality === 'local' ? deploymentDataTargetOperands(props.detail)?.machineId : undefined,
    props.configuration.config.path, props.lifetime, true);
  const inputHints = React.useMemo(() => destination
    ? deriveActionInputHints(destination.definition.configSchema, destination.definition.fieldHints) : null, [destination]);
  const fields = React.useMemo(() => inputHints
    ? resolveEffectiveInputFields({ inputHints }, props.configuration.config) : [], [inputHints, props.configuration.config]);
  const { actions } = props;
  const test = async () => {
    if (!actions || !target || running) return;
    setRunning(true);
    try { setTested(testOutcome(await actions.testBackupDestination(target))); }
    catch (error) {
      const outcome = readDeploymentActionError(error);
      const failure = outcome.kind === 'refused' ? presentActionFailureOutcome(outcome.failure
        ?? { errorCode: outcome.code, error: outcome.code }, 'deployment') : null;
      setTested({ ok: false, line: failure?.reason ?? t('projects.deployments.settingsSections.destinationRetry') });
    }
    finally { setRunning(false); }
  };
  return (
    <><Item
      testID={`${props.testID}.destination`}
      title={destination ? localize(destination.pluginId, destination.definition.title) : t('common.unavailable')}
      subtitle={tested?.line}
      subtitleLeading={tested && !tested.ok
        ? <StatusDot size={6} color={theme.colors.state.danger.foreground} /> : undefined}
      mode="info"
      rightElement={actions && target ? (
        <SectionActionButton testID={`${props.testID}.destination.test`}
          title={t('projects.deployments.settingsSections.destinationTest')} disabled={running} onPress={test} />
      ) : undefined}
      bottomElement={destination ? <ActionInputFields fields={fields} input={props.configuration.config}
        editable={false} resolveFieldOptions={destinationFieldOptions} onPatch={noop} /> : undefined}
    />
    <BackupPathCapacityReview capacity={pathCapacity.capacity}
      machine={pathCapacity.machineName} testID={`${props.testID}.destination`} />
    {destination?.definition.locality === 'local' ? <Item testID={`${props.testID}.destination.localWarning`}
      mode="info" title={t('projects.deployments.settingsSections.setupLocalWarning')}
      subtitle={t('projects.deployments.settingsSections.setupLocalGrowth')} /> : null}</>
  );
}

/**
 * Settings › Backups keep counts (lab `database/keep`) and Remove old backups now. Change edits the counts in place and
 * Save writes them through `deployments.backups.configure`; Remove runs
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
      {prune.outcome && props.review && target ? <DeployOutcomeBanner controller={prune.banner}
        machine={props.machineName(target.machineId)} copy="setting" /> : null}
    </>
  );
}

type CredentialRole = DeploymentBackupConfigurationV1['credentialBindings'][number]['role'];
const CREDENTIAL_LABEL: Readonly<Record<string, 'credentialAccessKeyId' | 'credentialSecretAccessKey'
  | 'credentialRepositoryPassword' | 'credentialSessionToken' | 'credentialSshPrivateKey'>> = {
  accessKeyId: 'credentialAccessKeyId', secretAccessKey: 'credentialSecretAccessKey',
  repositoryPassword: 'credentialRepositoryPassword', sessionToken: 'credentialSessionToken', sshPrivateKey: 'credentialSshPrivateKey',
};
/** A search seed for the Store, not an identity: it only finds the plugins that add backup storage. */
const STORE_BACKUP_QUERY = 'backup';
const BACKUP_DESTINATION_SECTIONS = Object.freeze(['familiesById.backupDestinations']);
const BACKUP_RECEIVER_SECTIONS = Object.freeze(['familiesById.machineRecipes']);
const BACKUP_RECEIVER_SUPPLIED_INPUTS = Object.freeze(['senderPublicKey']);
const destinationFieldOptions = buildSessionActionFieldOptionsResolver({});

type BackupDestination = NonNullable<NonNullable<ReturnType<typeof usePluginUiProjectionCurrentness>['pluginUiProjection']>['backupDestinationsById']>[string];

type BackupConfigurePreparation = Exclude<DeploymentBackupConfigureInputV1, { intent: 'markNotNeeded' | 'rekeyAndSave' }>;
type BackupConfigureDraft = Omit<BackupConfigurePreparation, 'serverId' | 'environmentId' | 'expectedRevision'>;
type BackupDefaults = Awaited<ReturnType<ActionsFactory['prepareConfigurationDefaults']>>;

/** One captured defaults/source review opens the controller-owned Configure flow. */
export function DeploymentBackupSetup(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1; serverId: string; review: DeploymentReviewHandle;
  actions: Pick<ActionsFactory, 'configureBackup' | 'prepareConfigurationDefaults' | 'addBackupSchedule'>;
  lifetime: ServerAccountScopeLifetime; onChanged: () => void;
  machineName: (machineId: string) => string; onAddDatabase?: (() => void) | null; testID: string;
}>) {
  const router = useRouter();
  const route = useLocalSearchParams<{ deploymentEnvironment?: string; deploymentSetup?: string }>();
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentEnvironment = React.useRef(props.detail.environment.id);
  currentEnvironment.current = props.detail.environment.id;
  const projection = usePluginUiProjectionCurrentness({ serverId: props.serverId,
    machineId: props.detail.environment.controllerMachineId, sections: BACKUP_DESTINATION_SECTIONS });
  const destinations = React.useMemo(() => Object.values(projection.pluginUiProjection?.backupDestinationsById ?? {}),
    [projection.pluginUiProjection?.backupDestinationsById]);
  const change = useDeploymentChangePress(props.review, noop);
  const id = `${props.testID}.setup`;
  const open = React.useCallback(() => {
    const destination = destinations[0];
    if (!projection.interactionEnabled || !destination) return;
    void change.press(async () => {
      const defaults = await props.actions.prepareConfigurationDefaults(props.detail.environment, 'backups');
      if (!mounted.current || currentEnvironment.current !== props.detail.environment.id || !props.lifetime.isCurrent()) return { ok: false, error: 'action_account_scope_changed' };
      showDeploymentSheet({ component: DeploymentBackupSetupSheet,
        props: { detail: props.detail, destinations, destination, defaults,
          sourceChoices: defaults.backupSourceChoices ?? [], projection: projection.pluginUiProjection,
          lifetime: props.lifetime, testID: id, review: props.review,
          configure: (draft: BackupConfigureDraft) => props.actions.configureBackup(props.detail.environment, draft),
          onConfigured: (configuration: DeploymentBackupConfigurationV1, schedule: NonNullable<BackupDefaults['values']['backupSchedule']>) =>
            props.actions.addBackupSchedule({ environmentId: props.detail.environment.id,
              controllerMachineId: props.detail.environment.controllerMachineId, configuration, schedule }).then(() => {}),
          onChanged: props.onChanged, machine: props.machineName(props.detail.environment.controllerMachineId) },
        title: t('projects.deployments.settingsSections.setupSheetTitle'), testID: `${id}.modal` });
      return { ok: true };
    });
  }, [change.press, destinations, id, projection.interactionEnabled, projection.pluginUiProjection, props]);
  const openedFromReadiness = React.useRef<string | null>(null);
  React.useEffect(() => {
    const environmentId = props.detail.environment.id;
    if (route.deploymentEnvironment !== environmentId || route.deploymentSetup !== 'backups') {
      openedFromReadiness.current = null;
      return;
    }
    if (!projection.interactionEnabled || !destinations.length || openedFromReadiness.current === environmentId) return;
    openedFromReadiness.current = environmentId;
    open();
  }, [route.deploymentEnvironment, route.deploymentSetup, props.detail.environment.id,
    projection.interactionEnabled, destinations.length, open]);
  const finish = (content: React.ReactNode) => <>{content}
    <Item title={t('projects.deployments.backupNotNeededTitle')} mode="info" rightElement={
      <SectionActionButton testID={`${id}.notNeeded`} title={t('projects.deployments.backupNotNeededAction')}
        disabled={change.running} onPress={() => change.press(async () => {
          const result = await props.actions.configureBackup(props.detail.environment, { intent: 'markNotNeeded' });
          if (result.kind === 'notNeeded') props.onChanged();
          return { ok: true };
        })} />} />
    {change.outcome ? <DeployOutcomeBanner controller={change.banner}
      machine={props.machineName(props.detail.environment.controllerMachineId)} copy="setting" /> : null}</>;
  if (projection.phase === 'establishing') return finish(<Item testID={id} title={t('projects.deployments.loading')} mode="info" />);
  if (!destinations.length && projection.phase !== 'current') return finish(<Item testID={id}
    title={t('projects.deployments.settingsSections.setupTitle')} subtitle={t('projects.deployments.backupStatusUnavailable')} mode="info" />);
  if (!destinations.length) {
    const openStore = () => router.push(buildPluginsHomeRoute('app', { view: 'search', query: STORE_BACKUP_QUERY }));
    return finish(<Item testID={id} title={t('projects.deployments.settingsSections.setupTitle')}
      subtitle={t('projects.deployments.settingsSections.setupNoDestination')} onPress={openStore}
      rightElement={<SectionActionButton testID={`${id}.store`} title={t('projects.deployments.settingsSections.setupOpenStore')} onPress={openStore} />} />);
  }
  return finish(<Item testID={id} title={t('projects.deployments.settingsSections.setupTitle')}
    subtitle={t('projects.deployments.settingsSections.setupBody')} onPress={open}
    rightElement={<SectionActionButton testID={`${id}.start`} title={t('projects.deployments.settingsSections.setupStart')}
      icon="plus" disabled={change.running || !projection.interactionEnabled} onPress={open} />} />);
}

type PreviewDestinationIntent = NonNullable<Extract<DeploymentPreviewDataSelectionV1, { kind: 'template' }>['destinationBackup']>;
type BackupSetupCommonProps = Readonly<{
  detail: DeploymentEnvironmentReadDetailV1; destination: BackupDestination;
  destinations?: readonly BackupDestination[]; sourceChoices: readonly DeploymentBackupConfigurationV1['sources'][number][];
  defaults?: BackupDefaults; projection?: PluginUiProjectionModel | null; lifetime?: ServerAccountScopeLifetime;
  machine: string; testID: string;
}>;
type BackupSetupMode = Readonly<{
  mode?: 'configure'; review: DeploymentReviewHandle;
  configure: (draft: BackupConfigureDraft) => Promise<DeploymentBackupConfigureResultV1>;
  onConfigured?: (configuration: DeploymentBackupConfigurationV1, schedule: NonNullable<BackupDefaults['values']['backupSchedule']>) => Promise<void>;
  onChanged: () => void;
}> | Readonly<{ mode: 'intent'; initialIntent?: PreviewDestinationIntent; onIntent: (intent: PreviewDestinationIntent) => void }>;

/** One descriptor-driven draft: Configure applies it; preview authoring only returns intent. */
export function DeploymentBackupSetupSheet(props: BackupSetupCommonProps & BackupSetupMode & CustomModalInjectedProps) {
  const { onClose, setChrome } = props;
  const id = props.testID;
  const localize = usePluginLocalizedTextResolver({ projection: props.projection ?? null });
  const destinations = props.destinations ?? [props.destination];
  const intent = props.mode === 'intent' ? props : null;
  const configure = props.mode === 'intent' ? null : props.configure;
  const onChanged = props.mode === 'intent' ? noop : props.onChanged;
  const onConfigured = props.mode === 'intent' ? undefined : props.onConfigured;
  const preferred = intent?.initialIntent?.configuration.destinationRef ?? props.defaults?.values.backupDestination;
  const [destinationId, setDestinationId] = React.useState(() => destinations.find(entry => preferred
    && entry.pluginId === preferred.pluginId && entry.definition.id === preferred.localId)?.id ?? props.destination.id);
  const receiverDestination = destinations.find(entry => entry.pluginId === SFTP_BACKUP_DESTINATION_REF_V1.pluginId
    && entry.definition.id === SFTP_BACKUP_DESTINATION_REF_V1.localId);
  const anotherMachine = !intent && destinationId === 'anotherMachine' && receiverDestination !== undefined;
  const destination = anotherMachine ? receiverDestination : destinations.find(entry => entry.id === destinationId) ?? props.destination;
  const inputHints = React.useMemo(() => deriveActionInputHints(destination.definition.configSchema, destination.definition.fieldHints), [destination]);
  const [fields, setFields] = React.useState<Record<string, unknown>>(() => seedInputByFieldHints({ inputHints },
    intent?.initialIntent?.configuration.config ?? {}));
  const [destinationSetup, setDestinationSetup] = React.useState<DeploymentBackupAnotherMachineSetupV1>();
  const pathCapacity = useBackupPathCapacity(props.detail.environment.serverId,
    anotherMachine ? destinationSetup?.machineId
      : destination.definition.locality === 'local' ? deploymentDataTargetOperands(props.detail)?.machineId : undefined,
    anotherMachine ? destinationSetup?.receiverInputs.repositoryPath : fields.path, props.lifetime, !intent);
  const [sourceIds, setSourceIds] = React.useState(() => intent?.initialIntent?.configuration.sources.map(choice => choice.sourceId) ?? props.sourceChoices.map(choice => choice.sourceId));
  const [keep, setKeep] = React.useState(() => draftFrom(intent?.initialIntent?.configuration.retention ?? props.defaults?.values.backupRetention ?? { kind: 'keepEverything' }));
  const [bindings, setBindings] = React.useState<PreviewDestinationIntent['bindings']>(() => intent?.initialIntent?.bindings ?? []);
  const [prefix, setPrefix] = React.useState(() => intent?.initialIntent?.prefix ?? '');
  const serverId = props.lifetime?.scope.serverId ?? props.detail.environment.serverId;
  const machines = useMachineListForServer(serverId);
  // A receiver is set up by its installation: only Machines that report one can be chosen.
  const receiverMachines = React.useMemo(() => (machines ?? []).filter(machine => Boolean(machine.installationId)), [machines]);
  const receiverProjection = usePluginUiProjectionCurrentness({ serverId, machineId: destinationSetup?.machineId,
    enabled: anotherMachine && !!destinationSetup, sections: BACKUP_RECEIVER_SECTIONS });
  const receiverSetup = React.useMemo(() => MachineSetupV1Schema.parse({ items: [{ kind: 'setupRecipe',
    selection: { ref: BACKUP_RECEIVER_RECIPE_REF_V1, inputs: destinationSetup?.receiverInputs ?? {} } }] }),
  [destinationSetup?.receiverInputs]);
  const receiverInputState = React.useMemo(() => readMachineSetupRecipeInputState(receiverSetup,
    receiverProjection.pluginUiProjection, { suppliedInputKeys: BACKUP_RECEIVER_SUPPLIED_INPUTS }),
  [receiverSetup, receiverProjection.pluginUiProjection]);
  const [result, setResult] = React.useState<DeploymentBackupConfigureResultV1 | null>(null);
  const change = useDeploymentChangePress(props.mode === 'intent' ? null : props.review, noop);
  const scheduleChange = useDeploymentChangePress(props.mode === 'intent' ? null : props.review, noop);
  const retention = React.useMemo(() => retentionFromDraft(keep), [keep]);
  const config = React.useMemo(() => {
    const parsed = DeploymentBackupConfigurationV1Schema.shape.config.safeParse(
      Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)));
    return parsed.success ? parsed.data : null;
  }, [fields]);
  const sources = React.useMemo(() => props.sourceChoices.filter(entry => sourceIds.includes(entry.sourceId)), [props.sourceChoices, sourceIds]);
  const candidate = React.useMemo(() => !retention || !config || !sources.length ? null : DeploymentBackupConfigurationV1Schema.safeParse({
      configRevision: 1, destinationRef: { pluginId: destination.pluginId, localId: destination.definition.id },
      occurrenceId: destination.definition.id, config, sources,
      credentialBindings: bindings.map(({ purpose, configKey, role }) => ({ purpose, configKey, role })),
      ownership: { environmentId: props.detail.environment.id, prefix: '' }, retention }),
  [retention, config, sources, destination, bindings, props.detail.environment.id]);
  const prepared = React.useMemo(() => !candidate?.success ? null : prepareDeploymentBackupConfigurationV1({
    environmentId: props.detail.environment.id, configuration: candidate.data,
    destination: { ref: { pluginId: destination.pluginId, localId: destination.definition.id },
      occurrenceId: destination.definition.id, descriptor: destination.definition },
    bindings,
  }), [candidate, destination, bindings, props.detail.environment.id]);
  const configuration = anotherMachine ? destinationSetup && receiverProjection.interactionEnabled
    && receiverInputState.rows.length > 0 && receiverInputState.valid && candidate?.success ? candidate.data : null
    : prepared?.ok ? prepared.configuration : null;
  const complete = configuration !== null && (!intent || (prepared?.ok && prepared.bindingState === 'bound'));
  const busy = change.running || scheduleChange.running;
  const configured = result?.kind === 'configured';
  const locked = busy || configured;
  const chooseDestination = (next: string) => {
    const chosen = next === 'anotherMachine' ? receiverDestination : destinations.find(entry => entry.id === next);
    setDestinationId(next);
    // A provider preset is an editable S3 destination: its descriptor defaults seed the new draft.
    setFields(chosen ? seedInputByFieldHints({ inputHints: deriveActionInputHints(chosen.definition.configSchema,
      chosen.definition.fieldHints) }, {}) : {});
    setBindings([]); setDestinationSetup(undefined); setResult(null);
  };
  const submit = React.useCallback((intent: BackupConfigurePreparation['intent']) => {
    if (!configuration || !configure || busy || configured) return;
    void change.press(async () => {
      let next: DeploymentBackupConfigureResultV1;
      try { next = await configure({ intent, ...(destinationSetup ? { destinationSetup } : {}), configuration, backupBindings: bindings,
        explicit: { backupDestination: { pluginId: destination.pluginId, localId: destination.definition.id },
          backupRetention: configuration.retention, ...(props.defaults?.values.backupSchedule !== undefined
            ? { backupSchedule: props.defaults.values.backupSchedule } : {}) } });
      } catch (error) {
        const outcome = readDeploymentActionError(error);
        const details = outcome.kind === 'refused' ? outcome.failure?.details : undefined;
        if (details && typeof details === 'object' && !Array.isArray(details) && 'destinationSetup' in details) {
          const retained = DeploymentBackupAnotherMachineSetupV1Schema.safeParse(details.destinationSetup);
          if (retained.success) setDestinationSetup(retained.data);
        }
        throw error;
      }
      if ('destinationSetup' in next && next.destinationSetup) setDestinationSetup(next.destinationSetup);
      setResult(next);
      if (next.kind === 'configured') {
        onChanged();
        const schedule = props.defaults?.values.backupSchedule;
        if (schedule && onConfigured) {
          await scheduleChange.press(async () => {
            await onConfigured(next.configuration, schedule);
            onClose();
            return { ok: true };
          });
        } else onClose();
      }
      return { ok: true };
    });
  }, [configuration, configure, busy, configured, change.press, scheduleChange.press, props.defaults, onChanged, onConfigured,
    destination, bindings, destinationSetup, onClose]);
  const saveIntent = React.useCallback(() => {
    if (!intent || !complete || !configuration) return;
    const { ownership: _ownership, ...authored } = configuration;
    intent.onIntent({ configuration: authored, prefix, bindings });
    onClose();
  }, [intent, complete, configuration, prefix, bindings, onClose]);
  const chooseSecret = async (role: CredentialRole) => {
    if (!props.lifetime) return;
    const controller = new AbortController();
    const selection = await presentSavedSecretReferencePicker({ accountLifetime: props.lifetime, signal: controller.signal,
      isCurrent: () => props.lifetime?.isCurrent() === true });
    if (selection) { setBindings(current => [...current.filter(binding => binding.role !== role), {
      purpose: 'backupDestination', configKey: 'destination', role,
      source: { kind: 'secret', ref: selection.ref, resourceRevision: selection.resourceRevision } }]); setResult(null); }
  };
  const footer = React.useMemo(() => <ModalCardFooterActions cancel={{ onPress: onClose, testID: `${id}.cancel`, disabled: busy }}>
    {intent ? null : <SectionActionButton testID={`${id}.test`} title={t('projects.deployments.settingsSections.destinationTest')}
      disabled={!complete || locked} onPress={() => submit('test')} />}
    {intent ? null : <SectionActionButton testID={`${id}.initialize`} title={t('projects.deployments.settingsSections.setupInitializeAndSave')}
      disabled={!complete || locked} onPress={() => submit('initializeAndSave')} />}
    <RoundButton testID={`${id}.save`} size="normal" title={t('projects.deployments.settingsSections.setupSave')}
      disabled={!complete || locked} loading={busy} onPress={intent ? saveIntent : () => submit('save')} />
  </ModalCardFooterActions>, [onClose, id, busy, locked, complete, submit, intent, saveIntent]);
  const chrome = React.useMemo(() => ({ kind: 'card' as const, footer }), [footer]);
  useModalCardChrome(setChrome, chrome);
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  const configFields = resolveEffectiveInputFields({ inputHints }, fields);
  const refused = change.outcome?.kind === 'refused' ? change.outcome : null;
  return <ListPresentationProvider value="page" pageInsets="contained"><View testID={id} style={deploymentSheetStyles.body}>
    <Text style={deploymentSheetStyles.lead}>{intent ? t('projects.deployments.settingsSections.previewEditor.backupIntentBody')
      : t('projects.deployments.settingsSections.setupSheetLead', { machine: props.machine })}</Text>
    {intent ? <FieldItem label={t('projects.deployments.settingsSections.previewEditor.backupPrefix')}>
      <FieldTextInput testID={`${id}.prefix`} value={prefix} onChangeText={setPrefix}
        accessibilityLabel={t('projects.deployments.settingsSections.previewEditor.backupPrefix')} />
    </FieldItem> : null}
    {destinations.length > 1 || (!intent && receiverDestination) ? <FieldItem label={t('projects.deployments.settingsSections.setupDestination')}>
      <ValueFieldSelect testID={`${id}.destination`} label={t('projects.deployments.settingsSections.setupDestination')}
        items={[...destinations.map(entry => ({ id: entry.id, title: localize(entry.pluginId, entry.definition.title) })),
          ...(!intent && receiverDestination ? [{ id: 'anotherMachine', title: t('projects.deployments.settingsSections.setupAnotherMachine') }] : [])]}
        selectedId={destinationId} disabled={locked} onSelect={chooseDestination} fill /></FieldItem> : null}
    {destination.definition.locality === 'local' ? <Item mode="info" title={t('projects.deployments.settingsSections.setupLocalWarning')}
      subtitle={t('projects.deployments.settingsSections.setupLocalGrowth')} /> : null}
    {!result?.review?.capacity ? <BackupPathCapacityReview
      capacity={pathCapacity.capacity} machine={pathCapacity.machineName || props.machine} testID={id} /> : null}
    {anotherMachine ? <>
      <SessionMachineField serverId={serverId} testID={`${id}.receiver`} machines={receiverMachines}
        title={t('projects.deployments.settingsSections.setupReceiverMachine')}
        machineId={destinationSetup?.machineId ?? null} placeholder={t('projects.deployments.settingsSections.setupReceiverMachine')}
        awayMachinesChoosable disabled={locked} onSelectMachine={selected => {
          if (!selected.installationId) return;
          setDestinationSetup({ kind: 'anotherMachine', machineId: selected.id, expectedInstallationId: selected.installationId, receiverInputs: {} });
          setResult(null);
        }} />
      {destinationSetup && receiverProjection.interactionEnabled ? <MachineSetupRecipeInputs setup={receiverSetup}
        projection={receiverProjection.pluginUiProjection} scope={props.lifetime?.scope}
        suppliedInputKeys={BACKUP_RECEIVER_SUPPLIED_INPUTS} testID={`${id}.receiver.inputs`}
        onChange={setup => {
          const item = setup.items?.[0];
          if (item?.kind !== 'setupRecipe') return;
          const parsed = DeploymentBackupAnotherMachineSetupV1Schema.shape.receiverInputs.safeParse(item.selection.inputs);
          if (parsed.success) setDestinationSetup(current => current ? { ...current, receiverInputs: parsed.data } : current);
          setResult(null);
        }} /> : null}
    </> : <ActionInputFields fields={configFields} input={fields} editable={!locked} busy={busy}
      resolveFieldOptions={destinationFieldOptions} resolveFieldTestID={field => `${id}.${field.path}.input`}
      onPatch={patch => { setFields(current => ({ ...current, ...patch })); setResult(null); }} />}
    {props.sourceChoices.length ? <ItemGroup title={t('projects.deployments.backupSources')}>
      {props.sourceChoices.map(choice => <Item key={choice.sourceId} testID={`${id}.source.${choice.sourceId}`}
        title={choice.kind === 'dump' ? t('projects.deployments.backupSourceDump', { service: choice.service })
          : t('projects.deployments.backupSourceVolume', { service: choice.service, volume: choice.volume })}
        mode="info" rightElement={<Switch value={sourceIds.includes(choice.sourceId)} disabled={locked}
          onValueChange={include => { setSourceIds(current => include ? [...current, choice.sourceId]
            : current.filter(value => value !== choice.sourceId)); setResult(null); }} />} />)}
      </ItemGroup> : <Item title={t('projects.deployments.settingsSections.setupNoDatabaseTitle')}
        subtitle={t('projects.deployments.settingsSections.setupNoDatabaseBody')} mode="info" />}
    <ItemGroup title={t('projects.deployments.settingsSections.keepTitle')}>
      <Item title={retention?.kind === 'keepEverything' ? t('projects.deployments.backupKeepEverything')
        : t('projects.deployments.settingsSections.keepTitle')} subtitle={sourceWord(props.defaults?.sources.backupRetention)} mode="info" />
      {KEEP_FIELDS.map(field => <FieldValueItem key={field} testID={`${id}.keep.${field}`} fieldTestID={`${id}.keep.${field}.input`}
        title={t(`projects.deployments.settingsSections.${KEEP_LABEL[field]}`)} kind="integer" allowEmpty value={keep[field]}
        stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }} compactStepper disabled={locked}
        onDraftChange={text => setKeep(current => ({ ...current, [field]: text }))}
        onCommit={text => { setKeep(current => ({ ...current, [field]: text })); return text; }} />)}
    </ItemGroup>
    {!intent && props.defaults?.values.backupSchedule !== undefined ? <Item testID={`${id}.schedule`} mode="info"
      title={t('projects.deployments.settingsSections.scheduleTitle')}
      detail={props.defaults.values.backupSchedule ? formatAutomationScheduleLabel({ schedule: props.defaults.values.backupSchedule })
        : t('projects.deployments.settingsSections.scheduleOff')}
      subtitle={sourceWord(props.defaults.sources.backupSchedule)} /> : null}
    {anotherMachine ? null : <ItemGroup header="none">{destination.definition.credentialRoles.map(({ role, optional }) => <Item key={role}
      testID={`${id}.role.${role}`} title={t(`projects.deployments.settingsSections.${CREDENTIAL_LABEL[role] ?? 'credentialRepositoryPassword'}`)}
      subtitle={bindings.some(binding => binding.role === role) || (!intent && props.detail.content.bindings.some(binding => binding.purpose === 'backupDestination' && binding.role === role))
        ? t('projects.deployments.settingsSections.credentialSet') : t(`projects.deployments.settingsSections.${optional ? 'setupRoleOptional' : 'setupRoleRequired'}`)}
      mode="info" rightElement={props.lifetime ? <SectionActionButton testID={`${id}.role.${role}.choose`}
        title={t('projects.deployments.settingsSections.credentialChoose')} disabled={locked} onPress={() => { void chooseSecret(role); }} /> : undefined} />)}</ItemGroup>}
    <DeploymentBackupConfigurationResult result={result} machine={pathCapacity.machineName || props.machine} testID={id}
      capacity={result?.review?.capacity ? pathCapacity.capacity : undefined} />
    {refused ? <SurfaceStateCard testID={`${id}.refused`} size="line" kind="error" title={t('projects.deployments.addRefused')}
      reason={deploymentActionRefusalRemedy(refused.code)} diagnosticCode={refused.code} /> : null}
    {scheduleChange.outcome && props.mode !== 'intent' ? <DeployOutcomeBanner controller={scheduleChange.banner}
      machine={props.machine} copy="setting" /> : null}
    {setChrome ? null : footer}
  </View></ListPresentationProvider>;
}

/** The typed Configure result is shared by first setup and edits of a saved configuration. */
export function DeploymentBackupConfigurationResult(props: Readonly<{
  result: DeploymentBackupConfigureResultV1 | null; machine: string; testID: string; capacity?: StoragePathCapacityV1;
}>) {
  const { result } = props;
  const id = props.testID;
  const capacity = props.capacity ?? result?.review?.capacity;
  return <>
    {capacity ? <BackupPathCapacityReview capacity={capacity} machine={props.machine} testID={id} /> : null}
    {result?.kind === 'tested' ? <Item testID={`${id}.tested`} title={testOutcome(result.test).line} mode="info" /> : null}
    {result?.kind === 'needsBinding' ? <Item testID={`${id}.needsBinding`} title={t('projects.deployments.settingsSections.credentialMissing')}
      subtitle={result.missingRoles.join(', ')} mode="info" /> : null}
    {result?.kind === 'setupIncomplete' ? <SurfaceStateCard testID={`${id}.setupIncomplete`} kind="error" size="line"
      title={t('projects.deployments.settingsSections.setupIncomplete')} diagnosticCode={result.errorCode} /> : null}
  </>;
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
      {change.outcome && props.review ? <DeployOutcomeBanner controller={change.banner}
        machine={props.machineName(props.detail.environment.controllerMachineId)} copy="setting" /> : null}
    </>
  );
}

/** The starter editor owns destination/check selection, grants and scheduling; opening it has no effects. */
/** The restore-drill door: one per surface, placed by the page that composes the backup rows. */
export function DeploymentRestoreDrillRow(props: Readonly<{ serverId: string; testID: string }>) {
  const router = useRouter();
  const starter = getWorkflowStarterExamplesV1().find(example => example.key === 'restore-drill');
  if (!starter) return null;
  return <Item title={t(starter.titleKey)} subtitle={t(starter.descriptionKey)} mode="info"
    rightElement={<SectionActionButton testID={props.testID} title={t('common.open')}
      onPress={() => router.push({ pathname: WORKFLOWS_NEW_ROUTE,
        params: { example: starter.key, serverId: props.serverId } })} />} />;
}

/**
 * Backup schedules for the stable Environment, read and added through the trigger owner.
 */
export function DeploymentBackupScheduleRow(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  configuration: DeploymentBackupConfigurationV1;
  actions: ActionsFactory | null;
  testID: string;
}>) {
  const { actions } = props;
  const [sets, setSets] = React.useState<Awaited<ReturnType<ActionsFactory['backupScheduleSets']>> | null>(null);
  const [failure, setFailure] = React.useState<Readonly<{ reason: string; code: string | null; detail: string | null }> | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [reads, setReads] = React.useState(0);
  // The page's one failure presenter: its reason leads, the code and request id stay in Details for support.
  const showFailure = (error: unknown) => {
    const outcome = readDeploymentActionError(error);
    const requestId = error instanceof HappyError ? error.requestId : undefined;
    const code = outcome.kind === 'refused' ? outcome.code : null;
    const presented = code ? presentActionFailureOutcome({ ...(outcome.kind === 'refused' && outcome.failure
      ? outcome.failure : { ok: false as const, errorCode: code, error: code }), ...(requestId ? { requestId } : {}) }, 'deployment') : null;
    setFailure({ reason: presented?.reason ?? t('common.error'), code: presented?.code ?? code,
      detail: presented?.technicalDetails.filter(line => line.key !== 'failure-code').map(line => `${line.label}: ${line.value}`).join('\n') || null });
  };
  const environmentId = props.detail.environment.id;
  React.useEffect(() => {
    if (!actions) return;
    let live = true;
    actions.backupScheduleSets({ environmentId }).then((next) => {
      if (live) { setSets(next); setFailure(null); }
    }, (error) => {
      if (live) { setSets(null); showFailure(error); }
    });
    return () => { live = false; };
  }, [actions, environmentId, reads]);
  const turnOn = async () => {
    if (!actions || adding) return;
    setAdding(true);
    try {
      const starter = getWorkflowStarterExamplesV1().find(example => example.key === 'nightly-backups');
      if (starter?.triggerSeed?.kind !== 'schedule') throw new Error('workflow_starter_unavailable');
      const result = await actions.addBackupSchedule({ environmentId, configuration: props.configuration, schedule: starter.triggerSeed.schedule,
        controllerMachineId: props.detail.environment.controllerMachineId });
      setSets(current => [...(current ?? []), result.set]);
      setFailure(null);
    } catch (error) { showFailure(error); }
    finally { setAdding(false); }
  };
  const schedules = sets?.flatMap(set => set.triggers.flatMap(trigger => trigger.kind === 'schedule' && trigger.enabled
    ? [formatAutomationScheduleLabel(trigger)] : []));
  const status = schedules === undefined ? t('common.unavailable') : schedules.length > 0
    ? schedules.join(' · ') : t('projects.deployments.settingsSections.scheduleOff');
  return (
    <>
    <Item
      testID={`${props.testID}.schedule`}
      title={t('projects.deployments.settingsSections.scheduleTitle')}
      subtitle={status}
      mode="info"
      rightElement={actions && schedules?.length === 0 ? (
        <SectionActionButton testID={`${props.testID}.schedule.on`}
          title={t('projects.deployments.settingsSections.scheduleTurnOn')} disabled={adding} onPress={turnOn} />
      ) : undefined}
    />
    {failure ? <SurfaceStateCard testID={`${props.testID}.schedule.failed`} size="line" kind="error" title={failure.reason}
      diagnosticCode={failure.code} diagnosticDetail={failure.detail}
      action={{ label: t('common.retry'), onPress: () => setReads(count => count + 1) }} /> : null}
    {/* Environment Settings' one restore-drill door (VISUAL-136 E3: Backup controls no longer draw a second one). */}
    <DeploymentRestoreDrillRow serverId={props.detail.environment.serverId} testID={`${props.testID}.drill`} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 },
}));
