import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  ScmHostingRepositoryResolveAddressResponseV1Schema,
  type ScmHostingRepositoryResolveAddressResponseV1,
} from '@happier-dev/protocol/scm/repositoryClone';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineInventoryStatus } from '@/sync/domains/machines/machineInventorySnapshots';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { t } from '@/text';

export type ProjectSourceAddressMachines = Readonly<{
  inventoryStatus: MachineInventoryStatus;
  machines: readonly Readonly<
    Pick<Machine, 'id' | 'active'> &
      Partial<
        Pick<
          Machine,
          | 'activeAt'
          | 'kind'
          | 'revokedAt'
          | 'replacedByMachineId'
          | 'availability'
        >
      >
  >[];
  preferredMachineId?: string | null;
}>;
export type ProjectSourceAddressResolution =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'waiting_for_machines'; address: string; preferredMachineId?: string | null }>
  | Readonly<{ kind: 'resolving'; address: string; machineId: string }>
  | Readonly<{ kind: 'no_reachable_machine'; address: string }>
  /** The Home's Machine list could not be read, or the asked Machine's check failed (then it is named, with its code). */
  | Readonly<{ kind: 'unavailable'; address: string; machineId?: string; errorCode?: string }>
  | (ScmHostingRepositoryResolveAddressResponseV1 &
      Readonly<{ address: string; machineId: string }>);
/** Why an address cannot be used yet, as a translation key; null once it resolved. */
export type ProjectSourceAddressRefusal =
  | 'projects.sources.addressNoMachine'
  | 'projects.sources.backendUnavailable'
  | 'projects.sources.addressUnknown'
  | 'projects.sources.addressUnsupported'
  | 'projects.sources.addressCheckFailed'
  | 'projects.sources.addressInvalid'
  | 'projects.sources.loading';
/** Why a Source's Save is disabled: an address refusal, or no address yet. */
export type ProjectSourceSaveDisabledReason = ProjectSourceAddressRefusal | 'projects.sources.saveNeedsAddress';

type Execute = (
  actionId: ActionId,
  input: unknown,
  context?: UiActionExecutorContext,
) => Promise<ActionExecuteResult>;

/**
 * The one reading of a typed repository address (a new Source, or a repository to clone in Open): an
 * online Machine's hosting owner says which repository it names (`scm.hostingRepository.resolveAddress`).
 * `onResolving` reports the Machine asked before the answer arrives. Resolves to null when aborted.
 */
export async function resolveProjectSourceAddress(
  params: Readonly<{
    text: string;
    scope: ServerAccountScope;
    execute: Execute;
    machines: ProjectSourceAddressMachines;
    signal: AbortSignal;
    onResolving?: (
      resolution: Extract<
        ProjectSourceAddressResolution,
        { kind: 'resolving' }
      >,
    ) => void;
  }>,
): Promise<Readonly<{
  resolution: ProjectSourceAddressResolution;
  refusal: ProjectSourceAddressRefusal | null;
}> | null> {
  const address = params.text.trim();
  if (!address)
    return {
      resolution: { success: true, kind: 'invalid', address, machineId: '' },
      refusal: 'projects.sources.addressInvalid',
    };
  if (params.machines.inventoryStatus === 'loading')
    return {
      resolution: { kind: 'waiting_for_machines', address, preferredMachineId: params.machines.preferredMachineId },
      refusal: 'projects.sources.loading',
    };
  if (params.machines.inventoryStatus !== 'idle')
    return {
      resolution: { kind: 'unavailable', address },
      refusal: 'projects.sources.backendUnavailable',
    };
  const reachable = params.machines.machines.filter(
    (machine) =>
      isMachineVisibleForLaunchSelection(machine) &&
      machine.availability?.kind !== 'locked' &&
      isMachineSelectableForFleet(params.scope, machine),
  );
  const machine =
    reachable.find(
      (candidate) => candidate.id === params.machines.preferredMachineId,
    ) ?? reachable[0];
  if (!machine)
    return {
      resolution: { kind: 'no_reachable_machine', address },
      refusal: 'projects.sources.addressNoMachine',
    };
  params.onResolving?.({ kind: 'resolving', address, machineId: machine.id });
  let failureCode = 'invalid_response';
  try {
    const outcome = await params.execute(
      'scm.hostingRepository.resolveAddress',
      { address },
      {
        surface: 'ui',
        serverId: params.scope.serverId,
        expectedAccountId: params.scope.accountId,
        externalActionTarget: { kind: 'machine', machineId: machine.id },
        signal: params.signal,
      },
    );
    if (params.signal.aborted) return null;
    if (!outcome.ok) {
      failureCode = outcome.errorCode;
      throw new Error(outcome.errorCode);
    }
    const result = ScmHostingRepositoryResolveAddressResponseV1Schema.parse(
      outcome.result,
    );
    return {
      resolution: { ...result, address, machineId: machine.id },
      refusal:
        result.kind === 'resolved'
          ? null
          : result.kind === 'invalid'
            ? 'projects.sources.addressInvalid'
            : result.kind === 'unknown'
              ? 'projects.sources.addressUnknown'
              : 'projects.sources.addressUnsupported',
    };
  } catch {
    if (params.signal.aborted) return null;
    // The Machine that was asked could not answer: say which one and why, never that the repository is unsupported.
    return {
      resolution: { kind: 'unavailable', address, machineId: machine.id, errorCode: failureCode },
      refusal: 'projects.sources.addressCheckFailed',
    };
  }
}

/** The refusal in words; a failed check names the Machine asked and its code. */
export function presentProjectSourceAddressRefusal(
  resolution: ProjectSourceAddressResolution,
  refusal: ProjectSourceSaveDisabledReason,
  machineName: (machineId: string) => string,
): string {
  if (refusal === 'projects.sources.addressCheckFailed') {
    return resolution.kind === 'unavailable' && resolution.machineId
      ? t('projects.sources.addressCheckFailed', { machine: machineName(resolution.machineId), code: resolution.errorCode ?? 'invalid_response' })
      : t('projects.sources.backendUnavailable');
  }
  return t(refusal);
}
