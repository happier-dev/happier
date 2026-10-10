import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import {
  readLocalDaemonSharedState,
  subscribeLocalDaemonSharedState,
} from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetPickerRows,
  type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { t } from '@/text';

export type ManagedControllerScope = Readonly<{
  /** The machine whose installation runs provider calls: the person's choice, else the preselected default. */
  controller: ManagedControllerV1 | undefined;
  /** The chosen machine's record, for its name and presence. */
  machine: Machine | undefined;
  /** Whether any machine in this Home can manage machines at all. */
  hasCandidates: boolean;
  /** The canonical machine-scope chip, for the page header (or the section that owns the scope). */
  chip: React.ReactElement | null;
}>;

/**
 * "Managed from": which of this Home's machines with an installation runs a provisioner's calls
 * (lab `m-add` / `m-config`). It is shown through the canonical header chip
 * (`MachineAdministrationTargetSelector presentation="chip"`), offering only machines that can manage,
 * and starts on a sensible machine so the first frame is the catalog: this computer when it can
 * manage, else the first online candidate, else the first candidate. The choice is page-local, as the
 * draft it scopes is.
 */
/** A machine that can run provider calls for this Home: it has an installation and is not revoked. */
export function isManagedControllerCandidate(machine: Machine): boolean {
  return !!machine.installationId && !machine.revokedAt;
}

export function useManagedControllerScope(
  input: Readonly<{
    serverId: string;
    /** A machine the page already names (a preset's controller, the picker's handoff), used until the person picks. */
    preferred?: ManagedControllerV1;
    disabled?: boolean;
    onSelect?: (controller: ManagedControllerV1) => void;
    testIDPrefix: string;
  }>,
): ManagedControllerScope {
  const machines = useMachineListForServer(input.serverId);
  const rows = useMachineAdministrationTargetPickerRows();
  const thisMachineId = useThisComputerMachineId();
  const [chosen, setChosen] = React.useState<ManagedControllerV1 | undefined>();
  const { onSelect } = input;

  const eligible = React.useMemo(
    () =>
      (machines ?? []).filter(isManagedControllerCandidate),
    [machines],
  );
  const scopedRows = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          areServerProfileIdentifiersEquivalent(row.serverId, input.serverId) &&
          eligible.some(
            (machine) => machine.id === row.candidate.target.machineId,
          ),
      ),
    [eligible, input.serverId, rows],
  );
  // Kept identity-stable by its ids: presence updates must not restart the reads it scopes.
  const preferredMachineId = input.preferred?.machineId;
  const preferredInstallationId = input.preferred?.installationId;
  const preferred = React.useMemo(() => {
    const named = (candidate: ManagedControllerV1 | undefined) =>
      candidate &&
      eligible.find(
        (machine) =>
          machine.id === candidate.machineId &&
          machine.installationId === candidate.installationId,
      );
    const machine =
      named(chosen) ||
      named(
        preferredMachineId && preferredInstallationId
          ? { machineId: preferredMachineId, installationId: preferredInstallationId }
          : undefined,
      ) ||
      eligible.find((candidate) => candidate.id === thisMachineId) ||
      eligible.find((candidate) =>
        scopedRows.some(
          (row) =>
            row.candidate.target.machineId === candidate.id &&
            row.candidate.availability === 'online',
        ),
      ) ||
      eligible[0];
    return machine?.installationId
      ? { machineId: machine.id, installationId: machine.installationId }
      : undefined;
  }, [chosen, eligible, preferredInstallationId, preferredMachineId, scopedRows, thisMachineId]);
  const controllerMachineId = preferred?.machineId;
  const controllerInstallationId = preferred?.installationId;
  const controller = React.useMemo(
    (): ManagedControllerV1 | undefined =>
      controllerMachineId && controllerInstallationId
        ? { machineId: controllerMachineId, installationId: controllerInstallationId }
        : undefined,
    [controllerMachineId, controllerInstallationId],
  );

  const selection =
    React.useMemo((): MachineAdministrationTargetSelectionV1 => {
      const candidates = scopedRows.map((row) => row.candidate);
      const selectedTarget =
        scopedRows.find(
          (row) => row.candidate.target.machineId === controller?.machineId,
        )?.candidate.target ?? null;
      return {
        candidates,
        pickerRows: scopedRows,
        state: resolveMachineAdministrationTargetState({
          storedTarget: selectedTarget,
          candidates,
          allowSoleCandidate: false,
        }),
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: true,
        canExecute: false,
        selectTarget: (target) => {
          const machine = eligible.find(
            (candidate) => candidate.id === target.machineId,
          );
          if (!machine?.installationId) return;
          const next = {
            machineId: machine.id,
            installationId: machine.installationId,
          };
          setChosen(next);
          onSelect?.(next);
        },
        clearTarget: () => {},
        resolveExecutionTarget: () => null,
      };
    }, [controller?.machineId, eligible, onSelect, scopedRows]);

  const chip =
    scopedRows.length > 0 ? (
      <MachineAdministrationTargetSelector
        presentation="chip"
        selection={selection}
        groupTitle={t('managedMachines.config.managedFrom')}
        disabled={input.disabled}
        testIDPrefix={input.testIDPrefix}
      />
    ) : null;
  return {
    controller,
    machine: eligible.find((machine) => machine.id === controller?.machineId),
    hasCandidates: eligible.length > 0,
    chip,
  };
}

/** This computer's machine id, from the one shared local daemon status (no read of its own). */
function useThisComputerMachineId(): string | null {
  const runner = getSystemTasksRunner();
  const subscribe = React.useCallback(
    (listener: () => void) => subscribeLocalDaemonSharedState(runner, listener),
    [runner],
  );
  const read = React.useCallback(
    () => readLocalDaemonSharedState<LocalDaemonStatusData>(runner),
    [runner],
  );
  return (
    React.useSyncExternalStore(subscribe, read, read).status?.machineId ?? null
  );
}
