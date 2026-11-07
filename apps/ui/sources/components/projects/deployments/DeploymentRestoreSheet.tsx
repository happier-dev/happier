import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol';
import {
  readDeploymentRestoreStepProgressV1,
  type DeploymentRestoreStepV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { randomUUID } from '@/platform/randomUUID';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

import type { DeploymentUiRestoreInput } from './deploymentActions';
import { readDeploymentActionError } from './deploymentActionOutcome';
import {
  isDeploymentRestoreCheckStale,
  readDeploymentRestorePreparation,
  type DeploymentRestoreOperands,
  type DeploymentRestorePreparation,
  type DeploymentRetainedBackup,
} from './deploymentRestore';

export type DeploymentRestoreSheetInput = Readonly<{
  /** The Environment whose data is replaced, by name. */
  name: string;
  /** Where the restore runs, by name. */
  machine: string;
  /** The backup to restore; with `loadChoices` it is the person's pick instead. */
  backup?: DeploymentRetainedBackup;
  operands?: DeploymentRestoreOperands;
  /**
   * One step through the restore Action; the sheet is its designed confirmation. The request id names the
   * Action operation whose pushed phases the sheet shows while the restore runs.
   */
  restore: (
    input: DeploymentUiRestoreInput,
    operation?: Readonly<{ actionRequestId: string }>,
  ) => Promise<DeploymentBackupRestoreResultV1>;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
  /**
   * The restore points to choose from, read when the sheet opens. Without it the sheet restores `backup`.
   * A point the restore Action can't admit yet is listed but not selectable.
   */
  loadChoices?: (signal: AbortSignal) => Promise<readonly DeploymentRestoreChoice[]>;
}>;

/** One backup the person can pick; `restore` is null when the restore Action can't restore it yet. */
export type DeploymentRestoreChoice = Readonly<{
  snapshotId: string;
  takenAtMs: number;
  kind: 'beforeMigration' | 'scheduled';
  restore: Readonly<{ backup: DeploymentRetainedBackup; operands: DeploymentRestoreOperands }> | null;
}>;
type Choices =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; choices: readonly DeploymentRestoreChoice[] }>
  | Readonly<{ status: 'failed' }>;

type Settled = Exclude<DeploymentBackupRestoreResultV1, { kind: 'prepared' }>;
type Step =
  | Readonly<{ kind: 'choose' }>
  | Readonly<{ kind: 'check' }>
  | Readonly<{ kind: 'prepared'; preparation: DeploymentRestorePreparation }>
  | Readonly<{ kind: 'settled'; result: Settled }>;
type Refusal = Readonly<{ code: string; stale: boolean }>;
type RestoreStep = DeploymentRestoreStepV1;

const STEP_ORDER: readonly RestoreStep['id'][] = ['safety', 'stop', 'restore', 'start', 'health'];
const STEP_LABEL = {
  safety: 'projects.deployments.restoreStepSafety',
  stop: 'projects.deployments.restoreStepStop',
  restore: 'projects.deployments.restoreStepRestore',
  start: 'projects.deployments.restoreStepStart',
  health: 'projects.deployments.restoreStepHealth',
} as const satisfies Record<RestoreStep['id'], string>;
const STATUS_LABEL = {
  running: 'projects.deployments.restoreStepRunning',
  completed: 'projects.deployments.restoreStepCompleted',
  failed: 'projects.deployments.restoreStepFailed',
  skipped: 'projects.deployments.restoreStepSkipped',
} as const satisfies Record<RestoreStep['status'], string>;

/** One row per step the native owner reported, in the restore's own order; a later fact replaces an earlier one. */
function mergeRestoreStep(steps: readonly RestoreStep[], step: RestoreStep): readonly RestoreStep[] {
  const current = steps.find((candidate) => candidate.id === step.id);
  if (current?.status === step.status) return steps;
  return STEP_ORDER.flatMap((id) => {
    if (id === step.id) return [step];
    const kept = steps.find((candidate) => candidate.id === id);
    return kept ? [kept] : [];
  });
}

