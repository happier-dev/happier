import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { resolveManagedMachineWakeStateV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { isOwnComputerDefaultCandidate } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { isMachineAdministrationCandidateExplicitlySelectable, machineAdministrationTargetsEqual, resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetRows,
  resolveFreshMachineAdministrationExecutionTarget,
  doesMachineAdministrationTargetMatchActiveAccount,
  type MachineAdministrationTargetSelectionV1,
  type MachineAdministrationExecutionTargetOptions,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage, useActiveServerAccountScope, useSetting, useMachineListForServer, useMachineListForServerSelection, useServerScopedMachine } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readMachineAdministrationTargetPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import { rememberMachineAdministrationTargetObservation, useMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { readMachineRequestReachabilityObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { useAdmittedManagedMachineAbsentEnrolledIds, useManagedMachineInventory } from './useManagedMachineInventory';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';

export type ManagedControllerScope = Readonly<{
  /** The machine whose installation runs provider calls: the person's choice, else the preselected default. */
  controller: ManagedControllerV1 | undefined;
  /** The chosen machine's record, for its name and presence. */
  machine: Machine | undefined;
  /** Whether this Home has installed controller identities to show, including unavailable choices. */
  hasCandidates: boolean;
  /** Something in the chooser is online: nothing chosen yet is then a choice to make, not an outage. */
  hasOnlineCandidate: boolean;
  /** The chosen machine's pushed presence says it is offline: what it runs can't be created until it is back. */
  controllerOffline: boolean;
  /**
   * Whether this Home's machine list has been read: an empty `hasCandidates` before that is not
   * "no machine can manage", and `unavailable` is a list that could not be read (retry re-reads it).
   */
  machineList: 'settled' | 'loading' | 'unavailable';
  /** The canonical machine-scope chip, for the page header (or the section that owns the scope). */
  chip: React.ReactElement | null;
  /** The same chosen controller, revalidated by the Administration execution owner. */
  selection?: MachineAdministrationTargetSelectionV1;
}>;

/**
 * "Managed from": which of this Home's machines with an installation runs a provisioner's calls
 * (lab `m-add` / `m-config`). It is shown through the canonical header chip
 * (`MachineAdministrationTargetSelector presentation="chip"`), offering only machines that can manage,
 * and starts on an online controller admitted by the Action protocol, preferring held installed
 * provisioners and the person's last own-computer choice. Managed guests require a configured default or explicit selection;
 * their presence in this Home is not an invitation to use them as a controller. The choice is page-local, as the
 * draft it scopes is.
 */
/** Installed controllers, including asleep ones, but never retired identities. */
export function isManagedControllerCandidate(machine: Machine): boolean {
  return !!machine.installationId && !machine.revokedAt && !isMachineReplaced(machine);
}

function readControllerIds(machines: readonly Machine[]): string {
  return JSON.stringify(machines.filter(isManagedControllerCandidate).map(machine => machine.id));
}

/** Provisioner calls use the same operation protocol required by external Action admission. */
function supportsManagedControllerActions(machine: Machine): boolean {
  return typeof machine.operationProtocolCapabilitiesRevision === 'number' && machine.operationProtocolCapabilitiesRevision >= 1
    && supportsMachineOperationProtocolCapabilityV1(machine.operationProtocolCapabilities, 'externalActionExecutionAuthorization');
}

export function useManagedControllerScope(
  input: Readonly<{
    serverId: string;
    /** A machine the page already names (a preset's controller, the picker's handoff), used until the person picks. */
    preferred?: ManagedControllerV1;
    /** Exact preset authority fixes the controller without granting a Machine picker. */
    delegatedPreset?: boolean;
    /** Acquisition may prefer this device; recipe authoring does not demand its native task runner. */
    observeThisComputer?: boolean;
    disabled?: boolean;
    onSelect?: (controller: ManagedControllerV1) => void;
    testIDPrefix: string;
  }>,
): ManagedControllerScope {
  const listSettled = useIsMachineListSettled(input.serverId);
  const listStatus = useMachineListStatusForServer(input.serverId);
  const activeAccountScope = useActiveServerAccountScope();
  const { binding } = useServerCredentialAccountScopeBinding(input.serverId);
  const thisMachineId = useThisComputerMachineId(undefined, input.observeThisComputer !== false);
  const preferences = useSetting('machineAdministrationTargetsLocalV1');
  const settingsScope = useAccountSettingsScope();
  const observationScope = binding?.isCurrent() ? binding.scope : null;
  const lastPickedTarget = useMachineAdministrationTargetObservation(observationScope, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines);
  // An explicit named default and a last visit are distinct intents and owners.
  const defaultTarget = areAccountSettingsScopesEqual(settingsScope, observationScope)
    ? readMachineAdministrationTargetPreference(preferences, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines) : null;
  const rememberedTarget = defaultTarget ?? lastPickedTarget;
  const [chosen, setChosen] = React.useState<Readonly<{
    serverId: string; accountId: string | undefined; controller: ManagedControllerV1; explicit: boolean;
  }>>();
  const accountId = binding?.isCurrent() ? binding.scope.accountId : undefined;
  const scopedChoice = chosen && chosen.accountId === accountId && areServerProfileIdentifiersEquivalent(chosen.serverId, input.serverId)
    ? chosen : undefined;
  const preferredMachineId = input.preferred?.machineId;
  const preferredInstallationId = input.preferred?.installationId;
  const namedRetained = scopedChoice?.explicit ? scopedChoice.controller
    : preferredMachineId && preferredInstallationId ? input.preferred : scopedChoice?.controller;
  const { onSelect } = input;

  // The chooser owns its inventory demand, including an answer that removes its last row.
  // Row-owned demand alone would release that answer as soon as filtering unmounts the rows.
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const closedMachineId = !pickerOpen ? namedRetained?.machineId : undefined;
  const allMachines = useMachineListForServer(input.serverId, !closedMachineId);
  const namedMachine = useServerScopedMachine(input.serverId, closedMachineId);
  const machines = React.useMemo(() => closedMachineId ? namedMachine ? [namedMachine] : [] : allMachines,
    [allMachines, closedMachineId, namedMachine]);
  const controllerIdsKey = useMachineListForServerSelection(input.serverId, readControllerIds);
  const { inventoryRows: rows, pickerRows } = useMachineAdministrationTargetRows({
    accountScope: observationScope ?? undefined, selectedMachineId: closedMachineId, managedInventoryDemand: pickerOpen,
  });
  const inventoryHomes = React.useMemo(() => pickerOpen ? [input.serverId] : [], [input.serverId, pickerOpen]);
  const { machinesByEnrolledMachineIdByServerId } = useManagedMachineInventory(inventoryHomes);
  const managedByMachineId = machinesByEnrolledMachineIdByServerId[input.serverId];
  const absentMachineIds = useAdmittedManagedMachineAbsentEnrolledIds(input.serverId, binding);
  const controllerMachines = React.useMemo(() => (machines ?? []).filter(isManagedControllerCandidate), [machines]);
  const controllerIds = React.useMemo(() => new Set(JSON.parse(controllerIdsKey) as string[]), [controllerIdsKey]);
  const eligible = React.useMemo(
    () =>
      controllerMachines.filter(machine => !absentMachineIds.has(machine.id)),
    [absentMachineIds, controllerMachines],
  );
  const eligibleById = React.useMemo(() => new Map(eligible.map(machine => [machine.id, machine])), [eligible]);
  const availabilityReader = React.useMemo(() => binding?.isCurrent() ? readPluginAccountAvailability(binding.scope) : null, [binding]);
  const subscribeCapabilities = React.useCallback((notify: () => void) => availabilityReader?.subscribe(notify) ?? (() => {}), [availabilityReader]);
  const readCapabilities = React.useCallback(() => {
    const installed = binding?.isCurrent() ? availabilityReader?.readInstalledPlugins() : undefined;
    if (installed?.kind !== 'available') return eligible.map(() => 'unknown').join('|');
    const declarations = new Map<string, 'supported' | 'unknown'>();
    for (const plugin of installed.plugins) for (const installation of plugin.installations) {
      const materialization = installation.materialization;
      if (!materialization.enabled || materialization.trustState !== 'trusted'
        || !areServerProfileIdentifiersEquivalent(materialization.serverIdentityId, input.serverId)
        || !eligibleById.has(materialization.machineId) || declarations.get(materialization.machineId) === 'supported') continue;
      const declaration = installation.contributorDeclaration;
      const provisioners = declaration?.contributes.machineProvisioners ?? [];
      const platform = eligibleById.get(materialization.machineId)?.metadata?.platform;
      if (platform && provisioners.some(provisioner => provisioner.platforms.some(supported => supported === platform))) {
        declarations.set(materialization.machineId, 'supported');
      } else if (!declaration || !platform && provisioners.length > 0) {
        declarations.set(materialization.machineId, 'unknown');
      }
    }
    // Missing or unavailable declarations are not absence. Only a complete admitted census can
    // exclude a controller; the primitive result ignores renewal/heartbeat churn.
    return eligible.map(machine => declarations.get(machine.id) === 'supported' ? 'supported'
      : installed.completeness === 'complete' && declarations.get(machine.id) !== 'unknown' ? 'unsupported' : 'unknown').join('|');
  }, [availabilityReader, binding, eligible, eligibleById, input.serverId]);
  const capabilities = React.useSyncExternalStore(subscribeCapabilities, readCapabilities, readCapabilities);
  const capabilityStates = React.useMemo(() => capabilities.split('|'), [capabilities]);
  const installedProvisionerMachines = React.useMemo(() => new Set(eligible.filter((_machine, index) => capabilityStates[index] === 'supported').map(machine => machine.id)), [capabilityStates, eligible]);
  const unsupportedProvisionerMachines = React.useMemo(() => new Set(eligible.filter((_machine, index) => capabilityStates[index] === 'unsupported').map(machine => machine.id)), [capabilityStates, eligible]);
  const scopedRows = React.useMemo(() => {
      const isWakeable = (machineId: string) => {
        const managed = managedByMachineId?.[machineId];
        return !!managed && resolveManagedMachineWakeStateV1(managed, machineId) !== null;
      };
      const scoped = pickerRows.filter(
        (row) =>
          areServerProfileIdentifiersEquivalent(row.serverId, input.serverId) &&
          !absentMachineIds.has(row.candidate.target.machineId) &&
          (row.candidate.target.machineId === namedRetained?.machineId || controllerIds.has(row.candidate.target.machineId)),
      );
      return scoped.sort((left, right) =>
        Number(right.candidate.availability === 'online') - Number(left.candidate.availability === 'online')
        || Number(isMachineAdministrationCandidateExplicitlySelectable(right.candidate, 'lastKnown'))
          - Number(isMachineAdministrationCandidateExplicitlySelectable(left.candidate, 'lastKnown'))
        || Number(isWakeable(right.candidate.target.machineId)) - Number(isWakeable(left.candidate.target.machineId))
        || (left.candidate.availability === 'offline' && right.candidate.availability === 'offline'
          ? (readMachineActivity(right.machine).activeAt ?? 0) - (readMachineActivity(left.machine).activeAt ?? 0) : 0));
    }, [absentMachineIds, controllerIds, input.serverId, managedByMachineId, namedRetained?.machineId, pickerRows],
  );
  const automaticState = React.useMemo(() => {
    const readScope = binding?.isCurrent() ? binding.scope : null;
    return resolveMachineAdministrationTargetState({
      storedTarget: defaultTarget,
      candidates: scopedRows.map(row => row.candidate),
      automaticSelection: {
        isEligible: candidate => {
          const machine = eligibleById.get(candidate.target.machineId);
          return !!machine && supportsManagedControllerActions(machine)
            && isOwnComputerDefaultCandidate(machine)
            && !unsupportedProvisionerMachines.has(machine.id)
            && readMachineRequestReachabilityObservation(readScope, machine.id)?.outcome !== 'failed';
        },
        compare: (left, right) => {
          const leftId = left.target.machineId;
          const rightId = right.target.machineId;
          return Number(installedProvisionerMachines.has(rightId)) - Number(installedProvisionerMachines.has(leftId))
            || Number(!!rememberedTarget && machineAdministrationTargetsEqual(right.target, rememberedTarget))
              - Number(!!rememberedTarget && machineAdministrationTargetsEqual(left.target, rememberedTarget))
            || Number(rightId === thisMachineId) - Number(leftId === thisMachineId);
        },
      },
    });
  }, [binding, defaultTarget, eligibleById, installedProvisionerMachines, rememberedTarget, scopedRows, thisMachineId, unsupportedProvisionerMachines]);
  // Kept identity-stable by its ids: presence updates must not restart the reads it scopes.
  const preferred = React.useMemo(() => {
    // Resolve a default only once per page scope. Availability updates its status, never its identity;
    // fresh execution admission still decides whether the retained installation can run.
    if (namedRetained) return namedRetained;
    const machine = automaticState.kind !== 'unselected'
      && (automaticState.kind === 'online' || defaultTarget && automaticState.snapshot)
      ? eligibleById.get(automaticState.target.machineId) : undefined;
    return machine?.installationId
      ? { machineId: machine.id, installationId: machine.installationId }
      : undefined;
  }, [namedRetained?.machineId, namedRetained?.installationId, automaticState, defaultTarget, eligibleById]);
  const controllerMachineId = preferred?.machineId;
  const controllerInstallationId = preferred?.installationId;
  const controller = React.useMemo(
    (): ManagedControllerV1 | undefined =>
      controllerMachineId && controllerInstallationId
        ? { machineId: controllerMachineId, installationId: controllerInstallationId }
        : undefined,
    [controllerMachineId, controllerInstallationId],
  );
  React.useEffect(() => {
    if (!namedRetained && controller) setChosen({ serverId: input.serverId, accountId, controller, explicit: false });
  }, [namedRetained?.machineId, namedRetained?.installationId, controller, input.serverId, accountId]);

  const selection =
    React.useMemo((): MachineAdministrationTargetSelectionV1 => {
      const candidates = rows.filter(row => areServerProfileIdentifiersEquivalent(row.serverId, input.serverId))
        .map(row => row.candidate);
      const selectedTarget =
        rows.find(
          (row) => areServerProfileIdentifiersEquivalent(row.serverId, input.serverId)
            && row.candidate.target.machineId === controller?.machineId,
        )?.candidate.target ?? (controller && binding?.isCurrent()
          ? { serverIdentityId: binding.scope.serverId, machineId: controller.machineId }
          : null);
      const matchesAccount = doesMachineAdministrationTargetMatchActiveAccount({ target: selectedTarget, activeAccountServerId: activeAccountScope?.serverId });
      const resolveExecutionTarget = (options?: MachineAdministrationExecutionTargetOptions) => {
        if (!matchesAccount || !selectedTarget || !controller || !binding?.isCurrent()) return null;
        if (absentMachineIds.has(controller.machineId)) return null;
        const current = resolveFreshMachineAdministrationExecutionTarget(selectedTarget, { ...options, accountScope: binding.scope });
        return current?.machine.installationId === controller.installationId && supportsManagedControllerActions(current.machine) ? current : null;
      };
      return {
        candidates,
        pickerRows: scopedRows,
        state: resolveMachineAdministrationTargetState({
          storedTarget: selectedTarget,
          candidates,
          allowSoleCandidate: false,
          isInventoryKnown: () => listSettled,
        }),
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: matchesAccount,
        canExecute: resolveExecutionTarget() !== null,
        changeIntent: onSelect ? 'draft' : 'scope',
        selectTarget: (target) => {
          if (!scopedRows.some(row => row.candidate.target.machineId === target.machineId
            && row.candidate.target.serverIdentityId === target.serverIdentityId
            && isMachineAdministrationCandidateExplicitlySelectable(row.candidate, 'lastKnown'))) return;
          const machine = resolveServerScopedMachine(storage.getState(), input.serverId, target.machineId);
          if (!machine || !isManagedControllerCandidate(machine) || !machine.installationId) return;
          const next = {
            machineId: machine.id,
            installationId: machine.installationId,
          };
          setChosen({ serverId: input.serverId, accountId, controller: next, explicit: true });
          if (binding?.isCurrent()) {
            rememberMachineAdministrationTargetObservation(binding.scope, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines, target);
          }
          onSelect?.(next);
        },
        clearTarget: () => {},
        resolveExecutionTarget,
      };
    }, [absentMachineIds, binding, controller?.machineId, controller?.installationId, eligible, onSelect, scopedRows, rows, listSettled, activeAccountScope?.serverId, input.serverId, accountId]);

  const chip =
    controllerMachines.length > 0 || controller ? (
      <MachineAdministrationTargetSelector
        presentation="chip"
        selection={selection}
        groupTitle={t('managedMachines.config.managedFrom')}
        selectionPolicy="lastKnown"
        chipOpen={pickerOpen}
        onChipOpenChange={setPickerOpen}
        disabled={input.disabled}
        testIDPrefix={input.testIDPrefix}
      />
    ) : null;
  return {
    controller: input.delegatedPreset ? input.preferred : controller,
    machine: machines?.find((machine) => machine.id === controller?.machineId),
    hasCandidates: controllerMachines.length > 0,
    hasOnlineCandidate: scopedRows.some(row => row.candidate.availability === 'online'),
    machineList: listSettled ? 'settled' : listStatus === 'error' || listStatus === 'signedOut' ? 'unavailable' : 'loading',
    controllerOffline: scopedRows.some(row => row.candidate.target.machineId === (input.delegatedPreset ? input.preferred : controller)?.machineId
      && row.candidate.availability === 'offline'),
    chip: input.delegatedPreset ? null : chip,
    selection: input.delegatedPreset ? undefined : selection,
  };
}
