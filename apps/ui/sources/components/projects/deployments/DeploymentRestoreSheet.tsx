import * as React from 'react';
import { View } from 'react-native';
import type { DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol';

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
  backup: DeploymentRetainedBackup;
  operands: DeploymentRestoreOperands;
  /** One step through the restore Action; the sheet is its designed confirmation. */
  restore: (
    input: DeploymentUiRestoreInput,
  ) => Promise<DeploymentBackupRestoreResultV1>;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
}>;

type Settled = Exclude<DeploymentBackupRestoreResultV1, { kind: 'prepared' }>;
type Step =
  | Readonly<{ kind: 'check' }>
  | Readonly<{ kind: 'prepared'; preparation: DeploymentRestorePreparation }>
  | Readonly<{ kind: 'settled'; result: Settled }>;
type Refusal = Readonly<{ code: string; stale: boolean }>;

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
  const [step, setStep] = React.useState<Step>({ kind: 'check' });
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const { onClose, onApproval, restore, operands, backup } = props;

  const run = async (input: DeploymentUiRestoreInput) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await restore(input);
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
      setBusy(false);
    }
  };
  const check = () => run({ ...operands, mode: 'prepare' });
  const replace = () =>
    step.kind === 'prepared'
      ? run({
          ...operands,
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
        {step.kind === 'prepared' ? (
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
  const takenAtMs = preparation?.takenAtMs ?? backup.takenAtMs;
  const database = preparation ?? backup;
  const facts: Array<Readonly<{ key: string; label: string; value: string }>> =
    [
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