/**
 * The phases the running restore pushes on its existing Action operation, found by the request id the confirm
 * press issued. Nothing is read or polled; the store is fed by the operation subscription the app already holds.
 */
function observeRestoreSteps(requestId: string, onStep: (step: RestoreStep) => void): () => void {
  const read = () => {
    for (const operation of actionOperationStore.getSnapshot().operationsByKey.values()) {
      const snapshot = operation.snapshot;
      if (snapshot.requestId !== requestId || snapshot.actionId !== 'deployments.backups.restore') continue;
      const step = readDeploymentRestoreStepProgressV1(
        snapshot.progress?.kind === 'phase' ? snapshot.progress.phase : undefined,
      );
      if (step) onStep(step);
      return;
    }
  };
  read();
  return actionOperationStore.subscribe(read);
}

function backupLabel(
  backup: Pick<DeploymentRetainedBackup, 'versionLabel'>,
  takenAtMs: number | null,
): string {
  const time = takenAtMs === null ? null : formatAsOfTime(takenAtMs);
  if (backup.versionLabel && time)
    return t('projects.deployments.restoreBackupBefore', {
      version: backup.versionLabel,
      time,
    });
  if (time) return t('projects.deployments.restoreBackupTaken', { time });
  return backup.versionLabel
    ? t('projects.deployments.restoreBackupBeforeVersion', {
        version: backup.versionLabel,
      })
    : t('projects.deployments.restoreBackupRetained');
}

/**
 * Restore a backup (L3B public restore): replace one Environment's database with a backup a deploy kept before
 * its migration. Two presses, each one Action step: Check backup verifies it and saves the current data first,
 * so nothing is replaced yet; Replace data then applies exactly that check. The running code never changes.
 */
function DeploymentRestoreSheet(
  props: DeploymentRestoreSheetInput & CustomModalInjectedProps,
) {
  const [step, setStep] = React.useState<Step>({ kind: props.loadChoices ? 'choose' : 'check' });
  const [target, setTarget] = React.useState<Readonly<{ backup: DeploymentRetainedBackup; operands: DeploymentRestoreOperands }> | null>(
    props.backup && props.operands ? { backup: props.backup, operands: props.operands } : null);
  const [choices, setChoices] = React.useState<Choices>({ status: 'loading' });
  const [choicesGeneration, setChoicesGeneration] = React.useState(0);
  const { loadChoices } = props;
  // Opening the sheet is the demand: one read of the restore points, again only on Retry.
  React.useEffect(() => {
    if (!loadChoices) return;
    const controller = new AbortController();
    setChoices({ status: 'loading' });
    loadChoices(controller.signal).then(
      (loaded) => { if (!controller.signal.aborted) setChoices({ status: 'ready', choices: loaded }); },
      () => { if (!controller.signal.aborted) setChoices({ status: 'failed' }); },
    );
    return () => controller.abort();
  }, [loadChoices, choicesGeneration]);
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const [steps, setSteps] = React.useState<readonly RestoreStep[]>([]);
  const stopObserving = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stopObserving.current?.(), []);
  const { onClose, onApproval, restore } = props;

  const run = async (input: DeploymentUiRestoreInput) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const actionRequestId = randomUUID();
    if (input.mode === 'confirm') {
      setSteps([]);
      stopObserving.current = observeRestoreSteps(actionRequestId, (step) =>
        setSteps((current) => mergeRestoreStep(current, step)));
    }
    try {
      const result = await restore(input, { actionRequestId });
      // The settled result's steps are the owner's final word over any pushed phase.
      if (result.kind !== 'prepared' && result.steps) setSteps(result.steps.reduce(mergeRestoreStep, [] as readonly RestoreStep[]));
      if (result.kind === 'prepared') {
        const preparation = readDeploymentRestorePreparation(result);
        if (preparation) setStep({ kind: 'prepared', preparation });
        else setRefusal({ code: 'restore_prepare_required', stale: true });
      } else setStep({ kind: 'settled', result });
    } catch (error) {
      const outcome = readDeploymentActionError(error);
      if (outcome.kind === 'approval') {
        onClose();
        onApproval(outcome.artifactId);
        return;
      }
      if (outcome.kind === 'refused') {
        const stale = isDeploymentRestoreCheckStale(outcome.code);
        // A check that is no longer current cannot be confirmed; the person checks again.
        if (stale) setStep({ kind: 'check' });
        setRefusal({ code: outcome.code, stale });
      }
    } finally {
      stopObserving.current?.();
      stopObserving.current = null;
      setBusy(false);
    }
  };
  const check = () => target ? run({ ...target.operands, mode: 'prepare' }) : Promise.resolve();
  const replace = () =>
    step.kind === 'prepared' && target
      ? run({
          ...target.operands,
          mode: 'confirm',
          prepareOperationId: step.preparation.prepareOperationId,
        })
      : Promise.resolve();

  const footer =
    step.kind === 'settled' ? (
      <ModalCardFooterActions>
        <RoundButton
          testID="project-deployments.restore.done"
          size="normal"
          title={t('common.done')}
          onPress={onClose}
        />
      </ModalCardFooterActions>
    ) : (
      <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.restore.cancel', disabled: busy }}>
        {step.kind === 'choose' ? null : step.kind === 'prepared' ? (
          <RoundButton
            testID="project-deployments.restore.confirm"
            size="normal"
            display="destructive"
            loading={busy}
            disabled={busy}
            title={t('projects.deployments.restoreConfirm')}
            onPress={() => {
              void replace();
            }}
          />
        ) : (
          <RoundButton
            testID="project-deployments.restore.check"
            size="normal"
            loading={busy}
            disabled={busy}
            title={t('projects.deployments.restoreCheck')}
            onPress={() => {
              void check();
            }}
          />
        )}
      </ModalCardFooterActions>
    );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  const preparation = step.kind === 'prepared' ? step.preparation : null;
  // Every step after Choose holds a chosen backup; an unchosen sheet only ever shows Choose.
  const backup = target?.backup ?? null;
  const takenAtMs = preparation?.takenAtMs ?? backup?.takenAtMs ?? null;
  const database = preparation ?? backup;
  const facts: Array<Readonly<{ key: string; label: string; value: string }>> =
    !backup || !database ? [] : [
      {
        key: 'backup',
        label: t('projects.deployments.restoreBackup'),
        value: backupLabel(backup, takenAtMs),
      },
      {
        key: 'database',
        label: t('projects.deployments.restoreDatabase'),
        value: t('projects.deployments.restoreDatabaseValue', {
          service: database.service,
          database: database.database,
        }),
      },
      {
        key: 'machine',
        label: t('projects.deployments.machine'),
        value: props.machine,
      },
      ...(preparation
        ? [
            {
              key: 'safety',
              label: t('projects.deployments.restoreSafety'),
              value: preparation.safetyBackup
                ? preparation.safetyBackup.savedAtMs === null
                  ? t('projects.deployments.restoreSafetySavedNow')
                  : t('projects.deployments.restoreSafetySaved', {
                      time: formatAsOfTime(preparation.safetyBackup.savedAtMs),
                    })
                : t('projects.deployments.restoreSafetyNotNeeded'),
            },
          ]
        : []),
    ];

  const stepRows = steps.length > 0 ? (
    <ItemGroup testID="project-deployments.restore.steps" title={t('projects.deployments.restoreStepsTitle')}>
      {steps.map((entry) => (
        <Item
          key={entry.id}
          testID={`project-deployments.restore.step.${entry.id}`}
          title={t(STEP_LABEL[entry.id])}
          detail={t(STATUS_LABEL[entry.status])}
          mode="info"
        />
      ))}
    </ItemGroup>
  ) : null;

  if (step.kind === 'choose') {
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.restore" style={deploymentSheetStyles.body}>
          <Text style={deploymentSheetStyles.lead}>{t('projects.deployments.restoreChooseLead', { name: props.name })}</Text>
          <ItemGroup testID="project-deployments.restore.choices" title={t('projects.deployments.restoreChooseTitle')}>
            {choices.status === 'loading' ? (
              <SurfaceStateCard testID="project-deployments.restore.choices.loading" size="line" kind="loading"
                title={t('projects.deployments.loading')} />
            ) : choices.status === 'failed' ? (
              <SurfaceStateCard testID="project-deployments.restore.choices.failed" size="line" kind="error"
                title={t('projects.deployments.restoreChooseFailed')}
                action={{ label: t('common.retry'), onPress: () => setChoicesGeneration((value) => value + 1) }} />
            ) : choices.choices.length === 0 ? (
              <SurfaceStateCard testID="project-deployments.restore.choices.empty" size="line" kind="empty"
                title={t('projects.deployments.databaseRestoreNone')} />
            ) : choices.choices.map((choice) => {
              const kind = choice.kind === 'beforeMigration'
                ? t('projects.deployments.restorePointBeforeMigration') : t('projects.deployments.restorePointScheduled');
              const chosen = choice.restore;
              return (
                <Item
                  key={choice.snapshotId}
                  testID={`project-deployments.restore.choice.${choice.snapshotId}`}
                  title={formatAsOfTime(choice.takenAtMs)}
                  subtitle={chosen ? kind : t('projects.deployments.restorePointNotYet', { kind })}
                  disabled={!chosen}
                  {...(chosen ? { onPress: () => { setTarget(chosen); setStep({ kind: 'check' }); } } : { mode: 'info' as const })}
                />
              );
            })}
          </ItemGroup>
          {setChrome ? null : footer}
        </View>
      </ListPresentationProvider>
    );
  }

  if (step.kind === 'settled') {
    const { result } = step;
    const restored = result.kind === 'restored';
    return (
      <ListPresentationProvider value="page" pageInsets="contained">
        <View testID="project-deployments.restore" style={deploymentSheetStyles.body}>
          <SurfaceStateCard
            testID={`project-deployments.restore.result.${result.kind}`}
            size="details"
            layout="inline"
            kind={
              restored
                ? 'success'
                : result.kind === 'rolledBack'
                  ? 'warning'
                  : 'error'
            }
            title={
              restored
                ? t('projects.deployments.restoreRestored', {
                    name: props.name,
                  })
                : result.kind === 'rolledBack'
                  ? t('projects.deployments.restoreRolledBack')
                  : result.kind === 'outcome_unknown'
                    ? t('projects.deployments.restoreUnknown')
                    : t('projects.deployments.restoreRecoveryRequired')
            }
            reason={t('projects.deployments.restoreCodeUnchanged')}
          />
          {stepRows}
          {setChrome ? null : footer}
        </View>
      </ListPresentationProvider>
    );
  }

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.restore" style={deploymentSheetStyles.body}>
        <Text style={deploymentSheetStyles.lead}>
          {preparation
            ? preparation.safetyBackup
              ? t('projects.deployments.restoreReadyLead', { name: props.name })
              : t('projects.deployments.restoreReadyLeadEmpty', {
                  name: props.name,
                })
            : t('projects.deployments.restoreLead', { name: props.name })}
        </Text>
        <ItemGroup testID="project-deployments.restore.facts" header="none">
          {facts.map((fact) => (
            <Item
              key={fact.key}
              testID={`project-deployments.restore.fact.${fact.key}`}
              title={fact.label}
              subtitle={fact.value}
              subtitleLines={0}
              mode="info"
            />
          ))}
        </ItemGroup>
        {stepRows}
        {refusal ? (
          <SurfaceStateCard
            testID="project-deployments.restore.refused"
            size="line"
            kind="error"
            title={
              refusal.stale
                ? t('projects.deployments.restoreCheckAgain')
                : refusal.code === 'backup_required'
                  ? t('projects.deployments.restoreBackupUnusable')
                  : t('projects.deployments.restoreRefused')
            }
            diagnosticCode={refusal.code}
          />
        ) : null}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentRestoreSheet(
  input: DeploymentRestoreSheetInput,
): void {
  showDeploymentSheet({
    component: DeploymentRestoreSheet,
    props: input,
    title: t('projects.deployments.restoreTitle'),
    testID: 'project-deployments.restore.modal',
    closeOnBackdrop: false,
  });
}
